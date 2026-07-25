import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueuedReasoningProvider } from '@combat/agent-runtime';
import { AGENT_REGISTRY } from '@combat/agents';
import {
  createCreativeConcept,
  createScriptWithShots,
  createShotSpecification,
  getOrCreateShotGenerationJob,
  getQualityAssessmentForCandidate,
  InMemoryCampaignStore,
  submitCampaignBrief,
  type GenerationCandidateRecord,
} from '@combat/database';
import type { CampaignBriefContent } from '@combat/domain';
import { createExecuteSpecialistAgentActivity } from './execute-specialist-agent-activity';
import { createRunVisualQualityAssessmentsActivity } from './run-visual-quality-assessment-activity';

const BRIEF_CONTENT: CampaignBriefContent = {
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
};

function visualPass() {
  return {
    criterionScores: [
      { criterionId: 'subject-fidelity', pass: true, score: 1 },
      { criterionId: 'motion-coherence', pass: true, score: 1 },
      { criterionId: 'resolution-clarity', pass: true, score: 1 },
      { criterionId: 'brand-safety', pass: true, score: 1 },
    ],
    findings: [],
  };
}

function visualFailBlocking() {
  return {
    criterionScores: [
      { criterionId: 'subject-fidelity', pass: true, score: 1 },
      { criterionId: 'motion-coherence', pass: false, score: 0, note: 'morphing artifact' },
      { criterionId: 'resolution-clarity', pass: true, score: 1 },
      { criterionId: 'brand-safety', pass: true, score: 1 },
    ],
    findings: [
      {
        category: 'GENERATION',
        severity: 'BLOCKING',
        description: 'Morphing artifact on the subject.',
        suggestedAction: 'Regenerate with lower motion intensity.',
      },
    ],
  };
}

