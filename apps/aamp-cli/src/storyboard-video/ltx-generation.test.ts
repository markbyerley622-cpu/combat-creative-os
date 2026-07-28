import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LtxHostedVideoGenerationProvider, type VideoGenerationProvider } from '@combat/providers';
import { FakeLtxServer } from '@combat/providers/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { GenerationCache } from './generation-cache';
import { canonicalFrameId, type ResolvedKeyframe } from './keyframe-library';
import { modeReachesGenerationProvider, parseSceneManifest } from './scene-manifest';
import { generateSceneClip, assertGeneratedMediaUsable } from './scene-media';

/**
 * The generation stage, driven against the in-process fake LTX server.
 *
 * Zero money, zero third-party contact. What these prove is the behaviour that
 * decides whether a re-run is free and whether a product screen can ever reach
 * a generative model — the two properties where being wrong is expensive in
 * different currencies.
 */

const API_KEY = 'ltx_test_key_do_not_use_0123456789';

let directory: string;
let framePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ltx-gen-'));
  framePath = join(directory, 'FRAME-01.png');
  await writeFile(framePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
});

function keyframe(sceneNumber = 1): ResolvedKeyframe {
  return {
    sceneNumber,
    frameId: canonicalFrameId(sceneNumber),
    absolutePath: framePath,
    fileName: `${canonicalFrameId(sceneNumber)}.png`,
    checksumSha256: 'a'.repeat(64),
    sizeBytes: 7,
    widthPx: 1080,
    heightPx: 1920,
    mimeType: 'image/png',
  };
}

function scene(overrides: Record<string, unknown> = {}) {
  return {
    sceneNumber: 1,
    sourceFrame: 'FRAME-01',
    outputStartSeconds: 0,
    outputEndSeconds: 1.1,
    generationMode: 'LTX_IMAGE_TO_VIDEO' as const,
    motionPrompt: 'A figure breathes in low light. Do not alter any lettering or mark in frame.',
    cameraMotion: 'SLOW_PUSH_IN' as const,
    preserveExactTypography: false,
    preserveExactProductUi: false,
    acceptableFootageRoles: [],
    intent: 'hook',
    ...overrides,
  };
}

/** ffprobe answers for a real 1080x1920 six-second clip. */
const goodRunner = {
  run: async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }],
      format: { duration: '6.000000' },
    }),
    stderr: '',
  }),
} as never;

const binaries = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } as never;

function provider(server: FakeLtxServer): VideoGenerationProvider {
  return new LtxHostedVideoGenerationProvider({
    apiKey: API_KEY,
    model: 'ltx-2-3-fast',
    baseUrl: 'https://api.ltx.io',
    outputTimeoutMs: 60_000,
    outputDirectory: join(directory, 'provider-out'),
    fetchImpl: server.fetch,
    hostAllowance: { additionalTransferHostSuffixes: [server.transferHost] },
  });
}

async function generate(
  server: FakeLtxServer,
  cache: GenerationCache,
  overrides: Record<string, unknown> = {},
) {
  return generateSceneClip({
    scene: scene() as never,
    keyframe: keyframe(),
    provider: provider(server),
    model: 'ltx-2-3-fast',
    generateAudio: false,
    requiredSourceSeconds: 1.45,
    cache,
    originalsDirectory: join(directory, 'generated-originals'),
    workflowRunId: 'run-1',
    pollIntervalMs: 0,
    sleep: async () => undefined,
    runner: goodRunner,
    binaries,
    ...overrides,
  } as never);
}

describe('generation stage — buying and keeping footage', () => {
  it('buys the minimum supported duration that covers the scene and keeps the whole original', async () => {
    const server = new FakeLtxServer();
    const cache = await GenerationCache.open(join(directory, 'cache'));
    const clip = await generate(server, cache);

    // 1.45s needed, six-second floor.
    expect(clip.requestedDurationSeconds).toBe(6);
    expect(clip.originalDurationSeconds).toBe(6);
    expect(clip.costCents).toBe(36);
    expect(clip.ltxCalled).toBe(true);
    expect(clip.cacheHit).toBe(false);
    // The complete original is on disk, untrimmed.
    await expect(readFile(clip.originalPath)).resolves.toBeInstanceOf(Buffer);
  });

  it('records the exact submitted prompt checksum', async () => {
    const server = new FakeLtxServer();
    const cache = await GenerationCache.open(join(directory, 'cache'));
    const clip = await generate(server, cache);
    expect(clip.promptSha256).toMatch(/^[0-9a-f]{64}$/);

    const submitted = server.requests.find((r) => r.path === '/v2/image-to-video');
    expect((submitted?.body as { prompt: string }).prompt).toBe(scene().motionPrompt);
  });
});

