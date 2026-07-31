import { open, stat } from 'node:fs/promises';

import { DEFAULT_FFMPEG_BINARIES, DEFAULT_PROBE_TIMEOUT_MS } from '../binaries';
import type { CommandRunner } from '../command-runner';
import { parseFrameRate, probeRaw, type FfprobeOutput } from '../ffprobe';
import { ctaAnimationSeconds } from '../render/filter-graph';
import { OUTPUT_ELIGIBLE_USAGE_CLASSES, type RenderManifest } from '../render/manifest';
import { sha256File } from '../render/source-resolution';
import { measureRenderedAudio, type AudioMeasurement } from './audio-measurement';
import {
  hexToRgb,
  maxChannelDistance,
  measureRegion,
  measureTextContrastScore,
  sampleFrame,
  scaleRegion,
  wholeFrame,
  type Region,
  type SampleFrameOptions,
  type SampledFrame,
} from './frame-sampling';

/**
 * Actual-media QA — docs/aamp-architecture.md §9.3.
 *
 * Every check here is measured from the produced file, by ffprobe or by
 * arithmetic over extracted frames. Nothing is satisfied by what the manifest
 * asked for: a renderer that silently produced 1080×1080, or dropped the
 * audio stream, or drew no CTA, must fail here rather than be believed. A
 * report with any failed binding check is what stops a render becoming
 * READY or downloadable.
 */

export const QA_VERDICTS = ['PASS', 'FAIL'] as const;
export type QaVerdict = (typeof QA_VERDICTS)[number];

export const QA_INSTRUMENTS = [
  'ffprobe',
  'filesystem',
  'frame-pixels',
  'checksum',
  /** `ebur128`, `astats` and `silencedetect` over a decode of the master. */
  'audio-decode',
  /** Comparison against the storyboard the run committed to before rendering. */
  'storyboard',
  /**
   * A property of the manifest and its provenance rather than of the pixels —
   * rights eligibility and source accounting. Kept as its own instrument so it
   * can never be mistaken for something measured from the file: the rule that
   * a manifest value is not a measurement is about *picture and sound*, and a
   * licence is neither.
   */
  'manifest',
] as const;
export type QaInstrument = (typeof QA_INSTRUMENTS)[number];

export interface QaMeasurement {
  /** Stable identifier, so a failing check routes deterministically. */
  readonly check: string;
  readonly verdict: QaVerdict;
  /** What the instrument returned, rendered for the report. */
  readonly measured: string | number | boolean | null;
  readonly expected: string;
  /** How the value was obtained — never "the manifest said so". */
  readonly instrument: QaInstrument;
  readonly detail?: string;
  /**
   * Set when the instrument could not take the measurement at all.
   *
   * A `NOT_MEASURED` check is never a pass and never a silent omission: it is
   * reported with the exact reason and, because it is not a `PASS`, it fails
   * the report. An unmeasurable binding property is not a satisfied one.
   */
  readonly notMeasuredReason?: string;
}

/**
 * What the storyboard promised, so the render can be checked against it.
 *
 * Supplied by the caller rather than read from disk here: `@combat/media` has
 * no opinion about where a run keeps its artefacts, and QA that went looking
 * for files would stop being a pure function of the file it is measuring.
 */
export interface StoryboardExpectation {
  readonly beatCount: number;
  readonly totalDurationSeconds: number;
  /** Every source checksum the storyboard said would contribute bytes. */
  readonly sourceChecksums: readonly string[];
  /** Every rights classification the storyboard recorded. */
  readonly rightsClassifications: readonly string[];
}

export interface ActualMediaQaReport {
  readonly reportVersion: 2;
  readonly outputPath: string;
  readonly verdict: QaVerdict;
  readonly measuredAt: string;
  readonly measurements: readonly QaMeasurement[];
  readonly summary: {
    readonly sizeBytes: number;
    readonly checksumSha256: string;
    readonly containerFormats: readonly string[];
    readonly videoCodec: string | null;
    readonly audioCodec: string | null;
    readonly widthPx: number | null;
    readonly heightPx: number | null;
    readonly frameRate: number | null;
    readonly durationSeconds: number | null;
    readonly pixelFormat: string | null;
    readonly displayAspectRatio: string | null;
    readonly faststart: boolean | null;
    readonly audio: AudioMeasurement | null;
  };
}

export interface RunActualMediaQaOptions {
  readonly outputPath: string;
  readonly manifest: RenderManifest;
  readonly workDir: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Stamped into the report; supplied by the caller so QA stays deterministic. */
  readonly measuredAt: Date;
  /** When present, the render is also checked against what the storyboard promised. */
  readonly storyboard?: StoryboardExpectation;
  /**
   * Checksums of every source the run intended to use, so a render that
   * silently drew on something else fails here. Supplied by the composition
   * root, which is the only place that knows what was resolved.
   */
  readonly expectedSourceChecksums?: readonly string[];
}

/** yuv420p is the only pixel format that plays everywhere; the rest are a compatibility risk. */
const BROADLY_COMPATIBLE_PIXEL_FORMATS = ['yuv420p', 'yuvj420p'];
/** A frame whose luma barely varies is a blank frame, whatever its brightness. */
const BLANK_FRAME_STDDEV_THRESHOLD = 2.5;
/**
 * Share of the caption safe area that must read as outlined type. Calibrated
 * against the fixture render: a full caption line scores an order of
 * magnitude above this, while footage with bright areas but no type scores
 * well below it.
 */
