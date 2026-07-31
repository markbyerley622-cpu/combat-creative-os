import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

import {
  analyseClip,
  probeRaw,
  SUPPORTED_VIDEO_CODECS,
  type ClipTimeInterval,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';

import { StoryboardVideoError } from './failures';
import type { ResolvedKeyframe } from './keyframe-library';
import type { CameraMotion, SceneManifestEntry } from './scene-manifest';
import type { SceneSourceDecision } from './source-precedence';

/**
 * What is actually inside a resolved moving clip, measured locally.
 *
 * Every number here comes from FFmpeg reading the file on this machine. No
 * provider is constructed, no key is read, no request is made — inspection is
 * free, and being free is what makes it something an operator runs before
 * deciding to spend rather than after.
 *
 * **These measurements say nothing about creative quality.** They cannot: no
 * deterministic measurement of whether a shot is beautiful, whether a face is
 * convincing, whether a hand has five fingers or whether the story lands
 * exists, and inventing one would put the single number nobody could check at
 * the centre of the report. What they establish is narrower and worth
 * establishing: the file decodes, it is the right length, it is not black at
 * either end, it is not a held frame wearing a video container, it did not
 * come from a previews folder, and its opening composition is or is not the
 * approved keyframe's. Everything past that is a human's judgement, recorded
 * as one.
 *
 * The checks come in two tiers, and the difference is who can clear them:
 *
 * - `BINDING_TECHNICAL` — the file is unusable. No approval clears it; a
 *   different clip is needed.
 * - `FIDELITY_FINDING` — the file is usable and *disagrees with the brief*
 *   in a way a person has to rule on. It never clears itself, and an approval
 *   must name it.
 *
 * A check that could not be taken is `NOT_MEASURED` and is never a pass, which
 * is the preview path's rule and holds here for the same reason: an
 * unmeasurable binding property is not a satisfied one.
 */

export const MOTION_INSPECTION_PROFILE_VERSION = 1 as const;

export const MOTION_CHECK_IDS = [
  'FILE_PRESENT_AND_NON_EMPTY',
  'DECODABLE_VIDEO_STREAM',
  'MEASURED_GEOMETRY',
  'MEASURED_FRAME_RATE',
  'MEASURED_DURATION',
  'MEASURED_VIDEO_CODEC',
  'MEASURED_PIXEL_FORMAT',
  'NO_BLACK_OPENING',
  'NO_BLACK_ENDING',
  'NOT_FROZEN_OVER_EDIT_INTERVAL',
  'NO_CORRUPT_FRAMES',
  'SUFFICIENT_MOTION_FOR_DECLARED_REQUIREMENT',
  'SOURCE_COVERS_EDIT_INTERVAL',
  'NOT_A_PREVIEW_OR_CONTACT_SHEET_ASSET',
  'CHECKSUM_AND_PROVENANCE_RECORDED',
  'FIRST_FRAME_MATCHES_AUTHORITATIVE_KEYFRAME',
  'DELIVERS_WITHOUT_UPSCALE',
] as const;
export type MotionCheckId = (typeof MOTION_CHECK_IDS)[number];

export const MOTION_CHECK_TIERS: Readonly<
  Record<MotionCheckId, 'BINDING_TECHNICAL' | 'FIDELITY_FINDING'>
> = {
  FILE_PRESENT_AND_NON_EMPTY: 'BINDING_TECHNICAL',
  DECODABLE_VIDEO_STREAM: 'BINDING_TECHNICAL',
  MEASURED_GEOMETRY: 'BINDING_TECHNICAL',
  MEASURED_FRAME_RATE: 'BINDING_TECHNICAL',
  MEASURED_DURATION: 'BINDING_TECHNICAL',
  MEASURED_VIDEO_CODEC: 'BINDING_TECHNICAL',
  MEASURED_PIXEL_FORMAT: 'BINDING_TECHNICAL',
  NO_BLACK_OPENING: 'BINDING_TECHNICAL',
  NO_BLACK_ENDING: 'BINDING_TECHNICAL',
  NOT_FROZEN_OVER_EDIT_INTERVAL: 'BINDING_TECHNICAL',
  NO_CORRUPT_FRAMES: 'BINDING_TECHNICAL',
  SUFFICIENT_MOTION_FOR_DECLARED_REQUIREMENT: 'BINDING_TECHNICAL',
  SOURCE_COVERS_EDIT_INTERVAL: 'BINDING_TECHNICAL',
  NOT_A_PREVIEW_OR_CONTACT_SHEET_ASSET: 'BINDING_TECHNICAL',
  CHECKSUM_AND_PROVENANCE_RECORDED: 'BINDING_TECHNICAL',
  // Both of these are a real disagreement with the brief that a person must
  // rule on. A model may have animated a tighter, better shot than the
  // approved plate, and a 1920x1080 plate cropped to 9:16 may still be the
  // right picture — neither is a decision code may make on a reviewer's
  // behalf, and neither is a decision that may be skipped.
  FIRST_FRAME_MATCHES_AUTHORITATIVE_KEYFRAME: 'FIDELITY_FINDING',
  DELIVERS_WITHOUT_UPSCALE: 'FIDELITY_FINDING',
};

/** Delivery geometry the finished cut is built at. */
export const DELIVERY_WIDTH_PX = 1080;
export const DELIVERY_HEIGHT_PX = 1920;

// ---------------------------------------------------------------------------
// Motion energy
// ---------------------------------------------------------------------------

/**
 * How much the picture actually changes, with encoder noise removed.
 *
 * The naive measure — mean luma of the frame-to-frame difference — does not
 * work, and finding that out is the reason this is written down. Measured
 * against the real material: a still image encoded to h264 at CRF 18 scores
 * 1.22, a genuine slow push-in scores 1.31. The signal is buried in
 * quantisation noise, so any threshold placed on that measure would pass a
 * slideshow.
 *
 * Zeroing every per-pixel difference at or below `MOTION_NOISE_CUTOFF` before
 * averaging separates them completely: the same still measures **0.0000**, the
 * same slow push-in measures **1.72**, and a hard impact measures **11.53**.
 * Sampling at `MOTION_SAMPLE_FPS` rather than the source rate compares frames
 * far enough apart that a slow move accumulates, and at 192px wide the whole
 * pass is cheap.
 *
 * The single claim this measure supports is "this clip is not a held frame".
 * It is not a measure of how good the movement is, and no floor here should
 * ever be raised in an attempt to make it one.
 */
export const MOTION_SAMPLE_FPS = 8;
export const MOTION_SAMPLE_WIDTH_PX = 192;
export const MOTION_NOISE_CUTOFF = 16;
/** v2 added a floor for `CONTROLLED_PUSH_IN`. No existing floor was changed. */
export const MOTION_REQUIREMENT_PROFILE_VERSION = 2 as const;

/**
 * Floors by declared camera motion, all far below the slowest real movement
 * measured (1.72) and all far above a held frame (0.00).
 *
 * `STATIC` is the lowest but is deliberately not zero: a locked-off frame is
 * still a frame in which the subject moves, and a scene declared `STATIC`
 * whose picture does not change at all is a still.
 *
 * `CONTROLLED_PUSH_IN` sits at the `STATIC` floor, and that is not leniency.
 * This measurement is taken on the clip the *provider* returned, and a routed
 * motion asks the provider for `static` — the push is supplied afterwards by
 * `post-motion.ts`. Holding the returned plate to a push-in's floor would
 * refuse it for not containing a move it was deliberately not asked to make.
 * What this floor still catches is the thing it exists for: a returned clip
 * with no subject movement at all is a still, whatever is applied to it later.
 */
export const MOTION_ENERGY_FLOOR_BY_CAMERA_MOTION: Readonly<Record<CameraMotion, number>> = {
  STATIC: 0.15,
  SLOW_PUSH_IN: 0.3,
  CONTROLLED_PUSH_IN: 0.15,
  SLOW_PULL_OUT: 0.3,
  TILT_UP: 0.3,
  TILT_DOWN: 0.3,
  HANDHELD_DRIFT: 0.45,
  LATERAL_TRACK_LEFT: 0.45,
  LATERAL_TRACK_RIGHT: 0.45,
  ORBIT_LEFT: 0.45,
  ORBIT_RIGHT: 0.45,
};

// ---------------------------------------------------------------------------
// Keyframe agreement
// ---------------------------------------------------------------------------

/**
 * Whether the clip opens on the composition that was approved.
 *
 * Whole-frame difference does not answer this either, and the same real
 * material shows why: clip 1's first frame scores 0.871 against its own
 * keyframe and 0.871 against a different scene's. Both images are dark and
 * high-contrast, so a global mean is measuring exposure, not composition.
 *
 * Comparing the *layout of light* does work. Both images are taken to delivery
 * framing, reduced to a `KEYFRAME_GRID_COLUMNS x KEYFRAME_GRID_ROWS` grid of
 * cell means, and the two grids are correlated. Correlation is invariant to
 * overall brightness and contrast, which is exactly the invariance wanted: an
 * animated first frame is the same composition at a slightly different
 * exposure. Measured: the approved frame against a 6% push-in of itself scores
 * **0.98**; against a different approved frame, **0.00–0.02**.
 *
 * It answers one question — did this clip start from the approved plate — and
 * it says nothing about whether what follows is any good.
 */
export const KEYFRAME_GRID_COLUMNS = 4;
export const KEYFRAME_GRID_ROWS = 8;
export const KEYFRAME_COMPARISON_WIDTH_PX = 192;
export const KEYFRAME_COMPARISON_HEIGHT_PX = 341;
export const KEYFRAME_LAYOUT_AGREEMENT_FLOOR = 0.85;

/**
 * Path segments that are previews, contact sheets or working material.
 *
 * Refused by **location**, before any measurement is consulted — the same
 * structural rule the footage pack applies. A contact sheet that happens to
 * decode as a video is still a contact sheet.
 */
export const NON_PRODUCTION_PATH_SEGMENTS: readonly string[] = [
  'candidates',
  'work',
  'shortlists',
  'generation-briefs',
  'brief',
  'references',
  'previews',
  'contact-sheets',
];

export type MotionCheckStatus = 'PASS' | 'FAIL' | 'NOT_MEASURED' | 'NOT_APPLICABLE';

export interface MotionCheck {
  readonly id: MotionCheckId;
  readonly tier: 'BINDING_TECHNICAL' | 'FIDELITY_FINDING';
  readonly status: MotionCheckStatus;
  /** What was required, in words a person can act on. */
  readonly expected: string;
  /** What was found. Null only when the check could not be taken. */
  readonly observed: string | null;
  readonly notMeasuredReason?: string;
}

export interface InspectionFrame {
  readonly label: 'FIRST' | 'QUARTER' | 'MIDPOINT' | 'THREE_QUARTER' | 'FINAL';
  readonly atSeconds: number;
  /** Relative to the inspection directory, so the gallery is portable. */
  readonly fileName: string;
}

export interface SceneMotionInspection {
  readonly profileVersion: typeof MOTION_INSPECTION_PROFILE_VERSION;
  readonly sceneNumber: number;
  readonly sceneRole: string;
  readonly sourceType: string;
  readonly sourceIdentifier: string;
  readonly generationProvenance: string | null;
  readonly clipPath: string;
  readonly clipFileName: string;
  readonly clipChecksumSha256: string;
  readonly sizeBytes: number;
  readonly measured: {
    readonly widthPx: number | null;
    readonly heightPx: number | null;
    readonly frameRate: number | null;
    readonly durationSeconds: number | null;
    readonly videoCodec: string | null;
    readonly pixelFormat: string | null;
    readonly hasAudio: boolean | null;
  };
  readonly editInterval: {
    readonly outputStartSeconds: number;
    readonly outputEndSeconds: number;
    readonly requiredSourceSeconds: number;
  };
  readonly blackRegions: readonly ClipTimeInterval[];
  readonly freezeRegions: readonly ClipTimeInterval[];
  readonly motion: {
    readonly profileVersion: typeof MOTION_REQUIREMENT_PROFILE_VERSION;
    readonly declaredCameraMotion: CameraMotion;
    readonly floor: number;
    readonly measuredEnergy: number | null;
    readonly sampleFps: number;
    readonly noiseCutoff: number;
    readonly claim: string;
  };
  readonly keyframeAgreement: {
    readonly keyframeId: string;
    readonly keyframeChecksumSha256: string;
    readonly floor: number;
    readonly measuredAgreement: number | null;
    readonly method: string;
  } | null;
  readonly decodeErrors: readonly string[];
  readonly checks: readonly MotionCheck[];
  readonly verdict: 'TECHNICALLY_SOUND' | 'TECHNICALLY_INVALID' | 'NOT_PROVEN';
  readonly openFidelityFindings: readonly MotionCheckId[];
  readonly frames: readonly InspectionFrame[];
  readonly keyframePreviewFileName: string | null;
  readonly motionPrompt: string;
  readonly motionPromptSha256: string;
  /**
   * The prohibition clause the prompt carries. Named separately because it is
   * what a reviewer checks the picture against, and burying it in the prose
   * makes it unreadable at the moment it matters.
   */
  readonly negativeConstraints: readonly string[];
  readonly inspectionSha256: string;
  readonly measuredAtProfile: string;
}

export interface InspectSceneMotionOptions {
  readonly decision: SceneSourceDecision;
  readonly scene: SceneManifestEntry;
  readonly keyframe: ResolvedKeyframe;
  readonly clipPath: string;
  readonly requiredSourceSeconds: number;
  /** Where the sampled frames and the keyframe preview are written. */
  readonly inspectionDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

/**
 * Splits the prompt's prohibition clause out of its prose.
 *
 * The clause is what the reviewer is checking the picture against — "no
 * lettering was altered" is only answerable if the sentence forbidding it is
 * in front of them. Sentences are matched on their leading verb rather than
 * by scanning for forbidden words, so a prompt that merely mentions a mark is
 * not mistaken for one that forbids changing it.
 */
export function extractNegativeConstraints(motionPrompt: string): readonly string[] {
  return motionPrompt
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => /^(do not|never|no |avoid|must remain|must not)/i.test(sentence));
}

export async function inspectSceneMotion(
  options: InspectSceneMotionOptions,
): Promise<SceneMotionInspection> {
  const { decision, scene, keyframe } = options;
  const checks: MotionCheck[] = [];
  const record = (
    id: MotionCheckId,
    status: MotionCheckStatus,
    expected: string,
    observed: string | null,
    notMeasuredReason?: string,
  ): void => {
    checks.push({
      id,
      tier: MOTION_CHECK_TIERS[id],
      status,
      expected,
      observed,
      ...(notMeasuredReason ? { notMeasuredReason } : {}),
    });
  };

  await mkdir(options.inspectionDirectory, { recursive: true });
  const sceneLabel = `scene-${String(decision.sceneNumber).padStart(2, '0')}`;
  options.onProgress?.(`inspecting ${sceneLabel} — ${basename(options.clipPath)}`);

  // --- location, before anything is decoded ---------------------------------
  const offendingSegment = findNonProductionSegment(options.clipPath);
  record(
    'NOT_A_PREVIEW_OR_CONTACT_SHEET_ASSET',
    offendingSegment ? 'FAIL' : 'PASS',
    `no path segment among ${NON_PRODUCTION_PATH_SEGMENTS.join(', ')}`,
    offendingSegment ? `the clip sits under a "${offendingSegment}" directory` : 'production path',
  );

  // --- the file itself ------------------------------------------------------
  const stats = await stat(options.clipPath).catch(() => null);
  const present = Boolean(stats?.isFile() && stats.size > 0);
  record(
    'FILE_PRESENT_AND_NON_EMPTY',
    present ? 'PASS' : 'FAIL',
    'a readable file of non-zero length',
    present ? `${stats?.size ?? 0} bytes` : 'absent or empty',
  );

  let clipChecksumSha256 = '';
  let sizeBytes = 0;
  if (present) {
    const bytes = await readFile(options.clipPath);
    clipChecksumSha256 = createHash('sha256').update(bytes).digest('hex');
    sizeBytes = bytes.byteLength;
  }
  record(
    'CHECKSUM_AND_PROVENANCE_RECORDED',
    clipChecksumSha256 && decision.selectedSourceType ? 'PASS' : 'FAIL',
    'a sha256 recomputed from the bytes, and a named source provenance',
    clipChecksumSha256
      ? `${clipChecksumSha256.slice(0, 16)}… / ${decision.generationProvenance ?? decision.selectedSourceType}`
      : 'no checksum could be taken',
  );

  // --- probe ----------------------------------------------------------------
  let widthPx: number | null = null;
  let heightPx: number | null = null;
  let frameRate: number | null = null;
  let durationSeconds: number | null = null;
  let videoCodec: string | null = null;
  let pixelFormat: string | null = null;
  let hasAudio: boolean | null = null;
  let probeProblem: string | null = null;

  if (present) {
    try {
      const raw = await probeRaw(options.runner, options.clipPath, {
        ffprobePath: options.binaries.ffprobe,
      });
      const video = raw.streams?.find((stream) => stream.codec_type === 'video');
      if (!video) {
        probeProblem = 'the container holds no video stream';
      } else {
        widthPx = video.width ?? null;
        heightPx = video.height ?? null;
        frameRate = parseRational(video.avg_frame_rate ?? video.r_frame_rate);
        videoCodec = video.codec_name ?? null;
        pixelFormat = video.pix_fmt ?? null;
        const parsedDuration = Number(raw.format?.duration ?? video.duration ?? 0);
        durationSeconds =
          Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null;
        hasAudio = (raw.streams ?? []).some((stream) => stream.codec_type === 'audio');
      }
    } catch (error) {
      probeProblem = error instanceof Error ? error.message : String(error);
    }
  } else {
    probeProblem = 'there is no file to probe';
  }

  record(
    'DECODABLE_VIDEO_STREAM',
    probeProblem ? 'FAIL' : 'PASS',
    'ffprobe reports a video stream',
    probeProblem ?? `${videoCodec ?? 'unknown'} video stream`,
  );
  recordMeasurement(record, 'MEASURED_GEOMETRY', 'a real, non-zero pixel size', probeProblem, () =>
    widthPx && heightPx
      ? { pass: true, observed: `${widthPx}x${heightPx}` }
      : { pass: false, observed: 'no usable pixel dimensions' },
  );
  recordMeasurement(record, 'MEASURED_FRAME_RATE', 'a positive frame rate', probeProblem, () =>
    frameRate && frameRate > 0
      ? { pass: true, observed: `${frameRate.toFixed(3)} fps` }
      : { pass: false, observed: 'no readable frame rate' },
  );
  recordMeasurement(record, 'MEASURED_DURATION', 'a positive duration', probeProblem, () =>
    durationSeconds
      ? { pass: true, observed: `${durationSeconds.toFixed(3)}s` }
      : { pass: false, observed: 'no readable duration — a still or a broken container' },
  );
  recordMeasurement(
    record,
    'MEASURED_VIDEO_CODEC',
    `one of ${SUPPORTED_VIDEO_CODECS.join(', ')}`,
    probeProblem,
    () =>
      videoCodec && (SUPPORTED_VIDEO_CODECS as readonly string[]).includes(videoCodec)
        ? { pass: true, observed: videoCodec }
        : { pass: false, observed: videoCodec ?? 'unknown' },
  );
  recordMeasurement(record, 'MEASURED_PIXEL_FORMAT', 'a reported pixel format', probeProblem, () =>
    pixelFormat
      ? { pass: true, observed: pixelFormat }
      : { pass: false, observed: 'none reported' },
  );

  // --- coverage of the interval the cut will take ---------------------------
  const covers =
    durationSeconds !== null && durationSeconds + 1e-6 >= options.requiredSourceSeconds;
  record(
    'SOURCE_COVERS_EDIT_INTERVAL',
    durationSeconds === null ? 'NOT_MEASURED' : covers ? 'PASS' : 'FAIL',
    `at least ${options.requiredSourceSeconds.toFixed(3)}s, the beat plus its transition handles`,
    durationSeconds === null ? null : `${durationSeconds.toFixed(3)}s`,
    durationSeconds === null ? 'the duration could not be measured' : undefined,
  );

  // --- black, freeze and scene structure ------------------------------------
  let blackRegions: readonly ClipTimeInterval[] = [];
  let freezeRegions: readonly ClipTimeInterval[] = [];
  let analysisProblem: string | null = probeProblem;
  if (!probeProblem) {
    try {
      const analysis = await analyseClip(options.runner, options.clipPath, {
        ffmpegPath: options.binaries.ffmpeg,
        ffprobePath: options.binaries.ffprobe,
      });
      blackRegions = analysis.blackRegions;
      freezeRegions = analysis.freezeRegions;
      if (analysis.unavailable.length > 0) analysisProblem = analysis.unavailable.join('; ');
    } catch (error) {
      analysisProblem = error instanceof Error ? error.message : String(error);
    }
  }

  const interval = { start: 0, end: options.requiredSourceSeconds };
  const openingBlack = blackRegions.find((region) => region.startSeconds <= 1e-3);
  const endingBlack = blackRegions.find(
    (region) => durationSeconds !== null && region.endSeconds >= durationSeconds - 1e-3,
  );
  record(
    'NO_BLACK_OPENING',
    analysisProblem ? 'NOT_MEASURED' : openingBlack ? 'FAIL' : 'PASS',
    'the clip does not open on black',
    analysisProblem
      ? null
      : openingBlack
        ? `black from ${openingBlack.startSeconds.toFixed(3)}s to ${openingBlack.endSeconds.toFixed(3)}s`
        : 'no black at the head',
    analysisProblem ?? undefined,
  );
  record(
    'NO_BLACK_ENDING',
    analysisProblem ? 'NOT_MEASURED' : endingBlack ? 'FAIL' : 'PASS',
    'the clip does not end on black',
    analysisProblem
      ? null
      : endingBlack
        ? `black from ${endingBlack.startSeconds.toFixed(3)}s to ${endingBlack.endSeconds.toFixed(3)}s`
        : 'no black at the tail',
    analysisProblem ?? undefined,
  );

  const frozenOverInterval = freezeRegions.find(
    (region) => region.startSeconds < interval.end && region.endSeconds > interval.start,
  );
  record(
    'NOT_FROZEN_OVER_EDIT_INTERVAL',
    analysisProblem ? 'NOT_MEASURED' : frozenOverInterval ? 'FAIL' : 'PASS',
    `no frozen region overlapping 0–${interval.end.toFixed(3)}s, the window the cut takes`,
    analysisProblem
      ? null
      : frozenOverInterval
        ? `frozen from ${frozenOverInterval.startSeconds.toFixed(3)}s to ${frozenOverInterval.endSeconds.toFixed(3)}s`
        : 'no freeze over the window',
    analysisProblem ?? undefined,
  );

  // --- corrupt frames -------------------------------------------------------
  const decodeErrors = probeProblem
    ? []
    : await collectDecodeErrors(options.runner, options.binaries, options.clipPath);
  record(
    'NO_CORRUPT_FRAMES',
    probeProblem ? 'NOT_MEASURED' : decodeErrors.length === 0 ? 'PASS' : 'FAIL',
    'a full decode pass reports no errors',
    probeProblem ? null : decodeErrors.length === 0 ? 'clean decode' : decodeErrors.join('; '),
    probeProblem ?? undefined,
  );

  // --- motion ---------------------------------------------------------------
  const floor = MOTION_ENERGY_FLOOR_BY_CAMERA_MOTION[scene.cameraMotion];
  let measuredEnergy: number | null = null;
  let motionProblem: string | null = probeProblem;
  if (!probeProblem) {
    try {
      measuredEnergy = await measureMotionEnergy(
        options.runner,
        options.binaries,
        options.clipPath,
        options.requiredSourceSeconds,
      );
    } catch (error) {
      motionProblem = error instanceof Error ? error.message : String(error);
    }
  }
  record(
    'SUFFICIENT_MOTION_FOR_DECLARED_REQUIREMENT',
    measuredEnergy === null ? 'NOT_MEASURED' : measuredEnergy >= floor ? 'PASS' : 'FAIL',
    `at least ${floor} for a scene declared ${scene.cameraMotion} (a held frame measures 0.00)`,
    measuredEnergy === null ? null : measuredEnergy.toFixed(4),
    motionProblem ?? undefined,
  );

  // --- delivery headroom ----------------------------------------------------
  const upscales =
    widthPx !== null &&
    heightPx !== null &&
    (widthPx < DELIVERY_WIDTH_PX || heightPx < DELIVERY_HEIGHT_PX);
  record(
    'DELIVERS_WITHOUT_UPSCALE',
    widthPx === null || heightPx === null ? 'NOT_MEASURED' : upscales ? 'FAIL' : 'PASS',
    `at least ${DELIVERY_WIDTH_PX}x${DELIVERY_HEIGHT_PX} so the cover-scale to delivery never enlarges`,
    widthPx === null || heightPx === null
      ? null
      : upscales
        ? `${widthPx}x${heightPx} — the centre-crop to 9:16 is enlarged into the frame`
        : `${widthPx}x${heightPx}`,
    widthPx === null ? 'the geometry could not be measured' : undefined,
  );

  // --- the opening composition ----------------------------------------------
  // Only asked of clips that were animated from the approved plate. An
  // acquired photographic original was never supposed to match it, and asking
  // would produce a finding whose only honest resolution is "not applicable".
  const comparesToKeyframe =
    decision.selectedSourceType === 'LTX_GENERATED' ||
    decision.selectedSourceType === 'PRE_GENERATED_MANUAL_CLIP';
  let measuredAgreement: number | null = null;
  let agreementProblem: string | null = probeProblem;
  if (comparesToKeyframe && !probeProblem) {
    try {
      measuredAgreement = await measureKeyframeAgreement({
        runner: options.runner,
        binaries: options.binaries,
        clipPath: options.clipPath,
        keyframePath: keyframe.absolutePath,
        workingDirectory: options.inspectionDirectory,
        label: sceneLabel,
      });
    } catch (error) {
      agreementProblem = error instanceof Error ? error.message : String(error);
    }
  }
  record(
    'FIRST_FRAME_MATCHES_AUTHORITATIVE_KEYFRAME',
    !comparesToKeyframe
      ? 'NOT_APPLICABLE'
      : measuredAgreement === null
        ? 'NOT_MEASURED'
        : measuredAgreement >= KEYFRAME_LAYOUT_AGREEMENT_FLOOR
          ? 'PASS'
          : 'FAIL',
    `layout agreement of at least ${KEYFRAME_LAYOUT_AGREEMENT_FLOOR} with ${keyframe.frameId} at delivery framing (a 6% push-in of the approved frame measures 0.98; a different approved frame measures 0.00)`,
    !comparesToKeyframe
      ? `${decision.selectedSourceType} was never animated from a keyframe`
      : measuredAgreement === null
        ? null
        : measuredAgreement.toFixed(4),
    agreementProblem ?? undefined,
  );

  // --- frames for the gallery ------------------------------------------------
  const frames = probeProblem
    ? []
    : await extractInspectionFrames({
        runner: options.runner,
        binaries: options.binaries,
        clipPath: options.clipPath,
        inspectionDirectory: options.inspectionDirectory,
        label: sceneLabel,
        intervalSeconds: Math.min(
          options.requiredSourceSeconds,
          durationSeconds ?? options.requiredSourceSeconds,
        ),
      });

  const keyframePreviewFileName = await writeKeyframePreview({
    runner: options.runner,
    binaries: options.binaries,
    keyframePath: keyframe.absolutePath,
    inspectionDirectory: options.inspectionDirectory,
    label: sceneLabel,
  });

  const binding = checks.filter((check) => check.tier === 'BINDING_TECHNICAL');
  const verdict: SceneMotionInspection['verdict'] = binding.some((check) => check.status === 'FAIL')
    ? 'TECHNICALLY_INVALID'
    : binding.some((check) => check.status === 'NOT_MEASURED')
      ? 'NOT_PROVEN'
      : 'TECHNICALLY_SOUND';

  const openFidelityFindings = checks
    .filter((check) => check.tier === 'FIDELITY_FINDING')
    .filter((check) => check.status === 'FAIL' || check.status === 'NOT_MEASURED')
    .map((check) => check.id);

  const inspection: Omit<SceneMotionInspection, 'inspectionSha256'> = {
    profileVersion: MOTION_INSPECTION_PROFILE_VERSION,
    sceneNumber: decision.sceneNumber,
    sceneRole: decision.sceneRole,
    sourceType: decision.selectedSourceType,
    sourceIdentifier: decision.selectedIdentifier,
    generationProvenance: decision.generationProvenance ?? null,
    clipPath: options.clipPath,
    clipFileName: basename(options.clipPath),
    clipChecksumSha256,
    sizeBytes,
    measured: { widthPx, heightPx, frameRate, durationSeconds, videoCodec, pixelFormat, hasAudio },
    editInterval: {
      outputStartSeconds: scene.outputStartSeconds,
      outputEndSeconds: scene.outputEndSeconds,
      requiredSourceSeconds: options.requiredSourceSeconds,
    },
    blackRegions,
    freezeRegions,
    motion: {
      profileVersion: MOTION_REQUIREMENT_PROFILE_VERSION,
      declaredCameraMotion: scene.cameraMotion,
      floor,
      measuredEnergy,
      sampleFps: MOTION_SAMPLE_FPS,
      noiseCutoff: MOTION_NOISE_CUTOFF,
      claim:
        'This separates a moving clip from a held frame. It is not a measure of how good the movement is, and no number here supports a claim about creative quality.',
    },
    keyframeAgreement: comparesToKeyframe
      ? {
          keyframeId: keyframe.frameId,
          keyframeChecksumSha256: keyframe.checksumSha256,
          floor: KEYFRAME_LAYOUT_AGREEMENT_FLOOR,
          measuredAgreement,
          method: `${KEYFRAME_GRID_COLUMNS}x${KEYFRAME_GRID_ROWS} luma-layout correlation at delivery framing`,
        }
      : null,
    decodeErrors,
    checks,
    verdict,
    openFidelityFindings,
    frames,
    keyframePreviewFileName,
    motionPrompt: scene.motionPrompt,
    motionPromptSha256: createHash('sha256').update(scene.motionPrompt, 'utf8').digest('hex'),
    negativeConstraints: extractNegativeConstraints(scene.motionPrompt),
    measuredAtProfile: `motion-inspection v${MOTION_INSPECTION_PROFILE_VERSION}`,
  };

  return { ...inspection, inspectionSha256: hashInspection(inspection) };
}

/**
 * The digest a decision pins.
 *
 * Built from the findings rather than the whole record: the sampled frame
 * filenames and the absolute clip path are incidental, and letting them into
 * the digest would invalidate an approval because the run directory moved.
 */
export function hashInspection(
  inspection: Omit<SceneMotionInspection, 'inspectionSha256'>,
): string {
  const parts = [
    `profile=${inspection.profileVersion}`,
    `scene=${inspection.sceneNumber}`,
    `clip=${inspection.clipChecksumSha256}`,
    `verdict=${inspection.verdict}`,
    ...inspection.checks.map((check) => `${check.id}=${check.status}`),
    `findings=${[...inspection.openFidelityFindings].sort().join('|')}`,
  ];
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// measurement helpers
// ---------------------------------------------------------------------------

function recordMeasurement(
  record: (
    id: MotionCheckId,
    status: MotionCheckStatus,
    expected: string,
    observed: string | null,
    notMeasuredReason?: string,
  ) => void,
  id: MotionCheckId,
  expected: string,
  probeProblem: string | null,
  evaluate: () => { pass: boolean; observed: string },
): void {
  if (probeProblem) {
    record(id, 'NOT_MEASURED', expected, null, probeProblem);
    return;
  }
  const outcome = evaluate();
  record(id, outcome.pass ? 'PASS' : 'FAIL', expected, outcome.observed);
}

export function findNonProductionSegment(path: string): string | null {
  const segments = path.split(/[\\/]/).map((segment) => segment.toLowerCase());
  return NON_PRODUCTION_PATH_SEGMENTS.find((segment) => segments.includes(segment)) ?? null;
}

function parseRational(raw: string | undefined): number | null {
  if (!raw) return null;
  const [numerator, denominator] = raw.split('/').map(Number);
  if (!numerator || !denominator) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) && value > 0 ? Number(value.toFixed(3)) : null;
}

/**
 * A full decode with errors only, so a truncated or damaged clip is found here
 * rather than by FFmpeg halfway through the final composition.
 */
async function collectDecodeErrors(
  runner: CommandRunner,
  binaries: FfmpegBinaries,
  clipPath: string,
): Promise<readonly string[]> {
  const result = await runner.run(
    binaries.ffmpeg,
    ['-nostdin', '-v', 'error', '-xerror', '-i', clipPath, '-f', 'null', '-'],
    { timeoutMs: 300_000 },
  );
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (result.exitCode === 0 && lines.length === 0) return [];
  return lines.length > 0 ? lines.slice(0, 8) : [`ffmpeg exited ${result.exitCode}`];
}

export async function measureMotionEnergy(
  runner: CommandRunner,
  binaries: FfmpegBinaries,
  clipPath: string,
  intervalSeconds: number,
): Promise<number> {
  const filter = [
    `fps=${MOTION_SAMPLE_FPS}`,
    `scale=${MOTION_SAMPLE_WIDTH_PX}:-2`,
    'format=gray',
    'tblend=all_mode=difference',
    `lutyuv=y='if(gt(val,${MOTION_NOISE_CUTOFF}),val,0)'`,
    'signalstats',
    'metadata=mode=print:key=lavfi.signalstats.YAVG:file=-',
  ].join(',');

  const result = await runner.run(
    binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-t',
      intervalSeconds.toFixed(6),
      '-i',
      clipPath,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-vf',
      filter,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 300_000 },
  );
  if (result.exitCode !== 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `motion could not be measured: ${result.stderr.trim().slice(-300)}`,
    );
  }

  const values: number[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line.trim());
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) values.push(value);
    }
  }
  if (values.length === 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      'motion could not be measured: the detector reported no frames',
    );
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

