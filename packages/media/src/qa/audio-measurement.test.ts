import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFfmpegBinaries } from '../binaries';
import { NodeCommandRunner } from '../command-runner';
import {
  deriveClippedSampleCount,
  measureRenderedAudio,
  parseAstatsSummary,
  parseChannelCount,
  parseEbur128Summary,
  parseSilenceRuns,
} from './audio-measurement';

/**
 * The parsers are pinned against output copied from a real FFmpeg run, so a
 * change in this build's formatting fails here rather than silently turning
 * every loudness measurement into `null`. The live half then proves the whole
 * path against a file whose loudness is known because it was normalised to a
 * requested target on the way in.
 */

const REAL_EBUR128_OUTPUT = [
  '[Parsed_ebur128_0 @ 0000024d10e4db80] Summary:',
  '',
  '  Integrated loudness:',
  '    I:         -21.8 LUFS',
  '    Threshold: -31.8 LUFS',
  '',
  '  Loudness range:',
  '    LRA:        20.0 LU',
  '    Threshold: -41.8 LUFS',
  '    LRA low:   -41.8 LUFS',
  '    LRA high:  -21.8 LUFS',
  '',
  '  True peak:',
  '    Peak:      -20.8 dBFS',
].join('\n');

const REAL_ASTATS_OUTPUT = [
  '[Parsed_astats_1 @ 0000024d10e4e300] Overall',
  '[Parsed_astats_1 @ 0000024d10e4e300] DC offset: -0.000000',
  '[Parsed_astats_1 @ 0000024d10e4e300] Peak level dB: -20.827200',
  '[Parsed_astats_1 @ 0000024d10e4e300] Peak count: 2.000000',
  '[Parsed_astats_1 @ 0000024d10e4e300] Abs Peak count: 1.000000',
  '[Parsed_astats_1 @ 0000024d10e4e300] Number of samples: 144384',
].join('\n');

describe('audio measurement parsing', () => {
  it('reads the integrated loudness, range and true peak an FFmpeg build actually prints', () => {
    expect(parseEbur128Summary(REAL_EBUR128_OUTPUT)).toEqual({
      integratedLufs: -21.8,
      loudnessRangeLu: 20,
      truePeakDbtp: -20.8,
    });
  });

  it('reads past the filter-instance prefix astats puts on every line', () => {
    expect(parseAstatsSummary(REAL_ASTATS_OUTPUT)).toEqual({
      peakDb: -20.8272,
      absolutePeakCount: 1,
    });
  });

  it('returns null rather than a guess when a summary is absent', () => {
    expect(parseEbur128Summary('no audio here')).toEqual({
      integratedLufs: null,
      loudnessRangeLu: null,
      truePeakDbtp: null,
    });
    expect(parseAstatsSummary('no audio here')).toEqual({
      peakDb: null,
      absolutePeakCount: null,
    });
  });

  it('derives clipping from the peak, and refuses to invent a zero', () => {
    // Below full scale, nothing reached it.
    expect(deriveClippedSampleCount(-20.8, 1)).toBe(0);
    // At or above full scale, the absolute-peak count is the clipped count.
    expect(deriveClippedSampleCount(0, 1234)).toBe(1234);
    expect(deriveClippedSampleCount(0.4, 12)).toBe(12);
    // An unreadable peak is unknown, not clean.
    expect(deriveClippedSampleCount(null, 0)).toBeNull();
    expect(deriveClippedSampleCount(0, null)).toBeNull();
  });

  it('reads a channel layout as a count', () => {
    expect(
      parseChannelCount('Stream #0:0(und): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s'),
    ).toBe(2);
    expect(parseChannelCount('Audio: pcm_s16le, 44100 Hz, mono, s16, 705 kb/s')).toBe(1);
    expect(parseChannelCount('Video: h264, 1080x1920')).toBeNull();
  });

  it('reads every silence run, so the longest can be found', () => {
    expect(
      parseSilenceRuns(
        [
          '[silencedetect @ 0x1] silence_start: 1.0',
          '[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 1.5',
          '[silencedetect @ 0x1] silence_end: 9.0 | silence_duration: 3.25',
        ].join('\n'),
      ),
    ).toEqual([1.5, 3.25]);
  });
});

const binaries = resolveFfmpegBinaries(process.env);

function ffmpegAvailable(): boolean {
  return spawnSync(binaries.ffmpeg, ['-version'], { timeout: 15_000 }).status === 0;
}

