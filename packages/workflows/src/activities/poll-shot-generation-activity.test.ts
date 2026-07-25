import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createShotSpecification, getBudgetStatus, InMemoryCampaignStore } from '@combat/database';
import { MockVideoGenerationProvider } from '@combat/providers';
import { createDispatchShotGenerationActivity } from './dispatch-shot-generation-activity';
import { createPollShotGenerationActivity } from './poll-shot-generation-activity';

async function seedSpec(store: InMemoryCampaignStore, workspaceId: string, campaignId: string) {
  return createShotSpecification(store, workspaceId, {
    campaignId,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotId: randomUUID(),
    version: 1,
    shotNumber: 0,
    sequencePosition: 0,
    intendedDurationSeconds: 5,
    visualObjective: 'o',
    action: 'a',
    subject: 's',
    environment: 'e',
    cameraMovement: 'static',
    lensFraming: 'wide',
    lighting: 'soft',
    colorTreatment: 'neutral',
    motionIntensity: 'LOW',
    transitionIn: 'CUT',
    transitionOut: 'CUT',
    textSafeAreas: [],
    referenceAssetIds: [],
    continuityRequirements: [],
    providerId: 'mock-video-generation',
    promptVersionId: randomUUID(),
    generationPrompt: 'A boxer throws a jab',
    generationParams: { durationSeconds: 5, aspectRatio: '9:16', providerOptions: {} },
    outputRequirements: { durationSeconds: 5, aspectRatio: '9:16', minCandidateCount: 2 },
    qualityRubric: [],
    licensingConstraints: [],
    createdByAgentInvocationId: randomUUID(),
  });
}

async function dispatch(
  store: InMemoryCampaignStore,
  campaign: { id: string; workspaceId: string },
  provider: MockVideoGenerationProvider,
  spec: Awaited<ReturnType<typeof seedSpec>>,
  workflowRunId: string = randomUUID(),
) {
  const dispatchActivity = createDispatchShotGenerationActivity({
    videoGenerationProvider: provider,
    shotSpecificationDb: store,
    shotGenerationDb: store,
    budgetDb: store,
    estimatedCostCentsPerSecond: 50,
  });
  const result = await dispatchActivity({
    workspaceId: campaign.workspaceId,
    campaignId: campaign.id,
    workflowRunId,
    shotSpecificationId: spec.id,
    attemptNumber: 1,
  });
  if (!result.ok) throw new Error('dispatch failed in test setup');
  return result;
}

function buildPollActivity(store: InMemoryCampaignStore, provider: MockVideoGenerationProvider) {
  return createPollShotGenerationActivity({
    videoGenerationProvider: provider,
    shotGenerationDb: store,
    assetDb: store,
    budgetDb: store,
  });
}

