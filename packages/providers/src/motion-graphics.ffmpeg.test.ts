import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult, CommandRunner } from '@combat/media';

import {
  FfmpegMotionGraphicsProvider,
  RENDER_MANIFEST_BINDING_KEY,
} from './motion-graphics.ffmpeg';
import { MotionGraphicsProviderError, type MotionGraphicsTimeline } from './motion-graphics';

const FIXTURE_MANIFEST_PATH = resolve(
  __dirname,
  '..',
  '..',
  'media',
  'fixtures',
  'combat-reviews-15s.manifest.json',
);

const TIMELINE: MotionGraphicsTimeline = {
  aspectRatio: '9:16',
  outputFormat: 'mp4',
  durationFrames: 450,
  clips: [
    { order: 0, sourceRef: 'clip-training', inFrame: 0, outFrame: 135 },
    {
      order: 1,
      sourceRef: 'screenshot-fight-card',
      inFrame: 0,
      outFrame: 90,
      transitionIn: 'DISSOLVE',
    },
  ],
};

const NOW = new Date('2026-07-26T12:00:00.000Z');
/** Mirrors the fixture manifest's CTA window; the fake paints the end card from here on. */
const CTA_WINDOW = { startSeconds: 12, endSeconds: 15 };

let fixtureRaw: Record<string, unknown>;
let workRoot: string;
let manifestDir: string;
let outputRoot: string;

/**
 * A fake toolchain that answers ffprobe with conforming JSON and answers
 * ffmpeg by writing the file it was asked for — enough to drive the provider
 * end to end offline, including its QA gate.
 */
function fakeRunner(options: { squareOutput?: boolean } = {}): CommandRunner & {
  renderCount: () => number;
} {
  let renders = 0;
  const ok = (stdout: string): CommandResult => ({
    stdout,
    stderr: '',
    exitCode: 0,
    stderrTruncated: false,
  });

  const outputProbe = JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: options.squareOutput ? 1080 : 1080,
        height: options.squareOutput ? 1080 : 1920,
        avg_frame_rate: '30/1',
        pix_fmt: 'yuv420p',
        nb_frames: '450',
      },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
    ],
    format: { format_name: 'mov,mp4,m4a', duration: '15.000000' },
  });

  const runner: CommandRunner & { renderCount: () => number } = {
    renderCount: () => renders,
    async run(command, args, runOptions) {
      const target = args[args.length - 1] ?? '';
      if (command.includes('ffprobe')) {
        const path = target;
        if (path.includes('.jobs')) return ok(outputProbe);
        if (/\.(png)$/i.test(path)) {
          return ok(
            JSON.stringify({
              streams: [
                {
                  codec_type: 'video',
                  codec_name: 'png',
                  width: 1080,
                  height: 1920,
                  avg_frame_rate: '0/0',
                  nb_frames: '1',
                },
              ],
              format: { format_name: 'png_pipe', duration: '0.000000' },
            }),
          );
        }
        if (/\.(wav)$/i.test(path)) {
          return ok(
            JSON.stringify({
              streams: [
                { codec_type: 'audio', codec_name: 'pcm_s16le', channels: 2, sample_rate: '48000' },
              ],
              format: { format_name: 'wav', duration: '20.000000' },
            }),
          );
        }
        return ok(
          JSON.stringify({
            streams: [
              {
                codec_type: 'video',
                codec_name: 'h264',
                width: 1920,
                height: 1080,
                avg_frame_rate: '30/1',
                nb_frames: '180',
              },
              { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
            ],
            format: { format_name: 'mov,mp4,m4a', duration: '6.000000' },
          }),
        );
      }

      if (args.includes('rawvideo')) {
        const vf = args[args.indexOf('-vf') + 1] ?? '';
        const crop = /^crop=(\d+):(\d+)/.exec(vf);
        const scale = /^scale=(\d+):(\d+)/.exec(vf);
        const width = Number(crop?.[1] ?? scale?.[1] ?? 270);
        const height = Number(crop?.[2] ?? scale?.[2] ?? 480);
        const timeSeconds = Number(args[args.indexOf('-ss') + 1] ?? 0);
        const pixels = Buffer.alloc(width * height * 3);

        // High-contrast stripes read as both picture detail and outlined
        // type; the CTA window instead reads as the end card's own colour
        // with a band of copy on it. Painting the frame the way the timeline
        // actually looks is what lets the provider's QA gate be exercised.
        const stripe = (from: number, to: number): void => {
          for (let y = from; y < to; y += 1) {
            for (let x = 0; x < width; x += 1) {
              const offset = (y * width + x) * 3;
              const on = y % 8 < 3;
              pixels[offset] = on ? 250 : 4;
              pixels[offset + 1] = on ? 250 : 4;
              pixels[offset + 2] = on ? 250 : 4;
            }
          }
        };

        if (crop) {
          // A caption-band crop: type is only there while a cue is
          // scheduled, which is what the caption-timing check compares.
          const cues = (
            fixtureRaw as { captions: { cues: { startSeconds: number; endSeconds: number }[] } }
          ).captions.cues;
          const scheduled = cues.some(
            (cue) => timeSeconds >= cue.startSeconds && timeSeconds <= cue.endSeconds,
          );
          if (scheduled) stripe(0, height);
          else pixels.fill(96);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, pixels);
          return ok('');
        }

        if (timeSeconds >= CTA_WINDOW.startSeconds) {
          for (let i = 0; i < pixels.length; i += 3) {
            pixels[i] = 0x0b;
            pixels[i + 1] = 0x0b;
            pixels[i + 2] = 0x0f;
          }
          stripe(Math.round(height * 0.46), Math.round(height * 0.7));
        } else {
          stripe(0, height);
        }

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, pixels);
        return ok('');
      }

      renders += 1;
      const absolute = resolve(runOptions?.cwd ?? process.cwd(), target);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, Buffer.alloc(4096, 9));
      return ok('');
    },
  };
  return runner;
}