async function seedCampaignAtVisualQA(
  store: InMemoryCampaignStore,
  options: { shotCount?: number; workspaceId?: string; campaignId?: string } = {},
) {
  const { shotCount = 2 } = options;
  const workspaceId = options.workspaceId ?? randomUUID();
  const campaignId = options.campaignId ?? randomUUID();
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'VISUAL_QA' });
  await submitCampaignBrief(store, workspaceId, { campaignId, content: BRIEF_CONTENT });
  const concept = await createCreativeConcept(store, workspaceId, {
    campaignId,
    version: 1,
    logline: 'One weekend, twelve fight cards.',
    visualDirection: 'Fast-cut arena montage.',
    narrativeArc: 'Hook -> feature -> CTA.',
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

  const candidates: GenerationCandidateRecord[] = [];
  for (const shot of shots) {
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
      visualObjective: `Objective ${shot.index}`,
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
      generationPrompt: 'A boxer throws a jab',
      generationParams: { durationSeconds: 3, aspectRatio: '9:16', providerOptions: {} },
      outputRequirements: { durationSeconds: 3, aspectRatio: '9:16', minCandidateCount: 1 },
      qualityRubric: [],
      licensingConstraints: [],
      createdByAgentInvocationId: randomUUID(),
    });
    await getOrCreateShotGenerationJob(store, workspaceId, {
      campaignId,
      shotSpecificationId: spec.id,
      requestedCandidateCount: 1,
      maxAttempts: 3,
    });
    const candidate: GenerationCandidateRecord = {
      id: randomUUID(),
      workspaceId,
      shotSpecificationId: spec.id,
      shotGenerationAttemptId: randomUUID(),
      candidateIndex: 0,
      status: 'SUCCEEDED',
      providerCandidateRef: `ref-${shot.index}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.generationCandidateRecords.push(candidate);
    candidates.push(candidate);
  }
  return { workspaceId, campaignId, script, shots, candidates };
}

function buildActivity(store: InMemoryCampaignStore, results: Record<string, unknown>[]) {
  const executeSpecialistAgentActivity = createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider(results.map((result) => ({ result }))),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
  return createRunVisualQualityAssessmentsActivity({
    executeSpecialistAgentActivity,
    campaignDb: store,
    campaignBriefDb: store,
    scriptDb: store,
    shotSpecificationDb: store,
    shotGenerationDb: store,
    qualityAssessmentDb: store,
  });
}

describe('runVisualQualityAssessmentsActivity', () => {
  it('assesses every shot, persists a passing QualityAssessment with score + agent provenance', async () => {
    const store = new InMemoryCampaignStore();
    const { workspaceId, campaignId, candidates } = await seedCampaignAtVisualQA(store);
    const activity = buildActivity(store, [visualPass(), visualPass()]);

    const result = await activity({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allPassed).toBe(true);
    expect(result.anyBlocking).toBe(false);
    expect(store.qualityAssessmentRecords).toHaveLength(2);

    const assessment = await getQualityAssessmentForCandidate(
      store,
      workspaceId,
      candidates[0]!.id,
      'VISUAL_QA',
    );
    expect(assessment?.pass).toBe(true);
    expect(assessment?.overallScore).toBe(1);
    expect(assessment?.campaignId).toBe(campaignId);
    // AgentInvocation provenance: the assessment points at the invocation that produced it.
    expect(assessment?.createdByAgentInvocationId).toBeDefined();
    const invocation = store.agentInvocations.find(
      (i) => i.idempotencyKey === assessment?.createdByAgentInvocationId,
    );
    expect(invocation?.agentName).toBe('visual-quality-controller');
    expect(invocation?.stage).toBe('VISUAL_QA');
  });

  it('records a blocking failure and marks the shot failed when a criterion fails', async () => {
    const store = new InMemoryCampaignStore();
    const { workspaceId, campaignId, candidates } = await seedCampaignAtVisualQA(store, {
      shotCount: 2,
    });
    const activity = buildActivity(store, [visualFailBlocking(), visualPass()]);

    const result = await activity({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allPassed).toBe(false);
    expect(result.anyBlocking).toBe(true);
    const failing = result.shotResults.find((r) => !r.pass);
    expect(failing?.candidateId).toBe(candidates[0]!.id);
    expect(store.qualityFailureRecords).toHaveLength(1);
    expect(store.qualityFailureRecords[0]!.severity).toBe('BLOCKING');
  });

  it('never leaks or assesses a campaign in another workspace', async () => {
    const store = new InMemoryCampaignStore();
    const { campaignId } = await seedCampaignAtVisualQA(store);
    const activity = buildActivity(store, [visualPass(), visualPass()]);

    const result = await activity({
      workspaceId: randomUUID(), // a different workspace
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'CAMPAIGN_NOT_FOUND' });
    expect(store.qualityAssessmentRecords).toHaveLength(0);
  });

  it('is idempotent under Activity retry — no duplicate assessments, agent replayed', async () => {
    const store = new InMemoryCampaignStore();
    const { workspaceId, campaignId } = await seedCampaignAtVisualQA(store);
    const activity = buildActivity(store, [visualPass(), visualPass()]);

    await activity({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });
    const second = await activity({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });

    expect(second.ok).toBe(true);
    expect(store.qualityAssessmentRecords).toHaveLength(2);
    // Only two AgentInvocation rows (one per shot) — the retry replayed them.
    expect(store.agentInvocations).toHaveLength(2);
  });

  it('returns AGENT_FAILED (persisting nothing new) when the agent output is unusable', async () => {
    const store = new InMemoryCampaignStore();
    const { workspaceId, campaignId } = await seedCampaignAtVisualQA(store, { shotCount: 1 });
    // An empty criterionScores array violates VisualQualityControllerResultSchema (.min(1)).
    const activity = buildActivity(store, [{ criterionScores: [], findings: [] }]);

    const result = await activity({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'AGENT_FAILED' });
    expect(store.qualityAssessmentRecords).toHaveLength(0);
  });
});