/**
 * Takes both images to delivery framing and correlates their layout of light.
 *
 * The clip's frame goes through exactly the scale-and-crop the trim stage will
 * apply, so the comparison is against the picture that will be on screen
 * rather than against the raw container. A landscape clip compared before the
 * crop would agree with a portrait plate it will never actually match.
 */
export async function measureKeyframeAgreement(input: {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly clipPath: string;
  readonly keyframePath: string;
  readonly workingDirectory: string;
  readonly label: string;
}): Promise<number> {
  const deliveryFilter = [
    `scale=${DELIVERY_WIDTH_PX}:${DELIVERY_HEIGHT_PX}:force_original_aspect_ratio=increase`,
    `crop=${DELIVERY_WIDTH_PX}:${DELIVERY_HEIGHT_PX}`,
    `scale=${KEYFRAME_COMPARISON_WIDTH_PX}:${KEYFRAME_COMPARISON_HEIGHT_PX}`,
    'format=gray',
  ].join(',');

  const clipRaw = join(input.workingDirectory, `${input.label}-first.gray`);
  const keyframeRaw = join(input.workingDirectory, `${input.label}-keyframe.gray`);

  for (const [source, target] of [
    [input.clipPath, clipRaw],
    [input.keyframePath, keyframeRaw],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- two deterministic extractions
    const result = await input.runner.run(
      input.binaries.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        source,
        '-vf',
        deliveryFilter,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-y',
        target,
      ],
      { timeoutMs: 120_000 },
    );
    if (result.exitCode !== 0) {
      throw new StoryboardVideoError(
        'INVALID_GENERATED_MEDIA',
        `the opening composition could not be compared: ${result.stderr.trim().slice(-300)}`,
      );
    }
  }

  const clipGrid = gridMeans(await readFile(clipRaw));
  const keyframeGrid = gridMeans(await readFile(keyframeRaw));
  // Intermediate raw planes are removed: they are uncompressed pixels of the
  // operator's approved art, and the gallery has PNG previews for that.
  await unlink(clipRaw).catch(() => undefined);
  await unlink(keyframeRaw).catch(() => undefined);

  return Number(correlate(clipGrid, keyframeGrid).toFixed(4));
}

