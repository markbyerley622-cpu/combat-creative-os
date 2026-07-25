import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VERTICAL_SHORT_FORM_V1 } from '@combat/domain';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';
import {
  getLatestDeliveryProfile,
  getOrCreateDeliveryProfile,
  listDeliveryProfiles,
} from './delivery-profile-repository';
import {
  approveVariantSpecificationForExport,
  createVariantSpecification,
  getOrCreateCreativeVariant,
  getOrCreateVariantGenerationAttempt,
  getOrCreateVariantGenerationJob,
  getVariantSpecification,
  listCreativeVariants,
  listLiveVariantSpecifications,
  listVariantGenerationAttempts,
  updateCreativeVariant,
  updateVariantGenerationAttempt,
  VariantSpecificationImmutableError,
  type CreateVariantSpecificationInput,
} from './variant-repositories';

function buildSpecInput(
  overrides: Partial<CreateVariantSpecificationInput> = {},
): CreateVariantSpecificationInput {
  return {
    campaignId: overrides.campaignId ?? randomUUID(),
    parentMasterAssetId: overrides.parentMasterAssetId ?? randomUUID(),
    parentFinalQaAssessmentId: overrides.parentFinalQaAssessmentId ?? randomUUID(),
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
    targetDurationSeconds: overrides.targetDurationSeconds ?? 10,
    targetDurationFrames: (overrides.targetDurationSeconds ?? 10) * 30,
    aspectRatio: '9:16',
    resolutionWidth: 1080,
    resolutionHeight: 1920,
    frameRate: 30,
    cutPoints: [{ order: 0, sourceStartFrame: 0, sourceEndFrame: 300, variantStartFrame: 0 }],
    retainedClips: [
      {
        order: 0,
        shotId: randomUUID(),
        shotIndex: 0,
        sourceAssetId: randomUUID(),
        sourceStartFrame: 0,
        sourceEndFrame: 300,
      },
    ],
    retainedCues: [],
    retainedCaptions: [],
    ctaPlacement: { present: true, variantStartFrame: 240, variantEndFrame: 300 },
    captionBurnRequired: true,
    safeAreas: ['BOTTOM'],
    cutRationale: 'kept hook and CTA',
    removedRationale: ['dropped the promise beat'],
    qualityRubric: [],
    promptVersionId: randomUUID(),
    createdByAgentInvocationId: overrides.createdByAgentInvocationId ?? randomUUID(),
    ...overrides,
  };
}

describe('delivery-profile-repository', () => {
  it('seeds VERTICAL_SHORT_FORM_V1 idempotently per (workspace, key, version)', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();

    const first = await getOrCreateDeliveryProfile(store, workspaceId, VERTICAL_SHORT_FORM_V1);
    const second = await getOrCreateDeliveryProfile(store, workspaceId, VERTICAL_SHORT_FORM_V1);

    expect(first.alreadyExisted).toBe(false);
    expect(second.alreadyExisted).toBe(true);
    expect(second.profile.id).toBe(first.profile.id);
    expect(store.deliveryProfileRecords).toHaveLength(1);
    expect(first.profile.durationsSeconds).toEqual([15, 10, 6]);
    expect(first.profile.platforms).toEqual(['INSTAGRAM_REELS', 'TIKTOK', 'YOUTUBE_SHORTS']);
    expect(first.profile.captionBurnRequired).toBe(true);
    expect(first.profile.ctaTailSeconds).toBe(2);
  });

  it('resolves the latest version of a profile key and scopes reads by workspace', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();

    await getOrCreateDeliveryProfile(store, workspaceId, VERTICAL_SHORT_FORM_V1);
    await getOrCreateDeliveryProfile(store, workspaceId, {
      ...VERTICAL_SHORT_FORM_V1,
      version: 2,
      ctaTailSeconds: 3,
    });
    await getOrCreateDeliveryProfile(store, otherWorkspaceId, VERTICAL_SHORT_FORM_V1);

    const latest = await getLatestDeliveryProfile(store, workspaceId, 'VERTICAL_SHORT_FORM_V1');
    expect(latest?.version).toBe(2);
    expect(latest?.ctaTailSeconds).toBe(3);
    expect(await listDeliveryProfiles(store, workspaceId)).toHaveLength(2);
    expect(await listDeliveryProfiles(store, otherWorkspaceId)).toHaveLength(1);
  });
});