const CAPTION_TEXT_SCORE_THRESHOLD = 0.004;
/** How much higher the cue-time score must be than the between-cues baseline. */
const CAPTION_TIMING_SCORE_MARGIN = 0.002;
/** How far the CTA card's measured background may sit from the requested colour. */
const CTA_BACKGROUND_TOLERANCE = 30;
/**
 * How many frames are sampled across the body of the cut for black and freeze
 * detection. Nine is enough that a black or held second in a 15-second cut
 * cannot fall between two samples, and cheap enough to run on every render.
 */
const WALK_SAMPLE_COUNT = 9;
/**
 * Mean per-channel difference below which two consecutive samples are the same
 * picture. Not zero: h264 is lossy, so even a genuinely held frame differs by
 * a fraction of a level between two decodes.
 */
const FROZEN_FRAME_DELTA_THRESHOLD = 0.75;
/** Broadcast-style tolerance on integrated loudness. */
const LOUDNESS_TOLERANCE_LU = 2;
/** `loudnorm`'s single-pass mode lands near, not exactly on, the requested ceiling. */
const PEAK_TOLERANCE_DB = 1.5;

export async function runActualMediaQa(
  runner: CommandRunner,
  options: RunActualMediaQaOptions,
): Promise<ActualMediaQaReport> {
  const { manifest, outputPath } = options;
  const measurements: QaMeasurement[] = [];
  const record = (measurement: QaMeasurement): void => {
    measurements.push(measurement);
  };

  // ---- file existence and size -------------------------------------------
  let sizeBytes = 0;
  let fileExists = false;
  try {
    const stats = await stat(outputPath);
    fileExists = stats.isFile();
    sizeBytes = stats.size;
  } catch {
    fileExists = false;
  }

  record({
    check: 'output.exists',
    verdict: fileExists ? 'PASS' : 'FAIL',
    measured: fileExists,
    expected: 'a regular file exists at the output path',
    instrument: 'filesystem',
  });
  record({
    check: 'output.nonZeroSize',
    verdict: sizeBytes > 0 ? 'PASS' : 'FAIL',
    measured: sizeBytes,
    expected: 'greater than 0 bytes',
    instrument: 'filesystem',
  });

  if (!fileExists || sizeBytes === 0) {
    return finalise(options, measurements, {
      sizeBytes,
      checksumSha256: '',
      containerFormats: [],
      videoCodec: null,
      audioCodec: null,
      widthPx: null,
      heightPx: null,
      frameRate: null,
      durationSeconds: null,
      pixelFormat: null,
      displayAspectRatio: null,
      faststart: null,
      audio: null,
    });
  }

  const checksumSha256 = await sha256File(outputPath);
  record({
    check: 'output.checksumRecorded',
    verdict: /^[0-9a-f]{64}$/.test(checksumSha256) ? 'PASS' : 'FAIL',
    measured: checksumSha256,
    expected: 'a sha256 digest of the produced file',
    instrument: 'checksum',
  });

  // ---- container and stream facts ----------------------------------------
  let probe: FfprobeOutput;
  try {
    probe = await probeRaw(runner, outputPath, {
      ffprobePath: options.ffprobePath,
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    record({
      check: 'output.decodable',
      verdict: 'FAIL',
      measured: null,
      expected: 'ffprobe reads the file',
      instrument: 'ffprobe',
      detail: error instanceof Error ? error.message : String(error),
    });
    return finalise(options, measurements, {
      sizeBytes,
      checksumSha256,
      containerFormats: [],
      videoCodec: null,
      audioCodec: null,
      widthPx: null,
      heightPx: null,
      frameRate: null,
      durationSeconds: null,
      pixelFormat: null,
      displayAspectRatio: null,
      faststart: null,
      audio: null,
    });
  }

  record({
    check: 'output.decodable',
    verdict: 'PASS',
    measured: true,
    expected: 'ffprobe reads the file',
    instrument: 'ffprobe',
  });

  const containerFormats = (probe.format?.format_name ?? '').split(',').filter(Boolean);
  const videoStream = probe.streams?.find((s) => s.codec_type === 'video');
  const audioStream = probe.streams?.find((s) => s.codec_type === 'audio');
  const durationSeconds = Number(probe.format?.duration ?? Number.NaN);
  const frameRate = parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate);

  record({
    check: 'container.isMp4',
    verdict: containerFormats.includes('mp4') ? 'PASS' : 'FAIL',
    measured: containerFormats.join(','),
    expected: 'format_name includes "mp4"',
    instrument: 'ffprobe',
  });
  record({
    check: 'video.codecIsH264',
    verdict: videoStream?.codec_name === 'h264' ? 'PASS' : 'FAIL',
    measured: videoStream?.codec_name ?? null,
    expected: 'h264',
    instrument: 'ffprobe',
  });
  record({
    check: 'video.widthPx',
    verdict: videoStream?.width === manifest.output.widthPx ? 'PASS' : 'FAIL',
    measured: videoStream?.width ?? null,
    expected: String(manifest.output.widthPx),
    instrument: 'ffprobe',
  });
  record({
    check: 'video.heightPx',
    verdict: videoStream?.height === manifest.output.heightPx ? 'PASS' : 'FAIL',
    measured: videoStream?.height ?? null,
    expected: String(manifest.output.heightPx),
    instrument: 'ffprobe',
  });

  // ffprobe omits display_aspect_ratio when the SAR is 1:1, so derive it from
  // the coded dimensions rather than requiring the tag to be present.
  const displayAspectRatio =
    videoStream?.display_aspect_ratio ??
    (videoStream?.width && videoStream.height
      ? reduceRatio(videoStream.width, videoStream.height)
      : null);
  record({
    check: 'video.displayAspectRatio',
    verdict: displayAspectRatio === '9:16' ? 'PASS' : 'FAIL',
    measured: displayAspectRatio,
    expected: '9:16',
    instrument: 'ffprobe',
  });

  const frameRateTolerance = 0.01;
  record({
    check: 'video.frameRate',
    verdict:
      Math.abs(frameRate - manifest.output.frameRate) <= frameRateTolerance ? 'PASS' : 'FAIL',
    measured: Number(frameRate.toFixed(4)),
    expected: `${manifest.output.frameRate} ± ${frameRateTolerance} fps`,
    instrument: 'ffprobe',
  });

  const durationToleranceSeconds =
    manifest.output.durationToleranceFrames / manifest.output.frameRate;
  const durationDelta = Number.isFinite(durationSeconds)
    ? Math.abs(durationSeconds - manifest.output.durationSeconds)
    : Number.POSITIVE_INFINITY;
  record({
    check: 'video.duration',
    verdict: durationDelta <= durationToleranceSeconds ? 'PASS' : 'FAIL',
    measured: Number.isFinite(durationSeconds) ? Number(durationSeconds.toFixed(4)) : null,
    expected: `${manifest.output.durationSeconds}s ± ${manifest.output.durationToleranceFrames} frame(s) (${durationToleranceSeconds.toFixed(4)}s)`,
    instrument: 'ffprobe',
  });

  const pixelFormat = videoStream?.pix_fmt ?? null;
  record({
    check: 'video.pixelFormatCompatible',
    verdict:
      pixelFormat !== null && BROADLY_COMPATIBLE_PIXEL_FORMATS.includes(pixelFormat)
        ? 'PASS'
        : 'FAIL',
    measured: pixelFormat,
    expected: BROADLY_COMPATIBLE_PIXEL_FORMATS.join(' or '),
    instrument: 'ffprobe',
  });

  const audioRequested = manifest.output.audioCodec !== null;
  record({
    check: 'audio.streamPresence',
    verdict: audioRequested === Boolean(audioStream) ? 'PASS' : 'FAIL',
    measured: Boolean(audioStream),
    expected: audioRequested ? 'an audio stream is present' : 'no audio stream',
    instrument: 'ffprobe',
  });
  if (audioRequested) {
    record({
      check: 'audio.codecIsAac',
      verdict: audioStream?.codec_name === 'aac' ? 'PASS' : 'FAIL',
      measured: audioStream?.codec_name ?? null,
      expected: 'aac',
      instrument: 'ffprobe',
    });
  }

  // ---- pixel measurements -------------------------------------------------
  const effectiveDuration = Number.isFinite(durationSeconds)
    ? durationSeconds
    : manifest.output.durationSeconds;
  const sampleOptions = {
    ffmpegPath: options.ffmpegPath ?? DEFAULT_FFMPEG_BINARIES.ffmpeg,
    workDir: options.workDir,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  };

  const sampleAt = async (timeSeconds: number): Promise<SampledFrame | null> => {
    try {
      return await sampleFrame(runner, outputPath, timeSeconds, sampleOptions);
    } catch {
      return null;
    }
  };

  const firstFrame = await sampleAt(0);
  record(blankFrameMeasurement('frame.firstNotBlank', firstFrame, 'the opening frame'));

  // A frame or two back from the very end: the final displayed frame, without
  // racing the last packet boundary.
  const lastFrame = await sampleAt(Math.max(0, effectiveDuration - 2 / manifest.output.frameRate));
  record(blankFrameMeasurement('frame.finalNotBlank', lastFrame, 'the closing frame'));

  if (manifest.cta) {
    const cta = manifest.cta;
    const ctaSampleTime = Math.min(
      effectiveDuration - 1 / manifest.output.frameRate,
      cta.startSeconds + (cta.endSeconds - cta.startSeconds) / 2,
    );
    const ctaFrame = await sampleAt(ctaSampleTime);
    if (!ctaFrame) {
      record({
        check: 'cta.presentInFinalInterval',
        verdict: 'FAIL',
        measured: null,
        expected: `the CTA card fills the frame at ${ctaSampleTime.toFixed(2)}s`,
        instrument: 'frame-pixels',
        detail: 'no frame could be sampled inside the CTA window',
      });
    } else {
      // Sample the top band, which the end card owns outright — the middle
      // carries the CTA typography and logo and would skew the colour.
      const band = scaleRegion(
        { x: 0, y: 0, width: manifest.output.widthPx, height: 200 },
        manifest.output.widthPx,
        manifest.output.heightPx,
        ctaFrame.widthPx,
        ctaFrame.heightPx,
      );
      const stats = measureRegion(ctaFrame, band);
      const distance = maxChannelDistance(stats, hexToRgb(cta.backgroundHex));
      record({
        check: 'cta.presentInFinalInterval',
        verdict: distance <= CTA_BACKGROUND_TOLERANCE ? 'PASS' : 'FAIL',
        measured: Number(distance.toFixed(2)),
        expected: `measured background within ${CTA_BACKGROUND_TOLERANCE}/255 of ${cta.backgroundHex} at ${ctaSampleTime.toFixed(2)}s`,
        instrument: 'frame-pixels',
        detail: `rgb(${stats.meanR.toFixed(1)}, ${stats.meanG.toFixed(1)}, ${stats.meanB.toFixed(1)})`,
      });

      const headline = scaleRegion(
        {
          x: 0,
          y: Math.round(manifest.output.heightPx * 0.46),
          width: manifest.output.widthPx,
          height: Math.round(manifest.output.heightPx * 0.24),
        },
        manifest.output.widthPx,
        manifest.output.heightPx,
        ctaFrame.widthPx,
        ctaFrame.heightPx,
      );
      const headlineStats = measureRegion(ctaFrame, headline);
      record({
        check: 'cta.copyRendered',
        verdict: headlineStats.stdDevLuma > BLANK_FRAME_STDDEV_THRESHOLD ? 'PASS' : 'FAIL',
        measured: Number(headlineStats.stdDevLuma.toFixed(2)),
        expected: `luma variation above ${BLANK_FRAME_STDDEV_THRESHOLD} in the CTA copy band`,
        instrument: 'frame-pixels',
      });
    }
  }

  if (manifest.captions) {
    const captions = manifest.captions;
    const cue = captions.cues[0];
    if (!cue) {
      record({
        check: 'captions.present',
        verdict: 'FAIL',
        measured: 0,
        expected: 'at least one caption cue',
        instrument: 'frame-pixels',
      });
    } else {
      const bandTop = Math.max(0, manifest.output.heightPx - captions.style.marginBottomPx - 300);
      const band: Region = {
        x: 0,
        y: bandTop,
        width: manifest.output.widthPx,
        height: Math.min(340, manifest.output.heightPx - bandTop),
      };
      // Native resolution, cropped to the caption safe area: the outline that
      // distinguishes type from bright footage is only a few pixels wide.
      const bandOptions = { ...sampleOptions, crop: band };
      const cueTime = cue.startSeconds + (cue.endSeconds - cue.startSeconds) / 2;

      const cueBand = await sampleBand(runner, outputPath, cueTime, bandOptions);
      if (!cueBand) {
        record({
          check: 'captions.present',
          verdict: 'FAIL',
          measured: null,
          expected: `burned-in caption pixels at ${cueTime.toFixed(2)}s`,
          instrument: 'frame-pixels',
          detail: 'no frame could be sampled inside the first cue',
        });
      } else {
        const cueScore = measureTextContrastScore(cueBand, wholeFrame(cueBand));
        record({
          check: 'captions.present',
          verdict: cueScore >= CAPTION_TEXT_SCORE_THRESHOLD ? 'PASS' : 'FAIL',
          measured: Number(cueScore.toFixed(6)),
          expected: `outlined-type score of at least ${CAPTION_TEXT_SCORE_THRESHOLD} in the caption safe area at ${cueTime.toFixed(2)}s`,
          instrument: 'frame-pixels',
        });

        // Timing is only measurable against a moment with no cue scheduled.
        // Without such a gap there is nothing to compare against, and the
        // check is recorded as not applicable rather than guessed at.
        const gap = findCaptionGap(captions.cues, effectiveDuration, manifest.cta?.startSeconds);
        if (gap !== null) {
          const gapBand = await sampleBand(runner, outputPath, gap, bandOptions);
          if (gapBand) {
            const gapScore = measureTextContrastScore(gapBand, wholeFrame(gapBand));
            record({
              check: 'captions.timing',
              verdict: cueScore >= gapScore + CAPTION_TIMING_SCORE_MARGIN ? 'PASS' : 'FAIL',
              measured: Number((cueScore - gapScore).toFixed(6)),
              expected: `outlined-type score at least ${CAPTION_TIMING_SCORE_MARGIN} higher during a cue (${cueTime.toFixed(2)}s) than between cues (${gap.toFixed(2)}s)`,
              instrument: 'frame-pixels',
              detail: `cue ${cueScore.toFixed(6)} vs gap ${gapScore.toFixed(6)}`,
            });
          }
        }
      }
    }
  }

  // ---- black and frozen frames across the whole cut -----------------------
  // The opening and closing frames were checked individually above; this walks
  // the body. A cut whose middle third is black still opens and closes on
  // picture, and would otherwise pass.
  //
  // Deliberately static or black moments are excluded rather than reported: a
  // `DIP_TO_BLACK` is *meant* to be black at its midpoint, and an end card is
  // *meant* to hold. Flagging either would make the check something an
  // operator learns to ignore, which is worse than not having it.
  const intentionallyStill = intentionallyStillWindows(manifest);
  const walk = await sampleAcross(
    sampleAt,
    effectiveDuration,
    WALK_SAMPLE_COUNT,
    intentionallyStill,
  );
  const walkable = walk.filter((entry): entry is { time: number; frame: SampledFrame } =>
    Boolean(entry.frame),
  );

  if (walkable.length < 2) {
    record({
      check: 'frame.noBlackFrames',
      verdict: 'FAIL',
      measured: walkable.length,
      expected: `at least 2 of ${WALK_SAMPLE_COUNT} sampled frames could be read`,
      instrument: 'frame-pixels',
      notMeasuredReason: 'too few frames could be sampled to judge the body of the cut',
    });
    record({
      check: 'frame.noFrozenFrames',
      verdict: 'FAIL',
      measured: walkable.length,
      expected: `at least 2 of ${WALK_SAMPLE_COUNT} sampled frames could be read`,
      instrument: 'frame-pixels',
      notMeasuredReason: 'too few frames could be sampled to judge the body of the cut',
    });
  } else {
    const blankTimes = walkable
      .filter(
        (entry) =>
          measureRegion(entry.frame, wholeFrame(entry.frame)).stdDevLuma <=
          BLANK_FRAME_STDDEV_THRESHOLD,
      )
      .map((entry) => entry.time);
    record({
      check: 'frame.noBlackFrames',
      verdict: blankTimes.length === 0 ? 'PASS' : 'FAIL',
      measured: blankTimes.length,
      expected: `no flat-fill frame among ${walkable.length} samples across the cut`,
      instrument: 'frame-pixels',
      ...(blankTimes.length > 0
        ? { detail: `flat at ${blankTimes.map((t) => `${t.toFixed(2)}s`).join(', ')}` }
        : {}),
    });

    // A freeze is two *consecutive* samples that are the same picture. Frame
    // differencing rather than per-frame statistics: two different frames can
    // share a mean luma, and a held frame is the only thing that shares every
    // pixel.
    const frozenTimes: number[] = [];
    for (let i = 1; i < walkable.length; i += 1) {
      const previous = walkable[i - 1] as { time: number; frame: SampledFrame };
      const current = walkable[i] as { time: number; frame: SampledFrame };
      if (
        meanAbsoluteFrameDifference(previous.frame, current.frame) < FROZEN_FRAME_DELTA_THRESHOLD
      ) {
        frozenTimes.push(current.time);
      }
    }
    record({
      check: 'frame.noFrozenFrames',
      verdict: frozenTimes.length === 0 ? 'PASS' : 'FAIL',
      measured: frozenTimes.length,
      expected: `no pair of consecutive samples differing by less than ${FROZEN_FRAME_DELTA_THRESHOLD}/255`,
      instrument: 'frame-pixels',
      ...(frozenTimes.length > 0
        ? { detail: `unchanged at ${frozenTimes.map((t) => `${t.toFixed(2)}s`).join(', ')}` }
        : {}),
    });
  }

  // ---- CTA hold -----------------------------------------------------------
  if (manifest.cta?.holdSeconds !== undefined && manifest.cta.holdSeconds > 0) {
    const cta = manifest.cta;
    const holdSeconds = cta.holdSeconds as number;
    const holdStart = cta.endSeconds - holdSeconds;
    const settleAllowance = ctaAnimationSeconds(cta.startSeconds, cta.endSeconds, holdSeconds);
    const holdFrame = await sampleAt(Math.min(effectiveDuration - 1 / 30, holdStart + 0.01));
    if (!holdFrame) {
      record({
        check: 'cta.holdDuration',
        verdict: 'FAIL',
        measured: null,
        expected: `the card is settled for the final ${holdSeconds}s`,
        instrument: 'frame-pixels',
        notMeasuredReason: `no frame could be sampled at ${holdStart.toFixed(2)}s`,
      });
    } else {
      const band = scaleRegion(
        { x: 0, y: 0, width: manifest.output.widthPx, height: 200 },
        manifest.output.widthPx,
        manifest.output.heightPx,
        holdFrame.widthPx,
        holdFrame.heightPx,
      );
      const distance = maxChannelDistance(
        measureRegion(holdFrame, band),
        hexToRgb(cta.backgroundHex),
      );
      record({
        check: 'cta.holdDuration',
        verdict: distance <= CTA_BACKGROUND_TOLERANCE ? 'PASS' : 'FAIL',
        measured: Number(distance.toFixed(2)),
        expected: `the end card is fully settled from ${holdStart.toFixed(2)}s (animation allowance ${settleAllowance.toFixed(2)}s)`,
        instrument: 'frame-pixels',
      });
    }
  }

  // ---- safe areas ---------------------------------------------------------
  if (manifest.captions) {
    const captions = manifest.captions;
    const cue = captions.cues[0];
    if (cue) {
      // Everything below the declared bottom margin must be clear. Measuring
      // the strip the captions are meant to stay out of is what makes this a
      // safe-area check rather than a restatement of the style block.
      const strip: Region = {
        x: 0,
        y: Math.max(0, manifest.output.heightPx - captions.style.marginBottomPx + 8),
        width: manifest.output.widthPx,
        height: Math.max(1, captions.style.marginBottomPx - 8),
      };
      const cueTime = cue.startSeconds + (cue.endSeconds - cue.startSeconds) / 2;
      const stripFrame = await sampleBand(runner, outputPath, cueTime, {
        ...sampleOptions,
        crop: strip,
      });
      if (!stripFrame) {
        record({
          check: 'safeArea.captionsInsideBottomMargin',
          verdict: 'FAIL',
          measured: null,
          expected: `no burned-in type below the ${captions.style.marginBottomPx}px bottom safe margin`,
          instrument: 'frame-pixels',
          notMeasuredReason: `no frame could be sampled at ${cueTime.toFixed(2)}s`,
        });
      } else {
        const score = measureTextContrastScore(stripFrame, wholeFrame(stripFrame));
        record({
          check: 'safeArea.captionsInsideBottomMargin',
          verdict: score < CAPTION_TEXT_SCORE_THRESHOLD ? 'PASS' : 'FAIL',
          measured: Number(score.toFixed(6)),
          expected: `outlined-type score below ${CAPTION_TEXT_SCORE_THRESHOLD} in the ${captions.style.marginBottomPx}px bottom safe margin`,
          instrument: 'frame-pixels',
        });
      }
    }
  }

  // ---- faststart ----------------------------------------------------------
  const faststart = await hasFaststartMoov(outputPath);
  record({
    check: 'container.faststart',
    verdict: faststart === true ? 'PASS' : 'FAIL',
    measured: faststart,
    expected:
      'the moov atom precedes the mdat atom, so the file starts playing before it finishes downloading',
    instrument: 'filesystem',
    ...(faststart === null ? { notMeasuredReason: 'the container atoms could not be read' } : {}),
  });

  // ---- audio, measured from the decode ------------------------------------
  let audio: AudioMeasurement | null = null;
  if (audioRequested && audioStream) {
    audio = await measureRenderedAudio(runner, outputPath, {
      ffmpegPath: options.ffmpegPath ?? DEFAULT_FFMPEG_BINARIES.ffmpeg,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    recordAudioMeasurements(record, manifest, audio, effectiveDuration);
  }

  // ---- rights and provenance ----------------------------------------------
  const ineligible = manifest.sources.filter(
    (source) => !OUTPUT_ELIGIBLE_USAGE_CLASSES.includes(source.license.usageClass),
  );
  record({
    check: 'rights.everySourceOutputEligible',
    verdict: ineligible.length === 0 ? 'PASS' : 'FAIL',
    measured:
      ineligible.map((source) => `${source.id}:${source.license.usageClass}`).join(',') || 0,
    expected: `every source is ${OUTPUT_ELIGIBLE_USAGE_CLASSES.join(' or ')}`,
    instrument: 'manifest',
  });

  // Provenance completeness is asserted only when the caller says the run was
  // supposed to have it. `expectedChecksum` is optional in the manifest by
  // design, so an absent one is not a defect on its own — a manifest that
  // never promised a checksum has not broken a promise. A caller that supplies
  // `expectedSourceChecksums` *is* making that promise, and is held to it.
  if (options.expectedSourceChecksums) {
    const withoutChecksum = manifest.sources.filter((source) => !source.expectedChecksum);
    record({
      check: 'provenance.everySourceChecksummed',
      verdict: withoutChecksum.length === 0 ? 'PASS' : 'FAIL',
      measured: withoutChecksum.map((source) => source.id).join(',') || 0,
      expected: 'every source carries the sha256 of the bytes it contributed',
      instrument: 'manifest',
    });

    const declared = new Set(
      manifest.sources.map((source) => source.expectedChecksum).filter(Boolean) as string[],
    );
    const missing = options.expectedSourceChecksums.filter((checksum) => !declared.has(checksum));
    record({
      check: 'provenance.sourcesAccountedFor',
      verdict: missing.length === 0 ? 'PASS' : 'FAIL',
      measured: missing.length,
      expected: 'every source the run resolved appears in the manifest with its checksum',
      instrument: 'manifest',
    });
  }

  // ---- storyboard agreement -----------------------------------------------
  if (options.storyboard) {
    const storyboard = options.storyboard;
    record({
      check: 'storyboard.beatCountMatchesRender',
      verdict: storyboard.beatCount === manifest.scenes.length ? 'PASS' : 'FAIL',
      measured: manifest.scenes.length,
      expected: `${storyboard.beatCount} beats, as the storyboard promised before the render`,
      instrument: 'storyboard',
    });
    const durationAgrees =
      Number.isFinite(durationSeconds) &&
      Math.abs(durationSeconds - storyboard.totalDurationSeconds) <= durationToleranceSeconds;
    record({
      check: 'storyboard.durationMatchesRender',
      verdict: durationAgrees ? 'PASS' : 'FAIL',
      measured: Number.isFinite(durationSeconds) ? Number(durationSeconds.toFixed(4)) : null,
      expected: `${storyboard.totalDurationSeconds}s ± ${durationToleranceSeconds.toFixed(4)}s, as the storyboard promised`,
      instrument: 'storyboard',
    });
    const storyboardRightsProblem = storyboard.rightsClassifications.filter(
      (classification) => classification === 'ANALYSIS_ONLY' || classification === 'UNKNOWN_RIGHTS',
    );
    record({
      check: 'storyboard.noAnalysisOnlyMaterial',
      verdict: storyboardRightsProblem.length === 0 ? 'PASS' : 'FAIL',
      measured: storyboardRightsProblem.join(',') || 0,
      expected: 'the storyboard records no analysis-only or unknown-rights material',
      instrument: 'storyboard',
    });
  }

  return finalise(options, measurements, {
    sizeBytes,
    checksumSha256,
    containerFormats,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    widthPx: videoStream?.width ?? null,
    heightPx: videoStream?.height ?? null,
    frameRate: Number.isFinite(frameRate) ? Number(frameRate.toFixed(4)) : null,
    durationSeconds: Number.isFinite(durationSeconds) ? Number(durationSeconds.toFixed(4)) : null,
    pixelFormat,
    displayAspectRatio,
    faststart,
    audio,
  });
}

/**
 * The audio checks, split out because there are eight of them and they share
 * one rule: an unavailable measurement is reported with its reason and is not
 * a pass. A master whose loudness could not be measured is not a master whose
 * loudness is correct.
 */
function recordAudioMeasurements(
  record: (measurement: QaMeasurement) => void,
  manifest: RenderManifest,
  audio: AudioMeasurement,
  effectiveDuration: number,
): void {
  const target = manifest.audio?.loudness ?? {
    integratedLufs: -14,
    truePeakDbtp: -1,
    loudnessRange: 11,
  };

  record({
    check: 'audio.integratedLoudness',
    verdict:
      audio.integratedLufs !== null &&
      Math.abs(audio.integratedLufs - target.integratedLufs) <= LOUDNESS_TOLERANCE_LU
        ? 'PASS'
        : 'FAIL',
    measured: audio.integratedLufs,
    expected: `${target.integratedLufs} LUFS ± ${LOUDNESS_TOLERANCE_LU} LU, measured from the master`,
    instrument: 'audio-decode',
    ...(audio.integratedLufs === null
      ? {
          notMeasuredReason:
            audio.unavailable.join('; ') || 'ebur128 reported no integrated loudness',
        }
      : {}),
  });

  record({
    check: 'audio.loudnessRange',
    verdict: audio.loudnessRangeLu !== null ? 'PASS' : 'FAIL',
    measured: audio.loudnessRangeLu,
    expected: 'a loudness range is reported by ebur128',
    instrument: 'audio-decode',
    ...(audio.loudnessRangeLu === null
      ? { notMeasuredReason: 'this FFmpeg build reported no LRA summary' }
      : {}),
  });

  record({
    check: 'audio.peakBelowCeiling',
    verdict:
      audio.peakDbtp !== null && audio.peakDbtp <= target.truePeakDbtp + PEAK_TOLERANCE_DB
        ? 'PASS'
        : 'FAIL',
    measured: audio.peakDbtp,
    expected: `at or below ${target.truePeakDbtp} dB (+${PEAK_TOLERANCE_DB} tolerance), measured as ${audio.peakBasis}`,
    instrument: 'audio-decode',
    ...(audio.peakDbtp === null
      ? { notMeasuredReason: 'neither a true peak nor a sample peak could be read' }
      : {}),
    detail: `peak basis: ${audio.peakBasis}`,
  });

  record({
    check: 'audio.noClipping',
    verdict: audio.clippedSampleCount === 0 ? 'PASS' : 'FAIL',
    measured: audio.clippedSampleCount,
    expected: '0 clipped samples',
    instrument: 'audio-decode',
    ...(audio.clippedSampleCount === null
      ? { notMeasuredReason: 'astats reported no clipped-sample count' }
      : {}),
  });

  // A whole-programme silence is a dropped mix; a gap longer than a fifth of
  // the cut is one too. Anything shorter is a creative choice.
  const silenceCeiling = Math.max(1, effectiveDuration * 0.2);
  record({
    check: 'audio.noLongSilence',
    verdict:
      audio.longestSilenceSeconds !== null && audio.longestSilenceSeconds <= silenceCeiling
        ? 'PASS'
        : 'FAIL',
    measured: audio.longestSilenceSeconds,
    expected: `no silent run longer than ${silenceCeiling.toFixed(2)}s`,
    instrument: 'audio-decode',
    ...(audio.longestSilenceSeconds === null
      ? { notMeasuredReason: 'silencedetect produced no output' }
      : {}),
  });

  record({
    check: 'audio.channelLayout',
    verdict: audio.channelCount === 2 ? 'PASS' : 'FAIL',
    measured: audio.channelCount,
    expected: '2 channels (stereo)',
    instrument: 'audio-decode',
    ...(audio.channelCount === null
      ? { notMeasuredReason: 'the decoder reported no channel layout' }
      : {}),
  });

  record({
    check: 'audio.sampleRate',
    verdict: audio.sampleRateHz === 48_000 ? 'PASS' : 'FAIL',
    measured: audio.sampleRateHz,
    expected: '48000 Hz',
    instrument: 'audio-decode',
    ...(audio.sampleRateHz === null
      ? { notMeasuredReason: 'the decoder reported no sample rate' }
      : {}),
  });
}

/**
 * Windows the manifest asks to be black or still, and which the black/freeze
 * walk must therefore skip.
 *
 * Two sources: every transition's overlap — a dip to black is black on
 * purpose — and the CTA end card, which is a held card by design and, when it
 * declares `holdSeconds`, is *required* to be still.
 */
export function intentionallyStillWindows(manifest: RenderManifest): readonly Region0[] {
  const windows: Region0[] = [];
  let runningLength = 0;

  manifest.scenes.forEach((scene, index) => {
    const overlap = scene.transitionIn?.durationSeconds ?? 0;
    const startSeconds = index === 0 ? 0 : runningLength - overlap;
    runningLength =
      index === 0 ? scene.durationSeconds : runningLength + scene.durationSeconds - overlap;
    if (overlap > 0) {
      // A frame either side, so a sample landing on the very edge of a blend
      // is not judged against the shot it is halfway out of.
      windows.push({
        startSeconds: startSeconds - 1 / manifest.output.frameRate,
        endSeconds: startSeconds + overlap + 1 / manifest.output.frameRate,
      });
    }
    // A scene that asked to be still is still. The freeze check exists to
    // catch a picture that stopped when it was *supposed* to be moving — a
    // dropped source, a stalled zoompan, an encoder that repeated a frame —
    // not to argue with a manifest that deliberately holds a screenshot so a
    // viewer can read it.
    if (declaresStillness(scene, manifest)) {
      windows.push({ startSeconds, endSeconds: startSeconds + scene.durationSeconds });
    }
  });

  if (manifest.cta) {
    windows.push({ startSeconds: manifest.cta.startSeconds, endSeconds: manifest.cta.endSeconds });
  }
  return windows;
}

interface Region0 {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/**
 * Whether a scene's own manifest entry says its picture does not move.
 *
 * **A scene whose source is a video is never still**, whatever treatment it
 * declares, and that qualification is the whole of this function's value.
 * `STATIC_HOLD` means "add no synthetic camera move" — which is exactly what a
 * scene carrying real footage or a composited interface asks for, because the
 * movement is already in the source. Reading it as "the picture does not move"
 * excused every moving scene from the freeze walk, and a cut whose scenes are
 * all moving sources then had *nothing* left to sample: the one check that
 * catches a dropped source, a stalled `zoompan` or a repeated frame was
 * switched off by the manifest describing itself correctly.
 *
 * A still image held so a viewer can read it is genuinely still, and that is
 * the case the exclusion exists for.
 */
function declaresStillness(
  scene: RenderManifest['scenes'][number],
  manifest: RenderManifest,
): boolean {
  const source = manifest.sources.find((candidate) => candidate.id === scene.sourceId);
  if (source && source.kind === 'VIDEO') return false;
  if (scene.treatment) {
    return (
      scene.treatment.key === 'STATIC_HOLD' ||
      scene.treatment.key === 'FRAMED_PHONE_UI' ||
      scene.treatment.intensity === 0
    );
  }
  return scene.motion === 'STATIC';
}

/** Evenly spaced sample times across the cut, skipping the excluded windows. */
async function sampleAcross(
  sampleAt: (timeSeconds: number) => Promise<SampledFrame | null>,
  durationSeconds: number,
  count: number,
  excluded: readonly Region0[],
): Promise<readonly { time: number; frame: SampledFrame | null }[]> {
  const results: { time: number; frame: SampledFrame | null }[] = [];
  for (let i = 1; i <= count; i += 1) {
    const time = (durationSeconds * i) / (count + 1);
    if (excluded.some((window) => time >= window.startSeconds && time <= window.endSeconds)) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- sampled in timeline order so the report reads chronologically
    results.push({ time, frame: await sampleAt(time) });
  }
  return results;
}

/** Mean per-channel absolute difference between two same-sized frames, 0–255. */
export function meanAbsoluteFrameDifference(a: SampledFrame, b: SampledFrame): number {
  if (a.widthPx !== b.widthPx || a.heightPx !== b.heightPx) return Number.POSITIVE_INFINITY;
  const length = Math.min(a.pixels.length, b.pixels.length);
  if (length === 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < length; i += 1) {
    total += Math.abs((a.pixels[i] ?? 0) - (b.pixels[i] ?? 0));
  }
  return total / length;
}

/**
 * Whether the `moov` atom precedes `mdat`.
 *
 * Read from the container's own atom table rather than inferred from the
 * `-movflags +faststart` argument: the argument is what was asked for, and a
 * remux or a copy afterwards can undo it without changing a single line of the
 * render code.
 */
export async function hasFaststartMoov(filePath: string): Promise<boolean | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    // Atom headers are 8 bytes: a 32-bit big-endian size, then a 4-byte type.
    // Walking the top level is enough — both atoms are always top level.
    let offset = 0;
    for (let steps = 0; steps < 64; steps += 1) {
      const header = Buffer.alloc(16);
      // eslint-disable-next-line no-await-in-loop -- the atom table is a linked walk
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) return null;

      const type = header.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;

      let size = header.readUInt32BE(0);
      if (size === 1) {
        if (bytesRead < 16) return null;
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(large);
      }
      if (size < 8) return null;
      offset += size;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function sampleBand(
  runner: CommandRunner,
  outputPath: string,
  timeSeconds: number,
  options: SampleFrameOptions,
): Promise<SampledFrame | null> {
  try {
    return await sampleFrame(runner, outputPath, timeSeconds, options);
  } catch {
    return null;
  }
}

function blankFrameMeasurement(
  check: string,
  frame: SampledFrame | null,
  label: string,
): QaMeasurement {
  if (!frame) {
    return {
      check,
      verdict: 'FAIL',
      measured: null,
      expected: `${label} carries picture detail`,
      instrument: 'frame-pixels',
      detail: 'the frame could not be sampled',
    };
  }
  const stats = measureRegion(frame, wholeFrame(frame));
  return {
    check,
    verdict: stats.stdDevLuma > BLANK_FRAME_STDDEV_THRESHOLD ? 'PASS' : 'FAIL',
    measured: Number(stats.stdDevLuma.toFixed(2)),
    expected: `luma standard deviation above ${BLANK_FRAME_STDDEV_THRESHOLD} (${label} is not a flat fill)`,
    instrument: 'frame-pixels',
    detail: `mean luma ${stats.meanLuma.toFixed(1)}`,
  };
}

/** A moment inside the cut where no cue is scheduled — the baseline the cue frame is compared against. */
function findCaptionGap(
  cues: readonly { startSeconds: number; endSeconds: number }[],
  durationSeconds: number,
  ctaStartSeconds: number | undefined,
): number | null {
  const limit = ctaStartSeconds ?? durationSeconds;
  const sorted = [...cues].sort((a, b) => a.startSeconds - b.startSeconds);
  let cursor = 0;
  for (const cue of sorted) {
    if (cue.startSeconds - cursor > 0.5) {
      return cursor + (cue.startSeconds - cursor) / 2;
    }
    cursor = Math.max(cursor, cue.endSeconds);
  }
  if (limit - cursor > 0.5) {
    return cursor + (limit - cursor) / 2;
  }
  return null;
}

function reduceRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height) || 1;
  return `${width / divisor}:${height / divisor}`;
}

function finalise(
  options: RunActualMediaQaOptions,
  measurements: readonly QaMeasurement[],
  summary: ActualMediaQaReport['summary'],
): ActualMediaQaReport {
  return {
    reportVersion: 2,
    outputPath: options.outputPath,
    verdict: measurements.every((m) => m.verdict === 'PASS') ? 'PASS' : 'FAIL',
    measuredAt: options.measuredAt.toISOString(),
    measurements,
    summary,
  };
}

export function failedChecks(report: ActualMediaQaReport): readonly QaMeasurement[] {
  return report.measurements.filter((m) => m.verdict === 'FAIL');
}
