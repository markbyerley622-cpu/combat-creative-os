import { DEFAULT_FFMPEG_BINARIES } from '../binaries';
import type { CommandRunner } from '../command-runner';

/**
 * Audio measured from a produced file.
 *
 * Every value here comes out of a decode of the finished master. None of it is
 * the manifest's `loudness` target restated: a renderer that dropped the
 * limiter, or normalised to the wrong programme, or emitted silence where a
 * music bed should be, has to fail here rather than be believed because the
 * manifest asked nicely.
 *
 * When an instrument is not available — an FFmpeg build without `ebur128`, a
 * file with no audio stream at all — the field is `null` and the exact reason
 * is recorded. A fabricated `-14.0` would be indistinguishable from a real
 * measurement and is the one outcome this module must never produce.
 */

export class AudioMeasurementError extends Error {
  constructor(
    public readonly filePath: string,
    detail: string,
  ) {
    super(`Could not measure audio in ${filePath}: ${detail}`);
    this.name = 'AudioMeasurementError';
  }
}

export interface AudioMeasurement {
  /** ITU-R BS.1770 integrated loudness, LUFS. */
  readonly integratedLufs: number | null;
  /** Loudness range, LU. Reported by `ebur128` where the build supports it. */
  readonly loudnessRangeLu: number | null;
  /**
   * True peak in dBTP where `ebur128`'s peak mode is available; otherwise the
   * sample peak from `astats`, which is the closest valid measured equivalent
   * and is labelled as such by `peakBasis`.
   */
  readonly peakDbtp: number | null;
  readonly peakBasis: 'TRUE_PEAK' | 'SAMPLE_PEAK' | 'UNAVAILABLE';
  /** Count of samples at or beyond full scale, from `astats`. */
  readonly clippedSampleCount: number | null;
  /** Longest run of digital silence, seconds, from `silencedetect`. */
  readonly longestSilenceSeconds: number | null;
  readonly channelCount: number | null;
  readonly sampleRateHz: number | null;
  /** Every measurement that could not be taken, with the reason. */
  readonly unavailable: readonly string[];
}

export interface MeasureAudioOptions {
  readonly ffmpegPath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Below this, a gap counts as silence. */
  readonly silenceThresholdDb?: number;
  readonly silenceMinimumSeconds?: number;
}

const DEFAULT_MEASUREMENT_TIMEOUT_MS = 120_000;
const DEFAULT_SILENCE_THRESHOLD_DB = -50;
const DEFAULT_SILENCE_MINIMUM_SECONDS = 0.5;

/**
 * `ebur128` and `astats` both write their summaries to stderr as a formatted
 * block; unlike the detectors in `clip-analysis`, neither exposes the summary
 * through the `metadata` filter — per-frame metadata exists, but the
 * *integrated* figure is only ever printed at end of stream. So this is the
 * case CLAUDE.md's rule allows for explicitly: there is no machine-readable
 * format to prefer. The parsers below are therefore written to be strict about
 * what they accept and to return `null` rather than a guess.
 */
function parseLabelledFloat(text: string, label: RegExp): number | null {
  const match = label.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function parseEbur128Summary(stderr: string): {
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
} {
  // The summary block is emitted once, at the end:
  //   Integrated loudness:
  //     I:         -14.0 LUFS
  //   Loudness range:
  //     LRA:         6.3 LU
  //   True peak:
  //     Peak:       -1.2 dBFS
  const summaryIndex = stderr.lastIndexOf('Integrated loudness:');
  const summary = summaryIndex === -1 ? stderr : stderr.slice(summaryIndex);
  return {
    integratedLufs: parseLabelledFloat(summary, /^\s*I:\s*(-?[\d.]+)\s*LUFS/m),
    loudnessRangeLu: parseLabelledFloat(summary, /^\s*LRA:\s*(-?[\d.]+)\s*LU/m),
    truePeakDbtp: parseLabelledFloat(summary, /^\s*Peak:\s*(-?[\d.inf]+)\s*dBFS/m),
  };
}

/**
 * Strips FFmpeg's `[Parsed_astats_1 @ 0x…] ` line prefix.
 *
 * `ebur128`'s summary block is printed raw, but `astats` prefixes every line
 * with its filter instance — which includes a pointer that differs between
 * runs. Removing it is what lets the patterns below anchor at the start of a
 * line, and what keeps the parse independent of a value that is not stable.
 */
function stripFilterPrefixes(text: string): string {
  return text.replace(/^\[[^\]\n]*@[^\]\n]*\]\s?/gm, '');
}

export function parseAstatsSummary(stderr: string): {
  peakDb: number | null;
  absolutePeakCount: number | null;
} {
  // `astats` prints per-channel blocks then an "Overall" block. The overall
  // peak is the one that matters for a stereo master.
  const stripped = stripFilterPrefixes(stderr);
  const overallIndex = stripped.lastIndexOf('Overall');
  const overall = overallIndex === -1 ? stripped : stripped.slice(overallIndex);

  return {
    peakDb: parseLabelledFloat(overall, /^\s*Peak level dB:\s*(-?[\d.]+)/m),
    absolutePeakCount: parseLabelledFloat(overall, /^\s*Abs Peak count:\s*([\d.]+)/m),
  };
}

/**
 * Samples at or beyond full scale.
 *
 * FFmpeg's `astats` has no clipped-sample counter in every build — this one
 * does not — so clipping is derived from the two figures it does report: the
 * overall peak, and how many samples reached the absolute peak. A peak at or
 * above 0 dBFS *is* clipping, and `Abs Peak count` is how many samples sat
 * there. Below 0 dBFS nothing reached full scale and the count is zero by
 * construction.
 *
 * Deriving it is honest; inventing a zero when the peak could not be read is
 * not, which is why an unreadable peak returns `null` rather than 0.
 */
