import { describe, expect, it } from 'vitest';

import { InMemoryReferenceStore, listCreativeMemoryIndexEntries } from '@combat/database';
import {
  collectionNameFor,
  QdrantError,
  StructuralBaselineEmbeddingProvider,
  type QdrantClient,
} from '@combat/providers';

import { seedBenchmarkWorkspace, WORKSPACE_A } from './benchmark-fixture';
import { InMemoryQdrant } from './in-memory-qdrant';
import { indexWorkspace } from './retrieval-pipeline';
import { runIndexCommand, type RetrievalContext } from './retrieval-commands';

/**
 * Creative Memory index-entry persistence.
 *
 * `creative_memory_index_runs` and `creative_memory_index_entries` were created
 * by the retrieval migration and `indexWorkspace` has always accepted seams for
 * them, but nothing passed those seams — so the tables stayed empty and every
 * re-index re-embedded every scene. These tests pin the wiring, and the
 * ordering property that makes the entries trustworthy: an entry says `INDEXED`
 * only after the point is actually in the collection.
 */

const AT = new Date('2026-07-27T00:00:00.000Z');

function context(
  store: InMemoryReferenceStore,
  qdrant: QdrantClient,
): RetrievalContext & {
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    db: store,
    env: {},
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    embedder: new StructuralBaselineEmbeddingProvider(),
    qdrant,
    now: () => AT,
    out,
    err,
  } as RetrievalContext & { out: string[]; err: string[] };
}

async function seeded(): Promise<InMemoryReferenceStore> {
  const store = new InMemoryReferenceStore();
  await seedBenchmarkWorkspace(store);
  return store;
}

describe('indexing records what it did', () => {
  it('writes one entry per scene and an index run', async () => {
    const store = await seeded();
    const io = context(store, new InMemoryQdrant().asClient());
    const code = await runIndexCommand({ workspace: WORKSPACE_A }, new Set(), io);

    expect(code).toBe(0);
    const entries = await listCreativeMemoryIndexEntries(store, WORKSPACE_A);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.state).toBe('INDEXED');
      expect(entry.embeddingInputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.qdrantPointId).toBeTruthy();
      expect(entry.indexedAt).toEqual(AT);
    }

    const runs = store.snapshot('creativeMemoryIndexRun');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ indexedCount: entries.length, failedCount: 0 });
  });

  it('skips unchanged scenes on the second run instead of re-embedding them', async () => {
    // The whole point of persisting the input hash. Before this wiring the
    // second run re-embedded every scene, every time.
    const store = await seeded();
    const qdrant = new InMemoryQdrant().asClient();

    const first = context(store, qdrant);
    await runIndexCommand({ workspace: WORKSPACE_A }, new Set(), first);
    const firstSummary = JSON.parse(first.out.join('')) as { indexed: number; skipped: number };

    const second = context(store, qdrant);
    await runIndexCommand({ workspace: WORKSPACE_A }, new Set(), second);
    const secondSummary = JSON.parse(second.out.join('')) as { indexed: number; skipped: number };

    expect(firstSummary.indexed).toBeGreaterThan(0);
    expect(firstSummary.skipped).toBe(0);
    expect(secondSummary.indexed).toBe(0);
    expect(secondSummary.skipped).toBe(firstSummary.indexed);
  });

  it('re-indexes everything under --force', async () => {
    const store = await seeded();
    const qdrant = new InMemoryQdrant().asClient();
    await runIndexCommand({ workspace: WORKSPACE_A }, new Set(), context(store, qdrant));

    const forced = context(store, qdrant);
    await runIndexCommand({ workspace: WORKSPACE_A }, new Set(['force']), forced);
    const summary = JSON.parse(forced.out.join('')) as { indexed: number; skipped: number };
    expect(summary.skipped).toBe(0);
    expect(summary.indexed).toBeGreaterThan(0);
  });
});

describe('an entry claims INDEXED only after the point is in the collection', () => {
  it('records the batch as FAILED when the upsert is refused', async () => {
    // A half-filled collection whose entries all say INDEXED is the failure
    // this ordering exists to prevent: the next run would see unchanged hashes
    // and skip exactly the scenes that are missing.
    const store = await seeded();
    const inner = new InMemoryQdrant().asClient();
    const refusing = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'upsertPoints') {
          return async () => {
            throw new QdrantError('REJECTED', 'collection is read-only');
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const io = context(store, refusing);
    const code = await runIndexCommand({ workspace: WORKSPACE_A }, new Set(), io);
    expect(code).not.toBe(0);

    const entries = await listCreativeMemoryIndexEntries(store, WORKSPACE_A);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.state).toBe('FAILED');
      expect(entry.failureType).toBe('UPSERT_FAILED');
      expect(entry.indexedAt ?? null).toBeNull();
    }
  });

  it('reports the same scenes as FAILED in the summary, not INDEXED', async () => {
    const store = await seeded();
    const inner = new InMemoryQdrant().asClient();
    const refusing = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'upsertPoints') {
          return async () => {
            throw new QdrantError('UNAVAILABLE', 'connection reset');
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const outcomes: string[] = [];
    await indexWorkspace({
      db: store,
      workspaceId: WORKSPACE_A,
      embedder: new StructuralBaselineEmbeddingProvider(),
      qdrant: refusing,
      recordEntry: async (entry) => void outcomes.push(`${entry.sceneId}:${entry.state}`),
    }).catch(() => undefined);

    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((outcome) => outcome.endsWith(':FAILED'))).toBe(true);
  });

  it('leaves the next run free to retry, because no hash was recorded as indexed', async () => {
    const store = await seeded();
    const inner = new InMemoryQdrant().asClient();
    let refuse = true;
    const flaky = new Proxy(inner, {
      get(target, property, receiver) {
        const original = Reflect.get(target, property, receiver) as unknown;
        if (property !== 'upsertPoints') return original;
        return async (...args: unknown[]) => {
          if (refuse) throw new QdrantError('UNAVAILABLE', 'connection reset');
          return (original as (...a: unknown[]) => Promise<void>).apply(target, args);
        };
      },
    });

    await runIndexCommand({ workspace: WORKSPACE_A }, new Set(), context(store, flaky));
    refuse = false;
    const retry = context(store, flaky);
    await runIndexCommand({ workspace: WORKSPACE_A }, new Set(), retry);

    const summary = JSON.parse(retry.out.join('')) as { indexed: number; skipped: number };
    expect(summary.skipped).toBe(0);
    expect(summary.indexed).toBeGreaterThan(0);

    const entries = await listCreativeMemoryIndexEntries(store, WORKSPACE_A);
    expect(entries.every((entry) => entry.state === 'INDEXED')).toBe(true);
    expect(
      entries.every(
        (entry) =>
          entry.qdrantCollection ===
          collectionNameFor(new StructuralBaselineEmbeddingProvider().getProfile()),
      ),
    ).toBe(true);
  });
});
