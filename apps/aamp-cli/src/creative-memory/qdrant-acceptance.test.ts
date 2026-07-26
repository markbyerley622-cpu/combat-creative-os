import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from '@combat/database';
import { CreativeMemoryQuerySchema } from '@combat/domain';
import {
  collectionNameFor,
  pointIdFor,
  QdrantClient,
  StructuralBaselineEmbeddingProvider,
  STRUCTURAL_BASELINE_PROFILE,
} from '@combat/providers';

import { seedBenchmarkWorkspace, WORKSPACE_A } from './benchmark-fixture';
import { indexWorkspace, searchCreativeMemory } from './retrieval-pipeline';

/**
 * Live Qdrant acceptance test — **real Qdrant, not an in-memory substitute**.
 *
 * Proves the integration the benchmark cannot: that a real collection is
 * created at the right dimension, that points survive a fresh client (i.e. the
 * data is in Qdrant rather than in this process), that deletion removes them,
 * and that the three benchmark queries return the objectively-correct top-one
 * result through an actual vector search.
 *
 * Start Qdrant first — and only Qdrant, so no unrelated volume is touched:
 *
 *     docker compose -f infrastructure/docker-compose.yml up -d qdrant
 *
 * Skips loudly when it is not reachable.
 */

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://127.0.0.1:6333';

/**
 * Synchronous on purpose: `describe.skip` must be chosen while the module is
 * evaluated, and this package compiles to CommonJS where top-level `await` is
 * unavailable. Probes in a child process so the check itself cannot hang the
 * suite.
 */
function qdrantReachable(): boolean {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `fetch(${JSON.stringify(`${QDRANT_URL}/healthz`)}, { signal: AbortSignal.timeout(3000) })
        .then((r) => process.exit(r.ok ? 0 : 1))
        .catch(() => process.exit(1));`,
    ],
    { timeout: 10_000 },
  );
  return probe.status === 0;
}

const reachable = qdrantReachable();
const suite = reachable ? describe : describe.skip;

if (!reachable) {
  // eslint-disable-next-line no-console -- a silently skipped acceptance test is worse than a noisy one
  console.warn(
    `[creative-memory] SKIPPED live Qdrant acceptance: nothing answering at ${QDRANT_URL}. Start it with: docker compose -f infrastructure/docker-compose.yml up -d qdrant`,
  );
}