const available = ffmpegAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  // eslint-disable-next-line no-console -- a silently skipped measurement test is worse than a noisy one
  console.warn(
    `[audio-measurement] SKIPPED: ffmpeg not runnable at "${binaries.ffmpeg}". Set FFMPEG_PATH to run the live measurement tests.`,
  );
}

suite('audio measurement against real FFmpeg', () => {
  let workDir: string;
  const runner = new NodeCommandRunner();

  /** A tone normalised to a known loudness, so the expected answer is known. */
  async function buildTone(targetLufs: number, name: string): Promise<string> {
    const target = join(workDir, name);
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
        'sine=frequency=440:duration=6:sample_rate=48000',
        '-af',
        `aformat=channel_layouts=stereo,loudnorm=I=${targetLufs}:TP=-1:LRA=11`,
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-y',
        target,
      ],
      { timeoutMs: 180_000 },
    );
    if (result.exitCode !== 0) throw new Error(`could not build the tone: ${result.stderr}`);
    return target;
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'audio-measure-'));
  }, 60_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('measures a loudness close to the one the file was normalised to', async () => {
    const measurement = await measureRenderedAudio(runner, await buildTone(-16, 'minus16.m4a'), {
      ffmpegPath: binaries.ffmpeg,
    });
    expect(measurement.integratedLufs).not.toBeNull();
    expect(Math.abs((measurement.integratedLufs as number) - -16)).toBeLessThan(2.5);
  }, 240_000);

  it('distinguishes two files normalised to different targets', async () => {
    const quiet = await measureRenderedAudio(runner, await buildTone(-24, 'minus24.m4a'), {
      ffmpegPath: binaries.ffmpeg,
    });
    const loud = await measureRenderedAudio(runner, await buildTone(-12, 'minus12.m4a'), {
      ffmpegPath: binaries.ffmpeg,
    });
    // The measurement tracks the file, not the request: if it did not, these
    // two would agree.
    expect(loud.integratedLufs as number).toBeGreaterThan((quiet.integratedLufs as number) + 6);
  }, 300_000);

  it('reports a peak, its basis, no clipping, the layout and the sample rate', async () => {
    const measurement = await measureRenderedAudio(runner, await buildTone(-16, 'peak.m4a'), {
      ffmpegPath: binaries.ffmpeg,
    });
    expect(measurement.peakBasis).toBe('TRUE_PEAK');
    expect(measurement.peakDbtp).not.toBeNull();
    expect(measurement.peakDbtp as number).toBeLessThan(0);
    expect(measurement.clippedSampleCount).toBe(0);
    expect(measurement.channelCount).toBe(2);
    expect(measurement.sampleRateHz).toBe(48_000);
    expect(measurement.unavailable).toEqual([]);
  }, 240_000);

  it('finds the silent gap a fixture deliberately contains', async () => {
    const target = join(workDir, 'gap.m4a');
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
        'sine=frequency=440:duration=2:sample_rate=48000',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo:d=3',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2:sample_rate=48000',
        '-filter_complex',
        '[0:a]aformat=channel_layouts=stereo[a0];[2:a]aformat=channel_layouts=stereo[a2];[a0][1:a][a2]concat=n=3:v=0:a=1[a]',
        '-map',
        '[a]',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-y',
        target,
      ],
      { timeoutMs: 180_000 },
    );
    if (result.exitCode !== 0) throw new Error(`could not build the gapped tone: ${result.stderr}`);

    const measurement = await measureRenderedAudio(runner, target, { ffmpegPath: binaries.ffmpeg });
    expect(measurement.longestSilenceSeconds).not.toBeNull();
    expect(measurement.longestSilenceSeconds as number).toBeGreaterThan(2.5);
  }, 240_000);

  it('reports the reason rather than a value when the file has no audio at all', async () => {
    const silent = join(workDir, 'silent.mp4');
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
        'testsrc2=size=128x128:rate=15:duration=1',
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-y',
        silent,
      ],
      { timeoutMs: 120_000 },
    );

    const measurement = await measureRenderedAudio(runner, silent, { ffmpegPath: binaries.ffmpeg });
    expect(measurement.integratedLufs).toBeNull();
    expect(measurement.peakBasis).toBe('UNAVAILABLE');
    expect(measurement.unavailable.join(' ')).toContain('AUDIO_MEASUREMENT_UNAVAILABLE');
  }, 180_000);
});
