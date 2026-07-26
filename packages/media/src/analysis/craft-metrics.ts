import { basename, dirname } from 'node:path';

import type { CommandRunner } from '../command-runner';
import type { FfmpegBinaries } from '../binaries';

/**
 * Deterministic, measured properties of a piece of media.
 *
 * Everything here is arithmetic over numbers a tool reported. Nothing in this
 * file forms a judgement: there is no "premium", no "engaging", no "strong
 * hook". Those are human readings and belong in an attributed annotation —
 * mixing a measurement and an opinion into one record is how a system starts
 * presenting taste as fact.
 *
 * Detector output is read as **machine-readable ffprobe frame tags**, never
 * scraped from FFmpeg's human-formatted log. `blackdetect` and `silencedetect`
 * both publish their results as frame metadata, which `ffprobe -show_entries
 * frame_tags=… -of json` returns as JSON.
 */

export interface TimeInterval {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface SceneStatistics {
  readonly sceneCount: number;
  readonly firstCutSeconds?: number;
  readonly averageSceneSeconds?: number;
  readonly medianSceneSeconds?: number;
  readonly minSceneSeconds?: number;
  readonly maxSceneSeconds?: number;
  readonly cutsPerSecond: number;
  /** `{ "0.5": 3 }` — count of scenes whose duration falls in each half-second bucket. */
  readonly sceneDurationHistogram: Record<string, number>;
}

/**
 * Editing statistics from detected scene boundaries.
 *
 * "Cuts" is one fewer than "scenes": a three-scene advertisement was cut
 * twice. Getting that off by one would misstate the pacing of every reference
 * in the library, so it is stated explicitly here rather than left implicit.
 */
export function computeSceneStatistics(
  scenes: readonly { startSeconds: number; durationSeconds: number }[],
  durationSeconds: number,
): SceneStatistics {
  const sceneCount = scenes.length;
  const cutCount = Math.max(0, sceneCount - 1);
  const cutsPerSecond = durationSeconds > 0 ? Number((cutCount / durationSeconds).toFixed(4)) : 0;

  if (sceneCount === 0) {
    return { sceneCount: 0, cutsPerSecond: 0, sceneDurationHistogram: {} };
  }

  const durations = scenes.map((scene) => scene.durationSeconds).sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(durations.length / 2);
  const median =
    durations.length % 2 === 0
      ? ((durations[middle - 1] as number) + (durations[middle] as number)) / 2
      : (durations[middle] as number);

  const histogram: Record<string, number> = {};
  for (const duration of durations) {
    const bucket = (Math.floor(duration / 0.5) * 0.5).toFixed(1);
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }

  // The first cut is where the second scene begins — absent in a single-shot
  // advertisement, which is a meaningful fact rather than a zero.
  const firstCut = scenes[1]?.startSeconds;

  return {
    sceneCount,
    ...(firstCut === undefined ? {} : { firstCutSeconds: Number(firstCut.toFixed(3)) }),
    averageSceneSeconds: Number((total / sceneCount).toFixed(3)),
    medianSceneSeconds: Number(median.toFixed(3)),
    minSceneSeconds: Number((durations[0] as number).toFixed(3)),
    maxSceneSeconds: Number((durations[durations.length - 1] as number).toFixed(3)),
    cutsPerSecond,
    sceneDurationHistogram: histogram,
  };
}

/** Greatest common divisor, for reducing a pixel geometry to an aspect ratio. */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function aspectRatioOf(widthPx: number, heightPx: number): string {
  if (widthPx <= 0 || heightPx <= 0) return 'unknown';
  const divisor = gcd(widthPx, heightPx);
  return `${widthPx / divisor}:${heightPx / divisor}`;
}

interface FrameTagQuery {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly filePath: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Runs an ffprobe lavfi graph and returns the frame tag objects it emitted.
 *
 * The file is addressed by bare name from its own directory: a Windows `C:\…`
 * path inside a filter argument collides with the `:` option separator, which
 * is the same constraint the renderer and the scene detector work around.
 */
async function readFrameTags(
  query: FrameTagQuery,
  graph: (bareFilename: string) => string,
  entries: string,
): Promise<Record<string, string>[]> {
  const args = [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    graph(basename(query.filePath)),
    '-show_entries',
    entries,
    '-of',
    'json',
  ];

  const { stdout } = await query.runner.run(query.binaries.ffprobe, args, {
    cwd: dirname(query.filePath),
    timeoutMs: query.timeoutMs ?? 5 * 60_000,
    ...(query.signal ? { signal: query.signal } : {}),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim().length === 0 ? '{}' : stdout);
  } catch {
    return [];
  }
  const frames = (parsed as { frames?: unknown }).frames;
  if (!Array.isArray(frames)) return [];

  const tags: Record<string, string>[] = [];
  for (const frame of frames) {
    const candidate = (frame as { tags?: unknown })?.tags;
    if (typeof candidate === 'object' && candidate !== null) {
      tags.push(candidate as Record<string, string>);
    }
  }
  return tags;
}

/** Pairs `*_start` / `*_end` tags into closed intervals, ignoring unpaired starts. */
function pairIntervals(
  tags: readonly Record<string, string>[],
  startKey: string,
  endKey: string,
): TimeInterval[] {
  const intervals: TimeInterval[] = [];
  let openStart: number | undefined;

  for (const tag of tags) {
    const start = tag[startKey];
    const end = tag[endKey];
    if (start !== undefined) {
      const value = Number(start);
      if (Number.isFinite(value)) openStart = value;
    }
    if (end !== undefined && openStart !== undefined) {
      const value = Number(end);
      if (Number.isFinite(value) && value > openStart) {
        intervals.push({
          startSeconds: Number(openStart.toFixed(3)),
          endSeconds: Number(value.toFixed(3)),
        });
      }
      openStart = undefined;
    }
  }
  return intervals;
}

/** Black-frame runs, via the `blackdetect` filter's frame metadata. */
export async function measureBlackFrameIntervals(
  query: FrameTagQuery,
  minimumSeconds = 0.2,
): Promise<TimeInterval[]> {
  const tags = await readFrameTags(
    query,
    (file) => `movie=${file},blackdetect=d=${minimumSeconds}:pix_th=0.10`,
    'frame_tags=lavfi.black_start,lavfi.black_end',
  );
  return pairIntervals(tags, 'lavfi.black_start', 'lavfi.black_end');
}

/**
 * Silent runs, via the `silencedetect` filter's frame metadata. Returns an
 * empty list for a file with no audio stream, which is not an error.
 */
export async function measureSilenceIntervals(
  query: FrameTagQuery,
  noiseFloorDb = -50,
  minimumSeconds = 0.5,
): Promise<TimeInterval[]> {
  try {
    const tags = await readFrameTags(
      query,
      (file) => `amovie=${file},silencedetect=n=${noiseFloorDb}dB:d=${minimumSeconds}`,
      'frame_tags=lavfi.silence_start,lavfi.silence_end',
    );
    return pairIntervals(tags, 'lavfi.silence_start', 'lavfi.silence_end');
  } catch {
    // `amovie` fails outright on a file with no audio — a fact already
    // recorded as `hasAudio: false`, not a measurement failure.
    return [];
  }
}

export interface BitrateMeasurement {
  readonly averageBitrateBps?: number;
  readonly peakBitrateBps?: number;
}

/**
 * Average and peak bitrate.
 *
 * Average comes from the container. Peak is computed by bucketing packet sizes
 * into one-second windows and taking the largest — the honest way to answer
 * "how heavy does this get?" without a second encode. Both are optional:
 * a container that does not report packet sizes yields no peak rather than a
 * fabricated one.
 */
export async function measureBitrate(query: FrameTagQuery): Promise<BitrateMeasurement> {
  const args = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time,size:format=bit_rate',
    '-of',
    'json',
    query.filePath,
  ];

