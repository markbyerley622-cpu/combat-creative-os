import {
  InMemoryCampaignStore,
  addMembership,
  createAssetWithProvenance,
  createCreativeConcept,
  createDraftShotSelectionSet,
  createQualityAssessmentForAsset,
  createQualityAssessmentForCandidate,
  createLearningRecord,
  createScriptWithShots,
  createShotSpecification,
  createVariantSpecification,
  getOrCreateCreativeVariant,
  ingestPerformanceObservation,
  reviewLearningRecord,
  getOrCreateVariantGenerationAttempt,
  getOrCreateVariantGenerationJob,
  updateCreativeVariant,
  type GenerationCandidateRecord,
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
  /** M13: a distributed campaign with closed performance data and learnings. */
  performanceCampaignId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  /**
   * Post-M14 audit finding H-3: a campaign parked at the HUMAN_SHOT_SELECTION
   * gate, with a QA-passed candidate per shot and a DRAFT selection set, so the
   * browser suite can exercise the shot-selection gate the way it already
   * exercises the concept gate.
   */
  shotSelectionCampaignId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  /** Post-M14 audit finding H-3: a campaign parked at the FINAL_APPROVAL gate, with an assessed FINAL_MASTER. */
  finalApprovalCampaignId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
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

/**
 * M13 fixture: a DISTRIBUTED campaign with two closed-window observations and
 * two learnings — one APPROVED at MEDIUM confidence (injectable) and one
 * PROPOSED at LOW confidence (never injectable, reviewable in the dashboard).
 * Lets the performance and learning screens be exercised end to end without a
 * platform connector, which M13 deliberately does not have.
 */
async function seedPerformance(store: InMemoryCampaignStore) {
  const workspaceId = FIXTURES.workspaceId;
  const campaignId = FIXTURES.performanceCampaignId;
  store.seedCampaign({
    id: campaignId,
    workspaceId,
    name: 'Combat Reviews Q3 Launch — performance',
    currentStage: 'DISTRIBUTED',
  });

  const window = {
    periodStart: new Date('2026-07-18T00:00:00Z'),
    periodEnd: new Date('2026-07-25T00:00:00Z'),
  };
  const observations = [];
  for (const [externalPostId, clicks] of [
    ['reels-15s', 1_500],
    ['reels-10s', 900],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- deterministic ordered fixture setup
    const { observation } = await ingestPerformanceObservation(store, workspaceId, {
      subject: {
        platform: 'INSTAGRAM_REELS',
        externalPostId,
        campaignId,
        durationSeconds: externalPostId === 'reels-15s' ? 15 : 10,
      },
      source: 'FIXTURE',
      ...window,
      raw: {
        impressions: 30_000,
        clicks,
        conversions: Math.round(clicks / 20),
        spendCents: 60_000,
      },
      fixtureRef: 'fixtures/vertical-short-form-week-30.json',
      now: new Date('2026-07-26T00:00:00Z'),
    });
    observations.push(observation);
  }

  const evidence = observations.map((o) => ({
    performanceObservationId: o.id,
    campaignId,
    platform: 'INSTAGRAM_REELS' as const,
    impressions: o.normalized.impressions,
  }));

  const { record: approved } = await createLearningRecord(store, workspaceId, {
    learningKey: 'fifteen-second-cut-outperforms-ten',
    insight:
      'The 15s Reels cut reached a 5.0% click-through rate against 3.0% for the 10s cut over the same window.',
    scope: 'STRATEGY',
    applicability: {
      platforms: ['INSTAGRAM_REELS'],
      durationsSeconds: [15, 10],
      tags: ['cut-length'],
    },
    confidence: 'MEDIUM',
    evidence,
    totalImpressions: 60_000,
    sourceCampaignId: campaignId,
    createdByAgentInvocationId: 'fixture-analyst-invocation-1',
    promptVersionId: 'fixture-prompt-version-1',
  });
  await reviewLearningRecord(store, workspaceId, approved.id, {
    status: 'APPROVED',
    reviewedByUserId: FIXTURES.ownerUserId,
  });

  // A thin-evidence learning: stays PROPOSED and, even if approved, is never
  // injected (LOW confidence is below the injection floor).
  await createLearningRecord(store, workspaceId, {
    learningKey: 'warm-lighting-may-help',
    insight: 'Warm gym lighting appeared in the higher-converting cut of this single window.',
    scope: 'CONCEPT',
    applicability: { platforms: ['INSTAGRAM_REELS'], durationsSeconds: [], tags: ['lighting'] },
    confidence: 'LOW',
    evidence: [evidence[0]!],
    totalImpressions: 30_000,
    sourceCampaignId: campaignId,
    createdByAgentInvocationId: 'fixture-analyst-invocation-2',
    promptVersionId: 'fixture-prompt-version-1',
  });
}

/**
 * Post-M14 audit finding H-3 fixture: a campaign parked at
 * HUMAN_SHOT_SELECTION with two shots, one QA-passed candidate each, and a
 * DRAFT `ShotSelectionSet`.
 *
 * The gate is reachable in the browser but *not* satisfied: no candidate is
 * selected and the set is not APPROVED, which is precisely the state the
 * dashboard must refuse to advance past. The concept gate already had this
 * coverage; the two remaining human gates did not.
 */
async function seedShotSelectionGate(store: InMemoryCampaignStore) {
  const workspaceId = FIXTURES.workspaceId;
  const campaignId = FIXTURES.shotSelectionCampaignId;
  store.seedCampaign({
    id: campaignId,
    workspaceId,
    name: 'Combat Reviews Q3 Launch — shot selection',
    currentStage: 'HUMAN_SHOT_SELECTION',
  });

  const concept = await createCreativeConcept(store, workspaceId, {
    campaignId,
    version: 1,
    logline: 'A gym owner watches reviews roll in without lifting a finger.',
    visualDirection: 'Handheld gym footage, warm lighting.',
    narrativeArc: 'Problem -> discovery -> relief.',
    referenceNotes: [],
  });
  const { script, shots } = await createScriptWithShots(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    version: 1,
    totalDurationFrames: 180,
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
        description: 'Feature: reviews arriving automatically.',
        durationFrames: 90,
        beat: 'FEATURE',
        dependsOnShotIndices: [0],
      },
    ],
  });

  const requiredShots = [];
  for (const shot of shots) {
    // eslint-disable-next-line no-await-in-loop -- deterministic ordered fixture setup
    const spec = await createShotSpecification(store, workspaceId, {
      campaignId,
      creativeConceptId: concept.id,
      creativeConceptVersion: 1,
      scriptId: script.id,
      scriptVersion: 1,
      shotId: shot.id,
      version: 1,
      shotNumber: shot.index,
      sequencePosition: shot.index,
      intendedDurationSeconds: 3,
      visualObjective: 'o',
      action: 'a',
      subject: 's',
      environment: 'gym',
      cameraMovement: 'static',
      lensFraming: 'wide',
      lighting: 'warm',
      colorTreatment: 'neutral',
      motionIntensity: 'LOW',
      transitionIn: 'CUT',
      transitionOut: 'CUT',
      textSafeAreas: [],
      referenceAssetIds: [],
      continuityRequirements: [],
      providerId: 'mock-video-generation',
      promptVersionId: `fixture-prompt-version-${shot.index}`,
      generationPrompt: shot.description,
      generationParams: { durationSeconds: 3, aspectRatio: '9:16', providerOptions: {} },
      outputRequirements: { durationSeconds: 3, aspectRatio: '9:16', minCandidateCount: 1 },
      qualityRubric: [],
      licensingConstraints: [],
      createdByAgentInvocationId: `fixture-prompt-invocation-${shot.index}`,
    });

    // eslint-disable-next-line no-await-in-loop -- same rationale
    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'VIDEO_CANDIDATE',
      s3Key: `mock/candidates/${campaignId}-${shot.index}.mp4`,
      checksum: `candidate-${campaignId}-${shot.index}`,
      mimeType: 'video/mp4',
      originalFilename: `shot-${shot.index}-candidate-0.mp4`,
      sizeBytes: 0,
      ingestionStatus: 'READY',
      generatedByActivity: 'pollShotGenerationActivity',
    });
    const candidate: GenerationCandidateRecord = {
      id: `00000000-0000-0000-0000-00000000c${shot.index}00`,
      workspaceId,
      shotSpecificationId: spec.id,
      shotGenerationAttemptId: `fixture-attempt-${shot.index}`,
      candidateIndex: 0,
      status: 'SUCCEEDED',
      assetId: asset.id,
      providerCandidateRef: `ref-${shot.index}`,
      seed: 42 + shot.index,
      durationSeconds: 3,
      aspectRatio: '9:16',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.generationCandidateRecords.push(candidate);

    for (const subjectStage of ['VISUAL_QA', 'CONTINUITY_QA'] as const) {
      // eslint-disable-next-line no-await-in-loop -- same rationale
      await createQualityAssessmentForCandidate(store, {
        workspaceId,
        campaignId,
        candidate,
        candidateCampaignId: campaignId,
        latestCandidateId: candidate.id,
        subjectStage,
        pass: true,
        overallScore: 1,
        scores: { 'subject-fidelity': 1 },
        assessedBy: 'AGENT',
        failures: [],
      });
    }

    requiredShots.push({
      shotId: shot.id,
      sequencePosition: shot.index,
      shotSpecificationId: spec.id,
      shotSpecificationVersion: 1,
    });
  }

  await createDraftShotSelectionSet(store, workspaceId, {
    campaignId,
    scriptId: script.id,
    scriptVersion: 1,
    creativeConceptId: concept.id,
    creativeConceptVersion: 1,
    version: 1,
    createdByUserId: FIXTURES.ownerUserId,
    requiredShots,
  });
}

