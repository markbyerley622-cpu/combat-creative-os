import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueuedReasoningProvider } from '@combat/agent-runtime';
import { AGENT_REGISTRY } from '@combat/agents';
import { MockMotionGraphicsProvider } from '@combat/providers';
import {
  createAssetWithProvenance,
  createCreativeConcept,
  createDraftShotSelectionSet,
  createQualityAssessmentForAsset,
  createRoughEditSpecification,
  createScriptWithShots,
  createSoundCue,
  createSoundDesignPlan,
  createTimeline,
  getVariantSpecification,
  InMemoryCampaignStore,
  listCreativeVariants,
  listVariantGenerationAttempts,
  submitCampaignBrief,
} from '@combat/database';
import { createExecuteSpecialistAgentActivity } from './execute-specialist-agent-activity';
import { createRunVariantGeneratorActivity } from './run-variant-generator-activity';
import { createDispatchVariantRenderActivity } from './dispatch-variant-render-activity';
import { createPollVariantRenderActivity } from './poll-variant-render-activity';
import { createCancelVariantRenderActivity } from './cancel-variant-render-activity';
import { createRunVariantFinalQaActivity } from './run-variant-final-qa-activity';

/**
 * Fixture master: 450 frames @30fps (15s), four shots on shot boundaries —
 * HOOK 0..120, PROMISE 120..270, FEATURE 270..390, CTA 390..450. Chosen so the
 * profile's three targets are all exactly achievable on real boundaries:
 * 15s = everything, 10s = HOOK + FEATURE + CTA, 6s = HOOK + CTA.
 */
const SHOT_FRAMES = [120, 150, 120, 60];
const BEATS = ['HOOK', 'PROMISE', 'FEATURE', 'CTA'] as const;

interface SeedOptions {
  readonly withMaster?: boolean;
  readonly masterQaPass?: boolean;
  readonly withSoundDesign?: boolean;
}

