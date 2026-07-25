import {
  InMemoryCampaignStore,
  addMembership,
  createAssetWithProvenance,
  createQualityAssessmentForAsset,
  createVariantSpecification,
  getOrCreateCreativeVariant,
  getOrCreateVariantGenerationAttempt,
  getOrCreateVariantGenerationJob,
  updateCreativeVariant,
} from '@combat/database';
import { createLogger } from '@combat/observability';
import { MockReviewProvider, MockStorageProvider } from '@combat/providers';
import type { WorkflowClient } from '@temporalio/client';
import { buildServer } from './server';

/**
 * A Fastify server backed entirely by in-memory fakes (no Postgres, no
 * Temporal) — never used by `src/index.ts`'s production entry point. This
 * exists so `apps/dashboard`'s Playwright suite (which needs a real
 * apps/api HTTP server to hit — CLAUDE.md forbids the dashboard from having
 * any direct DB/Temporal access of its own) can exercise real RBAC and
 * route code without the live infrastructure this environment doesn't have
 * (no Docker, no live Postgres — see docs/architecture.md §7.1). Fixture
 * ids are hardcoded and read by apps/dashboard/e2e/concept-approval.spec.ts.
 */

export const FIXTURES = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  ownerUserId: '22222222-2222-2222-2222-222222222222',
  reviewerUserId: '33333333-3333-3333-3333-333333333333',
  campaignId: '44444444-4444-4444-4444-444444444444',
  /** M12: a second campaign parked at VARIANT_QA with all three variants cut. */
  variantCampaignId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};

function buildFakeWorkflowClient(): WorkflowClient {
  const query = async (def: { name: string }) => {
    if (def.name === 'getStatus') return 'AWAITING_APPROVAL';
    if (def.name === 'getPendingGate') return 'CONCEPT';
    if (def.name === 'getRevisionCount') return 0;
    return undefined;
  };
  const getHandle = () => ({ query, signal: async () => undefined });
  const start = async () => ({ workflowId: 'fake', firstExecutionRunId: 'fake' });
  return { start, getHandle } as unknown as WorkflowClient;
}

