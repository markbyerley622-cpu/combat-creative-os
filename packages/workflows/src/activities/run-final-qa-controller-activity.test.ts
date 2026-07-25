import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueuedReasoningProvider } from '@combat/agent-runtime';
import { AGENT_REGISTRY } from '@combat/agents';
import {
  createAssetWithProvenance,
  createCreativeConcept,
  createRoughEditSpecification,
  createScriptWithShots,
  createSoundCue,
  createSoundDesignPlan,
  createTimeline,
  getQualityAssessmentForAsset,
  InMemoryCampaignStore,
  listQualityFailuresForAssessment,
  submitCampaignBrief,
  type RoughEditSpecificationRecord,
} from '@combat/database';
import { createExecuteSpecialistAgentActivity } from './execute-specialist-agent-activity';
import {
  buildFinalQaDeliverySpecification,
  buildFinalQaTechnicalProbe,
  createRunFinalQaControllerActivity,
  selectFinalQaRepairTarget,
} from './run-final-qa-controller-activity';

/** A clean master: every Final QA rubric criterion passes, no findings. */
function passingResult() {
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

/** A defective master whose findings carry `categories`, driving repair routing. */
function failingResult(
  categories: readonly ('COMPOSITING_TECHNICAL' | 'EDIT_TIMING' | 'AUDIO_TECHNICAL' | 'TECHNICAL')[],
) {
  return {
    criterionScores: [
      { criterionId: 'technical-delivery-spec', pass: false, score: 0 },
      { criterionId: 'caption-compliance', pass: true, score: 1 },
      { criterionId: 'visual-brand-safety', pass: true, score: 1 },
      { criterionId: 'edit-continuity', pass: true, score: 1 },
    ],
    findings: categories.map((category) => ({
      category,
      severity: 'BLOCKING' as const,
      description: `${category} defect on the master`,
      suggestedAction: 'repair upstream',
    })),
  };
}

interface SeedOptions {
  /** Omit the SOUND_DESIGN output (Timeline + plan + cues). */
  readonly withSoundDesign?: boolean;
  /** Omit the registered ROUGH_CUT render asset. */
  readonly withRoughCutAsset?: boolean;
  /** Timeline frames — set longer than the brief's 15s @ 30fps to model an over-duration master. */
  readonly timelineDurationFrames?: number;
  /** Rough-edit overlays — omit a CAPTION overlay to model a missing caption burn. */
  readonly overlays?: RoughEditSpecificationRecord['overlays'];
  readonly captionPlaceholder?: string;
}

async function seedFinalQaReady(store: InMemoryCampaignStore, opts: SeedOptions = {}) {
  const {
    withSoundDesign = true,
    withRoughCutAsset = true,
    timelineDurationFrames = 450,
    overlays = [{ kind: 'CAPTION' as const, description: 'burned-in captions' }],
    captionPlaceholder: caption = 'burn captions for sound-off viewing',
  } = opts;

  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'FINAL_QA' });
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
      callToAction: 'x',
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
  const { script } = await createScriptWithShots(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    version: 1,
    totalDurationFrames: 450,
    shots: [
      { index: 0, description: 'Shot 0', durationFrames: 225, beat: 'HOOK', dependsOnShotIndices: [] },
      { index: 1, description: 'Shot 1', durationFrames: 225, beat: 'CTA', dependsOnShotIndices: [0] },
    ],
  });

  const clip = (order: number) => ({
    order,
    shotId: randomUUID(),
    shotIndex: order,
    sourceAssetId: randomUUID(),
    sourceInFrame: 0,
    sourceOutFrame: 225,
    timelineStartFrame: order * 225,
    durationFrames: 225,
    transitionIn: 'CUT' as const,
  });
  const spec = await createRoughEditSpecification(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    creativeConceptVersion: 1,
    scriptId: script.id,
    scriptVersion: 1,
    shotSelectionSetId: randomUUID(),
    shotSelectionSetVersion: 1,
    version: 1,
    outputFormat: 'mp4',
    aspectRatio: '9:16',
    resolutionWidth: 1080,
    resolutionHeight: 1920,
    frameRate: 30,
    targetDurationFrames: 450,
    tracks: [{ trackType: 'VIDEO', clips: [clip(0), clip(1)] }],
    overlays,
    pacingNotes: 'fast',
    beatStructure: [],
    continuityNotes: [],
    textSafeAreas: [],
    brandTokens: [],
    captionPlaceholder: caption,
    musicPlaceholder: 'm',
    sfxPlaceholder: 's',
    platform: 'INSTAGRAM_REELS',
    platformDeliveryNotes: 'reels',
    editRationale: 'hook first',
    qualityRubric: [],
    promptVersionId: randomUUID(),
    createdByAgentInvocationId: randomUUID(),
  });

  let roughCutAssetId: string | undefined;
  if (withRoughCutAsset) {
    const created = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'ROUGH_CUT',
      s3Key: 'mock/rough-cut/1.mp4',
      checksum: `rough-cut-${campaignId}`,
      mimeType: 'video/mp4',
      originalFilename: 'rough-cut.mp4',
      sizeBytes: 0,
      ingestionStatus: 'READY',
      generatedByActivity: 'pollCompositionRenderActivity',
    });
    roughCutAssetId = created.asset.id;
  }

  if (withSoundDesign) {
    const timeline = await createTimeline(store, workspaceId, {
      campaignId,
      scriptId: script.id,
      version: 1,
      frameRate: 30,
      durationFrames: timelineDurationFrames,
      entries: [
        { shotId: randomUUID(), order: 0, startFrame: 0, durationFrames: 225 },
        { shotId: randomUUID(), order: 1, startFrame: 225, durationFrames: 225 },
      ],
    });
    const plan = await createSoundDesignPlan(store, workspaceId, {
      campaignId,
      timelineId: timeline.id,
      roughEditSpecificationId: spec.id,
      version: 1,
      musicBrief: 'driving bed',
      mixNotes: 'duck under VO',
      brandAudioGuidelines: [],
      qualityRubric: [],
      promptVersionId: randomUUID(),
      createdByAgentInvocationId: randomUUID(),
    });
    const stem = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'SOUND_STEM',
      s3Key: 'mock/sound-stem/0.wav',
      checksum: `sound-stem-${plan.id}-0`,
      mimeType: 'audio/wav',
      originalFilename: 'music-0.wav',
      sizeBytes: 0,
      ingestionStatus: 'READY',
      generatedByActivity: 'runSoundDirectorActivity',
    });
    await createSoundCue(store, workspaceId, {
      timelineId: timeline.id,
      type: 'MUSIC',
      startFrame: 0,
      durationFrames: 450,
      assetId: stem.asset.id,
      notes: 'bed',
    });
  }

  return { workspaceId, campaignId, specId: spec.id, roughCutAssetId };
}

