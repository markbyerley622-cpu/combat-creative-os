import { DEFAULT_FFMPEG_BINARIES, DEFAULT_PROBE_TIMEOUT_MS } from '../binaries';
import type { CommandRunner } from '../command-runner';
import { probeMedia } from '../ffprobe';

/**
 * What is actually inside a source clip, measured rather than declared.
 *
 * In-point selection needs three things no manifest can supply: where the
 * picture changes, where it is black, and where it is frozen. Without them a
 * cut can only ever start every clip at zero — which is the limitation this
 * module exists to remove — and "start 4 seconds in" is a coin flip that lands
 * on a slate, a fade or a still hold about as often as it lands on the shot.
 *
 * Two structural rules, both from CLAUDE.md's external-detector boundary:
 *
 * - **Machine-readable output only.** Detection results are read from lavfi's
 *   own `metadata` filter, whose `print` form is a documented key/value
 *   stream, rather than scraped out of the human-formatted `[blackdetect @
 *   0x…]` lines FFmpeg writes to stderr at info level. Those lines are a
 *   diagnostic, not an interface.
 * - **Argument arrays, bounded time, cancellation, typed failures.** Every
 *   invocation goes through `CommandRunner`, which spawns without a shell.
 *
 * The analysis is a pure function of the file's bytes: no clock, no
 * randomness, so the same clip always yields the same boundaries and the same
 * selection downstream.
 */

export class ClipAnalysisError extends Error {
  constructor(
    public readonly clipPath: string,
    detail: string,
  ) {
    super(`Could not analyse ${clipPath}: ${detail}`);
    this.name = 'ClipAnalysisError';
  }
}

export interface ClipTimeInterval {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface ClipAnalysis {
  readonly clipPath: string;
  readonly durationSeconds: number;
  readonly frameRate: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly videoCodec: string;
  readonly hasAudio: boolean;
  /**
   * Times at which the picture changes enough to read as a new shot, always
   * including 0. These are candidate in-points: cutting on one lands on the
   * start of something rather than in the middle of it.
   */
  readonly sceneBoundaries: readonly number[];
  /** Regions whose picture is black. Never a legal in-point. */
  readonly blackRegions: readonly ClipTimeInterval[];
  /** Regions whose picture does not change. Never a legal in-point. */
  readonly freezeRegions: readonly ClipTimeInterval[];
  /** Everything the detectors could not establish, named rather than assumed. */
  readonly unavailable: readonly string[];
}

export interface AnalyseClipOptions {
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Scene-change score above which a frame is treated as a new shot. 0.3 is
   * FFmpeg's own commonly-used working threshold: low enough to catch a cut
   * between two similar gym interiors, high enough that a camera move is not
   * mistaken for one.
   */
  readonly sceneThreshold?: number;
  /** Shortest run of black that counts as a black region. */
  readonly blackMinimumSeconds?: number;
  /** Shortest run of unchanging picture that counts as a freeze. */
  readonly freezeMinimumSeconds?: number;
}

const DEFAULT_SCENE_THRESHOLD = 0.3;
const DEFAULT_BLACK_MINIMUM_SECONDS = 0.1;
const DEFAULT_FREEZE_MINIMUM_SECONDS = 0.4;
/** A whole-clip decode is the expensive part; allow more than a probe would. */
const DEFAULT_ANALYSIS_TIMEOUT_MS = 120_000;

/**
 * One `pts_time` and the lavfi metadata keys reported at it.
 *
 * `metadata=mode=print` emits a `frame:N pts:… pts_time:…` header followed by
 * one `key=value` line per metadata entry on that frame, so parsing is a
 * matter of tracking the most recent header.
 */
interface MetadataEvent {
  readonly timeSeconds: number;
  readonly key: string;
  readonly value: string;
}

export function parseLavfiMetadata(stdout: string): readonly MetadataEvent[] {
  const events: MetadataEvent[] = [];
  let currentTime = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const frameHeader = /^frame:\d+\s+pts:\S+\s+pts_time:(-?[\d.]+)/.exec(line);
    if (frameHeader) {
      const parsed = Number(frameHeader[1]);
      if (Number.isFinite(parsed)) currentTime = parsed;
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    events.push({
      timeSeconds: currentTime,
      key: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    });
  }

  return events;
}

/**
 * Pairs `*_start` / `*_end` metadata into closed intervals.
 *
 * A region left open at the end of the clip is closed at the clip's duration:
 * a fade-to-black that runs to the final frame is still black, and treating it
 * as "never ended, so never happened" is exactly the mistake that puts a black
 * frame at the front of a cut.
 */
export function pairIntervals(
  events: readonly MetadataEvent[],
  startKey: string,
  endKey: string,
  durationSeconds: number,
): readonly ClipTimeInterval[] {
  const intervals: ClipTimeInterval[] = [];
  let openStart: number | null = null;

  for (const event of events) {
    if (event.key === startKey) {
      const value = Number(event.value);
      openStart = Number.isFinite(value) ? value : event.timeSeconds;
      continue;
    }
    if (event.key === endKey && openStart !== null) {
      const value = Number(event.value);
      const endSeconds = Number.isFinite(value) ? value : event.timeSeconds;
      if (endSeconds > openStart) intervals.push({ startSeconds: openStart, endSeconds });
      openStart = null;
    }
  }

  if (openStart !== null && durationSeconds > openStart) {
    intervals.push({ startSeconds: openStart, endSeconds: durationSeconds });
  }
  return intervals;
}

async function runDetector(
  runner: CommandRunner,
  clipPath: string,
  filter: string,
  options: AnalyseClipOptions,
): Promise<string> {
  const result = await runner.run(
    options.ffmpegPath ?? DEFAULT_FFMPEG_BINARIES.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
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
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS,
      signal: options.signal,
    },
  );
  if (result.exitCode !== 0) {
    throw new ClipAnalysisError(
      clipPath,
      result.stderr.trim() || `ffmpeg exited ${result.exitCode}`,
    );
  }
  return result.stdout;
}

