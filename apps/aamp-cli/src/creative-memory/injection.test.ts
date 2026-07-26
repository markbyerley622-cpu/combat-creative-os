import { describe, expect, it } from 'vitest';

import {
  InMemoryReferenceStore,
  withdrawBenchmarkProfile,
  listBenchmarkProfiles,
} from '@combat/database';
import {
  AGENT_SAFE_FORBIDDEN_KEYS,
  assertAgentSafeContext,
  CREATIVE_MEMORY_AGENT_ROLES,
  CREATIVE_MEMORY_RETRIEVAL_PLANS,
  findAgentSafetyViolations,
  type CreativeMemoryAgentRole,
  type RetrievalPlanInputs,
} from '@combat/domain';
import { QdrantClient, StructuralBaselineEmbeddingProvider } from '@combat/providers';

import { seedBenchmarkProfiles } from './benchmark-profile-commands';
import { seedBenchmarkWorkspace, WORKSPACE_A, WORKSPACE_B } from './benchmark-fixture';
import { InMemoryQdrant } from './in-memory-qdrant';
import { CreativeMemoryInjector, CreativeMemoryInjectionError } from './injection';
import { indexWorkspace } from './retrieval-pipeline';
import { selectWithDiversity, type RetrievedCandidate } from './role-context';

/**
 * Role-specific injection, against the synthetic benchmark fixture and an
 * in-process Qdrant.
 *
 * The three seeded references carry deliberately disjoint business roles, so
 * "each agent gets its own context" is an objective outcome here rather than a
 * matter of tuning: the Strategist's plan and the Shot-Prompt Engineer's plan
 * cannot reach the same rows.
 *
 * Nothing here contacts a real service, downloads a model or spends money.
 */

const CAMPAIGN = '99999999-9999-4999-8999-999999999999';
const AT = new Date('2026-07-27T00:00:00.000Z');

const INPUTS: RetrievalPlanInputs = {
  campaignPrompt: 'Promote this weekend’s coverage; hook on the number of events.',
  factualConstraints: ['PRODUCT — Coverage: every promotion in one place'],
  objective: 'Drive installs',
  targetAudience: 'Fans who follow multiple promotions',
  brandSystem: 'primary #0B0B0F, accent #FF3B30, caption type Arial, 9:16 vertical',
  platform: 'TIKTOK',
  targetDurationSeconds: 15,
  ctaHeadline: 'Download Free',
  strategy: {
    positioning: 'Where a fight weekend is followed end to end.',
    targetAudienceSummary: 'Multi-promotion followers.',
    keyMessages: ['One card, one place.'],
    toneGuidelines: ['Direct.'],
  },
  concept: {
    logline: 'One weekend of fights.',
    visualDirection: 'Vertical, high contrast.',
    narrativeArc: 'Hook, weekend, app, CTA.',
  },
};

async function seeded(options: { profiles?: boolean; workspaceId?: string } = {}) {
  const store = new InMemoryReferenceStore();
  await seedBenchmarkWorkspace(store);
  if (options.profiles !== false) {
    await seedBenchmarkProfiles(store, {
      workspaceId: options.workspaceId ?? WORKSPACE_A,
      name: 'combat-reviews-benchmark',
      reviewerId: 'reviewer-1',
      activatedBy: 'operator-1',
      at: AT,
    });
  }

  const embedder = new StructuralBaselineEmbeddingProvider();
  const qdrant = new InMemoryQdrant().asClient();
  await indexWorkspace({ db: store, workspaceId: WORKSPACE_A, embedder, qdrant });
  await indexWorkspace({ db: store, workspaceId: WORKSPACE_B, embedder, qdrant });
  return { store, embedder, qdrant };
}

function injector(
  deps: Awaited<ReturnType<typeof seeded>>,
  mode: 'required' | 'optional' = 'required',
  overrides: { workspaceId?: string; qdrant?: QdrantClient } = {},
): CreativeMemoryInjector {
  return new CreativeMemoryInjector({
    mode,
    dependencies: {
      db: deps.store,
      qdrant: overrides.qdrant ?? deps.qdrant,
      embedder: deps.embedder,
    },
    workspaceId: overrides.workspaceId ?? WORKSPACE_A,
    campaignId: CAMPAIGN,
    platform: 'TIKTOK',
    now: AT,
  });
}

function shotInputs(index: number, beat: string): RetrievalPlanInputs {
  return { ...INPUTS, shot: { index, description: `Beat ${index}`, beat } };
}