export function deriveClippedSampleCount(
  peakDb: number | null,
  absolutePeakCount: number | null,
): number | null {
  if (peakDb === null) return null;
  if (peakDb < 0) return 0;
  return absolutePeakCount === null ? null : Math.round(absolutePeakCount);
}

/** Channel layout, from the decoder's own stream line. `stereo` is 2, not "stereo". */
export function parseChannelCount(stderr: string): number | null {
  const match = /Audio:[^\n]*?,\s*\d+\s*Hz,\s*([a-z0-9.()+ ]+?),/i.exec(stderr);
  if (!match) return null;
  const layout = (match[1] ?? '').trim().toLowerCase();
  if (layout === 'mono') return 1;
  if (layout === 'stereo') return 2;
  const numbered = /^(\d+)(?:\.(\d+))?$/.exec(layout);
  if (numbered) return Number(numbered[1]) + Number(numbered[2] ?? 0);
  return null;
}

export function parseSilenceRuns(stderr: string): readonly number[] {
  const durations: number[] = [];
  const pattern = /silence_duration:\s*([\d.]+)/g;
  let match = pattern.exec(stderr);
  while (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) durations.push(value);
    match = pattern.exec(stderr);
  }
  return durations;
}

/**
 * Decodes the file's audio once through `ebur128`, `astats` and
 * `silencedetect`, and reads the three summaries out of the result.
 *
 * One pass rather than three: the filters are independent, and a master long
 * enough to matter is long enough that decoding it three times is a real cost
 * for no additional certainty.
 */
export async function measureRenderedAudio(
  runner: CommandRunner,
  filePath: string,
  options: MeasureAudioOptions = {},
): Promise<AudioMeasurement> {
  const unavailable: string[] = [];
  const silenceThreshold = options.silenceThresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB;
  const silenceMinimum = options.silenceMinimumSeconds ?? DEFAULT_SILENCE_MINIMUM_SECONDS;

  let stderr = '';
  try {
    const result = await runner.run(
      options.ffmpegPath ?? DEFAULT_FFMPEG_BINARIES.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        // `info` because the three summaries are logged, not written to a
        // metadata stream. Bounded by the runner's stderr tail.
        '-loglevel',
        'info',
        '-i',
        filePath,
        '-map',
        '0:a:0',
        '-vn',
        '-af',
        [
          'ebur128=peak=true:framelog=quiet',
          // `measure_perchannel=none` halves the output without losing the
          // overall block, which is the only one a stereo master needs.
          'astats=measure_perchannel=none',
          `silencedetect=noise=${silenceThreshold}dB:d=${silenceMinimum}`,
        ].join(','),
        '-f',
        'null',
        '-',
      ],
      {
        timeoutMs: options.timeoutMs ?? DEFAULT_MEASUREMENT_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
        // The summaries are the last thing written, and the runner keeps the
        // tail, so a long progress log cannot push them out.
        maxStderrBytes: 512 * 1024,
      },
    );
    if (result.exitCode !== 0) {
      throw new AudioMeasurementError(
        filePath,
        result.stderr.trim() || `ffmpeg exited ${result.exitCode}`,
      );
    }
    stderr = result.stderr;
  } catch (error) {
    return {
      integratedLufs: null,
      loudnessRangeLu: null,
      peakDbtp: null,
      peakBasis: 'UNAVAILABLE',
      clippedSampleCount: null,
      longestSilenceSeconds: null,
      channelCount: null,
      sampleRateHz: null,
      unavailable: [
        `AUDIO_MEASUREMENT_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const ebur128 = parseEbur128Summary(stderr);
  const astats = parseAstatsSummary(stderr);
  const clippedSampleCount = deriveClippedSampleCount(astats.peakDb, astats.absolutePeakCount);
  const silences = parseSilenceRuns(stderr);

  if (ebur128.integratedLufs === null) {
    unavailable.push('INTEGRATED_LOUDNESS_UNAVAILABLE: ebur128 printed no integrated summary');
  }
  if (ebur128.loudnessRangeLu === null) {
    unavailable.push('LOUDNESS_RANGE_UNAVAILABLE: ebur128 printed no LRA summary');
  }

  const peakDbtp = ebur128.truePeakDbtp ?? astats.peakDb;
  const peakBasis: AudioMeasurement['peakBasis'] =
    ebur128.truePeakDbtp !== null
      ? 'TRUE_PEAK'
      : astats.peakDb !== null
        ? 'SAMPLE_PEAK'
        : 'UNAVAILABLE';
  if (peakBasis === 'SAMPLE_PEAK') {
    unavailable.push(
      'TRUE_PEAK_UNAVAILABLE: ebur128 reported no true-peak figure; the sample peak from astats is reported instead',
    );
  }
  if (peakBasis === 'UNAVAILABLE') {
    unavailable.push('PEAK_UNAVAILABLE: neither ebur128 nor astats reported a peak');
  }
  if (clippedSampleCount === null) {
    unavailable.push(
      'CLIPPING_UNAVAILABLE: astats reported neither an overall peak nor an absolute-peak count',
    );
  }

  const sampleRateHz = parseLabelledFloat(stderr, /Audio:.*?,\s*(\d+)\s*Hz/);

  return {
    integratedLufs: ebur128.integratedLufs,
    loudnessRangeLu: ebur128.loudnessRangeLu,
    peakDbtp,
    peakBasis,
    clippedSampleCount,
    longestSilenceSeconds: silences.length > 0 ? Math.max(...silences) : 0,
    channelCount: parseChannelCount(stderr),
    sampleRateHz,
    unavailable,
  };
}