async function seed(store: InMemoryCampaignStore, opts: SeedOptions = {}) {
  const { withMaster = true, masterQaPass = true, withSoundDesign = true } = opts;
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'VARIANT_GENERATION' });

  await submitCampaignBrief(store, workspaceId, {
    campaignId,
    content: {
      campaignName: 'Q3',
      productName: 'Combat Reviews',
      productDescription: 'x',
      objective: 'x',
      targetAudience: 'x',
      customerProblem: 'x',
      valueProposition: 'x',
      productFeatures: ['x'],
      targetPlatforms: ['INSTAGRAM_REELS'],
      aspectRatios: ['9:16'],
      durationsSeconds: [15],
      brandVoice: 'confident',
      visualDirection: 'x',
      requiredMessaging: ['x'],
      callToAction: 'Book now',
      references: [],
      assetReferences: [],
      prohibitedClaims: [],
      budgetCents: 500000,
      locale: 'en-US',
    },
  });
  const concept = await createCreativeConcept(store, workspaceId, {
    campaignId,
    version: 1,
    logline: 'l',
    visualDirection: 'v',
    narrativeArc: 'n',
    referenceNotes: [],
  });
  const { script, shots } = await createScriptWithShots(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    version: 1,
    totalDurationFrames: 450,
    shots: SHOT_FRAMES.map((durationFrames, index) => ({
      index,
      description: `Shot ${index}`,
      durationFrames,
      beat: BEATS[index]!,
      dependsOnShotIndices: [],
    })),
  });

  const { set: selectionSet } = await createDraftShotSelectionSet(store, workspaceId, {
    campaignId,
    scriptId: script.id,
    scriptVersion: 1,
    creativeConceptId: concept.id,
    creativeConceptVersion: 1,
    version: 1,
    createdByUserId: randomUUID(),
    requiredShots: shots.map((shot, index) => ({
      shotId: shot.id,
      sequencePosition: index,
      shotSpecificationId: randomUUID(),
      shotSpecificationVersion: 1,
    })),
  });

  // Source assets, one per shot, pinned by the rough edit.
  const sourceAssetIds: string[] = [];
  for (const shot of shots) {
    // eslint-disable-next-line no-await-in-loop -- deterministic ordered fixture setup
    const created = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'VIDEO_CANDIDATE',
      s3Key: `mock/candidate/${shot.index}.mp4`,
      checksum: `candidate-${campaignId}-${shot.index}`,
      mimeType: 'video/mp4',
      originalFilename: `candidate-${shot.index}.mp4`,
      sizeBytes: 0,
      ingestionStatus: 'READY',
      generatedByActivity: 'pollShotGenerationActivity',
    });
    sourceAssetIds.push(created.asset.id);
  }

  let start = 0;
  const clips = shots.map((shot, index) => {
    const clip = {
      order: index,
      shotId: shot.id,
      shotIndex: index,
      sourceAssetId: sourceAssetIds[index]!,
      sourceInFrame: 0,
      sourceOutFrame: SHOT_FRAMES[index]!,
      timelineStartFrame: start,
      durationFrames: SHOT_FRAMES[index]!,
      transitionIn: 'CUT' as const,
    };
    start += SHOT_FRAMES[index]!;
    return clip;
  });

  const roughEdit = await createRoughEditSpecification(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    creativeConceptVersion: 1,
    scriptId: script.id,
    scriptVersion: 1,
    shotSelectionSetId: selectionSet.id,
    shotSelectionSetVersion: selectionSet.version,
    version: 1,
    outputFormat: 'mp4',
    aspectRatio: '9:16',
    resolutionWidth: 1080,
    resolutionHeight: 1920,
    frameRate: 30,
    targetDurationFrames: 450,
    tracks: [{ trackType: 'VIDEO', clips }],
    overlays: shots.map((_, index) => ({
      kind: 'CAPTION' as const,
      shotIndex: index,
      description: `Caption ${index}`,
    })),
    pacingNotes: 'fast',
    beatStructure: [],
    continuityNotes: [],
    textSafeAreas: ['BOTTOM'],
    brandTokens: [],
    captionPlaceholder: 'burn captions',
    musicPlaceholder: 'm',
    sfxPlaceholder: 's',
    platform: 'INSTAGRAM_REELS',
    platformDeliveryNotes: 'reels',
    editRationale: 'hook first',
    qualityRubric: [],
    promptVersionId: randomUUID(),
    createdByAgentInvocationId: randomUUID(),
  });

  let timelineId: string | undefined;
  if (withSoundDesign) {
    const timeline = await createTimeline(store, workspaceId, {
      campaignId,
      scriptId: script.id,
      version: 1,
      frameRate: 30,
      durationFrames: 450,
      entries: clips.map((c) => ({
        shotId: c.shotId,
        order: c.order,
        startFrame: c.timelineStartFrame,
        durationFrames: c.durationFrames,
      })),
    });
    timelineId = timeline.id;
    const plan = await createSoundDesignPlan(store, workspaceId, {
      campaignId,
      timelineId: timeline.id,
      roughEditSpecificationId: roughEdit.id,
      version: 1,
      musicBrief: 'driving bed',
      mixNotes: 'duck vo',
      brandAudioGuidelines: [],
      qualityRubric: [],
      promptVersionId: randomUUID(),
      createdByAgentInvocationId: randomUUID(),
    });
    // A continuous MUSIC bed (never a hard boundary) plus a discrete SFX cue
    // aligned to the PROMISE segment.
    await createSoundCue(store, workspaceId, {
      timelineId: timeline.id,
      type: 'MUSIC',
      startFrame: 0,
      durationFrames: 450,
      assetId: undefined,
      notes: 'bed',
    });
    await createSoundCue(store, workspaceId, {
      timelineId: timeline.id,
      type: 'SFX',
      startFrame: 120,
      durationFrames: 150,
      assetId: undefined,
      notes: 'whoosh',
    });
    void plan;
  }

  let masterId: string | undefined;
  if (withMaster) {
    const created = await createAssetWithProvenance(store, workspaceId, {
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
    masterId = created.asset.id;
    await createQualityAssessmentForAsset(store, workspaceId, {
      campaignId,
      assetId: masterId,
      subjectStage: 'FINAL_QA',
      pass: masterQaPass,
      overallScore: masterQaPass ? 1 : 0.2,
      scores: { 'technical-delivery-spec': masterQaPass ? 1 : 0 },
      assessedBy: 'AGENT',
      createdByAgentInvocationId: randomUUID(),
      failures: [],
    });
  }

  return { workspaceId, campaignId, masterId, timelineId, shots, sourceAssetIds };
}

/** The legal cut the fixture supports for each target duration. */
function legalCut(targetDurationSeconds: number, shotIds: string[]) {
  if (targetDurationSeconds === 15) {
    return {
      cutPoints: [{ order: 0, sourceStartFrame: 0, sourceEndFrame: 450, variantStartFrame: 0 }],
      retainedShotIds: shotIds,
    };
  }
  if (targetDurationSeconds === 10) {
    return {
      cutPoints: [
        { order: 0, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 0 },
        { order: 1, sourceStartFrame: 270, sourceEndFrame: 450, variantStartFrame: 120 },
      ],
      retainedShotIds: [shotIds[0]!, shotIds[2]!, shotIds[3]!],
    };
  }
  return {
    cutPoints: [
      { order: 0, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 0 },
      { order: 1, sourceStartFrame: 390, sourceEndFrame: 450, variantStartFrame: 120 },
    ],
    retainedShotIds: [shotIds[0]!, shotIds[3]!],
  };
}

function variantResult(targetDurationSeconds: number, shotIds: string[]) {
  const { cutPoints, retainedShotIds } = legalCut(targetDurationSeconds, shotIds);
  const totalFrames = targetDurationSeconds * 30;
  return {
    targetDurationSeconds,
    cutPoints,
    retainedShotIds,
    retainedCaptions: [
      { text: 'Caption', variantStartFrame: 0, variantEndFrame: totalFrames, safeArea: 'BOTTOM' },
    ],
    ctaPlacement: {
      present: true,
      variantStartFrame: totalFrames - 60,
      variantEndFrame: totalFrames,
      shotId: shotIds[3]!,
    },
    cutRationale: `Kept the hook and CTA for the ${targetDurationSeconds}s cut.`,
    removedRationale: ['Dropped the promise beat.'],
    qualityRubric: [],
  };
}

/** All three legal cuts, longest first — the profile's duration order. */
function allLegalResults(shotIds: string[]) {
  return [variantResult(15, shotIds), variantResult(10, shotIds), variantResult(6, shotIds)];
}

function passingQaResult() {
  return {
    criterionScores: [
      { criterionId: 'technical-delivery-spec', pass: true, score: 1 },
      { criterionId: 'caption-compliance', pass: true, score: 1 },
      { criterionId: 'visual-brand-safety', pass: true, score: 1 },
      { criterionId: 'edit-continuity', pass: true, score: 1 },
    ],
    findings: [],
  };
}

function failingQaResult() {
  return {
    criterionScores: [
      { criterionId: 'technical-delivery-spec', pass: false, score: 0 },
      { criterionId: 'caption-compliance', pass: true, score: 1 },
      { criterionId: 'visual-brand-safety', pass: true, score: 1 },
      { criterionId: 'edit-continuity', pass: true, score: 1 },
    ],
    findings: [
      {
        category: 'EDIT_TIMING' as const,
        severity: 'BLOCKING' as const,
        description: 'variant runs long',
      },
    ],
  };
}

function buildGenerator(store: InMemoryCampaignStore, results: Record<string, unknown>[]) {
  const executeSpecialistAgentActivity = createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider(results.map((result) => ({ result }))),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
  return createRunVariantGeneratorActivity({
    executeSpecialistAgentActivity,
    agentRegistry: AGENT_REGISTRY,
    campaignDb: store,
    creativeConceptDb: store,
    scriptDb: store,
    shotSelectionDb: store,
    roughEditSpecificationDb: store,
    timelineDb: store,
    soundDesignDb: store,
    qualityAssessmentDb: store,
    deliveryProfileDb: store,
    variantDb: store,
    promptDb: store,
    assetDb: store,
    resolveDeliverySpecificationId: async () => 'delivery-spec-1',
  });
}

function buildRenderActivities(
  store: InMemoryCampaignStore,
  provider = new MockMotionGraphicsProvider(),
) {
  return {
    provider,
    dispatch: createDispatchVariantRenderActivity({
      motionGraphicsProvider: provider,
      variantDb: store,
      budgetDb: store,
      estimatedCostCentsPerFrame: 1,
    }),
    poll: createPollVariantRenderActivity({
      motionGraphicsProvider: provider,
      variantDb: store,
      assetDb: store,
      budgetDb: store,
    }),
    cancel: createCancelVariantRenderActivity({
      motionGraphicsProvider: provider,
      variantDb: store,
      budgetDb: store,
    }),
  };
}

function buildVariantQa(store: InMemoryCampaignStore, results: Record<string, unknown>[]) {
  const executeSpecialistAgentActivity = createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider(results.map((result) => ({ result }))),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
  return createRunVariantFinalQaActivity({
    executeSpecialistAgentActivity,
    agentRegistry: AGENT_REGISTRY,
    campaignBriefDb: store,
    variantDb: store,
    qualityAssessmentDb: store,
    promptDb: store,
    assetDb: store,
  });
}

const run = { workflowRunId: 'run-1', deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1' } as const;

describe('runVariantGeneratorActivity — structured output and all three durations', () => {
  it('persists one immutable VariantSpecification per profile duration, with the full provenance chain', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const shotIds = s.shots.map((sh) => sh.id);
    const activity = buildGenerator(store, allLegalResults(shotIds));

    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.specifications.map((x) => x.targetDurationSeconds)).toEqual([15, 10, 6]);
    expect(result.parentMasterAssetId).toBe(s.masterId);

    const fifteen = await getVariantSpecification(
      store,
      s.workspaceId,
      result.specifications[0]!.variantSpecificationId,
    );
    expect(fifteen?.targetDurationFrames).toBe(450);
    expect(fifteen?.deliveryProfileKey).toBe('VERTICAL_SHORT_FORM_V1');
    expect(fifteen?.captionBurnRequired).toBe(true);
    expect(fifteen?.safeAreas).toEqual(['TOP', 'BOTTOM', 'CENTER']);
    // Provenance chain is fully pinned.
    expect(fifteen?.parentFinalQaAssessmentId).toBeDefined();
    expect(fifteen?.roughEditSpecificationVersion).toBe(1);
    expect(fifteen?.soundDesignPlanVersion).toBe(1);
    expect(fifteen?.timelineVersion).toBe(1);
    expect(fifteen?.cutRationale).toContain('15s');
    // retainedClips are derived from persisted data, pinned to real source assets.
    expect(fifteen?.retainedClips.map((c) => c.sourceAssetId)).toEqual(s.sourceAssetIds);

    const ten = await getVariantSpecification(
      store,
      s.workspaceId,
      result.specifications[1]!.variantSpecificationId,
    );
    expect(ten?.targetDurationFrames).toBe(300);
    // The 10s cut drops the PROMISE beat.
    expect(ten?.retainedClips.map((c) => c.beat)).toEqual(['HOOK', 'FEATURE', 'CTA']);

    const six = await getVariantSpecification(
      store,
      s.workspaceId,
      result.specifications[2]!.variantSpecificationId,
    );
    expect(six?.targetDurationFrames).toBe(180);
    expect(six?.retainedClips.map((c) => c.beat)).toEqual(['HOOK', 'CTA']);
  });

  it('seeds VERTICAL_SHORT_FORM_V1 on first use and pins its version on every specification', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const activity = buildGenerator(store, allLegalResults(s.shots.map((sh) => sh.id)));

    await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(store.deliveryProfileRecords).toHaveLength(1);
    expect(store.deliveryProfileRecords[0]!.durationsSeconds).toEqual([15, 10, 6]);
    expect(store.variantSpecificationRecords.every((v) => v.deliveryProfileVersion === 1)).toBe(
      true,
    );
  });

  it('is idempotent under retry — a replay writes no second version', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const shotIds = s.shots.map((sh) => sh.id);
    const activity = buildGenerator(store, [
      ...allLegalResults(shotIds),
      ...allLegalResults(shotIds),
    ]);
    const input = {
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    };

    await activity(input);
    const second = await activity(input);

    expect(second.ok).toBe(true);
    expect(store.variantSpecificationRecords).toHaveLength(3);
  });
});