function buildActivity(store: InMemoryCampaignStore, results: Record<string, unknown>[]) {
  const executeSpecialistAgentActivity = createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider(results.map((result) => ({ result }))),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
  return createRunFinalQaControllerActivity({
    executeSpecialistAgentActivity,
    agentRegistry: AGENT_REGISTRY,
    campaignDb: store,
    campaignBriefDb: store,
    roughEditSpecificationDb: store,
    timelineDb: store,
    soundDesignDb: store,
    qualityAssessmentDb: store,
    promptDb: store,
    assetDb: store,
  });
}

const run = { workflowRunId: 'run-1', revisionAttempt: 1 } as const;

describe('runFinalQaControllerActivity', () => {
  it('registers a FINAL_MASTER asset and persists a passing FINAL_QA assessment with provenance', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedFinalQaReady(store);
    const activity = buildActivity(store, [passingResult()]);

    const result = await activity({ workspaceId: s.workspaceId, campaignId: s.campaignId, ...run });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pass).toBe(true);
    expect(result.repairTarget).toBeUndefined();
    expect(result.overallScore).toBe(1);

    const master = store.assets.find((a) => a.kind === 'FINAL_MASTER');
    expect(master?.id).toBe(result.finalMasterAssetId);
    // Provenance chain FINAL_MASTER -> ROUGH_CUT + SOUND_STEM is real even
    // though no bytes exist.
    const provenance = store.assetProvenances.find((p) => p.assetId === master?.id);
    expect(provenance?.derivedFromAssetIds).toContain(s.roughCutAssetId);
    expect(provenance?.derivedFromAssetIds?.length).toBe(2);

    const assessment = await getQualityAssessmentForAsset(
      store,
      s.workspaceId,
      result.finalMasterAssetId,
      'FINAL_QA',
    );
    expect(assessment?.pass).toBe(true);
    expect(assessment?.generationCandidateId).toBeUndefined();
    const invocation = store.agentInvocations.find(
      (i) => i.idempotencyKey === assessment?.createdByAgentInvocationId,
    );
    expect(invocation?.stage).toBe('FINAL_QA');
    expect(invocation?.agentName).toBe('final-qa-controller');
  });

  it.each([
    ['COMPOSITING_TECHNICAL', 'COMPOSITING'],
    ['EDIT_TIMING', 'ROUGH_CUT'],
    ['AUDIO_TECHNICAL', 'SOUND_DESIGN'],
  ] as const)(
    'a master with a %s defect fails and routes repair to %s',
    async (category, repairTarget) => {
      const store = new InMemoryCampaignStore();
      const s = await seedFinalQaReady(store);
      const activity = buildActivity(store, [failingResult([category])]);

      const result = await activity({
        workspaceId: s.workspaceId,
        campaignId: s.campaignId,
        ...run,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.pass).toBe(false);
      expect(result.repairTarget).toBe(repairTarget);
      expect(result.blockingFindingCount).toBe(1);

      const failures = await listQualityFailuresForAssessment(store, result.assessmentId);
      expect(failures.map((f) => f.category)).toEqual([category]);
    },
  );

  it('routes to the most upstream repair target when a master carries several defects', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedFinalQaReady(store);
    const activity = buildActivity(store, [
      failingResult(['AUDIO_TECHNICAL', 'EDIT_TIMING', 'COMPOSITING_TECHNICAL']),
    ]);

    const result = await activity({ workspaceId: s.workspaceId, campaignId: s.campaignId, ...run });

    expect(result).toMatchObject({ ok: true, pass: false, repairTarget: 'COMPOSITING' });
  });

  it('escalates a failing master whose findings carry no routable repair category', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedFinalQaReady(store);
    const activity = buildActivity(store, [failingResult(['TECHNICAL'])]);

    const result = await activity({ workspaceId: s.workspaceId, campaignId: s.campaignId, ...run });

    expect(result).toMatchObject({ ok: false, reason: 'UNROUTABLE_FAILURE' });
    // The assessment is still persisted — the failure stays auditable.
    expect(store.qualityAssessmentRecords).toHaveLength(1);
    expect(store.qualityAssessmentRecords[0]!.pass).toBe(false);
  });

  it('is idempotent under retry — one master asset and one assessment', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedFinalQaReady(store);
    const activity = buildActivity(store, [passingResult(), passingResult()]);
    const input = { workspaceId: s.workspaceId, campaignId: s.campaignId, ...run };

    const first = await activity(input);
    const second = await activity(input);

    expect(first).toMatchObject({ ok: true, pass: true });
    expect(second).toMatchObject({ ok: true, pass: true });
    expect(store.assets.filter((a) => a.kind === 'FINAL_MASTER')).toHaveLength(1);
    expect(store.qualityAssessmentRecords).toHaveLength(1);
    expect(store.qualityFailureRecords).toHaveLength(0);
  });

  it('never reads another workspace campaign', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedFinalQaReady(store);
    const activity = buildActivity(store, [passingResult()]);

    const result = await activity({
      workspaceId: randomUUID(),
      campaignId: s.campaignId,
      ...run,
    });

    expect(result).toMatchObject({ ok: false, reason: 'CAMPAIGN_NOT_FOUND' });
    expect(store.qualityAssessmentRecords).toHaveLength(0);
  });

  it('refuses to assess before SOUND_DESIGN has produced a mix', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedFinalQaReady(store, { withSoundDesign: false });
    const activity = buildActivity(store, [passingResult()]);

    const result = await activity({ workspaceId: s.workspaceId, campaignId: s.campaignId, ...run });

    expect(result).toMatchObject({ ok: false, reason: 'SOUND_DESIGN_NOT_FOUND' });
    expect(store.assets.filter((a) => a.kind === 'FINAL_MASTER')).toHaveLength(0);
  });

  it('refuses to assess without a registered ROUGH_CUT render', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedFinalQaReady(store, { withRoughCutAsset: false });
    const activity = buildActivity(store, [passingResult()]);

    const result = await activity({ workspaceId: s.workspaceId, campaignId: s.campaignId, ...run });

    expect(result).toMatchObject({ ok: false, reason: 'ROUGH_CUT_ASSET_NOT_FOUND' });
  });

  it('returns AGENT_FAILED on an unusable agent output', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedFinalQaReady(store);
    // criterionScores .min(1) violated.
    const activity = buildActivity(store, [{ criterionScores: [], findings: [] }]);

    const result = await activity({ workspaceId: s.workspaceId, campaignId: s.campaignId, ...run });

    expect(result).toMatchObject({ ok: false, reason: 'AGENT_FAILED' });
    expect(store.qualityAssessmentRecords).toHaveLength(0);
  });
});

