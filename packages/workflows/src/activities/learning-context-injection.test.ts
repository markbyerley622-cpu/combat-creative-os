import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueuedReasoningProvider } from '@combat/agent-runtime';
import { AGENT_REGISTRY } from '@combat/agents';
import {
  createLearningRecord,
  InMemoryCampaignStore,
  reviewLearningRecord,
  submitCampaignBrief,
  type CreateLearningRecordInput,
} from '@combat/database';
import type { ExecuteSpecialistAgentInput } from '@combat/domain';
import { MAX_LEARNING_CONTEXT_ITEMS } from '@combat/domain';
import { createExecuteSpecialistAgentActivity } from './execute-specialist-agent-activity';
import { createRunStrategyConceptScriptActivity } from './run-strategy-concept-script-activity';

/**
 * M13 — proves the learning loop actually closes: an APPROVED, applicable,
 * sufficiently-evidenced learning reaches the Campaign Strategist and Creative
 * Director as bounded, attributed context on a subsequent campaign, and
 * everything that should not reach them does not.
 */

function learningInput(
  overrides: Partial<CreateLearningRecordInput> = {},
): CreateLearningRecordInput {
  const sourceCampaignId = overrides.sourceCampaignId ?? randomUUID();
  const evidence = overrides.evidence ?? [
    {
      performanceObservationId: randomUUID(),
      campaignId: sourceCampaignId,
      platform: 'INSTAGRAM_REELS' as const,
      impressions: 30_000,
    },
    {
      performanceObservationId: randomUUID(),
      campaignId: sourceCampaignId,
      platform: 'INSTAGRAM_REELS' as const,
      impressions: 30_000,
    },
  ];
  return {
    learningKey: overrides.learningKey ?? 'short-hook-holds-attention',
    insight: overrides.insight ?? 'Opening on the product in frame one lifted click-through.',
    scope: overrides.scope ?? 'STRATEGY',
    applicability: overrides.applicability ?? {
      platforms: ['INSTAGRAM_REELS'],
      durationsSeconds: [15],
      tags: ['hook'],
    },
    confidence: overrides.confidence ?? 'MEDIUM',
    evidence,
    totalImpressions: overrides.totalImpressions ?? 60_000,
    sourceCampaignId,
    createdByAgentInvocationId: overrides.createdByAgentInvocationId ?? randomUUID(),
    promptVersionId: overrides.promptVersionId ?? randomUUID(),
    ...overrides,
  };
}

async function seedApprovedLearning(
  store: InMemoryCampaignStore,
  workspaceId: string,
  overrides: Partial<CreateLearningRecordInput> = {},
) {
  const { record } = await createLearningRecord(store, workspaceId, learningInput(overrides));
  await reviewLearningRecord(store, workspaceId, record.id, {
    status: 'APPROVED',
    reviewedByUserId: randomUUID(),
  });
  return record;
}

async function seedCampaign(store: InMemoryCampaignStore, workspaceId: string) {
  const campaignId = randomUUID();
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'STRATEGY_REVIEW' });
  await submitCampaignBrief(store, workspaceId, {
    campaignId,
    content: {
      campaignName: 'Q4',
      productName: 'Combat Reviews',
      productDescription: 'x',
      objective: 'Drive trial signups',
      targetAudience: 'gym owners',
      customerProblem: 'x',
      valueProposition: 'x',
      productFeatures: ['review widgets'],
      targetPlatforms: ['INSTAGRAM_REELS'],
      aspectRatios: ['9:16'],
      durationsSeconds: [15],
      brandVoice: 'confident',
      visualDirection: 'x',
      requiredMessaging: ['try it free'],
      callToAction: 'Sign up today',
      references: [],
      assetReferences: [],
      prohibitedClaims: [],
      budgetCents: 500_000,
      locale: 'en-US',
    },
  });
  return campaignId;
}

