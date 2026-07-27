import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { CommandResult } from '../command-runner';
import type { RenderManifest } from '../render/manifest';
import { FakeCommandRunner, type RecordedCall } from './fake-command-runner';

/**
 * A fake FFmpeg toolchain complete enough to drive the whole renderer
 * offline: it answers `ffprobe` with plausible JSON, and it answers `ffmpeg`
 * by actually writing the file the invocation asked for. That is what lets
 * the renderer's own behaviour — idempotent reuse, rejected placement on a
 * failed QA check, provenance completeness — be tested without an encoder.
 */

export interface FakeToolchainOptions {
  /** Overrides the ffprobe answer for the produced file, so a QA failure can be induced. */
  readonly outputProbe?: Record<string, unknown>;
  /** Luma written into every sampled frame. A flat fill reads as a blank frame. */
  readonly framePattern?: 'DETAILED' | 'FLAT';
  /** Forces the render invocation to fail with this stderr. */
  readonly renderFailure?: { exitCode: number; stderr: string };
  readonly onRender?: () => void | Promise<void>;
  /**
   * Overrides the audio-measurement answer, so a loudness or clipping failure
   * can be induced offline.
   */
  readonly audioSummary?: FakeAudioSummary;
  /** Writes the container with `mdat` first, so the faststart check fails. */
  readonly faststart?: boolean;
}

/** The figures the fake audio decode reports back. */
export interface FakeAudioSummary {
  readonly integratedLufs: number;
  readonly loudnessRangeLu: number;
  readonly truePeakDbtp: number;
  readonly peakLevelDb: number;
  readonly absolutePeakCount: number;
  readonly silenceRunsSeconds?: readonly number[];
  readonly channelLayout?: string;
  readonly sampleRateHz?: number;
}

export const SOURCE_VIDEO_PROBE = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30/1',
      r_frame_rate: '30/1',
      pix_fmt: 'yuv420p',
      nb_frames: '180',
    },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
  ],
  format: { format_name: 'mov,mp4,m4a', duration: '6.000000' },
};

export const SOURCE_IMAGE_PROBE = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'png',
      width: 1080,
      height: 1920,
      avg_frame_rate: '0/0',
      pix_fmt: 'rgba',
      nb_frames: '1',
    },
  ],
  format: { format_name: 'png_pipe', duration: '0.000000' },
};

export const SOURCE_AUDIO_PROBE = {
  streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', channels: 2, sample_rate: '48000' }],
  format: { format_name: 'wav', duration: '20.000000' },
};

/** A conforming produced file: 1080×1920, 30 fps, H.264 + AAC in MP4. */
export function passingOutputProbe(durationSeconds: number): Record<string, unknown> {
  return {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        profile: 'High',
        width: 1080,
        height: 1920,
        avg_frame_rate: '30/1',
        r_frame_rate: '30/1',
        pix_fmt: 'yuv420p',
        nb_frames: String(Math.round(durationSeconds * 30)),
      },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
    ],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: durationSeconds.toFixed(6),
      nb_streams: 2,
    },
  };
}

function probeForSourcePath(path: string): Record<string, unknown> {
  if (/\.(png|jpe?g|webp)$/i.test(path)) return SOURCE_IMAGE_PROBE;
  if (/\.(wav|mp3|m4a|aac|flac)$/i.test(path)) return SOURCE_AUDIO_PROBE;
  return SOURCE_VIDEO_PROBE;
}

function ok(stdout: string): CommandResult {
  return { stdout, stderr: '', exitCode: 0, stderrTruncated: false };
}

/**
 * High-contrast stripes: bright pixels with dark ones a few pixels away.
 * That is both "not a blank frame" and the outlined-type signature caption
 * detection looks for, so a frame painted this way passes the pixel checks
 * the same way real picture content with burned-in captions does.
 */
function paintDetail(buffer: Buffer, width: number, from: number, to: number, phase = 0): void {
  for (let y = from; y < to; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const on = (y + phase) % 8 < 3;
      buffer[offset] = on ? 250 : 4;
      buffer[offset + 1] = on ? 250 : 4;
      buffer[offset + 2] = on ? 250 : 4;
    }
  }
}

/**
 * A phase that moves with the timeline.
 *
 * Real footage differs from frame to frame; a fake that paints the identical
 * pattern at every moment would read as a frozen picture to the freeze check
 * and make that check impossible to exercise offline. Shifting the stripes
 * with time is the smallest thing that makes the fake behave like moving
 * picture — and it is deterministic, so the render stays reproducible.
 */