describe('generation cache — a repeated run makes zero second calls', () => {
  it('records an entry keyed by everything that could change the output', async () => {
    const server = new FakeLtxServer();
    const cacheDirectory = join(directory, 'cache');
    const first = await generate(server, await GenerationCache.open(cacheDirectory));

    expect(first.ltxCalled).toBe(true);
    const entries = await readCacheKeys(cacheDirectory);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.cacheKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('spends nothing and calls nothing on the second run when the bytes still verify', async () => {
    const server = new FakeLtxServer();
    const cacheDirectory = join(directory, 'cache');
    const cache = await GenerationCache.open(cacheDirectory);

    const first = await generate(server, cache);
    // Put the original where the cache says it is, so the hit verifies.
    const { mkdir, copyFile } = await import('node:fs/promises');
    await mkdir(join(cacheDirectory, 'originals'), { recursive: true });
    const keys = await readCacheKeys(cacheDirectory);
    const relative = keys[0]?.relativePath as string;
    await copyFile(first.originalPath, join(cacheDirectory, relative));

    const callsAfterFirst = server.requests.length;
    const second = await generate(server, await GenerationCache.open(cacheDirectory));

    expect(second.cacheHit).toBe(true);
    expect(second.ltxCalled).toBe(false);
    expect(second.costCents).toBe(0);
    // Not one further request of any kind.
    expect(server.requests.length).toBe(callsAfterFirst);
    expect(server.submissions).toBe(1);
  });
});

describe('generation stage — failures are never papered over', () => {
  it('surfaces a failed job and never retries the paid call', async () => {
    const server = new FakeLtxServer({ defaultJob: { terminal: 'failed' } });
    const cache = await GenerationCache.open(join(directory, 'cache'));
    await expect(generate(server, cache)).rejects.toMatchObject({ kind: 'GENERATION_FAILED' });
    expect(server.submissions).toBe(1);
  });

  it('maps a payment refusal to its own failure kind', async () => {
    const server = new FakeLtxServer({ submitStatus: 402 });
    const cache = await GenerationCache.open(join(directory, 'cache'));
    await expect(generate(server, cache)).rejects.toMatchObject({ kind: 'PAYMENT_REQUIRED' });
  });

  it('maps throttling to its own failure kind, and does not retry', async () => {
    const server = new FakeLtxServer({ submitStatus: 429, retryAfterSeconds: 30 });
    const cache = await GenerationCache.open(join(directory, 'cache'));
    await expect(generate(server, cache)).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
    expect(server.requests.filter((r) => r.path === '/v2/image-to-video')).toHaveLength(1);
  });

  it('refuses a clip at the wrong geometry rather than rendering it', () => {
    expect(() =>
      assertGeneratedMediaUsable(
        { durationSeconds: 6, widthPx: 1920, heightPx: 1080, videoCodec: 'h264', hasAudio: false },
        3,
        1.45,
      ),
    ).toThrow(/1920x1080, not 1080x1920/);
  });

  it('refuses a clip shorter than the scene rather than stretching it', () => {
    expect(() =>
      assertGeneratedMediaUsable(
        {
          durationSeconds: 1.0,
          widthPx: 1080,
          heightPx: 1920,
          videoCodec: 'h264',
          hasAudio: false,
        },
        3,
        1.45,
      ),
    ).toThrow(/never stretched to fit/);
  });

  it('refuses a file that reports no duration', () => {
    expect(() =>
      assertGeneratedMediaUsable(
        { durationSeconds: 0, widthPx: 1080, heightPx: 1920, videoCodec: 'h264', hasAudio: false },
        3,
        1.45,
      ),
    ).toThrow(/not footage/);
  });
});

describe('exact-UI scenes never reach a generation provider', () => {
  it('is a property of the mode, not a downstream check', () => {
    const parsed = parseSceneManifest({
      manifestVersion: 1,
      storyboardId: 'X',
      authoredBy: 'a person',
      scenes: Array.from({ length: 10 }, (_, index) => ({
        sceneNumber: index + 1,
        sourceFrame: canonicalFrameId(index + 1),
        outputStartSeconds: index,
        outputEndSeconds: index + 1,
        generationMode: [3, 4, 6].includes(index + 1)
          ? 'EXACT_UI_MOTION'
          : index + 1 === 10
            ? 'STATIC_BRAND_COMPOSITION'
            : 'LTX_IMAGE_TO_VIDEO',
        motionPrompt: 'x. Do not alter anything.',
        cameraMotion: 'STATIC',
        preserveExactTypography: [3, 4, 6, 10].includes(index + 1),
        preserveExactProductUi: [3, 4, 6, 10].includes(index + 1),
        acceptableFootageRoles: [],
        intent: 'x',
      })),
    });

    const submittable = parsed.scenes
      .filter((s) => modeReachesGenerationProvider(s.generationMode))
      .map((s) => s.sceneNumber);
    expect(submittable).toEqual([1, 2, 5, 7, 8, 9]);
    // The four product/brand scenes are absent by construction.
    for (const sceneNumber of [3, 4, 6, 10]) {
      expect(submittable).not.toContain(sceneNumber);
    }
  });
});

/** Reads the cache file directly, so a test can find where an entry was stored. */
async function readCacheKeys(
  cacheDirectory: string,
): Promise<{ cacheKey: string; relativePath: string }[]> {
  const text = await readFile(join(cacheDirectory, 'generation-cache.json'), 'utf8');
  return (JSON.parse(text) as { entries: { cacheKey: string; relativePath: string }[] }).entries;
}
