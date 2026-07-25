import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createDraftShotSelectionSet,
  createShotSpecification,
  InMemoryCampaignStore,
  rejectShotSelection,
} from '@combat/database';
import { createLoadShotSelectionRegenerationFeedbackActivity } from './load-shot-selection-regeneration-feedback-activity';

type SpecInput = Parameters<typeof createShotSpecification>[2];
function specInput(campaignId: string, shotId: string): SpecInput {
  return {
    campaignId,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotId,
    version: 1,
    shotNumber: 0,
    sequencePosition: 0,
    intendedDurationSeconds: 3,
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
    generationPrompt: 'p',
    generationParams: { durationSeconds: 3, aspectRatio: '9:16', providerOptions: {} },
    outputRequirements: { durationSeconds: 3, aspectRatio: '9:16', minCandidateCount: 1 },
    qualityRubric: [],
    licensingConstraints: [],
    createdByAgentInvocationId: randomUUID(),
  };
}

describe('loadShotSelectionRegenerationFeedbackActivity', () => {
  function build(store: InMemoryCampaignStore) {
    return createLoadShotSelectionRegenerationFeedbackActivity({
      shotSelectionDb: store,
      scriptDb: store,
      shotSpecificationDb: store,
    });
  }

  it('maps each rejected shot to its latest ShotSpecification id with the feedback', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const scriptId = randomUUID();
    const shotId = randomUUID();
    store.scriptRecords.push({
      id: scriptId,
      workspaceId,
      campaignId,
      creativeConceptId: randomUUID(),
      version: 1,
      totalDurationFrames: 90,
      createdAt: new Date(),
    });
    store.shotRecords.push({
      id: shotId,
      workspaceId,
      scriptId,
      index: 0,
      description: 'shot',
      durationFrames: 90,
      beat: 'HOOK',
      status: 'PENDING',
      dependsOnShotIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const spec = await createShotSpecification(store, workspaceId, specInput(campaignId, shotId));
    const { set } = await createDraftShotSelectionSet(store, workspaceId, {
      campaignId,
      scriptId,
      scriptVersion: 1,
      creativeConceptId: randomUUID(),
      creativeConceptVersion: 1,
      version: 1,
      createdByUserId: randomUUID(),
      requiredShots: [
        { shotId, sequencePosition: 0, shotSpecificationId: spec.id, shotSpecificationVersion: 1 },
      ],
    });
    await rejectShotSelection(store, workspaceId, {
      setId: set.id,
      shotId,
      regenerationFeedback: 'Brighten the key light.',
      expectedRevision: 0,
      userId: randomUUID(),
    });

    const result = await build(store)({ workspaceId, campaignId });
    expect(result.feedback).toEqual([
      { shotSpecificationId: spec.id, feedback: 'Brighten the key light.' },
    ]);
  });

  it('returns no feedback when nothing was rejected', async () => {
    const store = new InMemoryCampaignStore();
    const result = await build(store)({ workspaceId: randomUUID(), campaignId: randomUUID() });
    expect(result.feedback).toEqual([]);
  });
});
