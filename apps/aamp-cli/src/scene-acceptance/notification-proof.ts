import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { NodeCommandRunner, type CommandRunner, type FfmpegBinaries } from '@combat/media';
import { LTX_SUPPORTED_FPS } from '@combat/providers';

import { assertStoryboardVideoArtefactSafe } from '../storyboard-video/artefact-safety';
import {
  STORYBOARD_VIDEO_EXIT_CODES,
  StoryboardVideoError,
  type StoryboardVideoExitCode,
} from '../storyboard-video/failures';
import { probeClip } from '../storyboard-video/scene-media';
import { loadAcceptanceBrief, type AcceptanceBrief } from './acceptance-brief';
import {
  buildNotificationDefectReport,
  measureNotification,
  type NotificationDefectReport,
} from './notification-defects';
import { compositeNotification, type NotificationCompositeResult } from './notification-composite';
import {
  writeNotificationComparisonGallery,
  NOTIFICATION_COMPARISON_GALLERY_FILENAME,
} from './notification-comparison-gallery';
import { measureNotificationPlacement, type PlacementReport } from './notification-placement';
import { assertNotPermanentlyRejected, PERMANENTLY_REJECTED_CLIP_NOTE } from './plate-library';

/**
 * The notification proof: a short cut of the Scene-1 picture with the new
 * treatment on it, produced for nothing.
 *
 * This exists because the notification is the one part of Scene 1 that nobody
 * has to pay to iterate on. The clip underneath it was bought once and was
 * **rejected** by a named reviewer for how the camera moved; that decision
 * stands and this run does not touch it. What those bytes are used for here is
 * compositing material — the only honest way to see a card sitting in this
 * room, on this subject, at this scale, without buying a second generation to
 * look at a graphic that was never the reason the first one was refused.
 *
 * The properties that make that safe are structural rather than promised:
 *
 * - **No provider is constructed anywhere on this path.** Not a video
 *   generation provider, not a reasoning provider, not a database client. There
 *   is no API key argument, no base URL, no credential read. A run cannot spend
 *   money because there is nothing here that could.
 * - **The rejection is carried, not quietly dropped.** Every artefact records
 *   that the underlying clip is rejected for output and why, and the proof is
 *   labelled as a treatment proof rather than as a scene.
 * - **Nothing here renders the advertisement.** One scene's opening second is
 *   produced. Scenes 2–10 and the fifteen-second cut are out of scope and every
 *   artefact says so rather than leaving it to be inferred.
 */

export const NOTIFICATION_PROOF_VERSION = 1 as const;

const SURFACE_SUBDIRECTORY = 'proof';
const FRAMES_DIRECTORY = 'frames';
const MEASUREMENT_DIRECTORY = 'measurement';

/** The moments the specification asks to see, in seconds. */
export const PROOF_FRAME_TIMES: readonly number[] = [0.0, 0.16, 0.34, 0.6, 1.05];

export interface NotificationProofOptions {
  readonly briefPath: string;
  /** The Scene-1 picture the card is composited over. */
  readonly sourceClipPath: string;
  /** The owned Combat Reviews mark. */
  readonly logoPath: string;
  readonly outputDirectory: string;
  /** The previous treatment's cut, for the side-by-side. Optional by design. */
  readonly previousCompositePath?: string;
  readonly binaries: FfmpegBinaries;
  readonly now: Date;
  readonly runner?: CommandRunner;
  /** Render twice and compare, which is how determinism becomes a measurement. */
  readonly verifyDeterminism?: boolean;
  readonly onProgress?: (message: string) => void;
}

export interface NotificationProofResult {
  readonly exitCode: StoryboardVideoExitCode;
  readonly runDirectory: string;
  readonly proofPath?: string;
  readonly proofChecksumSha256?: string;
  readonly surfaceAssetPath?: string;
  readonly galleryPath?: string;
  readonly framePaths: readonly string[];
  readonly measuredDurationSeconds?: number;
  readonly measuredWidthPx?: number;
  readonly measuredHeightPx?: number;
  readonly placementClears?: boolean;
  readonly measuredDefectCount?: number;
  readonly notMeasuredCount?: number;
  readonly openHumanJudgementCount?: number;
  readonly paidProviderCalls: 0;
  readonly costCents: 0;
  readonly artefacts: readonly string[];
  readonly failure?: string;
  readonly failureKind?: string;
}