describe('Final QA probe derivation — fixture masters with known technical defects', () => {
  const conformingSpec = {
    resolutionWidth: 1080,
    resolutionHeight: 1920,
    frameRate: 30,
    overlays: [{ kind: 'CAPTION' as const, description: 'captions' }],
  };

  it('derives a conforming probe from a clean master: 15s, 1080x1920, captions present', () => {
    const probe = buildFinalQaTechnicalProbe(conformingSpec, {
      durationFrames: 450,
      frameRate: 30,
    });

    expect(probe).toEqual({
      durationSeconds: 15,
      resolutionWidth: 1080,
      resolutionHeight: 1920,
      integratedLoudnessLufs: -14,
      hasBurnedInCaptions: true,
    });
  });

  it('surfaces an over-duration master: 16.5s against a 15s delivery slot', () => {
    const probe = buildFinalQaTechnicalProbe(conformingSpec, {
      durationFrames: 495,
      frameRate: 30,
    });
    const delivery = buildFinalQaDeliverySpecification(
      { platform: 'INSTAGRAM_REELS', aspectRatio: '9:16', captionPlaceholder: 'burn captions' },
      { durationsSeconds: [15] },
    );

    expect(probe.durationSeconds).toBeCloseTo(16.5);
    expect(probe.durationSeconds).toBeGreaterThan(delivery.durationSeconds);
  });

  it('surfaces a missing caption burn against a spec that requires one', () => {
    const probe = buildFinalQaTechnicalProbe(
      { ...conformingSpec, overlays: [{ kind: 'CTA', description: 'end card' }] },
      { durationFrames: 450, frameRate: 30 },
    );
    const delivery = buildFinalQaDeliverySpecification(
      { platform: 'TIKTOK', aspectRatio: '9:16', captionPlaceholder: 'burn captions' },
      { durationsSeconds: [15] },
    );

    expect(delivery.captionBurnRequired).toBe(true);
    expect(probe.hasBurnedInCaptions).toBe(false);
  });

  it('does not require a caption burn when the edit declares no caption intent', () => {
    const delivery = buildFinalQaDeliverySpecification(
      { platform: 'GENERIC', aspectRatio: '16:9', captionPlaceholder: '   ' },
      { durationsSeconds: [30] },
    );

    expect(delivery).toEqual({
      platform: 'GENERIC',
      aspectRatio: '16:9',
      durationSeconds: 30,
      captionBurnRequired: false,
      targetLoudnessLufs: -14,
    });
  });

  it('falls back to the edit frame rate when the timeline carries none', () => {
    const probe = buildFinalQaTechnicalProbe(conformingSpec, { durationFrames: 450, frameRate: 0 });

    expect(probe.durationSeconds).toBe(15);
  });
});

describe('selectFinalQaRepairTarget', () => {
  it('prefers the most upstream repair edge', () => {
    expect(selectFinalQaRepairTarget(['AUDIO_TECHNICAL', 'COMPOSITING_TECHNICAL'])).toBe(
      'COMPOSITING',
    );
    expect(selectFinalQaRepairTarget(['AUDIO_TECHNICAL', 'EDIT_TIMING'])).toBe('ROUGH_CUT');
    expect(selectFinalQaRepairTarget(['AUDIO_TECHNICAL'])).toBe('SOUND_DESIGN');
  });

  it('never selects a stage outside FINAL_QA revision edges', () => {
    // SHOT_UNUSABLE routes to HUMAN_SHOT_SELECTION — a human-gated stage that
    // is NOT a FINAL_QA revision edge, so it must never be selected.
    expect(selectFinalQaRepairTarget(['SHOT_UNUSABLE'])).toBeUndefined();
    expect(selectFinalQaRepairTarget(['TECHNICAL', 'CONTINUITY', 'PROMPT'])).toBeUndefined();
    expect(selectFinalQaRepairTarget([])).toBeUndefined();
  });
});