const AGENT_RESULTS = [
  {
    audienceProfile: {
      name: 'Gym Owner',
      demographics: {},
      psychographics: {},
      painPoints: ['manual review requests'],
      platformBehavior: {},
    },
    strategy: {
      positioning: 'p',
      targetAudienceSummary: 't',
      keyMessages: ['a'],
      toneGuidelines: ['b'],
    },
  },
  { logline: 'l', visualDirection: 'v', narrativeArc: 'n', referenceNotes: [] },
  {
    totalDurationFrames: 450,
    shots: [
      { index: 0, description: 'd', durationFrames: 450, beat: 'HOOK', dependsOnShotIndices: [] },
    ],
  },
];

/** Captures every agent payload so the injected context can be inspected. */
function buildActivity(store: InMemoryCampaignStore, opts: { withLearnings?: boolean } = {}) {
  const captured: ExecuteSpecialistAgentInput[] = [];
  const inner = createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider(AGENT_RESULTS.map((result) => ({ result }))),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
  const activity = createRunStrategyConceptScriptActivity({
    executeSpecialistAgentActivity: async (input) => {
      captured.push(input);
      return inner(input);
    },
    campaignBriefDb: store,
    humanApprovalDb: store,
    strategyDb: store,
    creativeConceptDb: store,
    scriptDb: store,
    ...(opts.withLearnings === false ? {} : { learningDb: store }),
  });
  return { activity, captured };
}

function payloadFor(
  captured: ExecuteSpecialistAgentInput[],
  agentName: string,
): Record<string, unknown> {
  const call = captured.find((c) => c.agentName === agentName);
  if (!call) throw new Error(`no ${agentName} call captured`);
  return call.payload as Record<string, unknown>;
}

describe('learning context reaches the Strategist and Creative Director', () => {
  it('injects an APPROVED, applicable learning into both agents, attributed', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const strategyLearning = await seedApprovedLearning(store, workspaceId, {
      scope: 'STRATEGY',
      insight: 'Opening on the product in frame one lifted click-through.',
    });
    const conceptLearning = await seedApprovedLearning(store, workspaceId, {
      learningKey: 'warm-gym-lighting',
      scope: 'CONCEPT',
      insight: 'Warm gym lighting outperformed clinical studio lighting.',
    });
    const campaignId = await seedCampaign(store, workspaceId);
    const { activity, captured } = buildActivity(store);

    const result = await activity({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      revisionAttempt: 1,
    });
    expect(result.ok).toBe(true);

    const strategist = payloadFor(captured, 'campaign-strategist');
    const director = payloadFor(captured, 'creative-director');

    expect(strategist.priorLearnings).toHaveLength(1);
    expect(director.priorLearnings).toHaveLength(1);

    // Attribution survives into the prompt: source id, version, confidence,
    // and the weight of evidence behind the claim.
    const [strategyLine] = strategist.priorLearnings as string[];
    expect(strategyLine).toContain(`learning:${strategyLearning.id} v1`);
    expect(strategyLine).toContain('MEDIUM confidence');
    expect(strategyLine).toContain('2 observation(s)');
    expect(strategyLine).toContain('60000 impressions');
    expect(strategyLine).toContain('Opening on the product in frame one lifted click-through.');

    const [conceptLine] = director.priorLearnings as string[];
    expect(conceptLine).toContain(`learning:${conceptLearning.id} v1`);
    expect(conceptLine).toContain('Warm gym lighting');
  });

  it('routes each learning only to the agent it is scoped to', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    await seedApprovedLearning(store, workspaceId, { scope: 'STRATEGY' });
    const campaignId = await seedCampaign(store, workspaceId);
    const { activity, captured } = buildActivity(store);

    await activity({ workspaceId, campaignId, workflowRunId: 'run-1', revisionAttempt: 1 });

    expect(payloadFor(captured, 'campaign-strategist').priorLearnings).toHaveLength(1);
    // A STRATEGY-scoped learning never leaks into the Creative Director.
    expect(payloadFor(captured, 'creative-director').priorLearnings).toHaveLength(0);
  });

  it('passes the approved brief verbatim — a learning never overrides it', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    await seedApprovedLearning(store, workspaceId, {
      insight: 'Drop the call to action entirely and target a different audience.',
    });
    const campaignId = await seedCampaign(store, workspaceId);
    const { activity, captured } = buildActivity(store);

    await activity({ workspaceId, campaignId, workflowRunId: 'run-1', revisionAttempt: 1 });

    const strategist = payloadFor(captured, 'campaign-strategist');
    // Every brief-derived field is exactly what the accepted brief said,
    // regardless of what the learning asserted.
    expect(strategist.objective).toBe('Drive trial signups');
    expect(strategist.keyMessages).toEqual(['try it free']);
    expect(strategist.mandatories).toEqual(['review widgets']);
    expect(strategist.targetPlatforms).toEqual(['INSTAGRAM_REELS']);
    expect(strategist.budgetCents).toBe(500_000);
    // The learning is present only as separate advisory context.
    expect(strategist.priorLearnings).toHaveLength(1);
  });

  it('caps the injected context so it cannot grow with workspace history', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    for (let i = 0; i < MAX_LEARNING_CONTEXT_ITEMS + 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- deterministic ordered fixture setup
      await seedApprovedLearning(store, workspaceId, {
        learningKey: `insight-${i}`,
        insight: `Insight number ${i}.`,
      });
    }
    const campaignId = await seedCampaign(store, workspaceId);
    const { activity, captured } = buildActivity(store);

    await activity({ workspaceId, campaignId, workflowRunId: 'run-1', revisionAttempt: 1 });

    expect(payloadFor(captured, 'campaign-strategist').priorLearnings).toHaveLength(
      MAX_LEARNING_CONTEXT_ITEMS,
    );
  });
});

