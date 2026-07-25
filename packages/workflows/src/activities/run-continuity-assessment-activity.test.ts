import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueuedReasoningProvider } from '@combat/agent-runtime';
import { AGENT_REGISTRY } from '@combat/agents';
import {
  createCreativeConcept,
  createQualityAssessmentForCandidate,
  createScriptWithShots,
  createShotSpecification,
  getOrCreateShotGenerationJob,
  InMemoryCampaignStore,
  submitCampaignBrief,
  type GenerationCandidateRecord,
} from '@combat/database';
import type {
  CampaignBriefContent,
  ExecuteSpecialistAgentInput,
  ExecuteSpecialistAgentOutput,
} from '@combat/domain';
import { createExecuteSpecialistAgentActivity } from './execute-specialist-agent-activity';
import { createRunContinuityAssessmentActivity } from './run-continuity-assessment-activity';

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

function continuityPass() {
  return {
    criterionScores: [
      { criterionId: 'visual-consistency', pass: true, score: 1 },
      { criterionId: 'narrative-continuity', pass: true, score: 1 },
    ],
    conflicts: [],
  };
}

function continuityBlockingOnShot(shotIndex: number) {
  return {
    criterionScores: [
      { criterionId: 'visual-consistency', pass: false, score: 0 },
      { criterionId: 'narrative-continuity', pass: true, score: 1 },
    ],
    conflicts: [
      {
        shotIndices: [shotIndex],
        issue: 'Lighting colour jumps between adjacent shots.',
        severity: 'BLOCKING',
      },
    ],
  };
}

async function seedCampaignAtContinuityQA(
  store: InMemoryCampaignStore,
  options: {
    shotCount?: number;
    withVisualPass?: boolean;
    workspaceId?: string;
    campaignId?: string;
  } = {},
) {
  const { shotCount = 3, withVisualPass = true } = options;
  const workspaceId = options.workspaceId ?? randomUUID();
  const campaignId = options.campaignId ?? randomUUID();
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'CONTINUITY_QA' });
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

    if (withVisualPass) {
      await createQualityAssessmentForCandidate(store, {
        workspaceId,
        campaignId,
        candidate,
        candidateCampaignId: campaignId,
        latestCandidateId: candidate.id,
        subjectStage: 'VISUAL_QA',
        pass: true,
        overallScore: 1,
        scores: { 'subject-fidelity': 1 },
        assessedBy: 'AGENT',
        failures: [],
      });
    }
  }
  return { workspaceId, campaignId, shots, candidates };
}

function realExecActivity(store: InMemoryCampaignStore, results: Record<string, unknown>[]) {
  return createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider(results.map((result) => ({ result }))),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
}

function buildActivity(
  store: InMemoryCampaignStore,
  exec: (input: ExecuteSpecialistAgentInput) => Promise<ExecuteSpecialistAgentOutput>,
) {
  return createRunContinuityAssessmentActivity({
    executeSpecialistAgentActivity: exec,
    campaignDb: store,
    campaignBriefDb: store,
    scriptDb: store,
    shotSpecificationDb: store,
    shotGenerationDb: store,
    qualityAssessmentDb: store,
  });
}

describe('runContinuityAssessmentActivity', () => {
  it('assesses the ordered candidate sequence and persists a CONTINUITY_QA assessment per candidate with shared provenance', async () => {
    const store = new InMemoryCampaignStore();
    const { workspaceId, campaignId, candidates } = await seedCampaignAtContinuityQA(store);

    // Capture the agent payload to assert the sequence is passed in shot order.
    let capturedInput: ExecuteSpecialistAgentInput | undefined;
    const exec = async (
      input: ExecuteSpecialistAgentInput,
    ): Promise<ExecuteSpecialistAgentOutput> => {
      capturedInput = input;
      return {
        invocationId: 'continuity-inv-1',
        agentName: 'continuity-controller',
        agentVersion: 1,
        status: 'SUCCEEDED',
        result: continuityPass(),
        failure: null,
        modelMeta: null,
        costCents: null,
        inputHash: 'h',
        outputHash: null,
        correlationId: 'c',
        idempotencyKey: 'continuity-inv-1',
        attempt: 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        replayed: false,
      };
    };

    const result = await buildActivity(
      store,
      exec,
    )({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allPassed).toBe(true);
    const payload = capturedInput?.payload as {
      selectedCandidateSummaries: { shotIndex: number }[];
    };
    expect(payload.selectedCandidateSummaries.map((s) => s.shotIndex)).toEqual([0, 1, 2]);
    // One assessment per candidate, all sharing the single agent invocation's provenance.
    expect(
      store.qualityAssessmentRecords.filter((a) => a.subjectStage === 'CONTINUITY_QA'),
    ).toHaveLength(3);
    const continuityAssessments = store.qualityAssessmentRecords.filter(
      (a) => a.subjectStage === 'CONTINUITY_QA',
    );
    for (const a of continuityAssessments) {
      expect(a.createdByAgentInvocationId).toBe('continuity-inv-1');
    }
    expect(continuityAssessments.map((a) => a.generationCandidateId).sort()).toEqual(
      candidates.map((c) => c.id).sort(),
    );
  });

  it('fails only the shot a blocking continuity conflict implicates', async () => {
    const store = new InMemoryCampaignStore();
    const { workspaceId, campaignId, candidates } = await seedCampaignAtContinuityQA(store);
    const activity = buildActivity(store, realExecActivity(store, [continuityBlockingOnShot(1)]));

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
    const failing = result.shotResults.filter((r) => !r.pass);
    expect(failing).toHaveLength(1);
    expect(failing[0]!.candidateId).toBe(candidates[1]!.id);
    expect(store.qualityFailureRecords.filter((f) => f.category === 'CONTINUITY')).toHaveLength(1);
  });

  it('refuses to run until every shot has a passing VISUAL_QA result', async () => {
    const store = new InMemoryCampaignStore();
    const { workspaceId, campaignId } = await seedCampaignAtContinuityQA(store, {
      withVisualPass: false,
    });
    const activity = buildActivity(store, realExecActivity(store, [continuityPass()]));

    const result = await activity({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'VISUAL_QA_INCOMPLETE' });
    expect(
      store.qualityAssessmentRecords.filter((a) => a.subjectStage === 'CONTINUITY_QA'),
    ).toHaveLength(0);
  });

  it('never leaks or assesses a campaign in another workspace', async () => {
    const store = new InMemoryCampaignStore();
    const { campaignId } = await seedCampaignAtContinuityQA(store);
    const activity = buildActivity(store, realExecActivity(store, [continuityPass()]));

    const result = await activity({
      workspaceId: randomUUID(),
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'CAMPAIGN_NOT_FOUND' });
  });

  it('is idempotent under Activity retry — no duplicate assessments', async () => {
    const store = new InMemoryCampaignStore();
    const { workspaceId, campaignId } = await seedCampaignAtContinuityQA(store);
    const activity = buildActivity(
      store,
      realExecActivity(store, [continuityPass(), continuityPass()]),
    );

    await activity({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });
    await activity({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      providerId: 'mock-video-generation',
      revisionAttempt: 1,
    });

    expect(
      store.qualityAssessmentRecords.filter((a) => a.subjectStage === 'CONTINUITY_QA'),
    ).toHaveLength(3);
  });
});
