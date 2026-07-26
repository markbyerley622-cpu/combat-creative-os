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
function paintDetail(buffer: Buffer, width: number, from: number, to: number): void {
  for (let y = from; y < to; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const on = y % 8 < 3;
      buffer[offset] = on ? 250 : 4;
      buffer[offset + 1] = on ? 250 : 4;
      buffer[offset + 2] = on ? 250 : 4;
    }
  }
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

export interface FakeToolchain {
  readonly runner: FakeCommandRunner;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  renderInvocations(): readonly RecordedCall[];
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

    // Frame extraction for QA: write the raw RGB the sampler expects,
    // painted to match what the timeline actually shows at that moment.
    if (call.args.includes('rawvideo')) {
      const vf = call.args[call.args.indexOf('-vf') + 1] ?? '';
      const crop = /^crop=(\d+):(\d+)/.exec(vf);
      const scale = /^scale=(\d+):(\d+)/.exec(vf);
      const width = Number(crop?.[1] ?? scale?.[1] ?? 270);
      const height = Number(crop?.[2] ?? scale?.[2] ?? 480);
      const timeSeconds = Number(call.args[call.args.indexOf('-ss') + 1] ?? 0);
      const buffer = Buffer.alloc(width * height * 3);

      if (options.framePattern === 'FLAT') {
        paintFill(buffer, [11, 11, 11]);
      } else if (crop) {
        // A caption-band crop. Type appears only while a cue is scheduled,
        // which is what makes the caption-timing comparison meaningful.
        const scheduled = (manifest.captions?.cues ?? []).some(
          (cue) => timeSeconds >= cue.startSeconds && timeSeconds <= cue.endSeconds,
        );
        if (scheduled) paintDetail(buffer, width, 0, height);
        else paintFill(buffer, [96, 96, 96]);
      } else if (
        manifest.cta &&
        timeSeconds >= manifest.cta.startSeconds &&
        timeSeconds <= manifest.cta.endSeconds
      ) {
        // The end card: its own background colour, with the copy band on it.
        paintFill(buffer, hexRgb(manifest.cta.backgroundHex));
        paintDetail(buffer, width, Math.round(height * 0.46), Math.round(height * 0.7));
      } else {
        paintDetail(buffer, width, 0, height);
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
    await writeFile(absolute, Buffer.alloc(4096, 7));
    return ok('');
  });

  return {
    runner,
    ffmpegPath,
    ffprobePath,
    renderInvocations: () =>
      runner.callsTo(ffmpegPath).filter((call) => !call.args.includes('rawvideo')),
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
