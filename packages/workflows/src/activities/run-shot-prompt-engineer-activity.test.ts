import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueuedReasoningProvider } from '@combat/agent-runtime';
import { AGENT_REGISTRY } from '@combat/agents';
import {
  createAssetWithProvenance,
  createCreativeConcept,
  createLicenseRecord,
  createScriptWithShots,
  InMemoryCampaignStore,
  submitCampaignBrief,
} from '@combat/database';
import { createExecuteSpecialistAgentActivity } from './execute-specialist-agent-activity';
import { createRunShotPromptEngineerActivity } from './run-shot-prompt-engineer-activity';

function shotResult(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'mock-video-gen',
    promptText: 'A boxer throws a slow-motion jab under cool blue arena lighting.',
    negativePrompt: 'no real athlete likenesses',
    params: { seedStrategy: 'fixed' },
    visualObjective: 'Establish the hook',
    action: 'A boxer throws a slow-motion jab',
    subject: 'Boxer',
    environment: 'Arena',
    cameraMovement: 'Static',
    lensFraming: 'Wide shot',
    lighting: 'Cool blue rim light',
    colorTreatment: 'Cool blue accent',
    motionIntensity: 'MEDIUM',
    transitionIn: 'CUT',
    transitionOut: 'CUT',
    textSafeAreas: ['CENTER'],
    continuityRequirements: [],
    qualityRubric: ['Boxer must be clearly the subject of the frame'],
    ...overrides,
  };
}

async function seedAcceptedBrief(
  store: InMemoryCampaignStore,
  campaignId: string,
  workspaceId: string,
) {
  await submitCampaignBrief(store, workspaceId, {
    campaignId,
    content: {
      campaignName: 'Launch Q3',
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
    },
  });
}

async function seedConceptAndScript(
  store: InMemoryCampaignStore,
  campaignId: string,
  workspaceId: string,
  shotCount = 2,
) {
  const concept = await createCreativeConcept(store, workspaceId, {
    campaignId,
    version: 1,
    logline: 'One weekend, twelve fight cards.',
    visualDirection: 'Fast-cut arena montage, cool blue accent lighting.',
    narrativeArc: 'Hook -> promise -> feature -> CTA.',
    referenceNotes: [],
  });
  const { script, shots } = await createScriptWithShots(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    version: 1,
    totalDurationFrames: 90 * shotCount,
    shots: Array.from({ length: shotCount }, (_, index) => ({
      index,
      description: `Shot ${index}: arena footage`,
      durationFrames: 90,
      beat: index === 0 ? ('HOOK' as const) : ('FEATURE' as const),
      dependsOnShotIndices: index === 0 ? [] : [index - 1],
    })),
  });
  return { concept, script, shots };
}

function buildDeps(store: InMemoryCampaignStore, results: Record<string, unknown>[]) {
  const executeSpecialistAgentActivity = createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider(results.map((result) => ({ result }))),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
  return createRunShotPromptEngineerActivity({
    executeSpecialistAgentActivity,
    agentRegistry: AGENT_REGISTRY,
    campaignBriefDb: store,
    creativeConceptDb: store,
    scriptDb: store,
    assetDb: store,
    licenseDb: store,
    promptDb: store,
    shotSpecificationDb: store,
  });
}