function createProvider(runner: CommandRunner): FfmpegMotionGraphicsProvider {
  return new FfmpegMotionGraphicsProvider({
    outputRoot,
    manifestDir,
    allowedSourceRoots: [manifestDir],
    binaries: { ffmpeg: 'fake-ffmpeg', ffprobe: 'fake-ffprobe' },
    runner,
    clock: () => NOW,
  });
}

beforeAll(async () => {
  fixtureRaw = JSON.parse(await readFile(FIXTURE_MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
});

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'combat-mg-'));
  manifestDir = join(workRoot, 'manifest');
  outputRoot = join(workRoot, 'out');
  const sources = (fixtureRaw as { sources: { path: string }[] }).sources;
  for (const source of sources) {
    const target = join(manifestDir, source.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.alloc(2048, 3));
  }
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function manifestBinding(mutate?: (raw: Record<string, any>) => void): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(fixtureRaw)) as Record<string, any>;
  mutate?.(clone);
  return { [RENDER_MANIFEST_BINDING_KEY]: clone };
}

describe('FfmpegMotionGraphicsProvider — the interface contract, unchanged', () => {
  it('advertises only what it can actually deliver', () => {
    const provider = createProvider(fakeRunner());
    const capabilities = provider.getCapabilities();
    expect(capabilities.outputFormats).toEqual(['mp4']);
    expect(capabilities.aspectRatios).toEqual(['9:16']);
  });

  it('is idempotent on createProject and submitRender', async () => {
    const provider = createProvider(fakeRunner());
    const a = await provider.createProject({ idempotencyKey: 'k', campaignId: 'c', name: 'n' });
    const b = await provider.createProject({ idempotencyKey: 'k', campaignId: 'c', name: 'n' });
    expect(b.projectId).toBe(a.projectId);

    const first = await provider.submitRender({
      idempotencyKey: 'r',
      projectId: a.projectId,
      timeline: TIMELINE,
      dataBindings: manifestBinding(),
    });
    const second = await provider.submitRender({
      idempotencyKey: 'r',
      projectId: a.projectId,
      timeline: TIMELINE,
      dataBindings: manifestBinding(),
    });
    expect(second.jobId).toBe(first.jobId);
  });

  it('rejects an unsupported capability combination before recording any state', async () => {
    const provider = createProvider(fakeRunner());
    await expect(
      provider.submitRender({
        idempotencyKey: 'bad',
        projectId: 'p',
        timeline: { ...TIMELINE, aspectRatio: '16:9' },
        dataBindings: manifestBinding(),
      }),
    ).rejects.toThrow(MotionGraphicsProviderError);
  });

  it('rejects a submission with no render manifest, rather than guessing one from the timeline', async () => {
    const provider = createProvider(fakeRunner());
    await expect(
      provider.submitRender({ idempotencyKey: 'x', projectId: 'p', timeline: TIMELINE }),
    ).rejects.toThrow(/renderManifest is required/);
  });

  it('rejects an invalid render manifest with the validation detail attached', async () => {
    const provider = createProvider(fakeRunner());
    await expect(
      provider.submitRender({
        idempotencyKey: 'y',
        projectId: 'p',
        timeline: TIMELINE,
        dataBindings: manifestBinding((raw) => {
          raw.scenes[0].durationSeconds = 99;
        }),
      }),
    ).rejects.toThrow(/Render manifest is invalid/);
  });
});

