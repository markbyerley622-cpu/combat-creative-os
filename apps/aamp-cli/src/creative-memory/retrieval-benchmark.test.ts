import { describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from '@combat/database';
import {
  AGENT_SAFE_FORBIDDEN_KEYS,
  AGENT_SAFE_FORBIDDEN_VALUE_PATTERNS,
  CreativeMemoryQuerySchema,
} from '@combat/domain';
import {
  collectionNameFor,
  QdrantClient,
  StructuralBaselineEmbeddingProvider,
  STRUCTURAL_BASELINE_PROFILE,
} from '@combat/providers';

import { indexWorkspace, searchCreativeMemory, RetrievalError } from './retrieval-pipeline';
import { seedBenchmarkWorkspace, WORKSPACE_A, WORKSPACE_B } from './benchmark-fixture';
import { InMemoryQdrant } from './in-memory-qdrant';

/**
 * Retrieval benchmark.
 *
 * The three seeded references are deliberately different concepts — fast
 * vertical combat hype, product-information demonstration, prediction and
 * community discussion — so the expected top-one result for each query is
 * objectively known from the annotations and craft metrics, not from taste.
 *
 * These run against an in-memory Qdrant stand-in so they are fast and
 * hermetic. The **live** Qdrant acceptance test (`qdrant-acceptance.test.ts`)
 * proves the same behaviour against a real server; this file proves the
 * ranking logic, that one proves the integration.
 */

function client(): QdrantClient {
  return new InMemoryQdrant().asClient();
}

async function indexed() {
  const store = new InMemoryReferenceStore();
  await seedBenchmarkWorkspace(store);
  const embedder = new StructuralBaselineEmbeddingProvider();
  const qdrant = client();
  const summary = await indexWorkspace({
    db: store,
    workspaceId: WORKSPACE_A,
    embedder,
    qdrant,
  });
  return { store, embedder, qdrant, summary };
}

async function search(
  overrides: Record<string, unknown>,
  context?: Awaited<ReturnType<typeof indexed>>,
) {
  const ctx = context ?? (await indexed());
  const query = CreativeMemoryQuerySchema.parse({
    queryVersion: 1,
    workspaceId: WORKSPACE_A,
    ...overrides,
  });
  return {
    ctx,
    result: await searchCreativeMemory({
      db: ctx.store,
      query,
      embedder: ctx.embedder,
      qdrant: ctx.qdrant,
    }),
  };
}

describe('benchmark queries rank the objectively-correct reference first', () => {
  it('“fast vertical fight-night hook” ranks the combat-hype reference first', async () => {
    const { result } = await search({
      query: 'fast vertical fight night hook with rapid impact cuts and crowd energy',
      mode: 'ADMIN',
    });
    expect(result.adminResults?.[0]?.brand).toBe('Combat hype');
  });

  it('“show detailed app information clearly” ranks the product reference first', async () => {
    const { result } = await search({
      query: 'show detailed app information clearly on screen, readable product demonstration',
      mode: 'ADMIN',
    });
    expect(result.adminResults?.[0]?.brand).toBe('Product information');
  });

  it('“prediction and fan discussion” ranks the community reference first', async () => {
    const { result } = await search({
      query: 'prediction and fan discussion, community arguing about scorecards',
      mode: 'ADMIN',
    });
    expect(result.adminResults?.[0]?.brand).toBe('Community prediction');
  });
});

describe('filters change the eligible result set', () => {
  it('a role filter excludes references without that role', async () => {
    // No seeded reference declares PREVISUALISATION, so the eligible set for
    // it must be empty however well the text matches.
    const { result } = await search({
      query: 'fast vertical fight night hook',
      filter: { businessRole: 'PREVISUALISATION' },
      mode: 'ADMIN',
    });
    expect(result.adminResults ?? []).toHaveLength(0);
  });

  it('a role filter narrows to exactly the references declaring it', async () => {
    const { result } = await search({
      query: 'prediction and discussion',
      filter: { businessRole: 'PERFORMANCE_ANALYSIS' },
      mode: 'ADMIN',
    });
    for (const entry of result.adminResults ?? []) {
      expect(entry.roleTags).toContain('PERFORMANCE_ANALYSIS');
    }
    expect((result.adminResults ?? []).length).toBeGreaterThan(0);
  });

  it('a platform filter restricts results to that platform', async () => {
    const { result } = await search({
      query: 'app information',
      filter: { platform: 'INSTAGRAM_REELS' },
      mode: 'ADMIN',
    });
    for (const entry of result.adminResults ?? []) {
      expect(entry.platform).toBe('INSTAGRAM_REELS');
    }
    expect((result.adminResults ?? []).length).toBeGreaterThan(0);
  });
});

describe('reranking and diversification', () => {
  it('reranking preserves or improves top-one accuracy', async () => {
    const context = await indexed();
    const query = 'prediction and fan discussion about scorecards';

    const withRerank = await searchCreativeMemory({
      db: context.store,
      query: CreativeMemoryQuerySchema.parse({
        queryVersion: 1,
        workspaceId: WORKSPACE_A,
        query,
        mode: 'ADMIN',
      }),
      embedder: context.embedder,
      qdrant: context.qdrant,
    });

    expect(withRerank.adminResults?.[0]?.brand).toBe('Community prediction');
    // The reranker actually contributed a score rather than defaulting to zero.
    expect(withRerank.adminResults?.[0]?.explanation.rerankScore).toBeGreaterThan(0);
  });

  it('caps how many scenes one advertisement can occupy', async () => {
    const { result } = await search({
      query: 'fast vertical fight night hook with rapid cuts',
      maxScenesPerReference: 1,
      resultCount: 3,
      mode: 'ADMIN',
    });
    const ids = (result.adminResults ?? []).map((entry) => entry.referenceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('labels structural reranking as a fallback rather than claiming neural reranking', async () => {
    const { result } = await search({ query: 'fast cuts', mode: 'ADMIN' });
    expect(result.fallbackStatus).toBe('FALLBACK_STRUCTURAL_RERANKING');
    expect(result.rerankingProfile).toBe('STRUCTURAL_RERANKER_V1');
  });
});

describe('indexing behaviour', () => {
  it('is idempotent: re-indexing writes the same points', async () => {
    const context = await indexed();
    const first = context.summary;
    const second = await indexWorkspace({
      db: context.store,
      workspaceId: WORKSPACE_A,
      embedder: context.embedder,
      qdrant: context.qdrant,
    });
    expect(second.indexed).toBe(first.indexed);
    expect(second.collection).toBe(first.collection);
    const count = await context.qdrant.countPoints(first.collection);
    expect(count).toBe(first.indexed);
  });

  it('skips unchanged scenes when a previous input hash is known', async () => {
    const context = await indexed();
    const hashes = new Map(
      context.summary.outcomes
        .filter((outcome) => outcome.inputHash)
        .map((outcome) => [outcome.sceneId, outcome.inputHash as string]),
    );
    const second = await indexWorkspace({
      db: context.store,
      workspaceId: WORKSPACE_A,
      embedder: context.embedder,
      qdrant: context.qdrant,
      previousHash: async (sceneId) => hashes.get(sceneId),
    });
    expect(second.skipped).toBe(context.summary.indexed);
    expect(second.indexed).toBe(0);
  });

  it('changes the input hash when an annotation changes, which is what marks a vector stale', async () => {
    const context = await indexed();
    const before = new Map(
      context.summary.outcomes.map((outcome) => [outcome.sceneId, outcome.inputHash]),
    );

    const [reference] = (await context.store.referenceAdvertisement.findMany({
      where: { workspaceId: WORKSPACE_A, referenceKey: 'combat-hype' },
    })) as unknown as { id: string }[];
    const [annotation] = (await context.store.referenceAnnotation.findMany({
      where: { workspaceId: WORKSPACE_A, referenceAdvertisementId: reference!.id },
    })) as unknown as { id: string }[];
    await context.store.referenceAnnotation.update({
      where: { id: annotation!.id },
      data: { transferablePrinciple: 'A completely different reviewed principle about pacing.' },
    });

    const after = await indexWorkspace({
      db: context.store,
      workspaceId: WORKSPACE_A,
      embedder: context.embedder,
      qdrant: context.qdrant,
    });
    const changed = after.outcomes.filter(
      (outcome) => outcome.inputHash && outcome.inputHash !== before.get(outcome.sceneId),
    );
    expect(changed.length).toBeGreaterThan(0);
  });

  it('drops a reference from results once it is no longer retrieval-ready', async () => {
    const context = await indexed();
    const [reference] = (await context.store.referenceAdvertisement.findMany({
      where: { workspaceId: WORKSPACE_A, referenceKey: 'combat-hype' },
    })) as unknown as { id: string }[];
    await context.store.referenceAdvertisement.update({
      where: { id: reference!.id },
      data: { processingState: 'REVIEW_REQUIRED' },
    });

    const { result } = await search(
      { query: 'fast vertical fight night hook', mode: 'ADMIN' },
      context,
    );
    expect((result.adminResults ?? []).map((entry) => entry.brand)).not.toContain('Combat hype');
  });
});

describe('workspace isolation', () => {
  it('never returns another workspace’s references', async () => {
    const context = await indexed();
    await indexWorkspace({
      db: context.store,
      workspaceId: WORKSPACE_B,
      embedder: context.embedder,
      qdrant: context.qdrant,
    });

    const { result } = await search({ query: 'anything at all', mode: 'ADMIN' }, context);
    for (const entry of result.adminResults ?? []) {
      expect(entry.brand).not.toBe('Other workspace');
    }
  });

  it('reports no eligible references for an empty workspace', async () => {
    const context = await indexed();
    await expect(
      searchCreativeMemory({
        db: context.store,
        query: CreativeMemoryQuerySchema.parse({
          queryVersion: 1,
          workspaceId: '99999999-9999-4999-8999-999999999999',
          query: 'anything',
        }),
        embedder: context.embedder,
        qdrant: context.qdrant,
      }),
    ).rejects.toBeInstanceOf(RetrievalError);
  });
});

describe('the agent-safe boundary holds', () => {
  it('contains no forbidden key anywhere in the serialised payload', async () => {
    const { result } = await search({
      query: 'fast vertical fight night hook',
      mode: 'AGENT_SAFE',
    });
    expect(result.insights?.length).toBeGreaterThan(0);
    expect(result.adminResults).toBeUndefined();

    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, nested] of Object.entries(value)) {
          expect(
            AGENT_SAFE_FORBIDDEN_KEYS as readonly string[],
            `forbidden key "${key}" at ${path}`,
          ).not.toContain(key);
          walk(nested, `${path}.${key}`);
        }
        return;
      }
      if (typeof value === 'string') {
        for (const pattern of AGENT_SAFE_FORBIDDEN_VALUE_PATTERNS) {
          expect(pattern.test(value), `forbidden value at ${path}: ${value}`).toBe(false);
        }
      }
    };

    walk(result.insights, 'insights');
  });

  it('carries the principle and its prohibition together', async () => {
    const { result } = await search({ query: 'fast cuts', mode: 'AGENT_SAFE' });
    for (const insight of result.insights ?? []) {
      expect(insight.transferablePrinciple.length).toBeGreaterThan(0);
      expect(insight.prohibitedDirectSimilarity.length).toBeGreaterThan(0);
    }
  });

  it('exposes the reranking fallback status to the agent', async () => {
    const { result } = await search({ query: 'fast cuts', mode: 'AGENT_SAFE' });
    for (const insight of result.insights ?? []) {
      expect(insight.explanation.fallbackStatus).toBe('FALLBACK_STRUCTURAL_RERANKING');
      expect(insight.explanation.retrievalProfile).toBe('STRUCTURAL_BASELINE_V1');
    }
  });

  it('always states that retrieval grants no output rights', async () => {
    const { result } = await search({ query: 'fast cuts', mode: 'AGENT_SAFE' });
    expect(result.notice).toBe(
      'Reference material is analysis-only. Retrieval grants no output rights.',
    );
  });
});

describe('collection identity', () => {
  it('encodes profile, revision, dimension and schema version', () => {
    expect(collectionNameFor(STRUCTURAL_BASELINE_PROFILE)).toBe(
      'creative_memory__structural_baseline_v1__rev_v1__d288__s1',
    );
  });

  it('changes when the model revision changes, so vectors cannot mix', () => {
    const other = { ...STRUCTURAL_BASELINE_PROFILE, embeddingRevision: 'v2' };
    expect(collectionNameFor(other)).not.toBe(collectionNameFor(STRUCTURAL_BASELINE_PROFILE));
  });
});