async function seed(store: InMemoryCampaignStore) {
  await addMembership(store, FIXTURES.workspaceId, {
    userId: FIXTURES.ownerUserId,
    role: 'OWNER_ADMIN',
  });
  await addMembership(store, FIXTURES.workspaceId, {
    userId: FIXTURES.reviewerUserId,
    role: 'REVIEWER',
  });
  store.seedCampaign({
    id: FIXTURES.campaignId,
    workspaceId: FIXTURES.workspaceId,
    name: 'Combat Reviews Q3 Launch',
    currentStage: 'CONCEPT_REVIEW',
  });
  store.campaignBriefRecords.push({
    id: '55555555-5555-5555-5555-555555555555',
    workspaceId: FIXTURES.workspaceId,
    campaignId: FIXTURES.campaignId,
    version: 1,
    campaignName: 'Combat Reviews Q3 Launch',
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
    acceptedAt: new Date(),
    createdAt: new Date(),
  });
  store.strategies.push({
    id: '66666666-6666-6666-6666-666666666666',
    workspaceId: FIXTURES.workspaceId,
    campaignId: FIXTURES.campaignId,
    version: 1,
    positioning: 'The trusted, automated review layer for combat gyms',
    targetAudienceSummary: 'Gym owners aged 28-45',
    keyMessages: ['Automated review collection', 'Built for combat gyms'],
    toneGuidelines: ['Confident, direct'],
    audienceProfile: {
      name: 'Gym Owner',
      demographics: {},
      psychographics: {},
      painPoints: ['manual review requests take too long'],
      platformBehavior: {},
    },
    createdAt: new Date(),
  });
  store.creativeConceptRecords.push({
    id: '77777777-7777-7777-7777-777777777777',
    workspaceId: FIXTURES.workspaceId,
    campaignId: FIXTURES.campaignId,
    version: 1,
    logline: 'A gym owner watches reviews roll in without lifting a finger.',
    visualDirection: 'Handheld gym footage, warm lighting.',
    narrativeArc: 'Problem -> discovery -> relief.',
    referenceNotes: [],
    createdAt: new Date(),
  });
  const scriptId = '88888888-8888-8888-8888-888888888888';
  store.scriptRecords.push({
    id: scriptId,
    workspaceId: FIXTURES.workspaceId,
    campaignId: FIXTURES.campaignId,
    creativeConceptId: '77777777-7777-7777-7777-777777777777',
    version: 1,
    totalDurationFrames: 450,
    createdAt: new Date(),
  });
  store.shotRecords.push({
    id: '99999999-9999-9999-9999-999999999999',
    workspaceId: FIXTURES.workspaceId,
    scriptId,
    index: 0,
    description: 'Hook: gym owner frustrated at a laptop.',
    durationFrames: 90,
    beat: 'HOOK',
    status: 'PENDING',
    dependsOnShotIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * M12 fixture: a campaign at VARIANT_QA with the three VERTICAL_SHORT_FORM_V1
 * variants cut from one master — 15s and 6s passing QA, 10s failing — so the
 * dashboard's comparison view, QA/failure display and preview placeholders are
 * all exercisable end-to-end without a live renderer.
 */
async function seedVariants(store: InMemoryCampaignStore) {
  const workspaceId = FIXTURES.workspaceId;
  const campaignId = FIXTURES.variantCampaignId;
  store.seedCampaign({
    id: campaignId,
    workspaceId,
    name: 'Combat Reviews Q3 Launch — delivery',
    currentStage: 'VARIANT_QA',
  });

  const master = await createAssetWithProvenance(store, workspaceId, {
    campaignId,
    kind: 'FINAL_MASTER',
    s3Key: 'mock/final-master/1.mp4',
    checksum: `final-master-${campaignId}`,
    mimeType: 'video/mp4',
    originalFilename: 'final-master-v1.mp4',
    sizeBytes: 0,
    ingestionStatus: 'READY',
    generatedByActivity: 'runFinalQaControllerActivity',
  });

  // 15s = whole master; 10s = HOOK + FEATURE + CTA; 6s = HOOK + CTA.
  const cuts: Record<number, { start: number; end: number }[]> = {
    15: [{ start: 0, end: 450 }],
    10: [
      { start: 0, end: 120 },
      { start: 270, end: 450 },
    ],
    6: [
      { start: 0, end: 120 },
      { start: 390, end: 450 },
    ],
  };

  for (const duration of [15, 10, 6]) {
    const ranges = cuts[duration]!;
    let variantStart = 0;
    const cutPoints = ranges.map((r, order) => {
      const point = {
        order,
        sourceStartFrame: r.start,
        sourceEndFrame: r.end,
        variantStartFrame: variantStart,
      };
      variantStart += r.end - r.start;
      return point;
    });
    const totalFrames = duration * 30;
    const passes = duration !== 10;

    // eslint-disable-next-line no-await-in-loop -- deterministic ordered fixture setup
    const { specification } = await createVariantSpecification(store, workspaceId, {
      campaignId,
      parentMasterAssetId: master.asset.id,
      parentFinalQaAssessmentId: '00000000-0000-0000-0000-0000000000f1',
      timelineId: '00000000-0000-0000-0000-0000000000t1',
      timelineVersion: 1,
      creativeConceptId: '77777777-7777-7777-7777-777777777777',
      creativeConceptVersion: 1,
      scriptId: '88888888-8888-8888-8888-888888888888',
      scriptVersion: 1,
      shotSelectionSetId: '00000000-0000-0000-0000-0000000000s1',
      shotSelectionSetVersion: 1,
      roughEditSpecificationId: '00000000-0000-0000-0000-0000000000r1',
      roughEditSpecificationVersion: 1,
      soundDesignPlanId: '00000000-0000-0000-0000-0000000000p1',
      soundDesignPlanVersion: 1,
      deliveryProfileId: '00000000-0000-0000-0000-0000000000d1',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      deliveryProfileVersion: 1,
      deliverySpecificationId: '00000000-0000-0000-0000-0000000000e1',
      platform: 'INSTAGRAM_REELS',
      targetDurationSeconds: duration,
      targetDurationFrames: totalFrames,
      aspectRatio: '9:16',
      resolutionWidth: 1080,
      resolutionHeight: 1920,
      frameRate: 30,
      cutPoints,
      retainedClips: cutPoints.map((c, order) => ({
        order,
        shotId: '99999999-9999-9999-9999-999999999999',
        shotIndex: order,
        sourceAssetId: master.asset.id,
        beat: order === 0 ? ('HOOK' as const) : ('CTA' as const),
        sourceStartFrame: c.sourceStartFrame,
        sourceEndFrame: c.sourceEndFrame,
      })),
      retainedCues: [],
      retainedCaptions: [
        {
          text: 'Automated review collection',
          variantStartFrame: 0,
          variantEndFrame: totalFrames,
          safeArea: 'BOTTOM' as const,
        },
      ],
      ctaPlacement: {
        present: true,
        variantStartFrame: totalFrames - 60,
        variantEndFrame: totalFrames,
      },
      captionBurnRequired: true,
      safeAreas: ['BOTTOM'],
      cutRationale: `Kept the hook and the CTA for the ${duration}s cut.`,
      removedRationale: duration === 15 ? [] : ['Dropped the promise beat to hit the target.'],
      qualityRubric: [],
      promptVersionId: '00000000-0000-0000-0000-0000000000v1',
      createdByAgentInvocationId: `invocation-${duration}`,
    });

    // eslint-disable-next-line no-await-in-loop -- same rationale
    const job = await getOrCreateVariantGenerationJob(store, workspaceId, {
      campaignId,
      variantSpecificationId: specification.id,
      maxAttempts: 3,
    });
    // eslint-disable-next-line no-await-in-loop -- same rationale
    await getOrCreateVariantGenerationAttempt(store, workspaceId, {
      variantGenerationJobId: job.id,
      attemptNumber: 1,
      idempotencyKey: `fixture:VARIANT:${specification.id}:1`,
      providerId: 'mock-motion-graphics',
      status: 'SUCCEEDED',
      estimatedCostCents: totalFrames * 2,
      actualCostCents: totalFrames * 2,
      startedAt: new Date(),
    });

    // eslint-disable-next-line no-await-in-loop -- same rationale
    const asset = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'VARIANT',
      s3Key: `mock/variant/${duration}.mp4`,
      checksum: `variant-${campaignId}-${duration}`,
      mimeType: 'video/mp4',
      originalFilename: `variant-${duration}s.mp4`,
      sizeBytes: 0,
      ingestionStatus: 'READY',
      generatedByActivity: 'pollVariantRenderActivity',
      derivedFromAssetIds: [master.asset.id],
    });
    // eslint-disable-next-line no-await-in-loop -- same rationale
    const { variant } = await getOrCreateCreativeVariant(store, workspaceId, {
      campaignId,
      deliverySpecificationId: specification.deliverySpecificationId,
      variantSpecificationId: specification.id,
      durationSeconds: duration,
    });
    // eslint-disable-next-line no-await-in-loop -- same rationale
    const { assessment } = await createQualityAssessmentForAsset(store, workspaceId, {
      campaignId,
      assetId: asset.asset.id,
      subjectStage: 'VARIANT_QA',
      pass: passes,
      overallScore: passes ? 1 : 0.25,
      scores: { 'technical-delivery-spec': passes ? 1 : 0 },
      assessedBy: 'AGENT',
      createdByAgentInvocationId: `qa-invocation-${duration}`,
      failures: passes
        ? []
        : [
            {
              category: 'EDIT_TIMING',
              severity: 'BLOCKING',
              description: 'Variant runs 1.4s over the 10s slot.',
              suggestedAction: 'Re-cut on a shot boundary.',
            },
          ],
    });
    // eslint-disable-next-line no-await-in-loop -- same rationale
    await updateCreativeVariant(store, variant.id, {
      status: passes ? 'READY' : 'FAILED',
      assetId: asset.asset.id,
      qualityAssessmentId: assessment.id,
    });
  }
}

async function main() {
  const store = new InMemoryCampaignStore();
  await seed(store);
  await seedVariants(store);
  const app = buildServer({
    logger: createLogger({ serviceName: 'api-fake', level: 'silent' }),
    approvalDb: store,
    campaignDb: store,
    assetDb: store,
    shotGenerationDb: store,
    shotReviewDb: store,
    compositingDb: store,
    soundDesignDb: store,
    finalQaDb: store,
    variantDb: store,
    storageProvider: new MockStorageProvider(),
    reviewProvider: new MockReviewProvider(),
    workflowClient: buildFakeWorkflowClient(),
  });
  const port = Number(process.env.PORT ?? 4100);
  await app.listen({ host: '127.0.0.1', port });
  // eslint-disable-next-line no-console
  console.log(`apps/api dev-fake-server listening on http://127.0.0.1:${port}`);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('dev-fake-server failed to start:', error);
  process.exitCode = 1;
});