describe('runVariantGeneratorActivity — cut-point correctness', () => {
  it.each([
    [
      'a mid-clip cut that is not on a timeline boundary',
      { cutPoints: [{ order: 0, sourceStartFrame: 0, sourceEndFrame: 300, variantStartFrame: 0 }] },
      'CUT_NOT_ON_TIMELINE_BOUNDARY',
    ],
    [
      'a cut that splits a discrete audio cue',
      {
        cutPoints: [
          { order: 0, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 0 },
          { order: 1, sourceStartFrame: 150, sourceEndFrame: 330, variantStartFrame: 120 },
        ],
      },
      'CUT_SPLITS_AUDIO_CUE',
    ],
  ])('rejects %s without persisting anything', async (_label, override, expectedCode) => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const shotIds = s.shots.map((sh) => sh.id);
    const bad = { ...variantResult(15, shotIds), ...override };
    const activity = buildGenerator(store, [bad]);

    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(result).toMatchObject({ ok: false, reason: 'INVALID_CUT' });
    if (result.ok || result.reason !== 'INVALID_CUT') return;
    expect(result.violations.map((v) => v.code)).toContain(expectedCode);
    expect(store.variantSpecificationRecords).toHaveLength(0);
  });

  it('rejects a 10s cut that drops the CTA (the profile requires it at >=10s)', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const shotIds = s.shots.map((sh) => sh.id);
    // 15s is fine; the 10s answer drops the CTA.
    const badTen = {
      ...variantResult(10, shotIds),
      ctaPlacement: { present: false },
    };
    const activity = buildGenerator(store, [variantResult(15, shotIds), badTen]);

    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(result).toMatchObject({ ok: false, reason: 'INVALID_CUT', targetDurationSeconds: 10 });
    if (result.ok || result.reason !== 'INVALID_CUT') return;
    expect(result.violations.map((v) => v.code)).toContain('CTA_MISSING');
  });

  it('rejects a cut that retains no captions when the profile requires a burn-in', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const shotIds = s.shots.map((sh) => sh.id);
    const activity = buildGenerator(store, [
      { ...variantResult(15, shotIds), retainedCaptions: [] },
    ]);

    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(result).toMatchObject({ ok: false, reason: 'INVALID_CUT' });
    if (result.ok || result.reason !== 'INVALID_CUT') return;
    expect(result.violations.map((v) => v.code)).toContain('CAPTIONS_REQUIRED_BUT_ABSENT');
  });

  it('rejects a cut whose duration misses the target', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const shotIds = s.shots.map((sh) => sh.id);
    const activity = buildGenerator(store, [
      {
        ...variantResult(15, shotIds),
        cutPoints: [{ order: 0, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 0 }],
      },
    ]);

    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(result).toMatchObject({ ok: false, reason: 'INVALID_CUT' });
    if (result.ok || result.reason !== 'INVALID_CUT') return;
    expect(result.violations.map((v) => v.code)).toContain('DURATION_MISMATCH');
  });
});

