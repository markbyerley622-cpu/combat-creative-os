import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';
import { createAssetWithProvenance } from './asset-repository';
import { createQualityAssessmentForCandidate } from './quality-assessment-repository';
import { createShotSpecification } from './shot-specification-repository';
import type { GenerationCandidateRecord } from './shot-generation-repository';
import { gatherCandidateEligibility } from './candidate-eligibility-repository';

type SpecInput = Parameters<typeof createShotSpecification>[2];

function specInput(
  campaignId: string,
  shotId: string,
  version = 1,
  overrides: Partial<SpecInput> = {},
): SpecInput {
  return {
    campaignId,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotId,
    version,
    shotNumber: 0,
    sequencePosition: 0,
    intendedDurationSeconds: 3,
    visualObjective: 'o',
    action: 'a',
    subject: 's',
    environment: 'e',
    cameraMovement: 'static',
    lensFraming: 'wide',
    lighting: 'soft',
    colorTreatment: 'neutral',
    motionIntensity: 'LOW' as const,
    transitionIn: 'CUT' as const,
    transitionOut: 'CUT' as const,
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
    ...overrides,
  };
}

interface SeedOptions {
  assetReady?: boolean;
  visualPass?: boolean;
  continuityPass?: boolean;
  withAsset?: boolean;
}

async function seedEligibleShot(opts: SeedOptions = {}) {
  const { assetReady = true, visualPass = true, continuityPass = true, withAsset = true } = opts;
  const store = new InMemoryCampaignStore();
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const shotId = randomUUID();

  const spec = await createShotSpecification(store, workspaceId, specInput(campaignId, shotId, 1));

  let assetId: string | undefined;
  if (withAsset) {
    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'VIDEO_CANDIDATE',
      s3Key: `candidates/${randomUUID()}`,
      checksum: randomUUID(),
      mimeType: 'video/mp4',
      originalFilename: 'candidate.mp4',
      sizeBytes: 1024,
      ingestionStatus: assetReady ? 'READY' : 'PENDING',
    });
    assetId = asset.id;
  }

  const candidate: GenerationCandidateRecord = {
    id: randomUUID(),
    workspaceId,
    shotSpecificationId: spec.id,
    shotGenerationAttemptId: randomUUID(),
    candidateIndex: 0,
    status: 'SUCCEEDED',
    assetId,
    providerCandidateRef: 'ref',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  store.generationCandidateRecords.push(candidate);

  await createQualityAssessmentForCandidate(store, {
    workspaceId,
    campaignId,
    candidate,
    candidateCampaignId: campaignId,
    latestCandidateId: candidate.id,
    subjectStage: 'VISUAL_QA',
    pass: visualPass,
    overallScore: visualPass ? 1 : 0,
    scores: {},
    assessedBy: 'AGENT',
    failures: visualPass
      ? []
      : [{ category: 'GENERATION', severity: 'BLOCKING', description: 'artifact' }],
  });
  await createQualityAssessmentForCandidate(store, {
    workspaceId,
    campaignId,
    candidate,
    candidateCampaignId: campaignId,
    latestCandidateId: candidate.id,
    subjectStage: 'CONTINUITY_QA',
    pass: continuityPass,
    overallScore: continuityPass ? 1 : 0,
    scores: {},
    assessedBy: 'AGENT',
    failures: [],
  });

  return { store, workspaceId, campaignId, shotId, spec, candidate };
}

describe('gatherCandidateEligibility', () => {
  it('returns eligible for a SUCCEEDED, READY, QA-passed, latest candidate', async () => {
    const { store, workspaceId, campaignId, shotId, candidate } = await seedEligibleShot();
    const result = await gatherCandidateEligibility(store, workspaceId, {
      campaignId,
      shotId,
      candidateId: candidate.id,
      latestScriptVersion: 1,
      latestConceptVersion: 1,
    });
    expect(result?.eligibility.eligible).toBe(true);
    expect(result?.visualQaAssessmentId).toBeDefined();
    expect(result?.continuityQaAssessmentId).toBeDefined();
  });

  it('flags ASSET_NOT_READY when the candidate asset is not READY', async () => {
    const { store, workspaceId, campaignId, shotId, candidate } = await seedEligibleShot({
      assetReady: false,
    });
    const result = await gatherCandidateEligibility(store, workspaceId, {
      campaignId,
      shotId,
      candidateId: candidate.id,
      latestScriptVersion: 1,
      latestConceptVersion: 1,
    });
    expect(result?.eligibility.eligible).toBe(false);
    expect(result?.eligibility.reasons).toContain('ASSET_NOT_READY');
  });

  it('flags a failed VISUAL_QA and its unresolved blocking defect', async () => {
    const { store, workspaceId, campaignId, shotId, candidate } = await seedEligibleShot({
      visualPass: false,
    });
    const result = await gatherCandidateEligibility(store, workspaceId, {
      campaignId,
      shotId,
      candidateId: candidate.id,
      latestScriptVersion: 1,
      latestConceptVersion: 1,
    });
    expect(result?.eligibility.reasons).toEqual(
      expect.arrayContaining(['VISUAL_QA_NOT_PASSED', 'UNRESOLVED_BLOCKING_DEFECT']),
    );
  });

  it('flags VERSION_MISMATCH / SUPERSEDED when a newer ShotSpecification exists for the shot', async () => {
    const { store, workspaceId, campaignId, shotId, spec, candidate } = await seedEligibleShot();
    // A newer spec version for the same shot supersedes the candidate's spec.
    await createShotSpecification(
      store,
      workspaceId,
      specInput(campaignId, shotId, 2, {
        creativeConceptId: spec.creativeConceptId,
        scriptId: spec.scriptId,
      }),
    );
    const result = await gatherCandidateEligibility(store, workspaceId, {
      campaignId,
      shotId,
      candidateId: candidate.id,
      latestScriptVersion: 1,
      latestConceptVersion: 1,
    });
    expect(result?.eligibility.reasons).toEqual(
      expect.arrayContaining(['VERSION_MISMATCH', 'SUPERSEDED']),
    );
  });

  it('returns null for an unknown candidate id', async () => {
    const { store, workspaceId, campaignId, shotId } = await seedEligibleShot();
    const result = await gatherCandidateEligibility(store, workspaceId, {
      campaignId,
      shotId,
      candidateId: randomUUID(),
      latestScriptVersion: 1,
      latestConceptVersion: 1,
    });
    expect(result).toBeNull();
  });
});