describe('pollShotGenerationActivity', () => {
  it('registers a candidate + Asset per output and charges actual cost on SUCCEEDED', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: campaign.workspaceId,
      level: 'SHOT',
      scopeId: spec.shotId,
      limitCents: 100_000,
    });
    const provider = new MockVideoGenerationProvider();
    const dispatched = await dispatch(store, campaign, provider, spec);
    const poll = buildPollActivity(store, provider);

    const result = await poll({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      shotId: spec.shotId,
      providerId: spec.providerId,
      attemptId: dispatched.attemptId,
    });

    expect(result).toMatchObject({ terminal: true, status: 'SUCCEEDED' });
    if (!('candidateIds' in result)) throw new Error('expected candidateIds');
    expect(result.candidateIds).toHaveLength(2);
    expect(result.assetIds).toHaveLength(2);
    expect(store.generationCandidateRecords).toHaveLength(2);
    expect(store.assets).toHaveLength(2);
    expect(store.assets.every((a) => a.kind === 'VIDEO_CANDIDATE')).toBe(true);
    expect(store.shotGenerationAttemptRecords[0]!.status).toBe('SUCCEEDED');
    expect(store.shotGenerationJobRecords[0]!.status).toBe('SUCCEEDED');

    const shotEntries = store.budgetLedgerEntries.filter(
      (e) => e.budgetPolicyId === store.budgetPolicies[0]!.id,
    );
    expect(shotEntries.map((e) => e.entryType)).toContain('CHARGE');
  });

  /**
   * Post-M14 audit finding C-2, asserted end-to-end across the real
   * dispatch → poll pair rather than only at the ledger level: after a
   * successful job the budget must report exactly what the provider charged,
   * with the pre-dispatch reservation fully closed out.
   */
  it('leaves spentCents equal to the attempt actual cost after a successful job', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: campaign.workspaceId,
      level: 'WORKSPACE',
      scopeId: campaign.workspaceId,
      limitCents: 100_000,
    });
    const provider = new MockVideoGenerationProvider();
    const dispatched = await dispatch(store, campaign, provider, spec);
    const poll = buildPollActivity(store, provider);

    await poll({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      shotId: spec.shotId,
      providerId: spec.providerId,
      attemptId: dispatched.attemptId,
    });

    const attempt = store.shotGenerationAttemptRecords[0]!;
    expect(attempt.status).toBe('SUCCEEDED');
    const status = await getBudgetStatus(
      store,
      campaign.workspaceId,
      'WORKSPACE',
      campaign.workspaceId,
    );
    expect(status!.spentCents).toBe(attempt.actualCostCents);
    expect(status!.remainingCents).toBe(100_000 - attempt.actualCostCents!);
  });

  it('a re-run poll after settlement does not charge or release a second time', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: campaign.workspaceId,
      level: 'WORKSPACE',
      scopeId: campaign.workspaceId,
      limitCents: 100_000,
    });
    const provider = new MockVideoGenerationProvider();
    const dispatched = await dispatch(store, campaign, provider, spec);
    const poll = buildPollActivity(store, provider);
    const pollInput = {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      shotId: spec.shotId,
      providerId: spec.providerId,
      attemptId: dispatched.attemptId,
    };

    await poll(pollInput);
    const afterFirst = await getBudgetStatus(
      store,
      campaign.workspaceId,
      'WORKSPACE',
      campaign.workspaceId,
    );
    await poll(pollInput);
    await poll(pollInput);

    const afterReplays = await getBudgetStatus(
      store,
      campaign.workspaceId,
      'WORKSPACE',
      campaign.workspaceId,
    );
    expect(afterReplays!.spentCents).toBe(afterFirst!.spentCents);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'CHARGE')).toHaveLength(1);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'RELEASE')).toHaveLength(1);
  });

  it('a failed provider job leaves no charge and no standing reservation', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: campaign.workspaceId,
      level: 'WORKSPACE',
      scopeId: campaign.workspaceId,
      limitCents: 100_000,
    });
    const workflowRunId = randomUUID();
    const provider = new MockVideoGenerationProvider({
      forcedFailures: {
        [`${workflowRunId}:GEN:${spec.id}:1`]: {
          reason: 'PROVIDER_ERROR',
          retryable: true,
          message: 'boom',
        },
      },
    });
    const dispatched = await dispatch(store, campaign, provider, spec, workflowRunId);

    const poll = buildPollActivity(store, provider);
    const result = await poll({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      shotId: spec.shotId,
      providerId: spec.providerId,
      attemptId: dispatched.attemptId,
    });

    expect(result).toMatchObject({ terminal: true, status: 'FAILED' });
    const status = await getBudgetStatus(
      store,
      campaign.workspaceId,
      'WORKSPACE',
      campaign.workspaceId,
    );
    expect(status!.spentCents).toBe(0);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'CHARGE')).toHaveLength(0);
  });

  it('re-polling an already-SUCCEEDED attempt is idempotent and does not re-register candidates', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    const provider = new MockVideoGenerationProvider();
    const dispatched = await dispatch(store, campaign, provider, spec);
    const poll = buildPollActivity(store, provider);
    const input = {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      shotId: spec.shotId,
      providerId: spec.providerId,
      attemptId: dispatched.attemptId,
    };

    const first = await poll(input);
    const second = await poll(input);

    expect(second).toEqual(first);
    expect(store.generationCandidateRecords).toHaveLength(2);
    expect(store.assets).toHaveLength(2);
  });

  it('reports a non-terminal status without touching the budget ledger', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    const provider = new MockVideoGenerationProvider({ pollsUntilTerminal: 2 });
    const dispatched = await dispatch(store, campaign, provider, spec);
    const poll = buildPollActivity(store, provider);

    const result = await poll({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      shotId: spec.shotId,
      providerId: spec.providerId,
      attemptId: dispatched.attemptId,
    });

    expect(result).toEqual({ terminal: false, status: 'SUBMITTED' });
    expect(store.budgetLedgerEntries).toHaveLength(0);
    expect(store.generationCandidateRecords).toHaveLength(0);
  });

  it('releases the full reservation on a FAILED terminal status', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: campaign.workspaceId,
      level: 'SHOT',
      scopeId: spec.shotId,
      limitCents: 100_000,
    });
    const workflowRunId = randomUUID();
    // Force this exact idempotency key to fail, matching what dispatch will construct.
    const forcedKey = `${workflowRunId}:GEN:${spec.id}:1`;
    const failingProvider = new MockVideoGenerationProvider({
      forcedFailures: {
        [forcedKey]: { reason: 'PROVIDER_REJECTED', retryable: true, message: 'rejected' },
      },
    });
    const dispatched = await createDispatchShotGenerationActivity({
      videoGenerationProvider: failingProvider,
      shotSpecificationDb: store,
      shotGenerationDb: store,
      budgetDb: store,
      estimatedCostCentsPerSecond: 50,
    })({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId,
      shotSpecificationId: spec.id,
      attemptNumber: 1,
    });
    if (!dispatched.ok)
      throw new Error('expected successful dispatch (failure happens on poll, not submit)');

    const poll = buildPollActivity(store, failingProvider);
    const result = await poll({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      shotId: spec.shotId,
      providerId: spec.providerId,
      attemptId: dispatched.attemptId,
    });

    expect(result).toMatchObject({
      terminal: true,
      status: 'FAILED',
      failureReason: 'PROVIDER_REJECTED',
    });
    expect(store.shotGenerationAttemptRecords[0]!.status).toBe('FAILED');
    const shotEntries = store.budgetLedgerEntries.filter(
      (e) => e.budgetPolicyId === store.budgetPolicies[0]!.id,
    );
    expect(shotEntries.map((e) => e.entryType)).toEqual(['RESERVATION', 'RELEASE']);
    expect(store.generationCandidateRecords).toHaveLength(0);
  });
});
