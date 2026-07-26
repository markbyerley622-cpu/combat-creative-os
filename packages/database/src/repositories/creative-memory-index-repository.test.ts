import { describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from './in-memory-reference-store';
import {
  CreativeMemoryIndexError,
  completeCreativeMemoryIndexRun,
  listCreativeMemoryIndexEntries,
  previousIndexInputHash,
  recordCreativeMemoryIndexEntry,
  redactIndexFailureDetail,
  startCreativeMemoryIndexRun,
} from './creative-memory-index-repository';

const WORKSPACE = '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e';
const OTHER_WORKSPACE = '11111111-2222-4333-8444-555555555555';
const AT = new Date('2026-07-27T00:00:00.000Z');

function entry(overrides: Partial<Parameters<typeof recordCreativeMemoryIndexEntry>[2]> = {}) {
  return {
    referenceSceneId: 'scene-1',
    referenceAdvertisementId: 'reference-1',
    profile: 'STRUCTURAL_BASELINE_V1',
    modelRevision: 'v1',
    vectorDimension: 256,
    embeddingInputHash: 'a'.repeat(64),
    vectorChecksum: 'b'.repeat(64),
    qdrantCollection: 'creative_memory__structural_baseline_v1__rev_v1__d256__s1',
    qdrantPointId: 'point-1',
    state: 'INDEXED' as const,
    at: AT,
    ...overrides,
  };
}

describe('index entries are one per scene per profile', () => {
  it('updates in place rather than accumulating rows', async () => {
    const store = new InMemoryReferenceStore();
    await recordCreativeMemoryIndexEntry(store, WORKSPACE, entry());
    await recordCreativeMemoryIndexEntry(
      store,
      WORKSPACE,
      entry({ embeddingInputHash: 'c'.repeat(64), vectorChecksum: 'd'.repeat(64) }),
    );

    const rows = await listCreativeMemoryIndexEntries(store, WORKSPACE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.embeddingInputHash).toBe('c'.repeat(64));
  });

  it('keeps another profile’s vectors in a different row', async () => {
    const store = new InMemoryReferenceStore();
    await recordCreativeMemoryIndexEntry(store, WORKSPACE, entry());
    await recordCreativeMemoryIndexEntry(
      store,
      WORKSPACE,
      entry({ profile: 'QWEN3_VL_2B_QUALITY_V1', vectorDimension: 2048 }),
    );
    expect(await listCreativeMemoryIndexEntries(store, WORKSPACE)).toHaveLength(2);
    expect(
      await listCreativeMemoryIndexEntries(store, WORKSPACE, {
        profile: 'QWEN3_VL_2B_QUALITY_V1',
      }),
    ).toHaveLength(1);
  });

  it('scopes reads to the workspace', async () => {
    const store = new InMemoryReferenceStore();
    await recordCreativeMemoryIndexEntry(store, WORKSPACE, entry());
    expect(await listCreativeMemoryIndexEntries(store, OTHER_WORKSPACE)).toEqual([]);
    expect(
      await previousIndexInputHash(store, OTHER_WORKSPACE, 'scene-1', 'STRUCTURAL_BASELINE_V1'),
    ).toBeUndefined();
  });

  it('refuses a profile the schema enum cannot express', async () => {
    const store = new InMemoryReferenceStore();
    await expect(
      recordCreativeMemoryIndexEntry(store, WORKSPACE, entry({ profile: 'MADE_UP_V9' })),
    ).rejects.toBeInstanceOf(CreativeMemoryIndexError);
  });
});

describe('the previously-recorded hash', () => {
  it('is returned only for an entry that is actually indexed', async () => {
    const store = new InMemoryReferenceStore();
    await recordCreativeMemoryIndexEntry(store, WORKSPACE, entry());
    expect(
      await previousIndexInputHash(store, WORKSPACE, 'scene-1', 'STRUCTURAL_BASELINE_V1'),
    ).toBe('a'.repeat(64));
  });

  it('is withheld for a failed entry, so the next run re-embeds rather than skipping', async () => {
    // The dangerous version of this returns the hash for any row that exists:
    // a scene that failed to reach the collection would then be skipped
    // forever, and the collection would stay quietly incomplete.
    const store = new InMemoryReferenceStore();
    await recordCreativeMemoryIndexEntry(
      store,
      WORKSPACE,
      entry({ state: 'FAILED', failureType: 'UPSERT_FAILED', failureDetail: 'boom' }),
    );
    expect(
      await previousIndexInputHash(store, WORKSPACE, 'scene-1', 'STRUCTURAL_BASELINE_V1'),
    ).toBeUndefined();
  });

  it('records indexedAt only for an indexed entry', async () => {
    const store = new InMemoryReferenceStore();
    await recordCreativeMemoryIndexEntry(store, WORKSPACE, entry({ state: 'FAILED' }));
    const [failed] = await listCreativeMemoryIndexEntries(store, WORKSPACE);
    expect(failed?.indexedAt ?? null).toBeNull();
    expect(failed?.lastVerifiedAt).toEqual(AT);
  });
});

describe('failure detail is redacted before it is persisted', () => {
  it('removes a URL, which is where an endpoint credential travels', () => {
    expect(redactIndexFailureDetail('POST https://user:pass@vectors.example/v1 failed')).toBe(
      'POST [REDACTED_URL] failed',
    );
  });

  it('removes an api-key-shaped token', () => {
    expect(redactIndexFailureDetail('rejected key sk-live-abcdefghijklmnop')).toContain(
      '[REDACTED_KEY]',
    );
  });

  it('bounds the length so a stack trace cannot become a column of prose', () => {
    expect(redactIndexFailureDetail('at frame '.repeat(500))?.length).toBe(500);
  });

  it('collapses a long unlabelled opaque blob', () => {
    expect(redactIndexFailureDetail('x'.repeat(64))).toBe('[REDACTED_TOKEN]');
  });

  it('is applied by the repository, not left to the caller', async () => {
    const store = new InMemoryReferenceStore();
    await recordCreativeMemoryIndexEntry(
      store,
      WORKSPACE,
      entry({
        state: 'FAILED',
        failureType: 'QDRANT_UNAVAILABLE',
        failureDetail: 'unreachable at http://127.0.0.1:6333 with api-key hunter2hunter2hunter2',
      }),
    );
    const [row] = await listCreativeMemoryIndexEntries(store, WORKSPACE);
    expect(row?.failureDetail).not.toContain('127.0.0.1:6333');
    expect(row?.failureDetail).not.toContain('hunter2hunter2hunter2');
  });
});

describe('index runs', () => {
  it('opens and closes with the counts the run actually produced', async () => {
    const store = new InMemoryReferenceStore();
    const run = await startCreativeMemoryIndexRun(store, WORKSPACE, {
      profile: 'STRUCTURAL_BASELINE_V1',
      qdrantCollection: 'creative_memory__structural_baseline_v1__rev_v1__d256__s1',
      startedAt: AT,
    });
    const closed = await completeCreativeMemoryIndexRun(store, run.id, {
      indexedCount: 3,
      skippedCount: 1,
      failedCount: 0,
      completedAt: new Date('2026-07-27T00:01:00.000Z'),
    });
    expect(closed).toMatchObject({ indexedCount: 3, skippedCount: 1, failedCount: 0 });
    expect(closed.completedAt).toEqual(new Date('2026-07-27T00:01:00.000Z'));
  });
});