function phaseFor(timeSeconds: number): number {
  return Math.round(timeSeconds * 7) % 8;
}

function paintFill(buffer: Buffer, rgb: readonly [number, number, number]): void {
  for (let i = 0; i < buffer.length; i += 3) {
    buffer[i] = rgb[0];
    buffer[i + 1] = rgb[1];
    buffer[i + 2] = rgb[2];
  }
}

function hexRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

/**
 * The three summary blocks a real `ebur128,astats,silencedetect` pass writes
 * to stderr, in the exact shape this FFmpeg family emits them — `ebur128`
 * unprefixed, `astats` prefixed with its filter instance. Pinning the shape
 * here is what lets the audio checks be exercised offline without the parsers
 * being tested against a format nothing produces.
 */
export function fakeAudioStderr(summary: FakeAudioSummary): string {
  const silence = (summary.silenceRunsSeconds ?? []).map(
    (duration, index) =>
      `[silencedetect @ 000001] silence_end: ${(index + 1) * 2} | silence_duration: ${duration}`,
  );
  return [
    `  Stream #0:0(und): Audio: aac (LC) (mp4a / 0x6134706D), ${summary.sampleRateHz ?? 48_000} Hz, ${summary.channelLayout ?? 'stereo'}, fltp, 192 kb/s`,
    ...silence,
    '[Parsed_ebur128_0 @ 000001] Summary:',
    '',
    '  Integrated loudness:',
    `    I:         ${summary.integratedLufs.toFixed(1)} LUFS`,
    '    Threshold: -24.0 LUFS',
    '',
    '  Loudness range:',
    `    LRA:        ${summary.loudnessRangeLu.toFixed(1)} LU`,
    '',
    '  True peak:',
    `    Peak:      ${summary.truePeakDbtp.toFixed(1)} dBFS`,
    '[Parsed_astats_1 @ 000002] Overall',
    `[Parsed_astats_1 @ 000002] Peak level dB: ${summary.peakLevelDb.toFixed(6)}`,
    `[Parsed_astats_1 @ 000002] Abs Peak count: ${summary.absolutePeakCount.toFixed(6)}`,
    '[Parsed_astats_1 @ 000002] Number of samples: 720000',
  ].join('\n');
}

/**
 * A container whose atom order is what the faststart check reads.
 *
 * The renderer asks FFmpeg for `+faststart`; the check reads the produced
 * file's atom table instead of trusting the flag, so the fake has to actually
 * write one. `moov` before `mdat` is faststart; the reverse is not.
 */
export function fakeMp4Container(faststart: boolean, sizeBytes = 4096): Buffer {
  const buffer = Buffer.alloc(sizeBytes, 7);
  const writeAtom = (offset: number, size: number, type: string): void => {
    buffer.writeUInt32BE(size, offset);
    buffer.write(type, offset + 4, 4, 'latin1');
  };
  writeAtom(0, 16, 'ftyp');
  if (faststart) {
    writeAtom(16, 16, 'moov');
    writeAtom(32, sizeBytes - 32, 'mdat');
  } else {
    writeAtom(16, sizeBytes - 32, 'mdat');
    writeAtom(sizeBytes - 16, 16, 'moov');
  }
  return buffer;
}

export interface FakeToolchain {
  readonly runner: FakeCommandRunner;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  renderInvocations(): readonly RecordedCall[];
}

/** Whether a recorded call is the audio-measurement decode rather than a render. */
function isAudioMeasurementCall(args: readonly string[]): boolean {
  const index = args.indexOf('-af');
  return index >= 0 && (args[index + 1] ?? '').includes('ebur128');
}