describe('runShotPromptEngineerActivity', () => {
  it('persists one ShotSpecification per shot, pinning a promptVersionId', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'PROMPTING' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    const { concept, script, shots } = await seedConceptAndScript(
      store,
      campaign.id,
      campaign.workspaceId,
    );
    const activity = buildDeps(store, [shotResult(), shotResult()]);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      providerId: 'mock-video-gen',
      revisionAttempt: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.shotSpecificationIds).toHaveLength(2);
    expect(store.shotSpecificationRecords).toHaveLength(2);
    for (const [i, spec] of store.shotSpecificationRecords.entries()) {
      expect(spec.shotId).toBe(shots[i]!.id);
      expect(spec.scriptId).toBe(script.id);
      expect(spec.creativeConceptId).toBe(concept.id);
      expect(spec.version).toBe(1);
      expect(spec.promptVersionId).toBeTruthy();
      expect(spec.generationPrompt).toBe(shotResult().promptText);
    }
    expect(store.promptVersions).toHaveLength(1);
    expect(store.agentInvocations).toHaveLength(2);
  });

  it('is idempotent: retrying the same revisionAttempt does not create duplicate invocations or specs', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'PROMPTING' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    await seedConceptAndScript(store, campaign.id, campaign.workspaceId, 1);
    const activity = buildDeps(store, [shotResult()]);
    const workflowRunId = randomUUID();

    const first = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId,
      providerId: 'mock-video-gen',
      revisionAttempt: 1,
    });
    const second = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId,
      providerId: 'mock-video-gen',
      revisionAttempt: 1,
    });

    expect(first).toEqual(second);
    expect(store.shotSpecificationRecords).toHaveLength(1);
    expect(store.agentInvocations).toHaveLength(1);
  });

  it('a second revisionAttempt persists a new version without touching version 1', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'PROMPTING' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    await seedConceptAndScript(store, campaign.id, campaign.workspaceId, 1);

    await buildDeps(store, [shotResult()])({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      providerId: 'mock-video-gen',
      revisionAttempt: 1,
    });
    await buildDeps(store, [shotResult()])({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      providerId: 'mock-video-gen',
      revisionAttempt: 2,
    });

    expect(store.shotSpecificationRecords).toHaveLength(2);
    expect(store.shotSpecificationRecords.map((s) => s.version).sort()).toEqual([1, 2]);
  });

  it('fails with BRIEF_NOT_FOUND when the campaign has no accepted brief', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'PROMPTING' });
    const activity = buildDeps(store, []);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      providerId: 'mock-video-gen',
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'BRIEF_NOT_FOUND' });
  });

  it('fails with CONCEPT_NOT_FOUND when no CreativeConcept exists', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'PROMPTING' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    const activity = buildDeps(store, []);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      providerId: 'mock-video-gen',
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'CONCEPT_NOT_FOUND' });
  });

  it('fails with STALE_SCRIPT_VERSION when the latest script targets a superseded concept', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'PROMPTING' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    await seedConceptAndScript(store, campaign.id, campaign.workspaceId, 1);
    // A concept revision landed after the script was generated -> the script is now stale.
    await createCreativeConcept(store, campaign.workspaceId, {
      campaignId: campaign.id,
      version: 2,
      logline: 'Revised logline.',
      visualDirection: 'Revised visual direction.',
      narrativeArc: 'Revised arc.',
      referenceNotes: [],
    });
    const activity = buildDeps(store, []);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      providerId: 'mock-video-gen',
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'STALE_SCRIPT_VERSION' });
    expect(store.shotSpecificationRecords).toHaveLength(0);
  });

  it('fails with UNLICENSED_REFERENCE_ASSET when a collected UPLOADED_SOURCE asset has no LicenseRecord', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'PROMPTING' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    await seedConceptAndScript(store, campaign.id, campaign.workspaceId, 1);
    await createAssetWithProvenance(store, campaign.workspaceId, {
      campaignId: campaign.id,
      kind: 'UPLOADED_SOURCE',
      s3Key: 'brand/logo.png',
      checksum: 'deadbeef',
      mimeType: 'image/png',
      originalFilename: 'logo.png',
      sizeBytes: 1024,
      uploadedByUserId: randomUUID(),
    });
    const activity = buildDeps(store, []);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      providerId: 'mock-video-gen',
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'UNLICENSED_REFERENCE_ASSET' });
    expect(store.shotSpecificationRecords).toHaveLength(0);
  });

  it('includes licensed reference assets and their restrictions as licensingConstraints', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'PROMPTING' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    await seedConceptAndScript(store, campaign.id, campaign.workspaceId, 1);
    const { asset } = await createAssetWithProvenance(store, campaign.workspaceId, {
      campaignId: campaign.id,
      kind: 'UPLOADED_SOURCE',
      s3Key: 'brand/logo.png',
      checksum: 'deadbeef',
      mimeType: 'image/png',
      originalFilename: 'logo.png',
      sizeBytes: 1024,
      uploadedByUserId: randomUUID(),
    });
    await createLicenseRecord(store, campaign.workspaceId, {
      assetId: asset.id,
      licenseType: 'LIMITED_USAGE',
      rightsHolder: 'Combat Reviews',
      restrictions: ['no third-party redistribution'],
    });
    const activity = buildDeps(store, [shotResult()]);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      providerId: 'mock-video-gen',
      revisionAttempt: 1,
    });

    expect(result.ok).toBe(true);
    expect(store.shotSpecificationRecords[0]!.referenceAssetIds).toEqual([asset.id]);
    expect(store.shotSpecificationRecords[0]!.licensingConstraints).toEqual([
      'no third-party redistribution',
    ]);
  });

  it('fails with AGENT_FAILED and persists no specs for that shot when the agent returns malformed output', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'PROMPTING' });
    await seedAcceptedBrief(store, campaign.id, campaign.workspaceId);
    await seedConceptAndScript(store, campaign.id, campaign.workspaceId, 1);
    const activity = buildDeps(store, [
      { not: 'a valid shot result' },
      { not: 'a valid shot result' },
    ]);

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      workflowRunId: randomUUID(),
      providerId: 'mock-video-gen',
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'AGENT_FAILED',
      agentName: 'shot-prompt-engineer',
    });
    expect(store.shotSpecificationRecords).toHaveLength(0);
  });
});
