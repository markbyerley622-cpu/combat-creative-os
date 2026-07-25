import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createShotSpecification, InMemoryCampaignStore } from '@combat/database';
import { MockVideoGenerationProvider } from '@combat/providers';
import { createDispatchShotGenerationActivity } from './dispatch-shot-generation-activity';

async function seedSpec(
  store: InMemoryCampaignStore,
  workspaceId: string,
  campaignId: string,
  overrides: Record<string, unknown> = {},
) {
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
    ...overrides,
  });
}

function buildActivity(store: InMemoryCampaignStore, provider = new MockVideoGenerationProvider()) {
  return createDispatchShotGenerationActivity({
    videoGenerationProvider: provider,
    shotSpecificationDb: store,
    shotGenerationDb: store,
    budgetDb: store,
    estimatedCostCentsPerSecond: 50,
  });
}

describe('dispatchShotGenerationActivity', () => {
  it('dispatches a shot, reserving budget and persisting a SUBMITTED attempt', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    const activity = buildActivity(store);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      shotSpecificationId: spec.id,
      attemptNumber: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(store.shotGenerationJobRecords).toHaveLength(1);
    expect(store.shotGenerationAttemptRecords).toHaveLength(1);
    expect(store.shotGenerationAttemptRecords[0]!.status).toBe('SUBMITTED');
    expect(store.shotGenerationAttemptRecords[0]!.providerJobId).toBe(result.providerJobId);
    expect(store.shotGenerationJobRecords[0]!.status).toBe('DISPATCHED');
    expect(store.shotGenerationJobRecords[0]!.attemptCount).toBe(1);
  });

  it('is idempotent: retrying the same (workflowRunId, shotSpecificationId, attemptNumber) does not double-dispatch', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    const activity = buildActivity(store);
    const workflowRunId = randomUUID();

    const first = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId,
      shotSpecificationId: spec.id,
      attemptNumber: 1,
    });
    const second = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId,
      shotSpecificationId: spec.id,
      attemptNumber: 1,
    });

    expect(first).toEqual(second);
    expect(store.shotGenerationAttemptRecords).toHaveLength(1);
    expect(store.shotGenerationJobRecords[0]!.attemptCount).toBe(1);
  });

  it('rejects an unsupported capability combination without ever calling the provider a second time', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id, {
      generationParams: { durationSeconds: 999, aspectRatio: '9:16', providerOptions: {} },
    });
    const activity = buildActivity(store);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      shotSpecificationId: spec.id,
      attemptNumber: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'UNSUPPORTED_CAPABILITY' });
    expect(store.shotGenerationAttemptRecords).toHaveLength(1);
    expect(store.shotGenerationAttemptRecords[0]!.status).toBe('FAILED');
    expect(store.shotGenerationAttemptRecords[0]!.failureReason).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('checks and reserves budget at WORKSPACE, CAMPAIGN, SHOT, and PROVIDER levels', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    for (const [level, scopeId] of [
      ['WORKSPACE', campaign.workspaceId],
      ['CAMPAIGN', campaign.id],
      ['SHOT', spec.shotId],
      ['PROVIDER', spec.providerId],
    ] as const) {
      store.budgetPolicies.push({
        id: randomUUID(),
        workspaceId: campaign.workspaceId,
        level,
        scopeId,
        limitCents: 100_000,
      });
    }
    const activity = buildActivity(store);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      shotSpecificationId: spec.id,
      attemptNumber: 1,
    });

    expect(result.ok).toBe(true);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'RESERVATION')).toHaveLength(4);
  });

  it('rejects and releases already-made reservations when a later budget level is exhausted', async () => {
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
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: campaign.workspaceId,
      level: 'CAMPAIGN',
      scopeId: campaign.id,
      limitCents: 1, // exhausted immediately -> CAMPAIGN check fails after WORKSPACE already reserved
    });
    const activity = buildActivity(store);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      shotSpecificationId: spec.id,
      attemptNumber: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'BUDGET_EXCEEDED', level: 'CAMPAIGN' });
    expect(store.shotGenerationAttemptRecords).toHaveLength(0);
    const workspaceEntries = store.budgetLedgerEntries.filter(
      (e) => e.budgetPolicyId === store.budgetPolicies[0]!.id,
    );
    expect(workspaceEntries.map((e) => e.entryType)).toEqual(['RESERVATION', 'RELEASE']);
  });

  it('dispatches as IMAGE_TO_VIDEO when the spec has reference assets, TEXT_TO_VIDEO otherwise', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id, {
      referenceAssetIds: [randomUUID()],
    });
    let capturedMode: string | undefined;
    const provider = new MockVideoGenerationProvider();
    const originalSubmit = provider.submit.bind(provider);
    provider.submit = async (input) => {
      capturedMode = input.mode;
      return originalSubmit(input);
    };
    const activity = buildActivity(store, provider);

    await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      shotSpecificationId: spec.id,
      attemptNumber: 1,
    });

    expect(capturedMode).toBe('IMAGE_TO_VIDEO');
  });
});
