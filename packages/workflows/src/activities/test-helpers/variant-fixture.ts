import { randomUUID } from 'node:crypto';
import { createVariantSpecification, type InMemoryCampaignStore } from '@combat/database';

/**
 * M14 test helper: seeds a campaign with one persisted `VariantSpecification`,
 * directly through the repository.
 *
 * The crash-recovery tests exercise the render dispatch/poll boundary, not the
 * Variant Generator — so this deliberately skips the agent run and the whole
 * upstream chain M12's own fixture builds, keeping those tests focused on the
 * failure windows they are about.
 */
export async function seedVariantSpecificationFixture(
  store: InMemoryCampaignStore,
  overrides: { targetDurationSeconds?: number } = {},
): Promise<{
  workspaceId: string;
  campaignId: string;
  specId: string;
  parentMasterAssetId: string;
}> {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const parentMasterAssetId = randomUUID();
  const targetDurationSeconds = overrides.targetDurationSeconds ?? 15;
  const frames = targetDurationSeconds * 30;

  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'VARIANT_GENERATION' });

  const { specification } = await createVariantSpecification(store, workspaceId, {
    campaignId,
    parentMasterAssetId,
    parentFinalQaAssessmentId: randomUUID(),
    timelineId: randomUUID(),
    timelineVersion: 1,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotSelectionSetId: randomUUID(),
    shotSelectionSetVersion: 1,
    roughEditSpecificationId: randomUUID(),
    roughEditSpecificationVersion: 1,
    soundDesignPlanId: randomUUID(),
    soundDesignPlanVersion: 1,
    deliveryProfileId: randomUUID(),
    deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
    deliveryProfileVersion: 1,
    deliverySpecificationId: randomUUID(),
    platform: 'INSTAGRAM_REELS',
    targetDurationSeconds,
    targetDurationFrames: frames,
    aspectRatio: '9:16',
    resolutionWidth: 1080,
    resolutionHeight: 1920,
    frameRate: 30,
    cutPoints: [{ order: 0, sourceStartFrame: 0, sourceEndFrame: frames, variantStartFrame: 0 }],
    retainedClips: [
      {
        order: 0,
        shotId: randomUUID(),
        shotIndex: 0,
        sourceAssetId: randomUUID(),
        sourceStartFrame: 0,
        sourceEndFrame: frames,
      },
    ],
    retainedCues: [],
    retainedCaptions: [
      { text: 'Caption', variantStartFrame: 0, variantEndFrame: frames, safeArea: 'BOTTOM' },
    ],
    ctaPlacement: { present: true, variantStartFrame: frames - 60, variantEndFrame: frames },
    captionBurnRequired: true,
    safeAreas: ['BOTTOM'],
    cutRationale: 'fixture cut',
    removedRationale: [],
    qualityRubric: [],
    promptVersionId: randomUUID(),
    createdByAgentInvocationId: randomUUID(),
  });

  return { workspaceId, campaignId, specId: specification.id, parentMasterAssetId };
}