describe('runVariantGeneratorActivity — master eligibility and isolation', () => {
  it('refuses a master that failed Final QA', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { masterQaPass: false });
    const activity = buildGenerator(store, allLegalResults(s.shots.map((sh) => sh.id)));

    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(result).toMatchObject({ ok: false, reason: 'MASTER_NOT_QA_PASSED' });
    expect(store.variantSpecificationRecords).toHaveLength(0);
  });

  it('refuses a campaign with no registered FINAL_MASTER', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withMaster: false });
    const activity = buildGenerator(store, allLegalResults(s.shots.map((sh) => sh.id)));

    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(result).toMatchObject({ ok: false, reason: 'MASTER_NOT_FOUND' });
  });

  it('refuses to cut before SOUND_DESIGN produced a timeline + plan', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withSoundDesign: false });
    const activity = buildGenerator(store, allLegalResults(s.shots.map((sh) => sh.id)));

    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(result).toMatchObject({ ok: false, reason: 'UPSTREAM_NOT_FOUND' });
  });

  it('never reads another workspace campaign', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const activity = buildGenerator(store, allLegalResults(s.shots.map((sh) => sh.id)));

    const result = await activity({
      workspaceId: randomUUID(),
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(result).toMatchObject({ ok: false, reason: 'CAMPAIGN_NOT_FOUND' });
    expect(store.variantSpecificationRecords).toHaveLength(0);
  });

  it('returns AGENT_FAILED on an unusable agent output', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const activity = buildGenerator(store, [{ targetDurationSeconds: 15, cutPoints: [] }]);

    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });

    expect(result).toMatchObject({ ok: false, reason: 'AGENT_FAILED' });
  });
});

