import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createCreativeConcept,
  createScriptWithShots,
  createShotSpecification,
  InMemoryCampaignStore,
} from '@combat/database';
import { createLoadLatestShotSpecificationsActivity } from './load-latest-shot-specifications-activity';

function baseSpecFields(identity: {
  campaignId: string;
  creativeConceptId: string;
  scriptId: string;
  shotId: string;
}): Parameters<typeof createShotSpecification>[2] {
  return {
    ...identity,
    creativeConceptVersion: 1,
    scriptVersion: 1,
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
    motionIntensity: 'LOW' as const,
    transitionIn: 'CUT' as const,
    transitionOut: 'CUT' as const,
    textSafeAreas: [],
    referenceAssetIds: [],
    continuityRequirements: [],
    providerId: 'mock',
    promptVersionId: randomUUID(),
    generationPrompt: 'prompt',
    generationParams: { durationSeconds: 3, aspectRatio: '9:16' as const, providerOptions: {} },
    outputRequirements: { durationSeconds: 3, aspectRatio: '9:16' as const, minCandidateCount: 1 },
    qualityRubric: [],
    licensingConstraints: [],
    createdByAgentInvocationId: randomUUID(),
  };
}

describe('loadLatestShotSpecificationsActivity', () => {
  it('resolves the latest ShotSpecification id for every shot in the latest script', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const concept = await createCreativeConcept(store, campaign.workspaceId, {
      campaignId: campaign.id,
      version: 1,
      logline: 'l',
      visualDirection: 'v',
      narrativeArc: 'n',
      referenceNotes: [],
    });
    const { script, shots } = await createScriptWithShots(store, campaign.workspaceId, {
      campaignId: campaign.id,
      creativeConceptId: concept.id,
      version: 1,
      totalDurationFrames: 180,
      shots: [
        { index: 0, description: 'a', durationFrames: 90, beat: 'HOOK', dependsOnShotIndices: [] },
        { index: 1, description: 'b', durationFrames: 90, beat: 'CTA', dependsOnShotIndices: [0] },
      ],
    });
    const specs = [];
    for (const shot of shots) {
      // eslint-disable-next-line no-await-in-loop
      specs.push(
        await createShotSpecification(
          store,
          campaign.workspaceId,
          baseSpecFields({
            campaignId: campaign.id,
            creativeConceptId: concept.id,
            scriptId: script.id,
            shotId: shot.id,
          }),
        ),
      );
    }

    const activity = createLoadLatestShotSpecificationsActivity({
      scriptDb: store,
      shotSpecificationDb: store,
    });
    const result = await activity({ workspaceId: campaign.workspaceId, campaignId: campaign.id });

    expect(result).toEqual({ ok: true, shotSpecificationIds: specs.map((s) => s.id) });
  });

  it('fails with SCRIPT_NOT_FOUND when the campaign has no Script', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const activity = createLoadLatestShotSpecificationsActivity({
      scriptDb: store,
      shotSpecificationDb: store,
    });

    const result = await activity({ workspaceId: campaign.workspaceId, campaignId: campaign.id });

    expect(result).toMatchObject({ ok: false, reason: 'SCRIPT_NOT_FOUND' });
  });

  it('fails with SHOT_MISSING_SPECIFICATION when a shot has no ShotSpecification yet', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign();
    const concept = await createCreativeConcept(store, campaign.workspaceId, {
      campaignId: campaign.id,
      version: 1,
      logline: 'l',
      visualDirection: 'v',
      narrativeArc: 'n',
      referenceNotes: [],
    });
    await createScriptWithShots(store, campaign.workspaceId, {
      campaignId: campaign.id,
      creativeConceptId: concept.id,
      version: 1,
      totalDurationFrames: 90,
      shots: [
        { index: 0, description: 'a', durationFrames: 90, beat: 'HOOK', dependsOnShotIndices: [] },
      ],
    });

    const activity = createLoadLatestShotSpecificationsActivity({
      scriptDb: store,
      shotSpecificationDb: store,
    });
    const result = await activity({ workspaceId: campaign.workspaceId, campaignId: campaign.id });

    expect(result).toMatchObject({ ok: false, reason: 'SHOT_MISSING_SPECIFICATION' });
  });
});
