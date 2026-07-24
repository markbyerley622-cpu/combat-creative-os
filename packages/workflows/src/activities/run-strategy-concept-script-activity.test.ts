import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueuedReasoningProvider, computeCost } from '@combat/agent-runtime';
import { AGENT_REGISTRY, campaignStrategistAgent } from '@combat/agents';
import { InMemoryCampaignStore, submitCampaignBrief } from '@combat/database';
import { createExecuteSpecialistAgentActivity } from './execute-specialist-agent-activity';
import { createRunStrategyConceptScriptActivity } from './run-strategy-concept-script-activity';

const CAMPAIGN_STRATEGIST_ESTIMATED_CENTS = Math.ceil(
  computeCost(
    campaignStrategistAgent.modelPolicy.model,
    campaignStrategistAgent.tokenBudget.maxInputTokens,
    campaignStrategistAgent.tokenBudget.maxOutputTokens,
  ).costMicroCents / 1_000_000,
);

const STRATEGY_RESULT = {
  audienceProfile: {
    name: 'Gym Owner',
    demographics: {},
    psychographics: {},
    painPoints: ['manual review requests take too long'],
    platformBehavior: {},
  },
  strategy: {
    positioning: 'The trusted, automated review layer for combat gyms',
    targetAudienceSummary: 'Gym owners aged 28-45 who run independent MMA/BJJ gyms',
    keyMessages: ['Automated review collection', 'Built for combat gyms'],
    toneGuidelines: ['Confident, direct, no jargon'],
  },
};

const CONCEPT_RESULT = {
  logline: 'A gym owner watches reviews roll in without lifting a finger.',
  visualDirection: 'Handheld gym footage, warm lighting, quick cuts on review notifications.',
  narrativeArc:
    'Problem (manual chasing) -> discovery (the app) -> relief (reviews arrive automatically).',
  referenceNotes: ['Feels like a founder testimonial, not a corporate ad'],
};

const SCRIPT_RESULT = {
  totalDurationFrames: 450,
  shots: [
    {
      index: 0,
      description: 'Hook: gym owner frustrated at a laptop.',
      durationFrames: 90,
      beat: 'HOOK',
      dependsOnShotIndices: [],
    },
    {
      index: 1,
      description: 'Promise: reviews start appearing automatically.',
      durationFrames: 120,
      beat: 'PROMISE',
      dependsOnShotIndices: [0],
    },
    {
      index: 2,
      description: 'Feature: dashboard fills with review widgets.',
      durationFrames: 150,
      beat: 'FEATURE',
      dependsOnShotIndices: [1],
    },
    {
      index: 3,
      description: 'CTA: Sign up today.',
      durationFrames: 90,
      beat: 'CTA',
      dependsOnShotIndices: [2],
    },
  ],
};

function buildDeps(store: InMemoryCampaignStore) {
  const executeSpecialistAgentActivity = createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider([
      { result: STRATEGY_RESULT },
      { result: CONCEPT_RESULT },
      { result: SCRIPT_RESULT },
    ]),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
  return createRunStrategyConceptScriptActivity({
    executeSpecialistAgentActivity,
    campaignBriefDb: store,
    strategyDb: store,
    creativeConceptDb: store,
    scriptDb: store,
    humanApprovalDb: store,
  });
}

async function seedAcceptedBrief(
  store: InMemoryCampaignStore,
  campaignId: string,
  workspaceId: string,
) {
  await submitCampaignBrief(store, workspaceId, {
    campaignId,
    content: {
      campaignName: 'Launch Q3',
      productName: 'Combat Reviews',
      productDescription: 'Review aggregator for combat sports gyms',
      objective: 'Drive trial signups',
      targetAudience: 'MMA gym owners',
      customerProblem: 'No easy way to collect reviews',
      valueProposition: 'Automated review collection',
      productFeatures: ['review widgets'],
      targetPlatforms: ['INSTAGRAM_REELS'],
      aspectRatios: ['9:16'],
      durationsSeconds: [15],
      brandVoice: 'confident',
      visualDirection: 'gritty gym footage',
      requiredMessaging: ['try it free'],
      callToAction: 'Sign up today',
      references: [],
      assetReferences: [],
      prohibitedClaims: [],
      budgetCents: 500000,
      locale: 'en-US',
    },
  });
}