  let stdout: string;
  try {
    ({ stdout } = await query.runner.run(query.binaries.ffprobe, args, {
      timeoutMs: query.timeoutMs ?? 5 * 60_000,
      ...(query.signal ? { signal: query.signal } : {}),
    }));
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }

  const formatBitrate = Number((parsed as { format?: { bit_rate?: string } })?.format?.bit_rate);
  const packets = (parsed as { packets?: unknown })?.packets;

  let peakBitrateBps: number | undefined;
  if (Array.isArray(packets) && packets.length > 0) {
    const bytesPerSecond = new Map<number, number>();
    for (const packet of packets) {
      const time = Number((packet as { pts_time?: string })?.pts_time);
      const size = Number((packet as { size?: string })?.size);
      if (!Number.isFinite(time) || !Number.isFinite(size)) continue;
      const bucket = Math.floor(time);
      bytesPerSecond.set(bucket, (bytesPerSecond.get(bucket) ?? 0) + size);
    }
    const peakBytes = Math.max(0, ...bytesPerSecond.values());
    if (peakBytes > 0) peakBitrateBps = Math.round(peakBytes * 8);
  }

  return {
    ...(Number.isFinite(formatBitrate) && formatBitrate > 0
      ? { averageBitrateBps: Math.round(formatBitrate) }
      : {}),
    ...(peakBitrateBps === undefined ? {} : { peakBitrateBps }),
  };
}
