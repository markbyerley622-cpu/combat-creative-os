import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { computeGenerationCacheKey, GenerationCache } from './generation-cache';
import { cacheRelativePath } from './scene-media';

/**
 * The cache's one job: a second run must not re-buy what the first run bought.
 *
 * This file exists because that job silently was not being done. The entry
 * recorded `originals/scene-01-….mp4` while the bytes were written to a sibling
 * `generated-originals/` folder, so every lookup read a path that did not
 * exist, correctly treated the missing file as "no usable cached clip", and
 * bought the scene again. Nothing failed, nothing warned, and ten paid requests
 * were made for five scenes.
 *
 * Every test below therefore goes through the **whole** round trip — write the
 * bytes where the run writes them, record the entry, reopen the cache from
 * disk, look it up — rather than asserting that `record` stored what it was
 * handed. A test that only checked the entry would have passed throughout.
 */

let runDirectory: string;
let cacheDirectory: string;
let originalsDirectory: string;

beforeEach(async () => {
  runDirectory = await mkdtemp(join(tmpdir(), 'aamp-generation-cache-'));
  cacheDirectory = join(runDirectory, 'generation-cache');
  originalsDirectory = join(runDirectory, 'generated-originals');
  await mkdir(cacheDirectory, { recursive: true });
  await mkdir(originalsDirectory, { recursive: true });
});

const KEY = computeGenerationCacheKey({
  inputFrameChecksumSha256: 'a'.repeat(64),
  motionPromptSha256: 'b'.repeat(64),
  model: 'ltx-2-3-fast',
  durationSeconds: 6,
  resolution: '1080x1920',
  fps: 24,
  generateAudio: false,
  cameraMotion: 'STATIC',
});

/** Writes a clip exactly where the run writes it, and records it. */
async function bought(bytes: Buffer): Promise<GenerationCache> {
  const cache = await GenerationCache.open(cacheDirectory);
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const originalPath = join(originalsDirectory, `scene-01-${checksumSha256.slice(0, 16)}.mp4`);
  await writeFile(originalPath, bytes);
  await cache.record({
    cacheKey: KEY,
    sceneNumber: 1,
    relativePath: cacheRelativePath(cache, originalPath),
    checksumSha256,
    sizeBytes: bytes.byteLength,
    durationSeconds: 6.041667,
    widthPx: 1080,
    heightPx: 1920,
    model: 'ltx-2-3-fast',
    requestedDurationSeconds: 6,
    costCents: 36,
    recordedAt: 'run:first',
  });
  return cache;
}

describe('a second run does not re-buy what the first run bought', () => {
  it('hits on a reopened cache, and resolves to the bytes that were written', async () => {
    const bytes = Buffer.from('the generated clip');
    await bought(bytes);

    // Reopened from disk, exactly as the next run would.
    const reopened = await GenerationCache.open(cacheDirectory);
    const hit = await reopened.lookup(KEY);

    expect(hit).not.toBeNull();
    expect(reopened.absolutePathFor(hit as NonNullable<typeof hit>)).toContain(
      'generated-originals',
    );
    expect(hit?.costCents).toBe(36);
  });

  it('records a path that resolves, whatever the layout', async () => {
    // The regression itself: a path composed from an assumed layout instead of
    // measured from where the file landed.
    const cache = await bought(Buffer.from('x'));
    const hit = await cache.lookup(KEY);
    expect(hit?.relativePath).toMatch(/generated-originals/);
    expect(hit?.relativePath).not.toMatch(/\\/);
  });
});

describe('a hit is byte-verified, never taken on trust', () => {
  it('misses when the file was altered after it was recorded', async () => {
    const bytes = Buffer.from('the generated clip');
    const cache = await bought(bytes);
    const entry = (await cache.lookup(KEY)) as NonNullable<
      Awaited<ReturnType<GenerationCache['lookup']>>
    >;

    await writeFile(cache.absolutePathFor(entry), Buffer.from('something else entirely'));
    expect(await cache.lookup(KEY)).toBeNull();
  });

  it('misses when the file is gone', async () => {
    const cache = await bought(Buffer.from('the generated clip'));
    const entry = (await cache.lookup(KEY)) as NonNullable<
      Awaited<ReturnType<GenerationCache['lookup']>>
    >;
    const { rm } = await import('node:fs/promises');
    await rm(cache.absolutePathFor(entry));
    expect(await cache.lookup(KEY)).toBeNull();
  });

  it('misses on a key it never saw', async () => {
    const cache = await bought(Buffer.from('the generated clip'));
    expect(await cache.lookup('f'.repeat(64))).toBeNull();
  });
});

describe('the key covers every input that could change the output', () => {
  const base = {
    inputFrameChecksumSha256: 'a'.repeat(64),
    motionPromptSha256: 'b'.repeat(64),
    model: 'ltx-2-3-fast',
    durationSeconds: 6,
    resolution: '1080x1920',
    fps: 24,
    generateAudio: false,
    cameraMotion: 'STATIC',
  } as const;

  it('changes when any one of them changes', () => {
    const variants = [
      { ...base, inputFrameChecksumSha256: 'c'.repeat(64) },
      { ...base, motionPromptSha256: 'c'.repeat(64) },
      { ...base, model: 'ltx-2-3-pro' },
      { ...base, durationSeconds: 8 },
      { ...base, resolution: '720x1280' },
      { ...base, fps: 30 },
      { ...base, generateAudio: true },
      { ...base, cameraMotion: 'CONTROLLED_PUSH_IN' },
      { ...base, lastFrameChecksumSha256: 'd'.repeat(64) },
    ];
    const keys = new Set(variants.map(computeGenerationCacheKey));
    expect(keys.has(computeGenerationCacheKey(base))).toBe(false);
    expect(keys.size).toBe(variants.length);
  });

  it('is stable across two computations of the same inputs', () => {
    expect(computeGenerationCacheKey(base)).toBe(computeGenerationCacheKey({ ...base }));
  });
});