describe('runStrategyConceptScriptActivity', () => {
  it('sequences Strategist -> Creative Director -> Script Director and persists all three as version 1', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'STRATEGY_REVIEW' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    const activity = buildDeps(store);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      revisionAttempt: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    expect(store.strategies).toHaveLength(1);
    expect(store.strategies[0]!.id).toBe(result.strategyId);
    expect(store.creativeConceptRecords).toHaveLength(1);
    expect(store.creativeConceptRecords[0]!.id).toBe(result.conceptId);
    expect(store.scriptRecords).toHaveLength(1);
    expect(store.scriptRecords[0]!.id).toBe(result.scriptId);
    expect(store.shotRecords).toHaveLength(4);
    expect(store.agentInvocations).toHaveLength(3);
    expect(store.agentInvocations.map((a) => a.agentName)).toEqual([
      'campaign-strategist',
      'creative-director',
      'script-timing-director',
    ]);
  });

  it('is idempotent: retrying the same revisionAttempt does not create duplicate agent invocations or artifact rows', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'STRATEGY_REVIEW' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    const activity = buildDeps(store);
    const workflowRunId = randomUUID();

    const first = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId,
      revisionAttempt: 1,
    });
    const second = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId,
      revisionAttempt: 1,
    });

    expect(first).toEqual(second);
    expect(store.strategies).toHaveLength(1);
    expect(store.creativeConceptRecords).toHaveLength(1);
    expect(store.scriptRecords).toHaveLength(1);
    expect(store.agentInvocations).toHaveLength(3);
  });

  it('fails with BRIEF_NOT_FOUND when the campaign has no accepted brief', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'STRATEGY_REVIEW' });
    const activity = buildDeps(store);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      revisionAttempt: 1,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'BRIEF_NOT_FOUND',
      detail: `Campaign ${campaign.id} has no accepted CampaignBrief`,
    });
  });

  it('a second revisionAttempt persists a new version without touching version 1', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'STRATEGY_REVIEW' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    const activity = buildDeps(store);

    await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      revisionAttempt: 1,
    });

    const revisionActivity = createRunStrategyConceptScriptActivity({
      executeSpecialistAgentActivity: createExecuteSpecialistAgentActivity({
        agentRegistry: AGENT_REGISTRY,
        reasoningProvider: new QueuedReasoningProvider([
          { result: STRATEGY_RESULT },
          { result: CONCEPT_RESULT },
          { result: SCRIPT_RESULT },
        ]),
        campaignDb: store,
        agentInvocationDb: store,
        budgetDb: store,
      }),
      campaignBriefDb: store,
      strategyDb: store,
      creativeConceptDb: store,
      scriptDb: store,
      humanApprovalDb: store,
    });

    await revisionActivity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      revisionAttempt: 2,
    });

    expect(store.strategies).toHaveLength(2);
    expect(store.strategies.map((s) => s.version).sort()).toEqual([1, 2]);
    expect(store.creativeConceptRecords).toHaveLength(2);
    expect(store.scriptRecords).toHaveLength(2);
  });

  it('fails with AGENT_FAILED (reason BUDGET_EXCEEDED) and persists no artifacts when the campaign budget is exhausted', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'STRATEGY_REVIEW' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: campaign.workspaceId,
      level: 'CAMPAIGN',
      scopeId: campaign.id,
      limitCents: CAMPAIGN_STRATEGIST_ESTIMATED_CENTS - 1,
    });
    const activity = buildDeps(store);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'AGENT_FAILED',
      agentName: 'campaign-strategist',
    });
    expect(store.strategies).toHaveLength(0);
    expect(store.creativeConceptRecords).toHaveLength(0);
    expect(store.scriptRecords).toHaveLength(0);
    // The budget rejection is still persisted as a terminal AgentInvocation (ADR-0004 requirement 6).
    expect(store.agentInvocations).toHaveLength(1);
    expect(store.agentInvocations[0]!.failureReason).toBe('BUDGET_EXCEEDED');
  });

  it('fails with AGENT_FAILED (reason SCHEMA_INVALID) and persists no artifacts when an agent returns malformed output', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'STRATEGY_REVIEW' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    const activity = createRunStrategyConceptScriptActivity({
      executeSpecialistAgentActivity: createExecuteSpecialistAgentActivity({
        agentRegistry: AGENT_REGISTRY,
        // Two queued responses (agent-runtime retries once with a corrective
        // re-prompt on schema failure) — both malformed, so it gives up.
        reasoningProvider: new QueuedReasoningProvider([
          { result: { not: 'a valid strategy result' } },
          { result: { not: 'a valid strategy result' } },
        ]),
        campaignDb: store,
        agentInvocationDb: store,
        budgetDb: store,
      }),
      campaignBriefDb: store,
      strategyDb: store,
      creativeConceptDb: store,
      scriptDb: store,
      humanApprovalDb: store,
    });

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'AGENT_FAILED',
      agentName: 'campaign-strategist',
    });
    expect(store.strategies).toHaveLength(0);
    expect(store.agentInvocations[0]!.failureReason).toBe('SCHEMA_INVALID');
  });
});
