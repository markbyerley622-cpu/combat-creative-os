import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import {
  analyseClip,
  measureRenderedAudio,
  parseFrameRate,
  probeRaw,
  resolveFfmpegBinaries,
  type ClipAnalysis,
  type ClipTimeInterval,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';
import type {
  MediaKind,
  MediaQualityDecision,
  MediaQualityMeasurements,
  MediaQualityScores,
  MediaRightsDecision,
} from '@combat/providers';

/**
 * `COMBAT_REVIEWS_PREMIUM_SOURCE_V1` — the source-footage standard.
 *
 * This is a **different benchmark from Creative Memory**, and conflating the
 * two would be the easiest mistake to make in this milestone. Creative Memory
 * is the *creative* benchmark: hook strength, pacing, shot rhythm, transition
 * discipline, typography, motion design, CTA timing, originality. This profile
 * is the *source* benchmark: is the raw material technically good enough, and
 * editable enough, to build something premium out of.
 *
 * Everything here is measured from the actual bytes. Not one value is a
 * declared width, a catalogue duration or a provider's claimed frame rate.
 * That is the point: a stock API will happily describe a 720p upload as "HD",
 * and a manifest value that reached a report as if it were a measurement is the
 * failure this whole module exists to prevent.
 *
 * What it deliberately does **not** claim: cinematic quality. There is no
 * reliable machine measurement of lighting, subject separation, composition or
 * colour, so this profile reports none. `humanChecksRequired` names the things
 * a person has to look at — watermarks, burned-in captions, logos, whether the
 * shot is actually any good — rather than inventing a number for them.
 */

export const SOURCE_QUALITY_PROFILE_VERSION = 'COMBAT_REVIEWS_PREMIUM_SOURCE_V1';

/**
 * The technical floor.
 *
 * `minimumWidthPx`/`minimumHeightPx` are expressed as a *long edge* and *short
 * edge* rather than width and height, because a portrait 1080×1920 clip and a
 * landscape 1920×1080 clip are both acceptable 1080-line sources and a naive
 * width check would refuse the first.
 */
export const PREMIUM_SOURCE_FLOOR = {
  /** 1920×1080 in either orientation. */
  minimumLongEdgePx: 1920,
  minimumShortEdgePx: 1080,
  preferredLongEdgePx: 3840,
  minimumFrameRate: 24,
  /** Below this a clip cannot carry a beat; it may still be justified explicitly. */
  minimumUsableSeconds: 2,
  /** Fraction of the clip that may be black before it fails. */
  maximumBlackRatio: 0.25,
  maximumFreezeRatio: 0.25,
  /** A 9:16 crop of the source must still be at least this wide. */
  minimumVerticalCropWidthPx: 1080,
} as const;

/**
 * Containers and codecs that reach the renderer.
 *
 * Checked here rather than discovered at render time: an unsupported codec
 * that fails during FFmpeg composition has already cost a download, an
 * approval and an operator's afternoon.
 */
export const SUPPORTED_SOURCE_VIDEO_CODECS: readonly string[] = [
  'h264',
  'hevc',
  'vp9',
  'vp8',
  'av1',
  'prores',
  'mpeg4',
];
export const SUPPORTED_SOURCE_IMAGE_CODECS: readonly string[] = [
  'mjpeg',
  'png',
  'webp',
  'tiff',
  'bmp',
  'gif',
];
export const SUPPORTED_SOURCE_AUDIO_CODECS: readonly string[] = [
  'aac',
  'mp3',
  'pcm_s16le',
  'pcm_s24le',
  'opus',
  'flac',
  'vorbis',
];

export class SourceQualityError extends Error {
  constructor(
    public readonly filePath: string,
    detail: string,
  ) {
    super(`Could not measure ${filePath}: ${detail}`);
    this.name = 'SourceQualityError';
  }
}

export interface MeasureSourceOptions {
  readonly filePath: string;
  readonly mediaKind: MediaKind;
  readonly runner: CommandRunner;
  readonly binaries?: FfmpegBinaries;
  readonly signal?: AbortSignal;
  /**
   * Skips the two whole-clip decode passes. Used only by the pack-import
   * calibration over large libraries, and recorded in `notMeasured` — a faster
   * inspection that silently reported no black frames would be a lie.
   */
  readonly skipDeepAnalysis?: boolean;
}

function totalSeconds(regions: readonly ClipTimeInterval[]): number {
  return regions.reduce(
    (sum, region) => sum + Math.max(0, region.endSeconds - region.startSeconds),
    0,
  );
}

/**
 * The longest stretch with no black, no freeze and no shot change in it.
 *
 * This is the number that actually predicts editability: a 30-second clip made
 * of eleven half-second cuts is not a 30-second clip for our purposes, and a
 * duration field cannot tell the two apart.
 */
export function longestUsableRun(analysis: ClipAnalysis): number {
  const cuts = new Set<number>([0, analysis.durationSeconds]);
  for (const boundary of analysis.sceneBoundaries) cuts.add(boundary);
  for (const region of [...analysis.blackRegions, ...analysis.freezeRegions]) {
    cuts.add(region.startSeconds);
    cuts.add(region.endSeconds);
  }
  const ordered = [...cuts]
    .filter((time) => Number.isFinite(time) && time >= 0)
    .sort((a, b) => a - b);

  let longest = 0;
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const start = ordered[index] as number;
    const end = ordered[index + 1] as number;
    const midpoint = (start + end) / 2;
    const unusable = [...analysis.blackRegions, ...analysis.freezeRegions].some(
      (region) => region.startSeconds <= midpoint && region.endSeconds >= midpoint,
    );
    if (!unusable) longest = Math.max(longest, end - start);
  }
  return Number(longest.toFixed(3));
}