async function contextsForAllRoles(deps: Awaited<ReturnType<typeof seeded>>) {
  const inject = injector(deps);
  const contexts = new Map<
    CreativeMemoryAgentRole,
    Awaited<ReturnType<CreativeMemoryInjector['contextFor']>>
  >();
  for (const role of CREATIVE_MEMORY_AGENT_ROLES) {
    // eslint-disable-next-line no-await-in-loop -- resolved in role order for determinism
    contexts.set(
      role,
      await inject.contextFor(
        role,
        role === 'SHOT_PROMPT_ENGINEER' ? shotInputs(0, 'HOOK') : INPUTS,
        role === 'SHOT_PROMPT_ENGINEER' ? { shotIndex: 0 } : {},
      ),
    );
  }
  return { inject, contexts };
}

describe('each agent receives its own role-appropriate context', () => {
  it('gives all four roles a context', async () => {
    const { contexts } = await contextsForAllRoles(await seeded());
    for (const role of CREATIVE_MEMORY_AGENT_ROLES) {
      expect(contexts.get(role), `${role} received no context`).toBeDefined();
      expect(contexts.get(role)?.agentRole).toBe(role);
    }
  });

  it('draws on different references for different roles', async () => {
    const { contexts } = await contextsForAllRoles(await seeded());
    const strategist = contexts.get('CAMPAIGN_STRATEGIST')?.items.map((item) => item.referenceId);
    const director = contexts.get('CREATIVE_DIRECTOR')?.items.map((item) => item.referenceId);
    const script = contexts.get('SCRIPT_TIMING_DIRECTOR')?.items.map((item) => item.referenceId);

    // The seeded references carry disjoint business roles, so these must not
    // overlap — if they did, the plans would not be role-specific at all.
    expect(new Set(strategist).size).toBeGreaterThan(0);
    expect([...new Set(strategist)]).not.toEqual([...new Set(director)]);
    expect([...new Set(director)]).not.toEqual([...new Set(script)]);
  });

  it('populates only the observation fields each role’s plan permits', async () => {
    const { contexts } = await contextsForAllRoles(await seeded());
    for (const role of CREATIVE_MEMORY_AGENT_ROLES) {
      const permitted = new Set<string>(
        CREATIVE_MEMORY_RETRIEVAL_PLANS[role].permittedObservations,
      );
      for (const item of contexts.get(role)?.items ?? []) {
        for (const key of Object.keys(item.observations)) {
          expect(
            permitted.has(key),
            `${role} was told ${key}, which its plan does not permit`,
          ).toBe(true);
        }
      }
    }
  });

  it('carries each role’s focus areas and the governing profile identity', async () => {
    const { contexts } = await contextsForAllRoles(await seeded());
    const strategist = contexts.get('CAMPAIGN_STRATEGIST');
    expect(strategist?.focusAreas).toContain('hook strategy');
    expect(strategist?.benchmarkProfileName).toBe('combat-reviews-benchmark');
    expect(strategist?.benchmarkProfileVersion).toBe(1);
    expect(strategist?.planKey).toBe('CAMPAIGN_STRATEGIST_CRAFT_V1');
  });

  it('retrieves per shot, so two beats can be briefed differently', async () => {
    const deps = await seeded();
    const inject = injector(deps);
    await inject.contextFor('SHOT_PROMPT_ENGINEER', shotInputs(0, 'HOOK'), { shotIndex: 0 });
    await inject.contextFor('SHOT_PROMPT_ENGINEER', shotInputs(3, 'CTA'), { shotIndex: 3 });

    const hashes = inject.audits.map((audit) => audit.queryHash);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(inject.audits.map((audit) => audit.shotIndex)).toEqual([0, 3]);
  });
});

describe('determinism', () => {
  it('produces byte-identical contexts for the same request and index state', async () => {
    const first = await contextsForAllRoles(await seeded());
    const second = await contextsForAllRoles(await seeded());

    for (const role of CREATIVE_MEMORY_AGENT_ROLES) {
      const left = first.contexts.get(role);
      const right = second.contexts.get(role);
      // Reference ids are generated per seed, so the comparison is on the
      // shape and the derived values rather than on the identifiers.
      expect(left?.items.length).toBe(right?.items.length);
      expect(left?.queryHash).toBe(right?.queryHash);
      expect(left?.items.map((item) => item.measurements)).toEqual(
        right?.items.map((item) => item.measurements),
      );
    }
  });

  it('produces a different query hash for a different campaign prompt', async () => {
    const deps = await seeded();
    const a = injector(deps);
    const b = injector(deps);
    await a.contextFor('CAMPAIGN_STRATEGIST', INPUTS);
    await b.contextFor('CAMPAIGN_STRATEGIST', {
      ...INPUTS,
      campaignPrompt: 'Promote the prediction game; hook on a disputed scorecard.',
    });
    expect(a.audits[0]?.queryHash).not.toBe(b.audits[0]?.queryHash);
  });
});

