import { stat } from 'node:fs/promises';

import { DEFAULT_FFMPEG_BINARIES, DEFAULT_PROBE_TIMEOUT_MS } from '../binaries';
import type { CommandRunner } from '../command-runner';
import { parseFrameRate, probeRaw, type FfprobeOutput } from '../ffprobe';
import type { RenderManifest } from '../render/manifest';
import { sha256File } from '../render/source-resolution';
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

export interface QaMeasurement {
  /** Stable identifier, so a failing check routes deterministically. */
  readonly check: string;
  readonly verdict: QaVerdict;
  /** What the instrument returned, rendered for the report. */
  readonly measured: string | number | boolean | null;
  readonly expected: string;
  /** How the value was obtained — never "the manifest said so". */
  readonly instrument: 'ffprobe' | 'filesystem' | 'frame-pixels' | 'checksum';
  readonly detail?: string;
}

export interface ActualMediaQaReport {
  readonly reportVersion: 1;
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
  });
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
    reportVersion: 1,
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