suite('Creative Memory live Qdrant acceptance', () => {
  const client = (): QdrantClient =>
    new QdrantClient({
      baseUrl: QDRANT_URL,
      ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    });

  // A test-scoped collection, so the acceptance run cannot disturb a real one.
  const profile = { ...STRUCTURAL_BASELINE_PROFILE, embeddingRevision: 'acceptance-test' };
  const collection = collectionNameFor(profile);

  let store: InMemoryReferenceStore;
  let embedder: StructuralBaselineEmbeddingProvider;

  beforeAll(async () => {
    store = new InMemoryReferenceStore();
    await seedBenchmarkWorkspace(store);
    embedder = new StructuralBaselineEmbeddingProvider();
    // Point the embedder's profile at the test collection revision.
    embedder.getProfile = () => profile;

    await client().deleteCollection(collection);
  }, 120_000);

  afterAll(async () => {
    // Removes only this test's own collection. No Docker volume is touched.
    await client()
      .deleteCollection(collection)
      .catch(() => undefined);
  }, 60_000);

  it('reports the Qdrant service healthy', async () => {
    expect(await client().isHealthy()).toBe(true);
  });

  it('creates the versioned collection at the profile’s dimension', async () => {
    const qdrant = client();
    const { created } = await qdrant.ensureCollection(collection, profile.vectorDimension);
    expect(created).toBe(true);
    expect(await qdrant.collectionDimension(collection)).toBe(profile.vectorDimension);
  }, 60_000);

  it('refuses a collection whose dimension disagrees with the profile', async () => {
    await expect(
      client().ensureCollection(collection, profile.vectorDimension + 1),
    ).rejects.toThrow(/DIMENSION_MISMATCH|holds .* vectors/);
  }, 60_000);

  it('indexes the synthetic reference scenes into real Qdrant', async () => {
    const summary = await indexWorkspace({
      db: store,
      workspaceId: WORKSPACE_A,
      embedder,
      qdrant: client(),
    });
    expect(summary.collection).toBe(collection);
    expect(summary.indexed).toBeGreaterThan(0);
    expect(summary.failed).toBe(0);

    const count = await client().countPoints(collection, {
      must: [{ key: 'workspaceId', match: { value: WORKSPACE_A } }],
    });
    expect(count).toBe(summary.indexed);
  }, 300_000);

  it.each([
    ['fast vertical fight night hook with rapid impact cuts and crowd energy', 'Combat hype'],
    [
      'show detailed app information clearly on screen, readable product demonstration',
      'Product information',
    ],
    ['prediction and fan discussion, community arguing about scorecards', 'Community prediction'],
  ])(
    'search %j returns %s first through real vector search',
    async (query, expectedBrand) => {
      const result = await searchCreativeMemory({
        db: store,
        query: CreativeMemoryQuerySchema.parse({
          queryVersion: 1,
          workspaceId: WORKSPACE_A,
          query,
          mode: 'ADMIN',
        }),
        embedder,
        qdrant: client(),
      });
      expect(result.qdrantCollection).toBe(collection);
      expect(result.adminResults?.[0]?.brand).toBe(expectedBrand);
    },
    120_000,
  );

  it('persists across a fresh client, proving the data is in Qdrant', async () => {
    // A brand-new client with no shared state: if the points were only in this
    // process, this returns nothing.
    const fresh = new QdrantClient({
      baseUrl: QDRANT_URL,
      ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    });
    const count = await fresh.countPoints(collection, {
      must: [{ key: 'workspaceId', match: { value: WORKSPACE_A } }],
    });
    expect(count).toBeGreaterThan(0);

    const result = await searchCreativeMemory({
      db: store,
      query: CreativeMemoryQuerySchema.parse({
        queryVersion: 1,
        workspaceId: WORKSPACE_A,
        query: 'fast vertical fight night hook',
        mode: 'ADMIN',
      }),
      embedder,
      qdrant: fresh,
    });
    expect(result.adminResults?.[0]?.brand).toBe('Combat hype');
  }, 120_000);

  it('removes a reference’s points and drops it from results', async () => {
    const qdrant = client();
    const [reference] = (await store.referenceAdvertisement.findMany({
      where: { workspaceId: WORKSPACE_A, referenceKey: 'combat-hype' },
    })) as unknown as { id: string }[];
    const scenes = (await store.referenceScene.findMany({
      where: { workspaceId: WORKSPACE_A, referenceAdvertisementId: reference!.id },
    })) as unknown as { id: string }[];

    const before = await qdrant.countPoints(collection);
    await qdrant.deletePoints(
      collection,
      scenes.map((scene) => pointIdFor(WORKSPACE_A, scene.id, profile.profile)),
    );
    const after = await qdrant.countPoints(collection);
    expect(after).toBe(before - scenes.length);

    const result = await searchCreativeMemory({
      db: store,
      query: CreativeMemoryQuerySchema.parse({
        queryVersion: 1,
        workspaceId: WORKSPACE_A,
        query: 'fast vertical fight night hook with rapid impact cuts',
        mode: 'ADMIN',
      }),
      embedder,
      qdrant,
    });
    expect((result.adminResults ?? []).map((entry) => entry.brand)).not.toContain('Combat hype');
  }, 120_000);

  it('reports a typed failure when Qdrant is unreachable', async () => {
    const dead = new QdrantClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 });
    expect(await dead.isHealthy()).toBe(false);
    await expect(dead.search(collection, [0, 0, 0], 5)).rejects.toMatchObject({
      name: 'QdrantError',
    });
  }, 60_000);
});
