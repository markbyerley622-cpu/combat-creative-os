import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { StoryboardVideoError } from './failures';

/**
 * Generated clips, addressed by what produced them.
 *
 * The cache key covers every input that could change the output: the start
 * frame's bytes, the optional last frame's bytes, the exact prompt, the model,
 * the duration, the resolution, the frame rate, whether audio was asked for,
 * and the camera motion. Change any one of them and the key changes, so a
 * re-run with an edited prompt regenerates rather than silently reusing the
 * clip the old prompt produced.
 *
 * The cache exists to stop a re-run costing money twice, and it is only
 * trustworthy if a hit is verified: an entry whose file is missing, resized or
 * altered is a miss, not a hit. Reuse is **byte-verified** on every read —
 * trusting a recorded checksum without recomputing it would make the cache
 * exactly as reliable as the last thing that wrote to the directory.
 *
 * `--regenerate-scene` bypasses a hit for one scene, and nothing else does.
 */

export const GENERATION_CACHE_VERSION = 1 as const;
export const GENERATION_CACHE_FILENAME = 'generation-cache.json';

export interface GenerationCacheKeyInput {
  readonly inputFrameChecksumSha256: string;
  readonly lastFrameChecksumSha256?: string;
  readonly motionPromptSha256: string;
  readonly model: string;
  readonly durationSeconds: number;
  readonly resolution: string;
  readonly fps: number;
  readonly generateAudio: boolean;
  readonly cameraMotion: string;
}

/**
 * A stable, order-independent digest of the key inputs.
 *
 * Built from an explicit, ordered list of `name=value` pairs rather than
 * `JSON.stringify` of an object: key order in a serialised object is an
 * implementation detail, and a cache key that depends on one would change
 * under an innocent refactor and silently re-bill every scene.
 */
export function computeGenerationCacheKey(input: GenerationCacheKeyInput): string {
  const parts = [
    `v=${GENERATION_CACHE_VERSION}`,
    `frame=${input.inputFrameChecksumSha256.toLowerCase()}`,
    `last=${(input.lastFrameChecksumSha256 ?? 'none').toLowerCase()}`,
    `prompt=${input.motionPromptSha256.toLowerCase()}`,
    `model=${input.model}`,
    `duration=${input.durationSeconds}`,
    `resolution=${input.resolution}`,
    `fps=${input.fps}`,
    `audio=${input.generateAudio ? 'yes' : 'no'}`,
    `camera=${input.cameraMotion}`,
  ];
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

const CacheEntrySchema = z
  .object({
    cacheKey: z.string().regex(/^[0-9a-f]{64}$/),
    sceneNumber: z.number().int().min(1).max(64),
    /** Relative to the cache directory, so a moved run directory still resolves. */
    relativePath: z.string().min(1),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().positive(),
    durationSeconds: z.number().positive(),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
    model: z.string().min(1),
    requestedDurationSeconds: z.number().positive(),
    costCents: z.number().int().min(0),
    /** No URL, no credential, no job token — only what a later reader needs. */
    recordedAt: z.string().min(1),
  })
  .strict();
export type GenerationCacheEntry = z.infer<typeof CacheEntrySchema>;

const CacheFileSchema = z
  .object({
    cacheVersion: z.literal(GENERATION_CACHE_VERSION),
    entries: z.array(CacheEntrySchema).default([]),
  })
  .strict();

export class GenerationCache {
  private readonly entries = new Map<string, GenerationCacheEntry>();

  private constructor(
    private readonly cacheDirectory: string,
    private readonly cacheFilePath: string,
  ) {}

  /**
   * Loads a cache, tolerating an absent or unreadable one.
   *
   * A corrupt cache file is an empty cache, not a failed run: the cost of
   * being wrong is regenerating, which is recoverable, while refusing to start
   * because a JSON file went bad is not.
   */
  static async open(cacheDirectory: string): Promise<GenerationCache> {
    const directory = resolve(cacheDirectory);
    const cache = new GenerationCache(directory, join(directory, GENERATION_CACHE_FILENAME));
    try {
      const parsed = CacheFileSchema.safeParse(
        JSON.parse(await readFile(cache.cacheFilePath, 'utf8')),
      );
      if (parsed.success) {
        for (const entry of parsed.data.entries) cache.entries.set(entry.cacheKey, entry);
      }
    } catch {
      // No cache yet, or an unreadable one. Both are an empty cache.
    }
    return cache;
  }

  get directory(): string {
    return this.cacheDirectory;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Returns a hit only when the bytes on disk still hash to what was recorded.
   *
   * Every one of the three failure paths below is a miss rather than an error:
   * the file vanished, the file changed, or the file is unreadable. In all
   * three the honest answer is "there is no usable cached clip", and
   * regenerating is the correct response.
   */
  async lookup(cacheKey: string): Promise<GenerationCacheEntry | null> {
    const entry = this.entries.get(cacheKey);
    if (!entry) return null;
    const absolutePath = join(this.cacheDirectory, entry.relativePath);
    try {
      const bytes = await readFile(absolutePath);
      if (bytes.byteLength !== entry.sizeBytes) return null;
      const checksum = createHash('sha256').update(bytes).digest('hex');
      if (checksum !== entry.checksumSha256) return null;
      return entry;
    } catch {
      return null;
    }
  }

  absolutePathFor(entry: GenerationCacheEntry): string {
    return join(this.cacheDirectory, entry.relativePath);
  }

  async record(entry: GenerationCacheEntry): Promise<void> {
    const parsed = CacheEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new StoryboardVideoError(
        'INVALID_GENERATED_MEDIA',
        `refusing to record an invalid cache entry: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    this.entries.set(entry.cacheKey, parsed.data);
    await this.flush();
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.cacheFilePath), { recursive: true });
    // Sorted by key so the file is byte-stable across runs that touched the
    // same entries in a different order.
    const entries = [...this.entries.values()].sort((a, b) => a.cacheKey.localeCompare(b.cacheKey));
    await writeFile(
      this.cacheFilePath,
      `${JSON.stringify({ cacheVersion: GENERATION_CACHE_VERSION, entries }, null, 2)}\n`,
      'utf8',
    );
  }
}