/**
 * Measures a clip's structure.
 *
 * Two decode passes rather than one: `select` drops frames, so a black or
 * freeze detector placed after it would be measuring a different clip than the
 * one on disk. Splitting the graph and printing both metadata streams to the
 * same stdout would interleave two sets of `pts_time` headers with no way to
 * tell them apart, which is worse than paying for a second pass.
 */
export async function analyseClip(
  runner: CommandRunner,
  clipPath: string,
  options: AnalyseClipOptions = {},
): Promise<ClipAnalysis> {
  const probe = await probeMedia(runner, clipPath, {
    ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (probe.mediaType !== 'VIDEO') {
    throw new ClipAnalysisError(
      clipPath,
      `expected a video clip but it probes as ${probe.mediaType}`,
    );
  }

  const unavailable: string[] = [];
  const sceneThreshold = options.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD;
  const blackMinimum = options.blackMinimumSeconds ?? DEFAULT_BLACK_MINIMUM_SECONDS;
  const freezeMinimum = options.freezeMinimumSeconds ?? DEFAULT_FREEZE_MINIMUM_SECONDS;

  let blackRegions: readonly ClipTimeInterval[] = [];
  let freezeRegions: readonly ClipTimeInterval[] = [];
  try {
    const stdout = await runDetector(
      runner,
      clipPath,
      [
        `blackdetect=d=${blackMinimum}:pic_th=0.98:pix_th=0.10`,
        `freezedetect=n=-60dB:d=${freezeMinimum}`,
        'metadata=mode=print:file=-',
      ].join(','),
      options,
    );
    const events = parseLavfiMetadata(stdout);
    blackRegions = pairIntervals(
      events,
      'lavfi.black_start',
      'lavfi.black_end',
      probe.durationSeconds,
    );
    freezeRegions = pairIntervals(
      events,
      'lavfi.freezedetect.freeze_start',
      'lavfi.freezedetect.freeze_end',
      probe.durationSeconds,
    );
  } catch (error) {
    // Named, never assumed. A clip whose black regions could not be measured
    // must not be treated as a clip with no black regions — the caller decides
    // whether to use it, and it decides knowing this.
    unavailable.push(
      `BLACK_AND_FREEZE_DETECTION_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let sceneBoundaries: readonly number[] = [0];
  try {
    const stdout = await runDetector(
      runner,
      clipPath,
      [`select='gt(scene,${sceneThreshold})'`, 'metadata=mode=print:file=-'].join(','),
      options,
    );
    const times = parseLavfiMetadata(stdout)
      .filter((event) => event.key === 'lavfi.scene_score')
      .map((event) => event.timeSeconds)
      .filter((time) => Number.isFinite(time) && time > 0 && time < probe.durationSeconds);
    sceneBoundaries = [0, ...times].sort((a, b) => a - b);
  } catch (error) {
    unavailable.push(
      `SCENE_DETECTION_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    clipPath,
    durationSeconds: probe.durationSeconds,
    frameRate: probe.frameRate,
    widthPx: probe.widthPx,
    heightPx: probe.heightPx,
    videoCodec: probe.videoCodec,
    hasAudio: probe.hasAudio,
    sceneBoundaries,
    blackRegions,
    freezeRegions,
    unavailable,
  };
}

/** True when `[startSeconds, endSeconds)` overlaps any measured region. */
export function overlapsAny(
  regions: readonly ClipTimeInterval[],
  startSeconds: number,
  endSeconds: number,
): boolean {
  return regions.some(
    (region) => region.startSeconds < endSeconds && region.endSeconds > startSeconds,
  );
}