describe('FfmpegMotionGraphicsProvider — rendering', () => {
  it('reaches SUCCEEDED and hands back an output ref describing real bytes', async () => {
    const provider = createProvider(fakeRunner());
    const handle = await provider.submitRender({
      idempotencyKey: 'ok',
      projectId: 'p',
      timeline: TIMELINE,
      dataBindings: manifestBinding(),
    });

    const status = await provider.waitForCompletion(handle);
    expect(await provider.getFailure(handle)).toBeNull();
    expect(status).toBe('SUCCEEDED');

    const output = await provider.fetchRenderOutput(handle);
    expect(output.format).toBe('mp4');
    expect(output.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(output.durationFrames).toBe(450);
    expect(output.s3Key).toMatch(/combat-reviews-vertical-15s-[0-9a-f]{16}\.mp4$/);
  });

  it('reports a local render as costing nothing, and its compute in frames', async () => {
    const provider = createProvider(fakeRunner());
    const handle = await provider.submitRender({
      idempotencyKey: 'cost',
      projectId: 'p',
      timeline: TIMELINE,
      dataBindings: manifestBinding(),
    });
    await provider.waitForCompletion(handle);
    await expect(provider.getUsage(handle)).resolves.toEqual({
      costCents: 0,
      currency: 'USD',
      computeUnits: 450,
    });
  });

  it('FAILS a render whose actual-media QA failed, and refuses to hand back its output', async () => {
    const provider = createProvider(fakeRunner({ squareOutput: true }));
    const handle = await provider.submitRender({
      idempotencyKey: 'qa-fail',
      projectId: 'p',
      timeline: TIMELINE,
      dataBindings: manifestBinding(),
    });

    expect(await provider.waitForCompletion(handle)).toBe('FAILED');
    const failure = await provider.getFailure(handle);
    expect(failure?.reason).toBe('PROVIDER_REJECTED');
    expect(failure?.message).toMatch(/actual-media QA failed/);
    await expect(provider.fetchRenderOutput(handle)).rejects.toThrow(/has no output/);
  });

  it('FAILS with the underlying detail when resolution rejects a source', async () => {
    const provider = createProvider(fakeRunner());
    const handle = await provider.submitRender({
      idempotencyKey: 'unlicensed',
      projectId: 'p',
      timeline: TIMELINE,
      dataBindings: manifestBinding((raw) => {
        raw.sources[4].license.usageClass = 'ANALYSIS_ONLY';
      }),
    });

    expect(await provider.waitForCompletion(handle)).toBe('FAILED');
    const failure = await provider.getFailure(handle);
    expect(failure?.reason).toBe('PROVIDER_ERROR');
    expect(failure?.message).toMatch(/may not contribute to output/);
  });

  it('does not re-encode when the same idempotency key is submitted after completion', async () => {
    const runner = fakeRunner();
    const provider = createProvider(runner);
    const handle = await provider.submitRender({
      idempotencyKey: 'once',
      projectId: 'p',
      timeline: TIMELINE,
      dataBindings: manifestBinding(),
    });
    await provider.waitForCompletion(handle);
    expect(runner.renderCount()).toBe(1);

    const again = await provider.submitRender({
      idempotencyKey: 'once',
      projectId: 'p',
      timeline: TIMELINE,
      dataBindings: manifestBinding(),
    });
    expect(again.jobId).toBe(handle.jobId);
    expect(runner.renderCount()).toBe(1);
  });

  it('marks a cancelled render CANCELLED rather than SUCCEEDED', async () => {
    const provider = createProvider(fakeRunner());
    const handle = await provider.submitRender({
      idempotencyKey: 'cancel',
      projectId: 'p',
      timeline: TIMELINE,
      dataBindings: manifestBinding(),
    });
    await provider.cancel(handle);
    await provider.waitForCompletion(handle);
    expect(await provider.getStatus(handle)).toBe('CANCELLED');
  });
});
