import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFfmpegBinaries } from '../binaries';
import { NodeCommandRunner } from '../command-runner';
import {
  analyseClip,
  ClipAnalysisError,
  overlapsAny,
  pairIntervals,
  parseLavfiMetadata,
} from './clip-analysis';

/**
 * The parsers are tested offline; the detectors are tested against real
 * FFmpeg, because "does `blackdetect` report what I think it reports" is
 * exactly the question a fake cannot answer. The live half skips loudly when
 * the toolchain is absent, which is the normal outcome under `pnpm test`.
 */

describe('lavfi metadata parsing', () => {
  it('attributes each key to the frame time that preceded it', () => {
    const events = parseLavfiMetadata(
      [
        'frame:0    pts:0       pts_time:0',
        'lavfi.scene_score=0.041',
        'frame:45   pts:46080   pts_time:1.5',
        'lavfi.scene_score=0.812',
      ].join('\n'),
    );
    expect(events).toEqual([
      { timeSeconds: 0, key: 'lavfi.scene_score', value: '0.041' },
      { timeSeconds: 1.5, key: 'lavfi.scene_score', value: '0.812' },
    ]);
  });

  it('ignores lines that are neither a frame header nor a key/value pair', () => {
    expect(parseLavfiMetadata('\n  \nnot a pair\nframe:1 pts:1 pts_time:0.1\n')).toEqual([]);
  });

  it('pairs a start and an end into a closed interval', () => {
    const events = parseLavfiMetadata(
      [
        'frame:0 pts:0 pts_time:0',
        'lavfi.black_start=0',
        'frame:30 pts:1 pts_time:1',
        'lavfi.black_end=1',
      ].join('\n'),
    );
    expect(pairIntervals(events, 'lavfi.black_start', 'lavfi.black_end', 5)).toEqual([
      { startSeconds: 0, endSeconds: 1 },
    ]);
  });

  it('closes a region that runs to the end of the clip rather than discarding it', () => {
    // A fade-to-black that never "ends" is still black. Dropping it is how a
    // black frame reaches the front of a cut.
    const events = parseLavfiMetadata(
      ['frame:0 pts:0 pts_time:4', 'lavfi.black_start=4'].join('\n'),
    );
    expect(pairIntervals(events, 'lavfi.black_start', 'lavfi.black_end', 6)).toEqual([
      { startSeconds: 4, endSeconds: 6 },
    ]);
  });

  it('detects overlap against a candidate window', () => {
    const regions = [{ startSeconds: 2, endSeconds: 3 }];
    expect(overlapsAny(regions, 0, 1.9)).toBe(false);
    expect(overlapsAny(regions, 1.9, 2.1)).toBe(true);
    expect(overlapsAny(regions, 2.2, 2.4)).toBe(true);
    expect(overlapsAny(regions, 3, 4)).toBe(false);
  });
});

const binaries = resolveFfmpegBinaries(process.env);

function ffmpegAvailable(): boolean {
  return spawnSync(binaries.ffmpeg, ['-version'], { timeout: 15_000 }).status === 0;
}

const available = ffmpegAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  // eslint-disable-next-line no-console -- a silently skipped detector test is worse than a noisy one
  console.warn(
    `[clip-analysis] SKIPPED: ffmpeg not runnable at "${binaries.ffmpeg}". Set FFMPEG_PATH to run the live detector tests.`,
  );
}

suite('clip analysis against real FFmpeg', () => {
  let workDir: string;
  const runner = new NodeCommandRunner();

  /**
   * A purpose-built clip with three known regions: two seconds of moving
   * picture, two seconds of black, then two seconds of a held still. Built
   * from `lavfi` sources, so nothing copyrighted enters the repository and the
   * expected answer is known exactly rather than eyeballed.
   */
  async function buildProbeClip(): Promise<string> {
    const target = join(workDir, 'three-regions.mp4');
    const result = await runner.run(
      binaries.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30:duration=2',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x240:r=30:d=2',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x3366AA:s=320x240:r=30:d=2',
        '-filter_complex',
        '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
        '-map',
        '[v]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '24',
        '-pix_fmt',
        'yuv420p',
        '-y',
        target,
      ],
      { timeoutMs: 120_000 },
    );
    if (result.exitCode !== 0) throw new Error(`could not build the probe clip: ${result.stderr}`);
    return target;
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'clip-analysis-'));
  }, 60_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('finds the black region a fixture deliberately contains', async () => {
    const analysis = await analyseClip(runner, await buildProbeClip(), {
      ffmpegPath: binaries.ffmpeg,
      ffprobePath: binaries.ffprobe,
    });
    expect(analysis.unavailable).toEqual([]);
    expect(analysis.blackRegions.length).toBeGreaterThan(0);

    const black = analysis.blackRegions[0]!;
    // The fixture's black runs from 2s to 4s; allow a frame either side.
    expect(black.startSeconds).toBeGreaterThan(1.8);
    expect(black.startSeconds).toBeLessThan(2.3);
    expect(black.endSeconds).toBeGreaterThan(3.7);
  }, 180_000);

  it('finds the frozen region a fixture deliberately contains', async () => {
    const analysis = await analyseClip(runner, await buildProbeClip(), {
      ffmpegPath: binaries.ffmpeg,
      ffprobePath: binaries.ffprobe,
    });
    // Both the black stretch and the flat colour hold are frozen picture.
    expect(analysis.freezeRegions.length).toBeGreaterThan(0);
    const covered = analysis.freezeRegions.some(
      (region) => region.startSeconds < 5 && region.endSeconds > 4.5,
    );
    expect(covered, 'the held final colour was not reported as frozen').toBe(true);
  }, 180_000);

  it('reports scene boundaries at the constructed cuts, and always starts at zero', async () => {
    const analysis = await analyseClip(runner, await buildProbeClip(), {
      ffmpegPath: binaries.ffmpeg,
      ffprobePath: binaries.ffprobe,
    });
    expect(analysis.sceneBoundaries[0]).toBe(0);
    // Two hard changes were concatenated in, at 2s and 4s.
    expect(analysis.sceneBoundaries.length).toBeGreaterThanOrEqual(2);
    expect(analysis.sceneBoundaries.every((time) => time >= 0)).toBe(true);
    expect([...analysis.sceneBoundaries].sort((a, b) => a - b)).toEqual([
      ...analysis.sceneBoundaries,
    ]);
  }, 180_000);

  it('returns the same analysis for the same bytes', async () => {
    const clip = await buildProbeClip();
    const options = { ffmpegPath: binaries.ffmpeg, ffprobePath: binaries.ffprobe };
    const first = await analyseClip(runner, clip, options);
    const second = await analyseClip(runner, clip, options);
    expect(second).toEqual(first);
  }, 300_000);

  it('refuses a still image rather than analysing it as a clip', async () => {
    const still = join(workDir, 'still.png');
    await runner.run(
      binaries.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=64x64:d=1',
        '-frames:v',
        '1',
        '-y',
        still,
      ],
      { timeoutMs: 60_000 },
    );
    await expect(
      analyseClip(runner, still, { ffmpegPath: binaries.ffmpeg, ffprobePath: binaries.ffprobe }),
    ).rejects.toThrow(ClipAnalysisError);
  }, 120_000);
});
