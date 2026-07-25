import {
  evaluateCandidateEligibility,
  type CandidateEligibility,
  type CandidateEligibilityFacts,
} from '@combat/domain';
import { getAsset, type AssetDataSource } from './asset-repository';
import { getLicenseRecord, type LicenseDataSource } from './license-repository';
import {
  getQualityAssessmentForCandidate,
  listQualityFailuresForAssessment,
  type QualityAssessmentDataSource,
} from './quality-assessment-repository';
import {
  listGenerationCandidatesForSpecifications,
  type GenerationCandidateRecord,
  type ShotGenerationDataSource,
} from './shot-generation-repository';
import {
  listShotSpecificationsForShot,
  type ShotSpecificationDataSource,
} from './shot-specification-repository';

export type CandidateEligibilityDataSource = ShotSpecificationDataSource &
  ShotGenerationDataSource &
  AssetDataSource &
  QualityAssessmentDataSource &
  LicenseDataSource;

export interface CandidateEligibilityResult {
  candidate: GenerationCandidateRecord;
  facts: CandidateEligibilityFacts;
  eligibility: CandidateEligibility;
  visualQaAssessmentId?: string;
  continuityQaAssessmentId?: string;
}

function latestSucceeded(
  candidates: readonly GenerationCandidateRecord[],
): GenerationCandidateRecord | undefined {
  return [...candidates]
    .filter((c) => c.status === 'SUCCEEDED')
    .sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      return byTime !== 0 ? byTime : b.candidateIndex - a.candidateIndex;
    })[0];
}

/**
 * Gathers the eligibility facts for one candidate from persisted state and
 * evaluates them (via the pure `evaluateCandidateEligibility`). Returns `null`
 * when the candidate id isn't found under the shot — the caller treats that as
 * "no such candidate" rather than an ineligibility reason. All reads are
 * workspace-scoped, so a candidate from another workspace is never seen here.
 */
export async function gatherCandidateEligibility(
  db: CandidateEligibilityDataSource,
  workspaceId: string,
  input: {
    campaignId: string;
    shotId: string;
    candidateId: string;
    latestScriptVersion: number;
    latestConceptVersion: number;
  },
): Promise<CandidateEligibilityResult | null> {
  const specs = await listShotSpecificationsForShot(db, workspaceId, input.shotId);
  if (specs.length === 0) return null;
  const latestSpec = [...specs].sort((a, b) => b.version - a.version)[0]!;

  const allCandidates = await listGenerationCandidatesForSpecifications(
    db,
    specs.map((s) => s.id),
  );
  const candidate = allCandidates.find((c) => c.id === input.candidateId);
  if (!candidate) return null;
  const candidateSpec = specs.find((s) => s.id === candidate.shotSpecificationId) ?? latestSpec;

  const asset = candidate.assetId ? await getAsset(db, workspaceId, candidate.assetId) : null;

  const latestForLatestSpec = latestSucceeded(
    allCandidates.filter((c) => c.shotSpecificationId === latestSpec.id),
  );

  const visual = await getQualityAssessmentForCandidate(db, workspaceId, candidate.id, 'VISUAL_QA');
  const continuity = await getQualityAssessmentForCandidate(
    db,
    workspaceId,
    candidate.id,
    'CONTINUITY_QA',
  );

  let hasUnresolvedBlockingFailure = false;
  for (const assessment of [visual, continuity]) {
    if (assessment && !assessment.pass) {
      // eslint-disable-next-line no-await-in-loop -- at most two assessments per candidate
      const failures = await listQualityFailuresForAssessment(db, assessment.id);
      if (failures.some((f) => f.severity === 'BLOCKING')) {
        hasUnresolvedBlockingFailure = true;
      }
    }
  }

  let licensingValid = true;
  for (const assetId of candidateSpec.referenceAssetIds) {
    // eslint-disable-next-line no-await-in-loop -- small, per-spec reference set; fail-fast licensing check
    const license = await getLicenseRecord(db, workspaceId, assetId);
    if (!license) {
      licensingValid = false;
      break;
    }
  }

  const facts: CandidateEligibilityFacts = {
    generationSucceeded: candidate.status === 'SUCCEEDED',
    assetReady: asset?.ingestionStatus === 'READY',
    isLatestCandidate: latestForLatestSpec?.id === candidate.id,
    visualQaPassed: visual?.pass === true,
    continuityQaPassed: continuity?.pass === true,
    hasUnresolvedBlockingFailure,
    licensingValid,
    versionsMatch:
      candidateSpec.version === latestSpec.version &&
      candidateSpec.scriptVersion === input.latestScriptVersion &&
      candidateSpec.creativeConceptVersion === input.latestConceptVersion &&
      candidateSpec.campaignId === input.campaignId,
    superseded: candidateSpec.version < latestSpec.version,
  };

  return {
    candidate,
    facts,
    eligibility: evaluateCandidateEligibility(facts),
    visualQaAssessmentId: visual?.id,
    continuityQaAssessmentId: continuity?.id,
  };
}
