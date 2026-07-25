import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';
import {
  CampaignMismatchError,
  CrossWorkspaceQualityAssessmentError,
  StaleCandidateError,
  createQualityAssessmentForCandidate,
  getQualityAssessmentForCandidate,
  listQualityAssessmentsForCandidates,
  listQualityFailuresForAssessment,
  type CreateQualityAssessmentInput,
} from './quality-assessment-repository';

function buildInput(
  overrides: Partial<CreateQualityAssessmentInput> = {},
): CreateQualityAssessmentInput {
  const workspaceId = overrides.workspaceId ?? randomUUID();
  const campaignId = overrides.campaignId ?? randomUUID();
  const candidateId = overrides.candidate?.id ?? randomUUID();
  return {
    workspaceId,
    campaignId,
    candidate: overrides.candidate ?? {
      id: candidateId,
      workspaceId,
      status: 'SUCCEEDED',
    },
    candidateCampaignId: overrides.candidateCampaignId ?? campaignId,
    latestCandidateId: overrides.latestCandidateId ?? candidateId,
    subjectStage: overrides.subjectStage ?? 'VISUAL_QA',
    pass: overrides.pass ?? true,
    overallScore: overrides.overallScore ?? 1,
    scores: overrides.scores ?? { 'subject-fidelity': 1 },
    assessedBy: overrides.assessedBy ?? 'AGENT',
    createdByAgentInvocationId: overrides.createdByAgentInvocationId,
    failures: overrides.failures ?? [],
  };
}

describe('quality-assessment-repository', () => {
  it('persists a passing assessment with score + provenance and no failures', async () => {
    const store = new InMemoryCampaignStore();
    const invocationId = randomUUID();
    const input = buildInput({ overallScore: 0.9, createdByAgentInvocationId: invocationId });

    const { assessment, alreadyExisted } = await createQualityAssessmentForCandidate(store, input);

    expect(alreadyExisted).toBe(false);
    expect(assessment.pass).toBe(true);
    expect(assessment.overallScore).toBe(0.9);
    expect(assessment.campaignId).toBe(input.campaignId);
    expect(assessment.generationCandidateId).toBe(input.candidate.id);
    expect(assessment.createdByAgentInvocationId).toBe(invocationId);
    expect(assessment.scores).toEqual({ 'subject-fidelity': 1 });
    expect(store.qualityAssessmentRecords).toHaveLength(1);
  });

  it('persists blocking and non-blocking QualityFailure rows for a failing assessment', async () => {
    const store = new InMemoryCampaignStore();
    const input = buildInput({
      pass: false,
      overallScore: 0,
      scores: { 'motion-coherence': 0 },
      failures: [
        {
          category: 'GENERATION',
          severity: 'BLOCKING',
          description: 'Morphing artifact on the subject.',
          suggestedAction: 'Regenerate with a lower motion intensity.',
        },
        {
          category: 'TECHNICAL',
          severity: 'LOW',
          description: 'Slight banding in the background gradient.',
        },
      ],
    });

    const { assessment } = await createQualityAssessmentForCandidate(store, input);

    const failures = await listQualityFailuresForAssessment(store, assessment.id);
    expect(failures).toHaveLength(2);
    const blocking = failures.filter((f) => f.severity === 'BLOCKING');
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.suggestedAction).toBe('Regenerate with a lower motion intensity.');
  });

  it('is idempotent per (candidate, subjectStage): a retry returns the existing row and does not duplicate failures', async () => {
    const store = new InMemoryCampaignStore();
    const input = buildInput({
      pass: false,
      overallScore: 0,
      scores: {},
      failures: [{ category: 'TECHNICAL', severity: 'HIGH', description: 'Blurred frame.' }],
    });

    const first = await createQualityAssessmentForCandidate(store, input);
    const second = await createQualityAssessmentForCandidate(store, input);

    expect(second.alreadyExisted).toBe(true);
    expect(second.assessment.id).toBe(first.assessment.id);
    expect(store.qualityAssessmentRecords).toHaveLength(1);
    expect(store.qualityFailureRecords).toHaveLength(1);
  });

  it('a different subjectStage for the same candidate gets its own assessment', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const candidate = { id: randomUUID(), workspaceId, status: 'SUCCEEDED' as const };
    const base = { workspaceId, campaignId, candidate, candidateCampaignId: campaignId };

    await createQualityAssessmentForCandidate(
      store,
      buildInput({ ...base, subjectStage: 'VISUAL_QA' }),
    );
    await createQualityAssessmentForCandidate(
      store,
      buildInput({ ...base, subjectStage: 'CONTINUITY_QA' }),
    );

    expect(store.qualityAssessmentRecords).toHaveLength(2);
    const visual = await getQualityAssessmentForCandidate(
      store,
      workspaceId,
      candidate.id,
      'VISUAL_QA',
    );
    const continuity = await getQualityAssessmentForCandidate(
      store,
      workspaceId,
      candidate.id,
      'CONTINUITY_QA',
    );
    expect(visual?.id).not.toBe(continuity?.id);
  });

  it('listQualityAssessmentsForCandidates scopes by workspace and candidate id set', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const candidateA = randomUUID();
    const candidateB = randomUUID();

    await createQualityAssessmentForCandidate(
      store,
      buildInput({
        workspaceId,
        candidate: { id: candidateA, workspaceId, status: 'SUCCEEDED' },
      }),
    );
    await createQualityAssessmentForCandidate(
      store,
      buildInput({
        workspaceId: otherWorkspaceId,
        candidate: { id: candidateB, workspaceId: otherWorkspaceId, status: 'SUCCEEDED' },
      }),
    );

    const results = await listQualityAssessmentsForCandidates(store, workspaceId, [
      candidateA,
      candidateB,
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.generationCandidateId).toBe(candidateA);
  });

  it('rejects a candidate from another workspace (cross-workspace access)', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const input = buildInput({
      workspaceId,
      candidate: { id: randomUUID(), workspaceId: randomUUID(), status: 'SUCCEEDED' },
    });

    await expect(createQualityAssessmentForCandidate(store, input)).rejects.toBeInstanceOf(
      CrossWorkspaceQualityAssessmentError,
    );
    expect(store.qualityAssessmentRecords).toHaveLength(0);
  });

  it('rejects a candidate whose owning campaign does not match (mismatched candidate)', async () => {
    const store = new InMemoryCampaignStore();
    const input = buildInput({ candidateCampaignId: randomUUID() });

    await expect(createQualityAssessmentForCandidate(store, input)).rejects.toBeInstanceOf(
      CampaignMismatchError,
    );
    expect(store.qualityAssessmentRecords).toHaveLength(0);
  });

  it('rejects a candidate that never reached SUCCEEDED (stale/unusable)', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const input = buildInput({
      workspaceId,
      candidate: { id: randomUUID(), workspaceId, status: 'FAILED' },
    });

    await expect(createQualityAssessmentForCandidate(store, input)).rejects.toBeInstanceOf(
      StaleCandidateError,
    );
    expect(store.qualityAssessmentRecords).toHaveLength(0);
  });

  it('rejects a candidate superseded by a newer candidate for the same shot (stale)', async () => {
    const store = new InMemoryCampaignStore();
    const input = buildInput({ latestCandidateId: randomUUID() });

    await expect(createQualityAssessmentForCandidate(store, input)).rejects.toBeInstanceOf(
      StaleCandidateError,
    );
    expect(store.qualityAssessmentRecords).toHaveLength(0);
  });
});