describe('variant-repositories — VariantSpecification', () => {
  it('persists the full cut recipe and provenance chain at version 1', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const input = buildSpecInput();

    const { specification, alreadyExisted } = await createVariantSpecification(
      store,
      workspaceId,
      input,
    );

    expect(alreadyExisted).toBe(false);
    expect(specification.version).toBe(1);
    expect(specification.workspaceId).toBe(workspaceId);
    expect(specification.parentMasterAssetId).toBe(input.parentMasterAssetId);
    expect(specification.roughEditSpecificationVersion).toBe(1);
    expect(specification.soundDesignPlanVersion).toBe(1);
    expect(specification.cutPoints).toHaveLength(1);
    expect(specification.supersededAt).toBeUndefined();
    expect(specification.approvedForExportAt).toBeUndefined();
  });

  it('is idempotent per agent invocation — a replayed Activity writes no second version', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const input = buildSpecInput();

    const first = await createVariantSpecification(store, workspaceId, input);
    const second = await createVariantSpecification(store, workspaceId, input);

    expect(second.alreadyExisted).toBe(true);
    expect(second.specification.id).toBe(first.specification.id);
    expect(store.variantSpecificationRecords).toHaveLength(1);
  });

  it('versions and supersedes a prior live cut for the same duration', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const parentMasterAssetId = randomUUID();

    const first = await createVariantSpecification(
      store,
      workspaceId,
      buildSpecInput({ campaignId, parentMasterAssetId }),
    );
    const second = await createVariantSpecification(
      store,
      workspaceId,
      buildSpecInput({ campaignId, parentMasterAssetId }),
    );

    expect(second.specification.version).toBe(2);
    const reloadedFirst = await getVariantSpecification(store, workspaceId, first.specification.id);
    expect(reloadedFirst?.supersededAt).toBeInstanceOf(Date);

    const live = await listLiveVariantSpecifications(store, workspaceId, campaignId);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(second.specification.id);
  });

  it('keeps each target duration on its own version track', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const parentMasterAssetId = randomUUID();

    for (const targetDurationSeconds of [15, 10, 6]) {
      // eslint-disable-next-line no-await-in-loop -- sequential keeps version assignment deterministic
      await createVariantSpecification(
        store,
        workspaceId,
        buildSpecInput({ campaignId, parentMasterAssetId, targetDurationSeconds }),
      );
    }

    const live = await listLiveVariantSpecifications(store, workspaceId, campaignId);
    expect(live.map((s) => s.targetDurationSeconds)).toEqual([15, 10, 6]);
    expect(live.every((s) => s.version === 1)).toBe(true);
  });

  it('refuses to supersede a cut already approved for export', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const parentMasterAssetId = randomUUID();

    const { specification } = await createVariantSpecification(
      store,
      workspaceId,
      buildSpecInput({ campaignId, parentMasterAssetId }),
    );
    await approveVariantSpecificationForExport(store, workspaceId, specification.id);

    await expect(
      createVariantSpecification(
        store,
        workspaceId,
        buildSpecInput({ campaignId, parentMasterAssetId }),
      ),
    ).rejects.toBeInstanceOf(VariantSpecificationImmutableError);
    expect(store.variantSpecificationRecords).toHaveLength(1);
  });

  it('approving for export is idempotent and freezes the timestamp', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const { specification } = await createVariantSpecification(
      store,
      workspaceId,
      buildSpecInput(),
    );

    const first = await approveVariantSpecificationForExport(store, workspaceId, specification.id);
    const second = await approveVariantSpecificationForExport(store, workspaceId, specification.id);

    expect(first.approvedForExportAt).toEqual(second.approvedForExportAt);
  });

  it('never reads another workspace specification', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const { specification } = await createVariantSpecification(
      store,
      workspaceId,
      buildSpecInput({ campaignId }),
    );

    expect(await getVariantSpecification(store, randomUUID(), specification.id)).toBeUndefined();
    expect(await listLiveVariantSpecifications(store, randomUUID(), campaignId)).toHaveLength(0);
  });
});