/**
 * Post-M14 audit finding H-3 fixture: a campaign parked at FINAL_APPROVAL with
 * a registered FINAL_MASTER and its passing Final QA assessment, so the final
 * approval screen is reachable and its gate is exercisable in the browser.
 */
async function seedFinalApprovalGate(store: InMemoryCampaignStore) {
  const workspaceId = FIXTURES.workspaceId;
  const campaignId = FIXTURES.finalApprovalCampaignId;
  store.seedCampaign({
    id: campaignId,
    workspaceId,
    name: 'Combat Reviews Q3 Launch — final approval',
    currentStage: 'FINAL_APPROVAL',
  });

  const master = await createAssetWithProvenance(store, workspaceId, {
    campaignId,
    kind: 'FINAL_MASTER',
    s3Key: `mock/final-master/${campaignId}.mp4`,
    checksum: `final-master-${campaignId}`,
    mimeType: 'video/mp4',
    originalFilename: 'final-master-v1.mp4',
    sizeBytes: 0,
    ingestionStatus: 'READY',
    generatedByActivity: 'runFinalQaControllerActivity',
  });

  await createQualityAssessmentForAsset(store, workspaceId, {
    campaignId,
    assetId: master.asset.id,
    subjectStage: 'FINAL_QA',
    pass: true,
    overallScore: 0.94,
    scores: { 'technical-delivery-spec': 1, 'brand-compliance': 0.88 },
    assessedBy: 'AGENT',
    createdByAgentInvocationId: 'fixture-final-qa-invocation',
    failures: [],
  });
}

async function main() {
  const store = new InMemoryCampaignStore();
  await seed(store);
  await seedVariants(store);
  await seedPerformance(store);
  await seedShotSelectionGate(store);
  await seedFinalApprovalGate(store);
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
    performanceDb: store,
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
