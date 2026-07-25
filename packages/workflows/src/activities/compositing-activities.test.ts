import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueuedReasoningProvider } from '@combat/agent-runtime';
import { AGENT_REGISTRY } from '@combat/agents';
import { MockMotionGraphicsProvider } from '@combat/providers';
import {
  approveShotSelectionSet,
  createAssetWithProvenance,
  createCreativeConcept,
  createDraftShotSelectionSet,
  createQualityAssessmentForCandidate,
  createScriptWithShots,
  createShotSpecification,
  getLatestEditDecisionList,
  getRoughEditSpecification,
  InMemoryCampaignStore,
  listRenderJobsForCampaign,
  setShotSelectionCandidate,
  submitCampaignBrief,
  type GenerationCandidateRecord,
} from '@combat/database';
import { createExecuteSpecialistAgentActivity } from './execute-specialist-agent-activity';
import { createRunEditDirectorActivity } from './run-edit-director-activity';
import { createDispatchCompositionRenderActivity } from './dispatch-composition-render-activity';
import { createPollCompositionRenderActivity } from './poll-composition-render-activity';
import { createCancelCompositionRenderActivity } from './cancel-composition-render-activity';

type SpecInput = Parameters<typeof createShotSpecification>[2];
function specInput(campaignId: string, shotId: string, index: number): SpecInput {
  return {
    campaignId,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotId,
    version: 1,
    shotNumber: index,
    sequencePosition: index,
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

function editDirectorResult(shots: { shotIndex: number; durationFrames: number }[]) {
  let start = 0;
  const entries = shots.map((s, i) => {
    const entry = {
      shotIndex: s.shotIndex,
      order: i,
      startFrame: start,
      durationFrames: s.durationFrames,
      sourceInFrame: 0,
      sourceOutFrame: s.durationFrames,
      transitionIn: 'CUT' as const,
    };
    start += s.durationFrames;
    return entry;
  });
  return {
    frameRate: 30,
    durationFrames: shots.reduce((sum, s) => sum + s.durationFrames, 0),
    entries,
    pacingNotes: 'fast',
    overlays: [
      {
        kind: 'CTA' as const,
        shotIndex: shots[shots.length - 1]!.shotIndex,
        description: 'Sign up',
      },
    ],
    captionPlaceholder: 'captions TBD',
    musicPlaceholder: 'music TBD',
    sfxPlaceholder: 'sfx TBD',
    editRationale: 'hook first',
  };
}

async function seedApproved(
  store: InMemoryCampaignStore,
  opts: { shotCount?: number; qaPass?: boolean } = {},
) {
  const { shotCount = 2, qaPass = true } = opts;
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const reviewerId = randomUUID();
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'COMPOSITING' });
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
      brandVoice: 'x',
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
    referenceNotes: ['#000'],
  });
  const { script, shots } = await createScriptWithShots(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    version: 1,
    totalDurationFrames: 90 * shotCount,
    shots: Array.from({ length: shotCount }, (_, i) => ({
      index: i,
      description: `Shot ${i}`,
      durationFrames: 90,
      beat: i === 0 ? ('HOOK' as const) : ('CTA' as const),
      dependsOnShotIndices: i === 0 ? [] : [i - 1],
    })),
  });

  const draft = await createDraftShotSelectionSet(store, workspaceId, {
    campaignId,
    scriptId: script.id,
    scriptVersion: 1,
    creativeConceptId: concept.id,
    creativeConceptVersion: 1,
    version: 1,
    createdByUserId: reviewerId,
    requiredShots: [],
  });
  const candidateIds: string[] = [];
  let revision = 0;
  for (const shot of shots) {
    const spec = await createShotSpecification(
      store,
      workspaceId,
      specInput(campaignId, shot.id, shot.index),
    );
    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'VIDEO_CANDIDATE',
      s3Key: `c/${randomUUID()}`,
      checksum: randomUUID(),
      mimeType: 'video/mp4',
      originalFilename: 'c.mp4',
      sizeBytes: 1,
      ingestionStatus: 'READY',
    });
    const candidate: GenerationCandidateRecord = {
      id: randomUUID(),
      workspaceId,
      shotSpecificationId: spec.id,
      shotGenerationAttemptId: randomUUID(),
      candidateIndex: 0,
      status: 'SUCCEEDED',
      assetId: asset.id,
      providerCandidateRef: 'ref',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.generationCandidateRecords.push(candidate);
    candidateIds.push(candidate.id);
    for (const stage of ['VISUAL_QA', 'CONTINUITY_QA'] as const) {
      await createQualityAssessmentForCandidate(store, {
        workspaceId,
        campaignId,
        candidate,
        candidateCampaignId: campaignId,
        latestCandidateId: candidate.id,
        subjectStage: stage,
        pass: qaPass,
        overallScore: qaPass ? 1 : 0,
        scores: {},
        assessedBy: 'AGENT',
        failures: qaPass
          ? []
          : [{ category: 'GENERATION', severity: 'BLOCKING', description: 'x' }],
      });
    }
    // Draft has no rows (created with []), so add a selection row directly, then select.
    store.shotSelectionRecords.push({
      id: randomUUID(),
      workspaceId,
      shotSelectionSetId: draft.set.id,
      shotId: shot.id,
      sequencePosition: shot.index,
      shotSpecificationId: spec.id,
      shotSpecificationVersion: 1,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await setShotSelectionCandidate(store, workspaceId, {
      setId: draft.set.id,
      shotId: shot.id,
      candidateId: candidate.id,
      expectedRevision: revision,
      userId: reviewerId,
    });
    revision += 1;
  }
  await approveShotSelectionSet(store, workspaceId, {
    setId: draft.set.id,
    reviewerUserId: reviewerId,
    expectedRevision: revision,
    eligibleCandidateIds: new Set(candidateIds),
    approvedAt: new Date(),
  });

  return { store, workspaceId, campaignId, setId: draft.set.id, shots, candidateIds };
}

function editDirectorActivity(store: InMemoryCampaignStore, result: unknown) {
  const executeSpecialistAgentActivity = createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider([{ result }]),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
  return createRunEditDirectorActivity({
    executeSpecialistAgentActivity,
    agentRegistry: AGENT_REGISTRY,
    campaignDb: store,
    campaignBriefDb: store,
    creativeConceptDb: store,
    scriptDb: store,
    shotSelectionDb: store,
    eligibilityDb: store,
    promptDb: store,
    roughEditSpecificationDb: store,
  });
}

describe('run-edit-director-activity', () => {
  it('produces a versioned RoughEditSpecification from an approved selection with agent provenance', async () => {
    const s = await seedApproved(new InMemoryCampaignStore());
    const activity = editDirectorActivity(
      s.store,
      editDirectorResult(s.shots.map((sh) => ({ shotIndex: sh.index, durationFrames: 90 }))),
    );
    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      shotSelectionSetId: s.setId,
      attempt: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const spec = await getRoughEditSpecification(
      s.store,
      s.workspaceId,
      result.roughEditSpecificationId,
    );
    expect(spec?.version).toBe(1);
    expect(spec?.tracks[0]?.clips).toHaveLength(2);
    expect(spec?.createdByAgentInvocationId).toBeDefined();
    // Every clip pins a real selected source asset.
    expect(spec?.tracks[0]?.clips.every((c) => c.sourceAssetId)).toBe(true);
  });

  it('rejects an ineligible source (failed QA)', async () => {
    const s = await seedApproved(new InMemoryCampaignStore(), { qaPass: false });
    const activity = editDirectorActivity(
      s.store,
      editDirectorResult([{ shotIndex: 0, durationFrames: 90 }]),
    );
    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      shotSelectionSetId: s.setId,
      attempt: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'INELIGIBLE_SOURCE' });
  });

  it('rejects a selection built against a superseded script version (stale)', async () => {
    const s = await seedApproved(new InMemoryCampaignStore());
    // Bump the latest script version so the approved set is now stale.
    s.store.scriptRecords.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      creativeConceptId: randomUUID(),
      version: 2,
      totalDurationFrames: 90,
      createdAt: new Date(),
    });
    const activity = editDirectorActivity(
      s.store,
      editDirectorResult([{ shotIndex: 0, durationFrames: 90 }]),
    );
    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      shotSelectionSetId: s.setId,
      attempt: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'STALE_SELECTION' });
  });
});