describe('variant render — dispatch, poll, budget, cancellation', () => {
  async function seedOneSpec(store: InMemoryCampaignStore) {
    const s = await seed(store);
    const generator = buildGenerator(store, allLegalResults(s.shots.map((sh) => sh.id)));
    const result = await generator({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });
    if (!result.ok) throw new Error('fixture generator failed');
    return { ...s, specId: result.specifications[0]!.variantSpecificationId };
  }

  it('reserves budget, renders, registers a VARIANT asset with master provenance, and charges usage', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedOneSpec(store);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 100_000,
    });
    const { dispatch, poll } = buildRenderActivities(store);

    const dispatched = await dispatch({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      variantSpecificationId: s.specId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    });
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) return;

    // A reservation exists before the render resolves.
    expect(store.budgetLedgerEntries.some((e) => e.entryType === 'RESERVATION')).toBe(true);

    const polled = await poll({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: dispatched.attemptId,
      providerId: 'mock-motion-graphics',
    });
    expect(polled).toMatchObject({ terminal: true, status: 'SUCCEEDED' });
    if (!('terminal' in polled) || !polled.terminal || polled.status !== 'SUCCEEDED') return;

    const asset = store.assets.find((a) => a.id === polled.variantAssetId);
    expect(asset?.kind).toBe('VARIANT');
    // No real bytes are ever written.
    expect(asset?.sizeBytes).toBe(0);
    const provenance = store.assetProvenances.find((p) => p.assetId === asset?.id);
    expect(provenance?.derivedFromAssetIds).toContain(s.masterId);

    // The variant is RENDERING, not READY — only variant QA may promote it.
    const variants = await listCreativeVariants(store, s.workspaceId, s.campaignId);
    expect(variants).toHaveLength(1);
    expect(variants[0]!.status).toBe('RENDERING');

    expect(store.budgetLedgerEntries.some((e) => e.entryType === 'CHARGE')).toBe(true);
  });

  it('is idempotent: a replayed dispatch reuses the attempt and never double-reserves', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedOneSpec(store);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 100_000,
    });
    const { dispatch } = buildRenderActivities(store);
    const input = {
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      variantSpecificationId: s.specId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    };

    const first = await dispatch(input);
    const second = await dispatch(input);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.attemptId).toBe(first.attemptId);
    expect(store.variantGenerationAttemptRecords).toHaveLength(1);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'RESERVATION')).toHaveLength(1);
  });

  it('refuses to dispatch and releases nothing when the budget is exhausted', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedOneSpec(store);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 0,
    });
    const { dispatch } = buildRenderActivities(store);

    const result = await dispatch({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      variantSpecificationId: s.specId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    });

    expect(result).toMatchObject({ ok: false, reason: 'BUDGET_EXCEEDED', level: 'WORKSPACE' });
    const attempt = store.variantGenerationAttemptRecords[0]!;
    expect(attempt.status).toBe('FAILED');
    expect(attempt.failureReason).toBe('BUDGET_EXCEEDED');
  });

  it('surfaces a provider failure as a retryable terminal outcome and releases the reservation', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedOneSpec(store);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 100_000,
    });
    const key = `run-1:VARIANT:${s.specId}:1`;
    const provider = new MockMotionGraphicsProvider({
      forcedFailures: { [key]: { reason: 'PROVIDER_ERROR', message: 'render worker died' } },
    });
    const { dispatch, poll } = buildRenderActivities(store, provider);

    const dispatched = await dispatch({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      variantSpecificationId: s.specId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    });
    if (!dispatched.ok) throw new Error('dispatch should succeed');

    const polled = await poll({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: dispatched.attemptId,
      providerId: 'mock-motion-graphics',
    });

    expect(polled).toMatchObject({
      terminal: true,
      status: 'FAILED',
      failureReason: 'PROVIDER_ERROR',
    });
    expect(store.budgetLedgerEntries.some((e) => e.entryType === 'RELEASE')).toBe(true);
    const variants = await listCreativeVariants(store, s.workspaceId, s.campaignId);
    expect(variants[0]!.status).toBe('FAILED');
  });

  it('cancels an in-flight render, releases the reservation, and is idempotent', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedOneSpec(store);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 100_000,
    });
    const provider = new MockMotionGraphicsProvider({ pollsUntilTerminal: 5 });
    const { dispatch, cancel } = buildRenderActivities(store, provider);

    const dispatched = await dispatch({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      variantSpecificationId: s.specId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    });
    if (!dispatched.ok) throw new Error('dispatch should succeed');

    const first = await cancel({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: dispatched.attemptId,
      providerId: 'mock-motion-graphics',
    });
    const second = await cancel({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: dispatched.attemptId,
      providerId: 'mock-motion-graphics',
    });

    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(false);
    const attempts = await listVariantGenerationAttempts(
      store,
      store.variantGenerationJobRecords[0]!.id,
    );
    expect(attempts[0]!.status).toBe('CANCELLED');
    expect(store.budgetLedgerEntries.some((e) => e.entryType === 'RELEASE')).toBe(true);
  });
});