/**
 * How wide a 9:16 crop of this frame can be.
 *
 * A 3840×2160 source crops to 1215 px wide at full height, which clears the
 * 1080 floor; a 1920×1080 source crops to 607 px, which does not — it has to be
 * scaled up, and an upscale is not a 1080-wide source. Stating that as a
 * measurement rather than a rule of thumb is what stops "it's 4K, it'll be
 * fine" from becoming a soft vertical master.
 */
export function verticalCropWidth(widthPx: number, heightPx: number): number {
  if (widthPx <= 0 || heightPx <= 0) return 0;
  const cropWidthAtFullHeight = Math.floor((heightPx * 9) / 16);
  return Math.min(widthPx, cropWidthAtFullHeight);
}

/**
 * FFmpeg containers that only ever hold a still.
 *
 * This is the check that actually works, and finding out why took a real
 * library. ffprobe reports a JPEG as `image2` with a **synthetic 0.04-second
 * duration**, a 25/1 frame rate and *no* `nb_frames` at all — so the usual
 * "one frame and zero duration" heuristic reads it as a 0.04-second video and
 * the profile then refuses it for carrying the `mjpeg` codec. The container
 * name is the honest signal: every still-image demuxer is `image2` or ends in
 * `_pipe`.
 *
 * `gif` is deliberately absent: an animated GIF is a video, and the frame-count
 * branch is what classifies a single-frame one.
 */
const STILL_IMAGE_CONTAINERS: readonly string[] = [
  'image2',
  'image2pipe',
  'png_pipe',
  'jpeg_pipe',
  'mjpeg_pipe',
  'webp_pipe',
  'tiff_pipe',
  'bmp_pipe',
];

export function isStillImageContainer(formatName: string | undefined): boolean {
  if (!formatName) return false;
  // ffprobe reports comma-separated alternatives for ambiguous containers.
  return formatName
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => STILL_IMAGE_CONTAINERS.includes(entry) || entry.endsWith('_pipe'));
}

