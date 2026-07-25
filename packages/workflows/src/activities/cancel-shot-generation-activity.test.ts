import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createShotSpecification, InMemoryCampaignStore } from '@combat/database';
import { MockVideoGenerationProvider } from '@combat/providers';
import { createCancelShotGenerationActivity } from './cancel-shot-generation-activity';
import { createDispatchShotGenerationActivity } from './dispatch-shot-generation-activity';

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
    outputRequirements: { durationSeconds: 5, aspectRatio: '9:16', minCandidateCount: 1 },
    qualityRubric: [],
    licensingConstraints: [],
    createdByAgentInvocationId: randomUUID(),
  });
}

describe('cancelShotGenerationActivity', () => {
  it('cancels an in-flight attempt, marks it CANCELLED, and releases the full reservation', async () => {
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
    const provider = new MockVideoGenerationProvider({ pollsUntilTerminal: 5 });
    const dispatched = await createDispatchShotGenerationActivity({
      videoGenerationProvider: provider,
      shotSpecificationDb: store,
      shotGenerationDb: store,
      budgetDb: store,
      estimatedCostCentsPerSecond: 50,
    })({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      shotSpecificationId: spec.id,
      attemptNumber: 1,
    });
    if (!dispatched.ok) throw new Error('dispatch failed in test setup');

    const cancel = createCancelShotGenerationActivity({
      videoGenerationProvider: provider,
      shotGenerationDb: store,
      budgetDb: store,
    });
    const result = await cancel({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      shotId: spec.shotId,
      providerId: spec.providerId,
      attemptId: dispatched.attemptId,
    });

    expect(result).toEqual({ ok: true, alreadyTerminal: false });
    expect(store.shotGenerationAttemptRecords[0]!.status).toBe('CANCELLED');
    expect(store.shotGenerationJobRecords[0]!.status).toBe('CANCELLED');
    const entries = store.budgetLedgerEntries.filter(
      (e) => e.budgetPolicyId === store.budgetPolicies[0]!.id,
    );
    expect(entries.map((e) => e.entryType)).toEqual(['RESERVATION', 'RELEASE']);
  });

  it('is a no-op against an already-terminal attempt', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const spec = await seedSpec(store, campaign.workspaceId, campaign.id);
    const provider = new MockVideoGenerationProvider();
    const dispatched = await createDispatchShotGenerationActivity({
      videoGenerationProvider: provider,
      shotSpecificationDb: store,
      shotGenerationDb: store,
      budgetDb: store,
      estimatedCostCentsPerSecond: 50,
    })({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      shotSpecificationId: spec.id,
      attemptNumber: 1,
    });
    if (!dispatched.ok) throw new Error('dispatch failed in test setup');
    // Mark terminal directly (simulating a poll that already completed it).
    store.shotGenerationAttemptRecords[0]!.status = 'SUCCEEDED';

    const cancel = createCancelShotGenerationActivity({
      videoGenerationProvider: provider,
      shotGenerationDb: store,
      budgetDb: store,
    });
    const result = await cancel({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      shotId: spec.shotId,
      providerId: spec.providerId,
      attemptId: dispatched.attemptId,
    });

    expect(result).toEqual({ ok: true, alreadyTerminal: true });
  });
});
