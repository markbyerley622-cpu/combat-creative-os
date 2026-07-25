import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueuedReasoningProvider } from '@combat/agent-runtime';
import { AGENT_REGISTRY } from '@combat/agents';
import {
  createCreativeConcept,
  createRoughEditSpecification,
  createScriptWithShots,
  getLatestSoundDesignPlan,
  InMemoryCampaignStore,
  listSoundCuesForTimeline,
  submitCampaignBrief,
  type RoughEditSpecificationRecord,
} from '@combat/database';
import { createExecuteSpecialistAgentActivity } from './execute-specialist-agent-activity';
import { createRunSoundDirectorActivity } from './run-sound-director-activity';

function soundResult() {
  return {
    musicBrief: 'Driving electronic bed, builds to the CTA.',
    mixNotes: 'Duck music under any VO; punch SFX on cuts.',
    cues: [
      { type: 'MUSIC', startFrame: 0, durationFrames: 180, notes: 'bed' },
      { type: 'SFX', startFrame: 90, durationFrames: 8, notes: 'whoosh on cut' },
    ],
  };
}

async function seedSoundReady(
  store: InMemoryCampaignStore,
  opts: { withRoughEdit?: boolean } = {},
) {
  const { withRoughEdit = true } = opts;
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'SOUND_DESIGN' });
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
    referenceNotes: ['punchy'],
  });
  const { script } = await createScriptWithShots(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    version: 1,
    totalDurationFrames: 180,
    shots: [
      {
        index: 0,
        description: 'Shot 0',
        durationFrames: 90,
        beat: 'HOOK',
        dependsOnShotIndices: [],
      },
      {
        index: 1,
        description: 'Shot 1',
        durationFrames: 90,
        beat: 'CTA',
        dependsOnShotIndices: [0],
      },
    ],
  });

  if (withRoughEdit) {
    const clip = (order: number) => ({
      order,
      shotId: randomUUID(),
      shotIndex: order,
      sourceAssetId: randomUUID(),
      sourceInFrame: 0,
      sourceOutFrame: 90,
      timelineStartFrame: order * 90,
      durationFrames: 90,
      transitionIn: 'CUT' as const,
    });
    const spec: Omit<RoughEditSpecificationRecord, 'id' | 'createdAt' | 'workspaceId'> = {
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
      targetDurationFrames: 180,
      tracks: [{ trackType: 'VIDEO', clips: [clip(0), clip(1)] }],
      overlays: [],
      pacingNotes: 'fast',
      beatStructure: [],
      continuityNotes: [],
      textSafeAreas: [],
      brandTokens: [],
      captionPlaceholder: 'c',
      musicPlaceholder: 'm',
      sfxPlaceholder: 's',
      platform: 'INSTAGRAM_REELS',
      platformDeliveryNotes: 'reels',
      editRationale: 'hook first',
      qualityRubric: [],
      promptVersionId: randomUUID(),
      createdByAgentInvocationId: randomUUID(),
    };
    await createRoughEditSpecification(store, workspaceId, spec);
  }
  return { workspaceId, campaignId };
}

function buildActivity(store: InMemoryCampaignStore, results: Record<string, unknown>[]) {
  const executeSpecialistAgentActivity = createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider(results.map((result) => ({ result }))),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
  return createRunSoundDirectorActivity({
    executeSpecialistAgentActivity,
    agentRegistry: AGENT_REGISTRY,
    campaignDb: store,
    campaignBriefDb: store,
    creativeConceptDb: store,
    scriptDb: store,
    roughEditSpecificationDb: store,
    timelineDb: store,
    soundDesignDb: store,
    promptDb: store,
    assetDb: store,
  });
}

describe('runSoundDirectorActivity', () => {
  it('persists a versioned SoundDesignPlan + Timeline + SoundCues with SOUND_STEM stems + provenance', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedSoundReady(store);
    const activity = buildActivity(store, [soundResult()]);

    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      revisionAttempt: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cueCount).toBe(2);

    const plan = await getLatestSoundDesignPlan(store, s.workspaceId, s.campaignId);
    expect(plan?.musicBrief).toContain('electronic');
    expect(plan?.createdByAgentInvocationId).toBeDefined();
    const cues = await listSoundCuesForTimeline(store, result.timelineId);
    expect(cues).toHaveLength(2);
    // Every cue has an attached SOUND_STEM asset.
    expect(cues.every((c) => c.assetId)).toBe(true);
    expect(store.assets.filter((a) => a.kind === 'SOUND_STEM')).toHaveLength(2);
    // Provenance: the plan invocation is an AgentInvocation for SOUND_DESIGN.
    const inv = store.agentInvocations.find(
      (i) => i.idempotencyKey === plan?.createdByAgentInvocationId,
    );
    expect(inv?.stage).toBe('SOUND_DESIGN');
    expect(inv?.agentName).toBe('sound-director');
  });

  it('is idempotent under retry — no duplicate cues/stems', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedSoundReady(store);
    const activity = buildActivity(store, [soundResult(), soundResult()]);
    await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      revisionAttempt: 1,
    });
    const r2 = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      revisionAttempt: 1,
    });
    expect(r2.ok).toBe(true);
    expect(store.soundCueRecords).toHaveLength(2);
    expect(store.soundDesignPlanRecords).toHaveLength(1);
    expect(store.assets.filter((a) => a.kind === 'SOUND_STEM')).toHaveLength(2);
  });

  it('fails when there is no rough edit to score', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedSoundReady(store, { withRoughEdit: false });
    const activity = buildActivity(store, [soundResult()]);
    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      revisionAttempt: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'ROUGH_EDIT_NOT_FOUND' });
  });

  it('returns AGENT_FAILED on an unusable agent output', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedSoundReady(store);
    const activity = buildActivity(store, [{ musicBrief: 'x', mixNotes: 'x', cues: [] }]); // cues .min(1) violated
    const result = await activity({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      revisionAttempt: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'AGENT_FAILED' });
  });

  it('never leaks a campaign in another workspace', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedSoundReady(store);
    const activity = buildActivity(store, [soundResult()]);
    const result = await activity({
      workspaceId: randomUUID(),
      campaignId: s.campaignId,
      workflowRunId: 'run-1',
      revisionAttempt: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'CAMPAIGN_NOT_FOUND' });
  });
});