export async function sha256OfFile(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

/**
 * Measures one file.
 *
 * Order matters. The size check runs before any decode (there is no reason to
 * probe a zero-byte file), the probe runs before the analysis (a still image
 * has no black regions to look for), and audio is measured last because it is
 * the only optional instrument.
 */
export async function measureSourceMedia(
  options: MeasureSourceOptions,
): Promise<MediaQualityMeasurements> {
  const binaries = options.binaries ?? resolveFfmpegBinaries({});
  const notMeasured: string[] = [];

  const stats = await stat(options.filePath).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new SourceQualityError(options.filePath, 'the path is not a readable file');
  }
  if (stats.size === 0) {
    throw new SourceQualityError(options.filePath, 'the file is zero bytes');
  }

  const raw = await probeRaw(options.runner, options.filePath, {
    ffprobePath: binaries.ffprobe,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const videoStream = raw.streams?.find((stream) => stream.codec_type === 'video');
  const audioStream = raw.streams?.find((stream) => stream.codec_type === 'audio');
  if (!videoStream && !audioStream) {
    throw new SourceQualityError(options.filePath, 'no decodable video or audio stream');
  }

  const widthPx = videoStream?.width ?? 0;
  const heightPx = videoStream?.height ?? 0;
  const containerDuration = Number(raw.format?.duration ?? '');
  const durationSeconds =
    Number.isFinite(containerDuration) && containerDuration > 0 ? containerDuration : null;
  const bitrate = Number(raw.format?.bit_rate ?? '');

  const detectedMediaKind: MediaKind = videoStream
    ? isStillImageContainer(raw.format?.format_name) ||
      (Number(videoStream.nb_frames ?? 0) <= 1 && (durationSeconds ?? 0) === 0)
      ? 'IMAGE'
      : 'VIDEO'
    : 'AUDIO';
  // Recorded as a flag rather than pushed onto `notMeasured`: this is a
  // discrepancy between a claim and a measurement, not a property that could
  // not be taken, and the two mean different things to a reviewer.
  const declaredMediaKindMismatch = detectedMediaKind !== options.mediaKind;

  let analysis: ClipAnalysis | null = null;
  if (detectedMediaKind === 'VIDEO' && !options.skipDeepAnalysis) {
    try {
      analysis = await analyseClip(options.runner, options.filePath, {
        ffmpegPath: binaries.ffmpeg,
        ffprobePath: binaries.ffprobe,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      notMeasured.push(...analysis.unavailable);
    } catch (error) {
      notMeasured.push(
        `CLIP_ANALYSIS_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (detectedMediaKind === 'VIDEO') {
    notMeasured.push(
      'DEEP_ANALYSIS_SKIPPED: black, freeze and scene detection were not run for this inspection, so their absence is unmeasured rather than clean',
    );
  }

  let loudness: number | null = null;
  let clipped: number | null = null;
  if (audioStream) {
    try {
      const audio = await measureRenderedAudio(options.runner, options.filePath, {
        ffmpegPath: binaries.ffmpeg,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      loudness = audio.integratedLufs;
      clipped = audio.clippedSampleCount;
      notMeasured.push(...audio.unavailable);
    } catch (error) {
      notMeasured.push(
        `AUDIO_MEASUREMENT_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const blackSeconds = analysis ? totalSeconds(analysis.blackRegions) : null;
  const freezeSeconds = analysis ? totalSeconds(analysis.freezeRegions) : null;
  const effectiveDuration = analysis?.durationSeconds ?? durationSeconds ?? 0;
  const ratio = (seconds: number | null): number | null =>
    seconds === null || effectiveDuration <= 0
      ? null
      : Math.min(1, Number((seconds / effectiveDuration).toFixed(4)));

  const cropWidth = verticalCropWidth(widthPx, heightPx);

  return {
    fileSizeBytes: stats.size,
    detectedMediaKind,
    declaredMediaKindMismatch,
    container: raw.format?.format_name ?? 'unknown',
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    widthPx,
    heightPx,
    durationSeconds,
    frameRate: videoStream
      ? parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate) || null
      : null,
    pixelFormat: videoStream?.pix_fmt ?? null,
    bitrateBitsPerSecond: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
    blackRatio: ratio(blackSeconds),
    freezeRatio: ratio(freezeSeconds),
    sceneCount: analysis ? analysis.sceneBoundaries.length : null,
    sceneChangesPerMinute:
      analysis && effectiveDuration > 0
        ? Number((((analysis.sceneBoundaries.length - 1) * 60) / effectiveDuration).toFixed(2))
        : null,
    longestUsableRunSeconds: analysis ? longestUsableRun(analysis) : null,
    hasAudioStream: Boolean(audioStream),
    audioLoudnessLufs: loudness,
    audioClippedSamples: clipped,
    verticalCropFeasible: cropWidth >= PREMIUM_SOURCE_FLOOR.minimumVerticalCropWidthPx,
    verticalCropWidthPx: cropWidth,
    checksumSha256: await sha256OfFile(options.filePath),
    notMeasured,
  };
}

/* ------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* ------------------------------------------------------------------------- */

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Resolution, frame rate, codec support and compression headroom.
 *
 * Bitrate is scored *per megapixel per second* rather than absolutely, because
 * 8 Mbps is generous for 1080p and starved for 4K. It is a proxy for
 * compression damage, not a measurement of it — a low figure means detail was
 * probably thrown away, and a person still has to look.
 */
export function scoreTechnicalQuality(
  measurements: MediaQualityMeasurements,
  mediaKind: MediaKind,
): number {
  const longEdge = Math.max(measurements.widthPx, measurements.heightPx);
  const shortEdge = Math.min(measurements.widthPx, measurements.heightPx);

  let score = 0;
  if (longEdge >= 3840 && shortEdge >= 2160) score += 45;
  else if (longEdge >= 2560 && shortEdge >= 1440) score += 38;
  else if (longEdge >= 1920 && shortEdge >= 1080) score += 30;
  else if (longEdge >= 1280 && shortEdge >= 720) score += 12;
  else score += 0;

  if (mediaKind === 'IMAGE') {
    // Stills have no frame rate and no bitrate worth scoring; the remaining
    // weight goes to pixel count, which is all a still has to offer.
    const megapixels = (measurements.widthPx * measurements.heightPx) / 1_000_000;
    score += Math.min(40, megapixels * 4);
    score +=
      measurements.videoCodec && SUPPORTED_SOURCE_IMAGE_CODECS.includes(measurements.videoCodec)
        ? 15
        : 0;
    return clamp(score);
  }

  const frameRate = measurements.frameRate ?? 0;
  if (frameRate >= 50) score += 20;
  else if (frameRate >= 29.97) score += 16;
  else if (frameRate >= 24) score += 12;
  else score += 0;

  const codec = measurements.videoCodec ?? '';
  score += SUPPORTED_SOURCE_VIDEO_CODECS.includes(codec) ? 15 : 0;

  const megapixels = (measurements.widthPx * measurements.heightPx) / 1_000_000;
  const bitrate = measurements.bitrateBitsPerSecond;
  if (bitrate === null || megapixels <= 0) {
    // Unmeasured, so unscored. Half credit would be a guess dressed as a
    // measurement.
    score += 0;
  } else {
    const mbpsPerMegapixel = bitrate / 1_000_000 / megapixels;
    if (mbpsPerMegapixel >= 4) score += 20;
    else if (mbpsPerMegapixel >= 2) score += 15;
    else if (mbpsPerMegapixel >= 1) score += 9;
    else score += 3;
  }

  return clamp(score);
}

/**
 * How much an editor can actually do with it.
 *
 * Rewards a long clean run, some shot variety and the absence of black and
 * freeze. A still image scores a fixed mid value: it is perfectly usable and
 * has no edit properties to measure, and either extreme would distort ranking.
 */
export function scoreEditUtility(
  measurements: MediaQualityMeasurements,
  mediaKind: MediaKind,
): number {
  if (mediaKind !== 'VIDEO') return 50;

  const usable = measurements.longestUsableRunSeconds;
  if (usable === null) return 25; // unmeasured, and said so

  let score = 0;
  if (usable >= 6) score += 45;
  else if (usable >= 4) score += 38;
  else if (usable >= 2) score += 28;
  else if (usable >= 1) score += 12;

  const changes = measurements.sceneChangesPerMinute ?? 0;
  // Some variety is useful; a clip cutting more than about every two seconds is
  // somebody else's edit, not source footage.
  if (changes >= 4 && changes <= 30) score += 20;
  else if (changes > 30) score += 5;
  else score += 12;

  const black = measurements.blackRatio ?? 1;
  const freeze = measurements.freezeRatio ?? 1;
  score += black <= 0.02 ? 20 : black <= 0.1 ? 12 : black <= 0.25 ? 5 : 0;
  score += freeze <= 0.02 ? 15 : freeze <= 0.1 ? 9 : freeze <= 0.25 ? 4 : 0;

  return clamp(score);
}

/** How much survives a 9:16 crop, which is the only aspect this system ships. */
export function scoreVerticalSuitability(measurements: MediaQualityMeasurements): number {
  const cropWidth = measurements.verticalCropWidthPx;
  let score = 0;
  if (cropWidth >= 2160) score += 60;
  else if (cropWidth >= 1440) score += 52;
  else if (cropWidth >= 1080) score += 42;
  else if (cropWidth >= 810) score += 18;

  const longEdge = Math.max(measurements.widthPx, measurements.heightPx);
  const shortEdge = Math.min(measurements.widthPx, measurements.heightPx);
  const aspect = shortEdge > 0 ? longEdge / shortEdge : 0;
  // A native vertical or squarish source needs no crop at all and loses
  // nothing; an ultra-wide source loses most of the frame.
  if (measurements.heightPx > measurements.widthPx) score += 40;
  else if (aspect <= 1.4) score += 32;
  else if (aspect <= 1.8) score += 24;
  else if (aspect <= 2.0) score += 16;
  else score += 4;

  return clamp(score);
}

/**
 * How settled the licence position is. Not a legal opinion, and labelled as
 * such wherever it is displayed.
 */
export function scoreRightsConfidence(decision: MediaRightsDecision | undefined): number {
  if (!decision) return 0;
  switch (decision.outcome) {
    case 'AUTOMATICALLY_ELIGIBLE':
      return 90;
    case 'REVIEW_REQUIRED':
      // One open question is a different situation from six. The floor stays
      // above zero because review is a normal outcome, not a failure.
      return clamp(70 - decision.reasons.length * 8);
    case 'REJECTED':
      return 0;
    default:
      return 0;
  }
}

/**
 * The composite, for ranking only.
 *
 * Rights carries the largest single weight deliberately: a beautiful clip we
 * cannot publish is worth less than a merely good one we can, and a ranking
 * that put it first would be a ranking that wasted a reviewer's time.
 */
export function combineScores(
  parts: Omit<MediaQualityScores, 'overallSourceScore'>,
): MediaQualityScores {
  const overall =
    parts.technicalQualityScore * 0.3 +
    parts.editUtilityScore * 0.22 +
    parts.verticalSuitabilityScore * 0.18 +
    parts.rightsConfidenceScore * 0.3;
  return { ...parts, overallSourceScore: clamp(overall) };
}

/* ------------------------------------------------------------------------- */
/* The decision                                                               */
/* ------------------------------------------------------------------------- */

export interface EvaluateSourceQualityInput {
  readonly measurements: MediaQualityMeasurements;
  /**
   * What the caller believed it was. Used only to *report* a disagreement —
   * `measurements.detectedMediaKind` is what the profile is applied against,
   * because a catalogue row is a claim and a probe is a measurement.
   */
  readonly mediaKind: MediaKind;
  readonly rightsDecision?: MediaRightsDecision;
  /**
   * An operator's written justification for a clip below the length or
   * resolution floor — a two-second reaction shot, a logo plate for an overlay.
   * Absent, the floor applies.
   */
  readonly justification?: {
    readonly shortClipAccepted?: boolean;
    readonly smallOverlayUseAccepted?: boolean;
    readonly reason: string;
  };
}

/**
 * Turns measurements into a pass, a review or a refusal.
 *
 * Three outcomes rather than two, because the interesting cases are neither.
 * A clip can be technically immaculate and still need a person to confirm there
 * is no watermark in the corner — no measurement establishes that, and a
 * profile that quietly passed it would be claiming something it never checked.
 */
export function evaluateSourceQuality(input: EvaluateSourceQualityInput): MediaQualityDecision {
  const { measurements } = input;
  // The measured kind governs. A file declared `video` that measures as a still
  // is a still, and refusing it for "the codec mjpeg is not one the renderer
  // accepts" would be a confident, wrong answer dressed as a measurement.
  const mediaKind = measurements.detectedMediaKind ?? input.mediaKind;
  const failures: string[] = [];
  const reviews: string[] = [];
  const humanChecks: string[] = [];

  if (measurements.declaredMediaKindMismatch) {
    reviews.push(
      `the catalogue declares ${input.mediaKind} and the file measures as ${mediaKind}; the measured kind is what this profile was applied against, and the catalogue row should be corrected`,
    );
  }

  const longEdge = Math.max(measurements.widthPx, measurements.heightPx);
  const shortEdge = Math.min(measurements.widthPx, measurements.heightPx);

  if (measurements.fileSizeBytes === 0) failures.push('the file is zero bytes');

  if (
    longEdge < PREMIUM_SOURCE_FLOOR.minimumLongEdgePx ||
    shortEdge < PREMIUM_SOURCE_FLOOR.minimumShortEdgePx
  ) {
    const message = `${measurements.widthPx}×${measurements.heightPx} is below the ${PREMIUM_SOURCE_FLOOR.minimumLongEdgePx}×${PREMIUM_SOURCE_FLOOR.minimumShortEdgePx} source floor`;
    if (input.justification?.smallOverlayUseAccepted) {
      // Explicitly accepted for a small overlay — recorded, never inferred, and
      // still not a pass.
      reviews.push(
        `${message}; accepted for small-overlay use only: ${input.justification.reason}`,
      );
    } else {
      failures.push(
        `${message}. Upscaling does not satisfy it: an upscale invents pixels rather than recovering them, so a 1280×720 source scaled to 1920×1080 is still a 720-line source.`,
      );
    }
  }
  if (
    longEdge < PREMIUM_SOURCE_FLOOR.preferredLongEdgePx &&
    longEdge >= PREMIUM_SOURCE_FLOOR.minimumLongEdgePx
  ) {
    reviews.push(
      `${longEdge}px long edge clears the floor but is below the preferred ${PREMIUM_SOURCE_FLOOR.preferredLongEdgePx}px`,
    );
  }

  if (mediaKind === 'VIDEO') {
    const frameRate = measurements.frameRate;
    if (frameRate === null) {
      reviews.push('the frame rate could not be measured');
    } else if (frameRate < PREMIUM_SOURCE_FLOOR.minimumFrameRate) {
      failures.push(
        `${frameRate.toFixed(2)} fps is below the ${PREMIUM_SOURCE_FLOOR.minimumFrameRate} fps floor`,
      );
    }

    const codec = measurements.videoCodec;
    if (!codec) failures.push('no video codec could be identified');
    else if (!SUPPORTED_SOURCE_VIDEO_CODECS.includes(codec)) {
      failures.push(
        `the video codec "${codec}" is not one the renderer accepts, so it would fail at composition rather than here`,
      );
    }

    const usable = measurements.longestUsableRunSeconds;
    if (usable === null) {
      reviews.push('the longest usable run could not be measured, so clip length is unverified');
    } else if (usable < PREMIUM_SOURCE_FLOOR.minimumUsableSeconds) {
      if (input.justification?.shortClipAccepted) {
        reviews.push(
          `the longest usable run is ${usable.toFixed(2)}s, below the ${PREMIUM_SOURCE_FLOOR.minimumUsableSeconds}s floor; explicitly justified: ${input.justification.reason}`,
        );
      } else {
        failures.push(
          `the longest usable run is ${usable.toFixed(2)}s, below the ${PREMIUM_SOURCE_FLOOR.minimumUsableSeconds}s floor. A shorter clip needs an explicit written justification.`,
        );
      }
    }

    const black = measurements.blackRatio;
    const freeze = measurements.freezeRatio;
    if (black === null || freeze === null) {
      reviews.push(
        'black and freeze content could not be measured, so their absence is unverified',
      );
    } else {
      if (black > PREMIUM_SOURCE_FLOOR.maximumBlackRatio) {
        failures.push(
          `${(black * 100).toFixed(1)}% of the clip is black, over the ${(PREMIUM_SOURCE_FLOOR.maximumBlackRatio * 100).toFixed(0)}% ceiling`,
        );
      }
      if (freeze > PREMIUM_SOURCE_FLOOR.maximumFreezeRatio) {
        failures.push(
          `${(freeze * 100).toFixed(1)}% of the clip is frozen, over the ${(PREMIUM_SOURCE_FLOOR.maximumFreezeRatio * 100).toFixed(0)}% ceiling`,
        );
      }
    }
  }

  if (mediaKind === 'AUDIO' || measurements.hasAudioStream) {
    const codec = measurements.audioCodec;
    if (codec && !SUPPORTED_SOURCE_AUDIO_CODECS.includes(codec)) {
      failures.push(`the audio codec "${codec}" is not one the renderer accepts`);
    }
    if (measurements.audioClippedSamples !== null && measurements.audioClippedSamples > 0) {
      reviews.push(
        `${measurements.audioClippedSamples} clipped samples were measured in the source audio`,
      );
    }
  }

  if (!measurements.verticalCropFeasible) {
    reviews.push(
      `a 9:16 crop of this frame is ${measurements.verticalCropWidthPx}px wide, below the ${PREMIUM_SOURCE_FLOOR.minimumVerticalCropWidthPx}px vertical floor — it would have to be scaled up to fill the frame`,
    );
  }

  for (const entry of measurements.notMeasured) {
    reviews.push(`unmeasured: ${entry}`);
  }

  // The things no measurement establishes. Named on every item rather than
  // only on suspicious ones, because a check that appears selectively reads as
  // an accusation instead of a checklist.
  humanChecks.push(
    'Confirm there is no watermark, station bug or provider overlay anywhere in frame.',
    'Confirm there is no burned-in third-party caption, subtitle or lower third.',
    'Confirm no third-party logo, brand mark or sponsor board is prominent.',
    'Confirm the shot reads as premium: subject separation, lighting, composition, motion. No machine measurement of this exists and none is reported.',
  );

  const scores = combineScores({
    technicalQualityScore: scoreTechnicalQuality(measurements, mediaKind),
    editUtilityScore: scoreEditUtility(measurements, mediaKind),
    verticalSuitabilityScore: scoreVerticalSuitability(measurements),
    rightsConfidenceScore: scoreRightsConfidence(input.rightsDecision),
  });

  if (failures.length > 0) {
    return {
      outcome: 'BELOW_PROFILE',
      profileVersion: SOURCE_QUALITY_PROFILE_VERSION,
      scores,
      reasons: failures,
      humanChecksRequired: humanChecks,
    };
  }
  if (reviews.length > 0) {
    return {
      outcome: 'REVIEW_REQUIRED',
      profileVersion: SOURCE_QUALITY_PROFILE_VERSION,
      scores,
      reasons: reviews,
      humanChecksRequired: humanChecks,
    };
  }
  return {
    outcome: 'MEETS_PROFILE',
    profileVersion: SOURCE_QUALITY_PROFILE_VERSION,
    scores,
    reasons: [
      `measured ${measurements.widthPx}×${measurements.heightPx} at ${(measurements.frameRate ?? 0).toFixed(2)} fps, ${measurements.videoCodec ?? measurements.audioCodec ?? 'unknown codec'}, with every binding property taken from the file. This is a technical verdict only — creative quality is not measured.`,
    ],
    humanChecksRequired: humanChecks,
  };
}

/**
 * Ranks candidates for a reviewer's attention.
 *
 * Deterministic and total: highest overall first, ties broken on the four
 * component scores in a fixed order, and finally on candidate id. Nothing reads
 * a clock, so the same library always produces the same gallery order.
 */
export function rankBySourceQuality<
  T extends { readonly candidateId: string; readonly qualityDecision?: MediaQualityDecision },
>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    const left = a.qualityDecision?.scores;
    const right = b.qualityDecision?.scores;
    const keys: (keyof MediaQualityScores)[] = [
      'overallSourceScore',
      'rightsConfidenceScore',
      'technicalQualityScore',
      'editUtilityScore',
      'verticalSuitabilityScore',
    ];
    for (const key of keys) {
      const delta = (right?.[key] ?? -1) - (left?.[key] ?? -1);
      if (delta !== 0) return delta;
    }
    return a.candidateId.localeCompare(b.candidateId);
  });
}
