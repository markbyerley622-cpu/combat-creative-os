import { describe, expect, it } from 'vitest';
import {
  evaluateCandidateEligibility,
  type CandidateEligibilityFacts,
} from './candidate-eligibility';

const ELIGIBLE: CandidateEligibilityFacts = {
  generationSucceeded: true,
  assetReady: true,
  isLatestCandidate: true,
  visualQaPassed: true,
  continuityQaPassed: true,
  hasUnresolvedBlockingFailure: false,
  licensingValid: true,
  versionsMatch: true,
  superseded: false,
};

describe('evaluateCandidateEligibility', () => {
  it('accepts a fully eligible candidate', () => {
    expect(evaluateCandidateEligibility(ELIGIBLE)).toEqual({ eligible: true, reasons: [] });
  });

  it('reports every failing reason at once', () => {
    const result = evaluateCandidateEligibility({
      generationSucceeded: false,
      assetReady: false,
      isLatestCandidate: false,
      visualQaPassed: false,
      continuityQaPassed: false,
      hasUnresolvedBlockingFailure: true,
      licensingValid: false,
      versionsMatch: false,
      superseded: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      'NOT_SUCCEEDED',
      'ASSET_NOT_READY',
      'NOT_LATEST_CANDIDATE',
      'VISUAL_QA_NOT_PASSED',
      'CONTINUITY_QA_NOT_PASSED',
      'UNRESOLVED_BLOCKING_DEFECT',
      'LICENSING_INVALID',
      'VERSION_MISMATCH',
      'SUPERSEDED',
    ]);
  });

  it.each([
    ['generationSucceeded', 'NOT_SUCCEEDED'],
    ['assetReady', 'ASSET_NOT_READY'],
    ['isLatestCandidate', 'NOT_LATEST_CANDIDATE'],
    ['visualQaPassed', 'VISUAL_QA_NOT_PASSED'],
    ['continuityQaPassed', 'CONTINUITY_QA_NOT_PASSED'],
    ['licensingValid', 'LICENSING_INVALID'],
    ['versionsMatch', 'VERSION_MISMATCH'],
  ] as const)('flags %s=false as %s only', (field, reason) => {
    const result = evaluateCandidateEligibility({ ...ELIGIBLE, [field]: false });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([reason]);
  });

  it('flags an unresolved blocking defect', () => {
    const result = evaluateCandidateEligibility({
      ...ELIGIBLE,
      hasUnresolvedBlockingFailure: true,
    });
    expect(result.reasons).toEqual(['UNRESOLVED_BLOCKING_DEFECT']);
  });

  it('flags a superseded candidate', () => {
    const result = evaluateCandidateEligibility({ ...ELIGIBLE, superseded: true });
    expect(result.reasons).toEqual(['SUPERSEDED']);
  });
});
