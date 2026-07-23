import { describe, expect, it } from 'vitest';
import { CAMPAIGN_STAGES, type CampaignStage } from './campaign-stage';
import {
  CAMPAIGN_TRANSITIONS,
  evaluateCampaignTransition,
  isValidCampaignTransition,
  listValidNextStages,
  type TransitionFacts,
} from './transition-rules';

/** A facts object with every fact true — satisfies the requiredFacts of any single transition in isolation. */
const ALL_FACTS_TRUE: Required<TransitionFacts> = {
  briefAccepted: true,
  strategyApproved: true,
  conceptApproved: true,
  scriptApproved: true,
  allShotsHaveRequiredAssets: true,
  allShotsHaveCandidate: true,
  allShotsPassedAutomatedQA: true,
  allShotsSelected: true,
  compositingComplete: true,
  roughCutAssembled: true,
  finalQAPassed: true,
  finalApproved: true,
  exportRenderComplete: true,
  deliverySpecMet: true,
  distributionConfirmed: true,
  performanceMetricsCollected: true,
  strategyRevisionRequested: true,
  conceptRevisionRequested: true,
  scriptRevisionRequested: true,
  automatedQARetryAllowed: true,
  shotSelectionRegenerateRequested: true,
  finalQARevisionRequested: true,
  finalApprovalRevisionRequested: true,
  iterationPlanningRestartRequested: true,
};

describe('campaign transition rules — every valid transition', () => {
  it.each(CAMPAIGN_TRANSITIONS.map((t) => [t.from, t.to, t.kind] as const))(
    '%s -> %s (%s) succeeds once its required facts are true',
    (from, to) => {
      const result = evaluateCampaignTransition(from, to, ALL_FACTS_TRUE);
      expect(result.ok).toBe(true);
    },
  );

  it.each(CAMPAIGN_TRANSITIONS.map((t) => [t.from, t.to, t.requiredFacts] as const))(
    '%s -> %s is rejected as MISSING_PREREQUISITE when its required facts are false',
    (from, to, requiredFacts) => {
      if (requiredFacts.length === 0) return;
      const result = evaluateCampaignTransition(from, to, {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.type).toBe('MISSING_PREREQUISITE');
        if (result.reason.type === 'MISSING_PREREQUISITE') {
          expect(result.reason.missing).toEqual(requiredFacts);
        }
      }
    },
  );
});

describe('campaign transition rules — every invalid transition', () => {
  const validPairs = new Set(CAMPAIGN_TRANSITIONS.map((t) => `${t.from}->${t.to}`));
  const allPairs: Array<[CampaignStage, CampaignStage]> = [];
  for (const from of CAMPAIGN_STAGES) {
    for (const to of CAMPAIGN_STAGES) {
      if (from === to) continue;
      allPairs.push([from, to]);
    }
  }
  const invalidPairs = allPairs.filter(([from, to]) => !validPairs.has(`${from}->${to}`));

  // Sanity check: the exhaustive-pair sweep actually found invalid pairs to test.
  it('has at least one invalid pair to exercise', () => {
    expect(invalidPairs.length).toBeGreaterThan(0);
  });

  it.each(invalidPairs)('%s -> %s is rejected as INVALID_TRANSITION', (from, to) => {
    expect(isValidCampaignTransition(from, to)).toBe(false);
    const result = evaluateCampaignTransition(from, to, ALL_FACTS_TRUE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toEqual({ type: 'INVALID_TRANSITION', from, to });
    }
  });

  it('rejects a self-transition for every stage', () => {
    for (const stage of CAMPAIGN_STAGES) {
      expect(isValidCampaignTransition(stage, stage)).toBe(false);
    }
  });
});

describe('listValidNextStages', () => {
  it('matches the transition table for a sample of stages', () => {
    expect(listValidNextStages('DRAFT')).toEqual(['STRATEGY_REVIEW']);
    expect(listValidNextStages('AUTOMATED_QA')).toEqual(['HUMAN_SHOT_SELECTION', 'SHOT_GENERATION']);
    expect(listValidNextStages('ITERATION_PLANNING')).toEqual(['DRAFT']);
  });

  it('returns an empty array for a stage with no outgoing transitions in this table', () => {
    // Every stage in this pipeline has at least one outgoing edge; this guards
    // against silently treating a typo'd stage name as a dead end.
    for (const stage of CAMPAIGN_STAGES) {
      expect(listValidNextStages(stage).length).toBeGreaterThan(0);
    }
  });
});