export function createFakeToolchain(
  manifest: RenderManifest,
  options: FakeToolchainOptions = {},
): FakeToolchain {
  const runner = new FakeCommandRunner();
  const ffmpegPath = 'fake-ffmpeg';
  const ffprobePath = 'fake-ffprobe';
  const outputProbe = options.outputProbe ?? passingOutputProbe(manifest.output.durationSeconds);

  runner.setResponder(ffprobePath, (call) => {
    const path = call.args[call.args.length - 1] ?? '';
    if (path.endsWith('render.mp4') || path.includes('.aamp-output') || path.endsWith('.mp4.tmp')) {
      return ok(JSON.stringify(outputProbe));
    }
    // The renderer probes sources by absolute path and the produced file by
    // its job-directory path; anything inside a job directory is the output.
    if (path.includes(`${'.jobs'}`)) return ok(JSON.stringify(outputProbe));
    return ok(JSON.stringify(probeForSourcePath(path)));
  });

  runner.setResponder(ffmpegPath, async (call) => {
    const target = call.args[call.args.length - 1] ?? '';

    // The audio-measurement decode: it writes nothing and reports its findings
    // on stderr, exactly as the real one does.
    if (isAudioMeasurementCall(call.args)) {
      const loudness = manifest.audio?.loudness ?? {
        integratedLufs: -14,
        truePeakDbtp: -1,
        loudnessRange: 11,
      };
      return {
        stdout: '',
        stderr: fakeAudioStderr(
          options.audioSummary ?? {
            integratedLufs: loudness.integratedLufs,
            loudnessRangeLu: loudness.loudnessRange,
            truePeakDbtp: loudness.truePeakDbtp,
            peakLevelDb: loudness.truePeakDbtp,
            absolutePeakCount: 1,
          },
        ),
        exitCode: 0,
        stderrTruncated: false,
      };
    }

    // Frame extraction for QA: write the raw RGB the sampler expects,
    // painted to match what the timeline actually shows at that moment.
    if (call.args.includes('rawvideo')) {
      const vf = call.args[call.args.indexOf('-vf') + 1] ?? '';
      const crop = /^crop=(\d+):(\d+):(\d+):(\d+)/.exec(vf);
      const scale = /^scale=(\d+):(\d+)/.exec(vf);
      const width = Number(crop?.[1] ?? scale?.[1] ?? 270);
      const height = Number(crop?.[2] ?? scale?.[2] ?? 480);
      const cropTop = Number(crop?.[4] ?? 0);
      const timeSeconds = Number(call.args[call.args.indexOf('-ss') + 1] ?? 0);
      const phase = phaseFor(timeSeconds);
      const buffer = Buffer.alloc(width * height * 3);

      if (options.framePattern === 'FLAT') {
        paintFill(buffer, [11, 11, 11]);
      } else if (crop) {
        // Burned-in type sits *inside* the caption band and nowhere below it.
        // A crop whose centre falls under the bottom safe margin is the
        // safe-area probe, and painting type into it would fake the very
        // violation that check exists to catch.
        const marginBottomPx = manifest.captions?.style.marginBottomPx ?? 420;
        const insideCaptionBand = cropTop + height / 2 < manifest.output.heightPx - marginBottomPx;
        const scheduled = (manifest.captions?.cues ?? []).some(
          (cue) => timeSeconds >= cue.startSeconds && timeSeconds <= cue.endSeconds,
        );
        if (insideCaptionBand && scheduled) paintDetail(buffer, width, 0, height, phase);
        else paintFill(buffer, [96, 96, 96]);
      } else if (
        manifest.cta &&
        timeSeconds >= manifest.cta.startSeconds &&
        timeSeconds <= manifest.cta.endSeconds
      ) {
        // The end card: its own background colour, with the copy band on it.
        paintFill(buffer, hexRgb(manifest.cta.backgroundHex));
        paintDetail(buffer, width, Math.round(height * 0.46), Math.round(height * 0.7), phase);
      } else {
        paintDetail(buffer, width, 0, height, phase);
      }

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buffer);
      return ok('');
    }

    if (options.renderFailure) {
      return {
        stdout: '',
        stderr: options.renderFailure.stderr,
        exitCode: options.renderFailure.exitCode,
        stderrTruncated: false,
      };
    }

    await options.onRender?.();

    // The render itself: FFmpeg is invoked with cwd set to the job directory
    // and a relative output filename, so honour both.
    const cwd = call.options?.cwd ?? process.cwd();
    const absolute = resolve(cwd, target);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, fakeMp4Container(options.faststart !== false));
    return ok('');
  });

  return {
    runner,
    ffmpegPath,
    ffprobePath,
    renderInvocations: () =>
      runner
        .callsTo(ffmpegPath)
        .filter((call) => !call.args.includes('rawvideo') && !isAudioMeasurementCall(call.args)),
  };
}

/** Writes non-empty stand-in files for every source a manifest names. */
export async function materialiseSources(manifest: RenderManifest, baseDir: string): Promise<void> {
  for (const source of manifest.sources) {
    const target = join(baseDir, source.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.alloc(2048, 3));
  }
}