export function gridMeans(plane: Buffer): readonly number[] {
  const means: number[] = [];
  for (let row = 0; row < KEYFRAME_GRID_ROWS; row += 1) {
    for (let column = 0; column < KEYFRAME_GRID_COLUMNS; column += 1) {
      const y0 = Math.floor((row * KEYFRAME_COMPARISON_HEIGHT_PX) / KEYFRAME_GRID_ROWS);
      const y1 = Math.floor(((row + 1) * KEYFRAME_COMPARISON_HEIGHT_PX) / KEYFRAME_GRID_ROWS);
      const x0 = Math.floor((column * KEYFRAME_COMPARISON_WIDTH_PX) / KEYFRAME_GRID_COLUMNS);
      const x1 = Math.floor(((column + 1) * KEYFRAME_COMPARISON_WIDTH_PX) / KEYFRAME_GRID_COLUMNS);
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          sum += plane[y * KEYFRAME_COMPARISON_WIDTH_PX + x] ?? 0;
          count += 1;
        }
      }
      means.push(count > 0 ? sum / count : 0);
    }
  }
  return means;
}

export function correlate(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  const meanA = a.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < n; index += 1) {
    const x = (a[index] as number) - meanA;
    const y = (b[index] as number) - meanB;
    numerator += x * y;
    varianceA += x * x;
    varianceB += y * y;
  }
  // A flat image has no layout to correlate. Zero is the honest answer, and it
  // fails the floor rather than dividing by nothing.
  if (varianceA === 0 || varianceB === 0) return 0;
  return numerator / Math.sqrt(varianceA * varianceB);
}