export async function runNotificationProof(
  options: NotificationProofOptions,
): Promise<NotificationProofResult> {
  const runner = options.runner ?? new NodeCommandRunner();
  const runDirectory = resolve(options.outputDirectory);
  const artefacts: string[] = [];
  const framePaths: string[] = [];
  const onProgress = options.onProgress;

  try {
    await mkdir(runDirectory, { recursive: true });

    const brief = await loadAcceptanceBrief(options.briefPath);
    const sourceClipPath = resolve(options.sourceClipPath);
    // A clip under `generated-clips/` is refused by location, not by filename:
    // the two permanently-rejected landscape clips survive a rename and a
    // structural rule does too.
    assertNotPermanentlyRejected(sourceClipPath, 'the compositing source');

    const sourceBytes = await readFile(sourceClipPath).catch(() => null);
    if (!sourceBytes || sourceBytes.byteLength === 0) {
      throw new StoryboardVideoError(
        'INVALID_GENERATED_MEDIA',
        `the Scene-1 picture at ${sourceClipPath} could not be read. This command composites over existing bytes and never generates a substitute.`,
      );
    }
    const sourceChecksumSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const sourceMeasured = await probeClip(sourceClipPath, runner, options.binaries);

    const proofDurationSeconds = brief.notification.readableUntilSeconds;
    if (sourceMeasured.durationSeconds + 1e-6 < proofDurationSeconds) {
      throw new StoryboardVideoError(
        'INVALID_GENERATED_MEDIA',
        `the source runs ${sourceMeasured.durationSeconds.toFixed(3)}s but the proof needs ${proofDurationSeconds}s. A short source is never stretched to fit.`,
      );
    }

    onProgress?.(
      `compositing the new notification treatment over ${proofDurationSeconds}s of the Scene-1 picture — no provider is constructed and nothing is spent`,
    );

    // --- the proof ------------------------------------------------------------
    const proofDirectory = join(runDirectory, SURFACE_SUBDIRECTORY);
    await mkdir(proofDirectory, { recursive: true });
    const proofPath = join(proofDirectory, 'scene-01-notification-proof.mp4');
    const composite = await compositeNotification({
      sourceClipPath,
      outputPath: proofPath,
      notification: brief.notification,
      logoPath: resolve(options.logoPath),
      outputDurationSeconds: proofDurationSeconds,
      runner,
      binaries: options.binaries,
      ...(onProgress ? { onProgress } : {}),
    });

    // --- rendered twice, compared byte for byte -------------------------------
    let rerenderChecksumSha256: string | null = null;
    if (options.verifyDeterminism !== false) {
      onProgress?.('re-rendering the same plan to compare it byte for byte');
      const verifyDirectory = join(runDirectory, 'determinism');
      const second = await compositeNotification({
        sourceClipPath,
        outputPath: join(verifyDirectory, 'scene-01-notification-proof.mp4'),
        notification: brief.notification,
        logoPath: resolve(options.logoPath),
        outputDurationSeconds: proofDurationSeconds,
        runner,
        binaries: options.binaries,
      });
      rerenderChecksumSha256 = second.checksumSha256;
      // The comparison is the artefact; the second copy is not. Keeping it
      // would leave two files a reader has to tell apart.
      await rm(verifyDirectory, { recursive: true, force: true });
    }

    const proofMeasured = await probeClip(proofPath, runner, options.binaries);

    // --- placement, measured against the picture underneath -------------------
    const placement = await measureNotificationPlacement({
      sourceClipPath,
      frame: composite.timeline.frame,
      treatmentOccupiedRect: composite.timeline.occupiedRect,
      restingCardRect: composite.timeline.restRect,
      durationSeconds: proofDurationSeconds,
      frameRate: LTX_SUPPORTED_FPS,
      workingDirectory: join(runDirectory, MEASUREMENT_DIRECTORY),
      runner,
      binaries: options.binaries,
      ...(onProgress ? { onProgress } : {}),
    });

    // --- what is visibly wrong, measured off the proof ------------------------
    const measurements = await measureNotification({
      compositedClipPath: proofPath,
      assetPath: composite.surfaces.assetPath,
      assetWidthPx: composite.surfaces.assetRect.widthPx,
      assetHeightPx: composite.surfaces.assetRect.heightPx,
      brief: brief.notification,
      timeline: composite.timeline,
      durationSeconds: proofDurationSeconds,
      frameRate: LTX_SUPPORTED_FPS,
      workingDirectory: join(runDirectory, MEASUREMENT_DIRECTORY),
      runner,
      binaries: options.binaries,
      ...(onProgress ? { onProgress } : {}),
    });

    const defects = buildNotificationDefectReport({
      brief: brief.notification,
      timeline: composite.timeline,
      measurements,
      placement,
      measuredWidthPx: proofMeasured.widthPx,
      measuredHeightPx: proofMeasured.heightPx,
      measuredDurationSeconds: proofMeasured.durationSeconds,
      requestedDurationSeconds: proofDurationSeconds,
      rerenderChecksumSha256,
      renderChecksumSha256: composite.checksumSha256,
    });

    // --- the frames the specification asks to see -----------------------------
    const framesDirectory = join(runDirectory, FRAMES_DIRECTORY);
    await mkdir(framesDirectory, { recursive: true });
    for (const atSeconds of PROOF_FRAME_TIMES) {
      const fileName = `proof-${atSeconds.toFixed(2).replace('.', 'p')}s.png`;
      const target = join(framesDirectory, fileName);
      // eslint-disable-next-line no-await-in-loop -- ordered so a failure names its frame
      const extracted = await runner.run(
        options.binaries.ffmpeg,
        [
          '-nostdin',
          '-v',
          'error',
          '-ss',
          atSeconds.toFixed(3),
          '-i',
          proofPath,
          '-frames:v',
          '1',
          '-y',
          target,
        ],
        { timeoutMs: 120_000 },
      );
      if (extracted.exitCode !== 0) {
        throw new StoryboardVideoError(
          'INVALID_GENERATED_MEDIA',
          `the ${atSeconds.toFixed(2)}s proof frame could not be extracted: ${extracted.stderr.trim().slice(-300)}`,
        );
      }
      framePaths.push(target);
    }

    // --- the previous treatment, for the side-by-side -------------------------
    let previousRelativePath: string | null = null;
    let previousChecksumSha256: string | null = null;
    if (options.previousCompositePath) {
      const previous = resolve(options.previousCompositePath);
      const bytes = await readFile(previous).catch(() => null);
      if (bytes && bytes.byteLength > 0) {
        const copied = join(runDirectory, 'previous-treatment.mp4');
        await copyFile(previous, copied);
        previousRelativePath = toRelative(runDirectory, copied);
        previousChecksumSha256 = createHash('sha256').update(bytes).digest('hex');
      } else {
        onProgress?.(
          `the previous treatment at ${previous} could not be read; the gallery will say so rather than omitting the column`,
        );
      }
    }

    // --- the artefacts --------------------------------------------------------
    artefacts.push(
      await writeArtefact(runDirectory, 'notification-treatment.json', {
        proofVersion: NOTIFICATION_PROOF_VERSION,
        compositeVersion: composite.compositeVersion,
        treatmentVersion: composite.treatmentVersion,
        surfaceDesignVersion: brief.notification.surfaceDesignVersion,
        authoredBy: brief.authoredBy,
        treatment: composite.treatment,
        treatmentReason: brief.notification.treatmentReason,
        copy: {
          headerLabel: brief.notification.headerLabel,
          timestampLabel: brief.notification.timestampLabel,
          headline: brief.notification.headline,
          supportingLine: brief.notification.supportingLine,
          carriesNoCount: !/\d/.test(
            `${brief.notification.headline} ${brief.notification.supportingLine}`,
          ),
        },
        geometry: {
          frame: composite.timeline.frame,
          restingCardRect: composite.timeline.restRect,
          treatmentOccupiedRect: composite.timeline.occupiedRect,
          widthFractionOfFrame: Number(
            (composite.timeline.restRect.widthPx / composite.timeline.frame.widthPx).toFixed(4),
          ),
          cornerRadiusPx: brief.notification.cornerRadiusPx,
          withinSafeBounds: composite.withinSafeBounds,
        },
        animation: {
          states: composite.timeline.states,
          entranceEasing: brief.notification.entranceEasing,
          entranceRisePx: brief.notification.entranceRisePx,
          entranceStartScale: brief.notification.entranceStartScale,
          hasFadeOut: false,
        },
        matchTransitionSeed: composite.timeline.matchTransitionSeed,
        surfaces: {
          renderer: composite.surfaces.renderer,
          fontFamily: composite.surfaces.fontFamily,
          markChecksumSha256: composite.surfaces.markChecksumSha256,
          assetChecksumSha256: composite.surfaces.assetChecksumSha256,
          states: composite.surfaces.states.map((state) => ({
            stateId: state.stateId,
            fileName: state.fileName,
            checksumSha256: state.checksumSha256,
          })),
        },
        notes: composite.notes,
      }),
    );

    artefacts.push(await writeArtefact(runDirectory, 'placement-report.json', placement));
    artefacts.push(await writeArtefact(runDirectory, 'visible-defects.json', defects));
    artefacts.push(
      await writeArtefact(
        runDirectory,
        'proof-provenance.json',
        buildProvenance({
          brief,
          composite,
          placement,
          defects,
          proofDurationSeconds,
          proofMeasured,
          sourceChecksumSha256,
          sourceMeasured,
          rerenderChecksumSha256,
          generatedAt: options.now.toISOString(),
          ...(previousChecksumSha256 ? { previousChecksumSha256 } : {}),
        }),
      ),
    );

    const galleryPath = await writeNotificationComparisonGallery({
      runDirectory,
      proofRelativePath: toRelative(runDirectory, proofPath),
      surfaceAssetRelativePath: toRelative(runDirectory, composite.surfaces.assetPath),
      previousRelativePath,
      frames: framePaths.map((path, index) => ({
        atSeconds: PROOF_FRAME_TIMES[index] ?? 0,
        relativePath: toRelative(runDirectory, path),
      })),
      brief: brief.notification,
      timeline: composite.timeline,
      placement,
      defects,
      generatedAt: options.now.toISOString(),
    });
    artefacts.push(NOTIFICATION_COMPARISON_GALLERY_FILENAME);

    await rm(join(runDirectory, MEASUREMENT_DIRECTORY), { recursive: true, force: true });

    onProgress?.(
      `${defects.measuredDefectCount} measured defect(s), ${defects.notMeasuredCount} unmeasurable row(s), ${defects.openHumanJudgementCount} question(s) open for a person. Nothing was approved and nothing was spent.`,
    );

    return {
      // An unmeasurable row fails the run as surely as a defect does. A proof
      // that could not take its own measurements is not a proof, and a report
      // that counted only defects would call it one.
      exitCode:
        defects.measuredDefectCount === 0 && defects.notMeasuredCount === 0
          ? STORYBOARD_VIDEO_EXIT_CODES.SUCCESS
          : STORYBOARD_VIDEO_EXIT_CODES.FINAL_RENDER_FAILURE,
      runDirectory,
      proofPath,
      proofChecksumSha256: composite.checksumSha256,
      surfaceAssetPath: composite.surfaces.assetPath,
      galleryPath,
      framePaths,
      measuredDurationSeconds: proofMeasured.durationSeconds,
      measuredWidthPx: proofMeasured.widthPx,
      measuredHeightPx: proofMeasured.heightPx,
      placementClears: placement.clearsSubjectContent,
      measuredDefectCount: defects.measuredDefectCount,
      notMeasuredCount: defects.notMeasuredCount,
      openHumanJudgementCount: defects.openHumanJudgementCount,
      paidProviderCalls: 0,
      costCents: 0,
      artefacts,
    };
  } catch (error) {
    const typed =
      error instanceof StoryboardVideoError
        ? error
        : new StoryboardVideoError(
            'FINAL_RENDER_FAILURE',
            error instanceof Error ? error.message : String(error),
          );
    return {
      exitCode: typed.exitCode,
      runDirectory,
      framePaths,
      paidProviderCalls: 0,
      costCents: 0,
      artefacts,
      failure: typed.message,
      failureKind: typed.kind,
    };
  }
}