describe('variant-repositories — jobs, attempts and rendered variants', () => {
  it('creates one job per specification and appends immutable attempts', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const { specification } = await createVariantSpecification(
      store,
      workspaceId,
      buildSpecInput({ campaignId }),
    );

    const job = await getOrCreateVariantGenerationJob(store, workspaceId, {
      campaignId,
      variantSpecificationId: specification.id,
      maxAttempts: 3,
    });
    const again = await getOrCreateVariantGenerationJob(store, workspaceId, {
      campaignId,
      variantSpecificationId: specification.id,
      maxAttempts: 3,
    });

    expect(again.id).toBe(job.id);
    expect(store.variantGenerationJobRecords).toHaveLength(1);

    for (const attemptNumber of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- sequential attempt history
      await getOrCreateVariantGenerationAttempt(store, workspaceId, {
        variantGenerationJobId: job.id,
        attemptNumber,
        idempotencyKey: `run-1:VARIANT:${specification.id}:${attemptNumber}`,
        providerId: 'mock-motion-graphics',
        status: 'QUEUED',
        startedAt: new Date(),
      });
    }

    const attempts = await listVariantGenerationAttempts(store, job.id);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
  });

  it('is idempotent per (job, idempotencyKey) — a replayed dispatch reuses the attempt', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const { specification } = await createVariantSpecification(
      store,
      workspaceId,
      buildSpecInput(),
    );
    const job = await getOrCreateVariantGenerationJob(store, workspaceId, {
      campaignId: specification.campaignId,
      variantSpecificationId: specification.id,
      maxAttempts: 3,
    });
    const attemptInput = {
      variantGenerationJobId: job.id,
      attemptNumber: 1,
      idempotencyKey: 'run-1:VARIANT:spec:1',
      providerId: 'mock-motion-graphics',
      status: 'QUEUED' as const,
      startedAt: new Date(),
    };

    const first = await getOrCreateVariantGenerationAttempt(store, workspaceId, attemptInput);
    const second = await getOrCreateVariantGenerationAttempt(store, workspaceId, attemptInput);

    expect(first.alreadyExisted).toBe(false);
    expect(second.alreadyExisted).toBe(true);
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(store.variantGenerationAttemptRecords).toHaveLength(1);
  });

  it('records budget reservation and actual usage on the attempt', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const { specification } = await createVariantSpecification(
      store,
      workspaceId,
      buildSpecInput(),
    );
    const job = await getOrCreateVariantGenerationJob(store, workspaceId, {
      campaignId: specification.campaignId,
      variantSpecificationId: specification.id,
      maxAttempts: 3,
    });
    const { attempt } = await getOrCreateVariantGenerationAttempt(store, workspaceId, {
      variantGenerationJobId: job.id,
      attemptNumber: 1,
      idempotencyKey: 'k',
      providerId: 'mock-motion-graphics',
      status: 'QUEUED',
      startedAt: new Date(),
    });

    await updateVariantGenerationAttempt(store, attempt.id, {
      status: 'SUBMITTED',
      budgetReservationId: 'k',
      estimatedCostCents: 450,
    });
    const finished = await updateVariantGenerationAttempt(store, attempt.id, {
      status: 'SUCCEEDED',
      actualCostCents: 430,
      outputAssetId: randomUUID(),
      completedAt: new Date(),
    });

    expect(finished.estimatedCostCents).toBe(450);
    expect(finished.actualCostCents).toBe(430);
    expect(finished.outputAssetId).toBeDefined();
  });

  it('creates one CreativeVariant per specification, and surfaces it to the transition facts', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const { specification } = await createVariantSpecification(
      store,
      workspaceId,
      buildSpecInput({ campaignId }),
    );

    const first = await getOrCreateCreativeVariant(store, workspaceId, {
      campaignId,
      deliverySpecificationId: specification.deliverySpecificationId,
      variantSpecificationId: specification.id,
      durationSeconds: 10,
    });
    const second = await getOrCreateCreativeVariant(store, workspaceId, {
      campaignId,
      deliverySpecificationId: specification.deliverySpecificationId,
      variantSpecificationId: specification.id,
      durationSeconds: 10,
    });

    expect(second.alreadyExisted).toBe(true);
    expect(second.variant.id).toBe(first.variant.id);

    await updateCreativeVariant(store, first.variant.id, {
      status: 'READY',
      assetId: randomUUID(),
      qualityAssessmentId: randomUUID(),
    });

    const variants = await listCreativeVariants(store, workspaceId, campaignId);
    expect(variants).toHaveLength(1);
    expect(variants[0]!.status).toBe('READY');
    expect(variants[0]!.qualityAssessmentId).toBeDefined();

    // The transition-facts read shape sees the same row (variantsGenerated).
    const factRows = await store.creativeVariant.findMany({} as never);
    expect(factRows.some((r: { id: string }) => r.id === first.variant.id)).toBe(true);
  });

  it('scopes rendered variants by workspace', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const { specification } = await createVariantSpecification(
      store,
      workspaceId,
      buildSpecInput({ campaignId }),
    );
    await getOrCreateCreativeVariant(store, workspaceId, {
      campaignId,
      deliverySpecificationId: specification.deliverySpecificationId,
      variantSpecificationId: specification.id,
      durationSeconds: 10,
    });

    expect(await listCreativeVariants(store, randomUUID(), campaignId)).toHaveLength(0);
  });
});