describe('learning context — what never reaches an agent', () => {
  it.each([
    [
      'a PROPOSED learning awaiting human review',
      async (store: InMemoryCampaignStore, workspaceId: string) => {
        await createLearningRecord(store, workspaceId, learningInput());
      },
    ],
    [
      'a LOW-confidence learning',
      async (store: InMemoryCampaignStore, workspaceId: string) => {
        await seedApprovedLearning(store, workspaceId, { confidence: 'LOW' });
      },
    ],
    [
      'a learning applicable only to another platform',
      async (store: InMemoryCampaignStore, workspaceId: string) => {
        await seedApprovedLearning(store, workspaceId, {
          applicability: { platforms: ['YOUTUBE_SHORTS'], durationsSeconds: [], tags: [] },
        });
      },
    ],
    [
      'a learning applicable only to another duration',
      async (store: InMemoryCampaignStore, workspaceId: string) => {
        await seedApprovedLearning(store, workspaceId, {
          applicability: { platforms: [], durationsSeconds: [30], tags: [] },
        });
      },
    ],
  ])('excludes %s', async (_label, seed) => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    await seed(store, workspaceId);
    const campaignId = await seedCampaign(store, workspaceId);
    const { activity, captured } = buildActivity(store);

    await activity({ workspaceId, campaignId, workflowRunId: 'run-1', revisionAttempt: 1 });

    expect(payloadFor(captured, 'campaign-strategist').priorLearnings).toHaveLength(0);
  });

  it('never leaks another workspace learning', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    await seedApprovedLearning(store, randomUUID());
    const campaignId = await seedCampaign(store, workspaceId);
    const { activity, captured } = buildActivity(store);

    await activity({ workspaceId, campaignId, workflowRunId: 'run-1', revisionAttempt: 1 });

    expect(payloadFor(captured, 'campaign-strategist').priorLearnings).toHaveLength(0);
  });

  it('injects nothing when no learning store is wired at all (pre-M13 behaviour)', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    await seedApprovedLearning(store, workspaceId);
    const campaignId = await seedCampaign(store, workspaceId);
    const { activity, captured } = buildActivity(store, { withLearnings: false });

    await activity({ workspaceId, campaignId, workflowRunId: 'run-1', revisionAttempt: 1 });

    expect(payloadFor(captured, 'campaign-strategist').priorLearnings).toHaveLength(0);
    expect(payloadFor(captured, 'creative-director').priorLearnings).toHaveLength(0);
  });
});
