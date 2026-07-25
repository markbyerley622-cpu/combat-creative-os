import { z } from 'zod';

/**
 * Why a generated candidate may NOT be selected at the HUMAN_SHOT_SELECTION
 * gate (M8). A candidate is eligible only when every one of these checks
 * passes; any that fail are returned so the API/dashboard can explain exactly
 * why a candidate is disqualified rather than silently hiding it. This is a
 * pure, dependency-free enumeration + evaluator so `packages/workflows` (no
 * I/O) and `packages/database`/`apps/api` (which gather the facts) can share
 * one source of truth for the rule set.
 */
export const CANDIDATE_INELIGIBILITY_REASONS = [
  'NOT_SUCCEEDED',
  'ASSET_NOT_READY',
  'NOT_LATEST_CANDIDATE',
  'VISUAL_QA_NOT_PASSED',
  'CONTINUITY_QA_NOT_PASSED',
  'UNRESOLVED_BLOCKING_DEFECT',
  'LICENSING_INVALID',
  'VERSION_MISMATCH',
  'SUPERSEDED',
] as const;
export const CandidateIneligibilityReasonSchema = z.enum(CANDIDATE_INELIGIBILITY_REASONS);
export type CandidateIneligibilityReason = z.infer<typeof CandidateIneligibilityReasonSchema>;

/**
 * The boolean facts a caller gathers from persisted state before asking
 * whether a candidate can be selected. Kept as flat booleans (rather than raw
 * rows) so `evaluateCandidateEligibility` stays pure — mirroring the
 * `TransitionFacts`/`evaluateCampaignTransition` split.
 */
export interface CandidateEligibilityFacts {
  /** GenerationCandidate.status === 'SUCCEEDED'. */
  generationSucceeded: boolean;
  /** The candidate's Asset exists and is ingestion-status READY. */
  assetReady: boolean;
  /** This is the latest SUCCEEDED candidate for the shot's latest attempt (not an older one). */
  isLatestCandidate: boolean;
  /** A passing VISUAL_QA QualityAssessment exists for this candidate. */
  visualQaPassed: boolean;
  /** A passing CONTINUITY_QA QualityAssessment exists for this candidate. */
  continuityQaPassed: boolean;
  /** Any BLOCKING QualityFailure on this candidate's assessments that has not been resolved by a newer passing assessment. */
  hasUnresolvedBlockingFailure: boolean;
  /** Every licensed reference the candidate's ShotSpecification depends on still carries a valid LicenseRecord, and provenance is intact. */
  licensingValid: boolean;
  /** The candidate's campaign/workspace/script/ShotSpecification versions match the ones under review. */
  versionsMatch: boolean;
  /** A newer ShotSpecification version (or newer generation attempt) has superseded the one this candidate answers. */
  superseded: boolean;
}

export interface CandidateEligibility {
  eligible: boolean;
  reasons: CandidateIneligibilityReason[];
}

/**
 * Pure evaluation of whether a candidate can be selected. Returns every
 * failing reason (not just the first) so the review UI can list all the
 * blockers at once. `versionsMatch === false` and `superseded === true` are
 * kept as distinct reasons (VERSION_MISMATCH vs SUPERSEDED) because they
 * describe different failures a reviewer resolves differently — a version
 * mismatch means the candidate belongs to a different revision entirely, while
 * "superseded" means a newer attempt for this same shot now exists.
 */
export function evaluateCandidateEligibility(
  facts: CandidateEligibilityFacts,
): CandidateEligibility {
  const reasons: CandidateIneligibilityReason[] = [];
  if (!facts.generationSucceeded) reasons.push('NOT_SUCCEEDED');
  if (!facts.assetReady) reasons.push('ASSET_NOT_READY');
  if (!facts.isLatestCandidate) reasons.push('NOT_LATEST_CANDIDATE');
  if (!facts.visualQaPassed) reasons.push('VISUAL_QA_NOT_PASSED');
  if (!facts.continuityQaPassed) reasons.push('CONTINUITY_QA_NOT_PASSED');
  if (facts.hasUnresolvedBlockingFailure) reasons.push('UNRESOLVED_BLOCKING_DEFECT');
  if (!facts.licensingValid) reasons.push('LICENSING_INVALID');
  if (!facts.versionsMatch) reasons.push('VERSION_MISMATCH');
  if (facts.superseded) reasons.push('SUPERSEDED');
  return { eligible: reasons.length === 0, reasons };
}