describe('runVariantFinalQaActivity — the Final QA re-run per variant', () => {
  async function seedRenderedVariant(store: InMemoryCampaignStore) {
    const s = await seed(store);
    const generator = buildGenerator(store, allLegalResults(s.shots.map((sh) => sh.id)));
    const generated = await generator({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });
    if (!generated.ok) throw new Error('fixture generator failed');
    const specId = generated.specifications[0]!.variantSpecificationId;

    const { dispatch, poll } = buildRenderActivities(store);
    const dispatched = await dispatch({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      variantSpecificationId: specId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    });
    if (!dispatched.ok) throw new Error('dispatch failed');
    await poll({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: dispatched.attemptId,
      providerId: 'mock-motion-graphics',
    });
    return { ...s, specId };
  }

  it('promotes a passing variant to READY, records a VARIANT_QA assessment, and freezes the cut', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedRenderedVariant(store);
    const qa = buildVariantQa(store, [passingQaResult()]);

    const result = await qa({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      variantSpecificationId: s.specId,
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: true, pass: true });
    const variants = await listCreativeVariants(store, s.workspaceId, s.campaignId);
    expect(variants[0]!.status).toBe('READY');
    expect(variants[0]!.qualityAssessmentId).toBeDefined();

    // The assessment is asset-based, over the VARIANT asset, at VARIANT_QA.
    const assessment = store.qualityAssessmentRecords.find((a) => a.subjectStage === 'VARIANT_QA');
    expect(assessment?.assetId).toBe(variants[0]!.assetId);
    expect(assessment?.pass).toBe(true);

    // The specification is now immutable.
    const spec = await getVariantSpecification(store, s.workspaceId, s.specId);
    expect(spec?.approvedForExportAt).toBeInstanceOf(Date);
  });

  it('marks a failing variant FAILED and does NOT freeze the cut', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedRenderedVariant(store);
    const qa = buildVariantQa(store, [failingQaResult()]);

    const result = await qa({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      variantSpecificationId: s.specId,
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: true, pass: false, blockingFindingCount: 1 });
    const variants = await listCreativeVariants(store, s.workspaceId, s.campaignId);
    expect(variants[0]!.status).toBe('FAILED');
    const spec = await getVariantSpecification(store, s.workspaceId, s.specId);
    expect(spec?.approvedForExportAt).toBeUndefined();
  });

  it('refuses to assess a variant that has not been rendered', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const generator = buildGenerator(store, allLegalResults(s.shots.map((sh) => sh.id)));
    const generated = await generator({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      revisionAttempt: 1,
      ...run,
    });
    if (!generated.ok) throw new Error('fixture generator failed');
    const qa = buildVariantQa(store, [passingQaResult()]);

    const result = await qa({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      variantSpecificationId: generated.specifications[0]!.variantSpecificationId,
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'VARIANT_NOT_RENDERED' });
  });

  it('is idempotent per (variant asset, VARIANT_QA) — a replay writes no second assessment', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedRenderedVariant(store);
    const qa = buildVariantQa(store, [passingQaResult(), passingQaResult()]);
    const input = {
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      variantSpecificationId: s.specId,
      revisionAttempt: 1,
    };

    await qa(input);
    await qa(input);

    expect(
      store.qualityAssessmentRecords.filter((a) => a.subjectStage === 'VARIANT_QA'),
    ).toHaveLength(1);
  });
});