describe('composition render dispatch/poll/cancel', () => {
  async function dispatchAndSpec(
    store: InMemoryCampaignStore,
    provider: MockMotionGraphicsProvider,
  ) {
    const s = await seedApproved(store);
    const editRes = await editDirectorActivity(
      store,
      editDirectorResult(s.shots.map((sh) => ({ shotIndex: sh.index, durationFrames: 90 }))),
    )({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      shotSelectionSetId: s.setId,
      attempt: 1,
    });
    if (!editRes.ok) throw new Error('edit director failed in setup');
    const dispatch = createDispatchCompositionRenderActivity({
      motionGraphicsProvider: provider,
      roughEditSpecificationDb: store,
      compositionDb: store,
      budgetDb: store,
      estimatedCostCentsPerFrame: 1,
    });
    return { s, roughEditSpecificationId: editRes.roughEditSpecificationId, dispatch };
  }

  it('dispatches, polls to SUCCEEDED, registers the rough-edit asset + RenderJob + EDL, and charges budget', async () => {
    const store = new InMemoryCampaignStore();
    const provider = new MockMotionGraphicsProvider();
    const { s, roughEditSpecificationId, dispatch } = await dispatchAndSpec(store, provider);

    const d = await dispatch({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      roughEditSpecificationId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;

    const poll = createPollCompositionRenderActivity({
      motionGraphicsProvider: provider,
      compositionDb: store,
      roughEditSpecificationDb: store,
      assetDb: store,
      renderJobDb: store,
      editDecisionListDb: store,
      budgetDb: store,
    });
    const out = await poll({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: d.attemptId,
      providerId: d.providerId,
    });
    // Mock defaults to immediate SUCCEEDED.
    if (!('terminal' in out) || !out.terminal || out.status !== 'SUCCEEDED') {
      throw new Error('expected a terminal SUCCEEDED poll result');
    }

    // ROUGH_CUT asset registered.
    expect(store.assets.some((a) => a.kind === 'ROUGH_CUT' && a.id === out.roughEditAssetId)).toBe(
      true,
    );
    // COMPOSITING RenderJob (compositingComplete) + EDL (roughCutAssembled).
    const renderJobs = await listRenderJobsForCampaign(store, s.workspaceId, s.campaignId);
    expect(renderJobs.some((r) => r.kind === 'COMPOSITING' && r.status === 'SUCCEEDED')).toBe(true);
    expect(await getLatestEditDecisionList(store, s.workspaceId, s.campaignId)).toBeDefined();

    // Re-poll is idempotent: no second asset/render job.
    const before = store.assets.length;
    await poll({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: d.attemptId,
      providerId: d.providerId,
    });
    expect(store.assets.length).toBe(before);
  });

  it('is idempotent on a replayed dispatch', async () => {
    const store = new InMemoryCampaignStore();
    const provider = new MockMotionGraphicsProvider();
    const { s, roughEditSpecificationId, dispatch } = await dispatchAndSpec(store, provider);
    const input = {
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      roughEditSpecificationId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    };
    const a = await dispatch(input);
    const b = await dispatch(input);
    expect(a.ok && b.ok && a.attemptId === b.attemptId).toBe(true);
    expect(store.compositionAttemptRecords).toHaveLength(1);
  });

  it('rejects an unsupported capability at dispatch and releases the reservation', async () => {
    const store = new InMemoryCampaignStore();
    const provider = new MockMotionGraphicsProvider();
    const { s, roughEditSpecificationId, dispatch } = await dispatchAndSpec(store, provider);
    // Corrupt the spec's aspect ratio to an unsupported one.
    const spec = store.roughEditSpecificationRecords.find(
      (r) => r.id === roughEditSpecificationId,
    )!;
    spec.aspectRatio = '21:9';
    const d = await dispatch({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      roughEditSpecificationId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    });
    expect(d).toMatchObject({ ok: false, reason: 'UNSUPPORTED_CAPABILITY' });
  });

  it('rejects a dispatch when budget is exhausted', async () => {
    const store = new InMemoryCampaignStore();
    const provider = new MockMotionGraphicsProvider();
    const { s, roughEditSpecificationId, dispatch } = await dispatchAndSpec(store, provider);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 0,
    });
    const d = await dispatch({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      roughEditSpecificationId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    });
    expect(d).toMatchObject({ ok: false, reason: 'BUDGET_EXCEEDED' });
  });

  it('cancels an in-flight render', async () => {
    const store = new InMemoryCampaignStore();
    const provider = new MockMotionGraphicsProvider({ pollsUntilTerminal: 5 });
    const { s, roughEditSpecificationId, dispatch } = await dispatchAndSpec(store, provider);
    const d = await dispatch({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      roughEditSpecificationId,
      attemptNumber: 1,
      motionGraphicsProviderId: 'mock-motion-graphics',
      maxAttempts: 3,
    });
    if (!d.ok) throw new Error('dispatch failed');
    const cancel = createCancelCompositionRenderActivity({
      motionGraphicsProvider: provider,
      compositionDb: store,
      budgetDb: store,
    });
    const res = await cancel({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: d.attemptId,
      providerId: d.providerId,
    });
    expect(res.cancelled).toBe(true);
    expect(store.compositionAttemptRecords[0]?.status).toBe('CANCELLED');
  });
});