function buildProvenance(input: {
  brief: AcceptanceBrief;
  composite: NotificationCompositeResult;
  placement: PlacementReport;
  defects: NotificationDefectReport;
  proofDurationSeconds: number;
  proofMeasured: { durationSeconds: number; widthPx: number; heightPx: number; videoCodec: string };
  sourceChecksumSha256: string;
  sourceMeasured: { durationSeconds: number; widthPx: number; heightPx: number };
  rerenderChecksumSha256: string | null;
  generatedAt: string;
  previousChecksumSha256?: string;
}): unknown {
  return {
    proofVersion: NOTIFICATION_PROOF_VERSION,
    generatedAt: input.generatedAt,
    scope: {
      isTreatmentProof: true,
      scenesRendered: [1],
      scenesNotRendered: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      rendersFinalAdvertisement: false,
      note: 'A notification treatment proof over the Scene-1 slot. Scenes 2–10 are not touched and the fifteen-second master is not rendered.',
    },
    cost: {
      paidProviderCalls: 0,
      videoGenerationProviderCalls: 0,
      reasoningProviderCalls: 0,
      networkRequests: 0,
      costCents: 0,
      basis:
        'ZERO_COST — this command constructs no provider, reads no credential and makes no request. The figure is a property of the object graph, not an estimate.',
    },
    compositingSource: {
      checksumSha256: input.sourceChecksumSha256,
      measured: input.sourceMeasured,
      standing: 'REJECTED_FOR_OUTPUT',
      rejectionNote:
        'These bytes are the Scene-1 generation a named reviewer rejected for COMPOSITION_DRIFT and GAZE_LIFT. That decision stands and this run does not disturb it. They are used here only as compositing material, so a notification treatment can be judged against this room, this subject and this scale without buying a second generation. The rejected take is not a production source and is not reused for output.',
      permanentlyRejectedSources: PERMANENTLY_REJECTED_CLIP_NOTE,
    },
    proof: {
      requestedDurationSeconds: input.proofDurationSeconds,
      measured: input.proofMeasured,
      checksumSha256: input.composite.checksumSha256,
      rerenderChecksumSha256: input.rerenderChecksumSha256,
      byteIdenticalOnRerender:
        input.rerenderChecksumSha256 === null
          ? null
          : input.rerenderChecksumSha256 === input.composite.checksumSha256,
      // 1.100s is not representable at 24fps, so the nearest whole-frame
      // duration is what a file can carry. The requested and measured figures
      // are both recorded rather than one being rounded into the other.
      durationNote: `The Scene-1 slot is ${input.proofDurationSeconds}s. At ${LTX_SUPPORTED_FPS}fps that is not a whole number of frames, so the file carries the nearest whole-frame duration and both figures are recorded.`,
    },
    notification: {
      treatment: input.composite.treatment,
      compositeVersion: input.composite.compositeVersion,
      treatmentVersion: input.composite.treatmentVersion,
      surfaceDesignVersion: input.brief.notification.surfaceDesignVersion,
      markChecksumSha256: input.composite.surfaces.markChecksumSha256,
      surfaceAssetChecksumSha256: input.composite.surfaces.assetChecksumSha256,
      restingCardRect: input.composite.cardRect,
      treatmentOccupiedRect: input.composite.occupiedRect,
      generatedTypographyOrMark: false,
      notes: input.composite.notes,
    },
    placement: {
      profileVersion: input.placement.profileVersion,
      framesMeasured: input.placement.frameCount,
      framesOverlappingSubjectContent: input.placement.framesOverlappingSubjectContent,
      worstClearanceAbovePx: input.placement.worstClearanceAbovePx,
      worstClearanceBelowPx: input.placement.worstClearanceBelowPx,
      clearsSubjectContent: input.placement.clearsSubjectContent,
    },
    review: {
      measuredDefectCount: input.defects.measuredDefectCount,
      notMeasuredCount: input.defects.notMeasuredCount,
      openHumanJudgementCount: input.defects.openHumanJudgementCount,
      status: 'VISUAL_REVIEW_PENDING',
      reviewer: null,
      verdict: null,
      decidedAt: null,
    },
    ...(input.previousChecksumSha256
      ? { previousTreatmentChecksumSha256: input.previousChecksumSha256 }
      : {}),
    isRealCampaignRun: false,
    isPublicReleaseReady: false,
    requiresHumanApproval: true,
    caveat:
      'A zero-cost notification treatment proof. It establishes what a deterministic tool can measure about the card — where it sits, that it is never an empty panel, that the accent fires once, that it does not fade, and that the same plan re-renders to the same bytes. It establishes nothing about creative quality, and the picture underneath it remains a rejected take.',
  };
}

async function writeArtefact(runDirectory: string, name: string, value: unknown): Promise<string> {
  assertStoryboardVideoArtefactSafe(value, name);
  const target = join(runDirectory, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return name;
}

function toRelative(from: string, target: string): string {
  return relative(from, target).split('\\').join('/');
}