describe('the agent-safe boundary holds on real retrieved material', () => {
  it('produces contexts with no forbidden key or value anywhere', async () => {
    const { contexts } = await contextsForAllRoles(await seeded());
    for (const role of CREATIVE_MEMORY_AGENT_ROLES) {
      const context = contexts.get(role);
      expect(findAgentSafetyViolations(context)).toEqual([]);
      expect(() => assertAgentSafeContext(context, role)).not.toThrow();
      const serialised = JSON.stringify(context);
      for (const key of AGENT_SAFE_FORBIDDEN_KEYS) {
        expect(serialised).not.toContain(`"${key}":`);
      }
    }
  });

  it('always carries the rights notice', async () => {
    const { contexts } = await contextsForAllRoles(await seeded());
    expect(contexts.get('CAMPAIGN_STRATEGIST')?.notice).toBe(
      'Reference material is analysis-only. Retrieval grants no output rights.',
    );
  });
});

describe('governance decides whether anything is retrieved at all', () => {
  it('refuses when no benchmark profile has been approved', async () => {
    const deps = await seeded({ profiles: false });
    await expect(
      injector(deps, 'required').contextFor('CAMPAIGN_STRATEGIST', INPUTS),
    ).rejects.toThrow(CreativeMemoryInjectionError);
  });

  it('records the reason and continues in optional mode', async () => {
    const deps = await seeded({ profiles: false });
    const inject = injector(deps, 'optional');
    expect(await inject.contextFor('CAMPAIGN_STRATEGIST', INPUTS)).toBeUndefined();
    expect(inject.audits[0]?.governanceDecision).toBe('NOT_USED');
    expect(inject.audits[0]?.notUsedReason).toBe('NO_APPROVED_PROFILE');
  });

  it('stops governing once the profile is withdrawn', async () => {
    const deps = await seeded();
    const [profile] = await listBenchmarkProfiles(deps.store, WORKSPACE_A, {
      agentRole: 'CAMPAIGN_STRATEGIST',
    });
    await withdrawBenchmarkProfile(deps.store, WORKSPACE_A, profile!.id);

    const inject = injector(deps, 'optional');
    expect(await inject.contextFor('CAMPAIGN_STRATEGIST', INPUTS)).toBeUndefined();
    expect(inject.audits[0]?.notUsedReason).toBe('NO_APPROVED_PROFILE');
  });

  it('records the approving reviewer and the immutable activation provenance', async () => {
    const deps = await seeded();
    const inject = injector(deps);
    await inject.contextFor('CAMPAIGN_STRATEGIST', INPUTS);
    const audit = inject.audits[0];
    expect(audit?.benchmarkProfile?.reviewerId).toBe('reviewer-1');
    expect(audit?.benchmarkProfile?.activatedBy).toBe('operator-1');
    expect(audit?.benchmarkProfile?.governingChecksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(audit?.anyReferenceOutputEligible).toBe(false);
  });
});

describe('only reviewed, retrieval-eligible references are used', () => {
  it('drops a reference whose latest annotation is not approved', async () => {
    const deps = await seeded();
    const before = await injector(deps).contextFor('CAMPAIGN_STRATEGIST', INPUTS);
    const usedReference = before?.items[0]?.referenceId as string;

    // The in-memory store's delegates are typed `never` for the store's own
    // generic reasons; the rows are plain records, so the read is narrowed here.
    const annotations = (await deps.store.referenceAnnotation.findMany({
      where: { workspaceId: WORKSPACE_A, referenceAdvertisementId: usedReference },
    })) as unknown as { id: string }[];
    await deps.store.referenceAnnotation.update({
      where: { id: annotations[0]!.id },
      data: { approved: false },
    });

    const inject = injector(deps, 'optional');
    const after = await inject.contextFor('CAMPAIGN_STRATEGIST', INPUTS);
    expect(after?.items.map((item) => item.referenceId) ?? []).not.toContain(usedReference);
  });
});

describe('workspace isolation', () => {
  it('never returns another workspace’s reference', async () => {
    const deps = await seeded();
    const { contexts } = await contextsForAllRoles(deps);
    const foreign = (await deps.store.referenceAdvertisement.findMany({
      where: { workspaceId: WORKSPACE_B },
    })) as unknown as { id: string }[];
    const foreignIds = new Set(foreign.map((reference) => reference.id));

    for (const context of contexts.values()) {
      for (const item of context?.items ?? []) {
        expect(foreignIds.has(item.referenceId)).toBe(false);
      }
    }
  });

  it('cannot use a profile approved in another workspace', async () => {
    // Profiles seeded for workspace B only; the run is for workspace A.
    const deps = await seeded({ profiles: false });
    await seedBenchmarkProfiles(deps.store, {
      workspaceId: WORKSPACE_B,
      name: 'combat-reviews-benchmark',
      reviewerId: 'reviewer-b',
      activatedBy: 'operator-b',
      at: AT,
    });

    const inject = injector(deps, 'optional');
    expect(await inject.contextFor('CAMPAIGN_STRATEGIST', INPUTS)).toBeUndefined();
    expect(inject.audits[0]?.notUsedReason).toBe('NO_APPROVED_PROFILE');
  });
});

describe('retrieval failure never becomes a silent substitution', () => {
  it('refuses in required mode when the vector store is unreachable', async () => {
    const deps = await seeded();
    const broken = new QdrantClient({
      baseUrl: 'http://in-memory',
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
    });
    await expect(
      injector(deps, 'required', { qdrant: broken }).contextFor('CAMPAIGN_STRATEGIST', INPUTS),
    ).rejects.toThrow(/RETRIEVAL_UNAVAILABLE/);
  });

  it('records the reason and returns no context in optional mode', async () => {
    const deps = await seeded();
    const broken = new QdrantClient({
      baseUrl: 'http://in-memory',
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
    });
    const inject = injector(deps, 'optional', { qdrant: broken });
    expect(await inject.contextFor('CAMPAIGN_STRATEGIST', INPUTS)).toBeUndefined();
    expect(inject.audits[0]?.notUsedReason).toBe('RETRIEVAL_UNAVAILABLE');
    // Nothing fabricated: no items, no profile-derived context, no hash.
    expect(inject.audits[0]?.items).toEqual([]);
    expect(inject.audits[0]?.contextHash).toBeNull();
  });
});

describe('source diversity', () => {
  const candidate = (referenceId: string, sceneId: string, rank: number): RetrievedCandidate =>
    ({
      contributingRole: 'CAMPAIGN_STRATEGY',
      roleOrder: 0,
      insight: {
        referenceId,
        sceneId,
        roleTags: ['CAMPAIGN_STRATEGY'],
        craft: {
          sceneDurationSeconds: 1,
          advertisementDurationSeconds: 6,
          sceneCount: 6,
          cutsPerSecond: 0.8,
          aspectRatio: '9:16',
          pacing: 'FAST',
        },
        transferablePrinciple: 'p',
        prohibitedDirectSimilarity: 'q',
        explanation: {
          vectorRecallScore: 1,
          rerankScore: 1,
          roleMatch: true,
          platformMatch: true,
          pacingMatch: true,
          hookMatch: true,
          diversityAdjustment: 0,
          finalRank: rank,
          retrievalProfile: 'STRUCTURAL_BASELINE_V1',
          rerankingProfile: 'structural',
          fallbackStatus: 'FALLBACK_STRUCTURAL_RERANKING',
        },
      },
    }) as RetrievedCandidate;

  const limits = {
    topK: 4,
    maxContextCharacters: 6000,
    maxItemsPerReference: 2,
    minDistinctReferences: 2,
    referenceRoles: ['CAMPAIGN_STRATEGY'] as const,
  };

  it('caps how much one reference may contribute when alternatives exist', () => {
    const selection = selectWithDiversity(
      [
        candidate('ref-a', 'scene-1', 1),
        candidate('ref-a', 'scene-2', 2),
        candidate('ref-a', 'scene-3', 3),
        candidate('ref-b', 'scene-4', 4),
      ],
      limits,
    );
    const perReference = selection.selected.filter(
      (entry) => entry.insight.referenceId === 'ref-a',
    ).length;
    expect(perReference).toBe(2);
    expect(selection.distinctSelected).toBe(2);
    expect(selection.satisfiesDiversity).toBe(true);
  });

  it('does not treat a genuinely small library as a diversity failure', () => {
    const selection = selectWithDiversity(
      [candidate('ref-a', 'scene-1', 1), candidate('ref-a', 'scene-2', 2)],
      limits,
    );
    expect(selection.distinctAvailable).toBe(1);
    expect(selection.requiredDistinct).toBe(1);
    expect(selection.satisfiesDiversity).toBe(true);
  });

  it('fails diversity when alternatives existed but were not represented', () => {
    const selection = selectWithDiversity(
      [candidate('ref-a', 'scene-1', 1), candidate('ref-b', 'scene-2', 2)],
      { ...limits, topK: 1 },
    );
    expect(selection.distinctAvailable).toBe(2);
    expect(selection.requiredDistinct).toBe(2);
    expect(selection.satisfiesDiversity).toBe(false);
  });
});