const FRAME_POSITIONS: readonly { label: InspectionFrame['label']; fraction: number }[] = [
  { label: 'FIRST', fraction: 0 },
  { label: 'QUARTER', fraction: 0.25 },
  { label: 'MIDPOINT', fraction: 0.5 },
  { label: 'THREE_QUARTER', fraction: 0.75 },
  { label: 'FINAL', fraction: 1 },
];

async function extractInspectionFrames(input: {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly clipPath: string;
  readonly inspectionDirectory: string;
  readonly label: string;
  readonly intervalSeconds: number;
}): Promise<readonly InspectionFrame[]> {
  const frames: InspectionFrame[] = [];
  for (const position of FRAME_POSITIONS) {
    // The final frame is pulled a hair before the end: seeking exactly to the
    // duration lands past the last frame and produces nothing.
    const atSeconds = Number(
      Math.max(
        0,
        input.intervalSeconds * position.fraction - (position.fraction === 1 ? 0.04 : 0),
      ).toFixed(3),
    );
    const fileName = `${input.label}-${position.label.toLowerCase()}.png`;
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    const result = await input.runner.run(
      input.binaries.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        input.clipPath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${DELIVERY_WIDTH_PX}:${DELIVERY_HEIGHT_PX}:force_original_aspect_ratio=increase,crop=${DELIVERY_WIDTH_PX}:${DELIVERY_HEIGHT_PX},scale=216:384`,
        '-y',
        join(input.inspectionDirectory, fileName),
      ],
      { timeoutMs: 120_000 },
    );
    if (result.exitCode === 0) frames.push({ label: position.label, atSeconds, fileName });
  }
  return frames;
}

async function writeKeyframePreview(input: {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly keyframePath: string;
  readonly inspectionDirectory: string;
  readonly label: string;
}): Promise<string | null> {
  const fileName = `${input.label}-authoritative-keyframe.png`;
  const result = await input.runner.run(
    input.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      input.keyframePath,
      '-vf',
      `scale=${DELIVERY_WIDTH_PX}:${DELIVERY_HEIGHT_PX}:force_original_aspect_ratio=increase,crop=${DELIVERY_WIDTH_PX}:${DELIVERY_HEIGHT_PX},scale=216:384`,
      '-frames:v',
      '1',
      '-y',
      join(input.inspectionDirectory, fileName),
    ],
    { timeoutMs: 120_000 },
  );
  return result.exitCode === 0 ? fileName : null;
}

export { sep as pathSeparator };
