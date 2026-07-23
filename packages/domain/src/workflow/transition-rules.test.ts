import { describe, expect, it } from 'vitest';
import { CAMPAIGN_STAGES, type CampaignStage } from './campaign-stage';
import {
  CAMPAIGN_TRANSITIONS,
  SELF_LOOP_STAGES,
  evaluateCampaignTransition,
  isValidCampaignTransition,
  listValidNextStages,
  type TransitionFacts,
} from './transition-rules';

/** A facts object with every fact true — satisfies the requiredFacts of any single transition in isolation. */
const ALL_FACTS_TRUE: Required<TransitionFacts> = {
  briefAccepted: true,
  conceptDrafted: true,
  conceptApproved: true,
  scriptDrafted: true,
  allShotsHaveRequiredAssets: true,
  allShotsHavePrompts: true,
  allShotsHaveCandidate: true,
  allShotsPassedVisualQA: true,
  allShotsPassedContinuityQA: true,
  allShotsSelected: true,
  compositingComplete: true,
  roughCutAssembled: true,
  soundDesignComplete: true,
  finalQAPassed: true,
  finalApproved: true,
  variantsGenerated: true,
  variantQAPassed: true,
  exportRenderComplete: true,
  deliverySpecMet: true,
  conceptRevisionRequested: true,
  visualQARetryAllowed: true,
  continuityQARetryAllowed: true,
  shotSelectionRegenerateRequested: true,
  compositingRepairTargetIsShotSelection: true,
  compositingRepairTargetIsCompositingRetry: true,
  roughCutFailureRequiresRecompositing: true,
  soundDesignRepairTargetIsRoughCut: true,
  soundDesignRepairTargetIsSoundDesignRetry: true,
  finalQARepairTargetIsCompositing: true,
  finalQARepairTargetIsRoughCut: true,
  finalQAAudioFailure: true,
  finalApprovalRepairTargetIsCompositing: true,
  finalApprovalRepairTargetIsRoughCut: true,
  finalApprovalRepairTargetIsSoundDesign: true,
  variantQAFailed: true,
  exportTechnicalFailureRetry: true,
  distributionFailureDetected: true,
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

  it('SCRIPT_REVIEW -> CONCEPT_REVIEW is the sole transition with no required facts, by design (decision 9)', () => {
    const emptyFactTransitions = CAMPAIGN_TRANSITIONS.filter((t) => t.requiredFacts.length === 0);
    expect(emptyFactTransitions).toEqual([
      expect.objectContaining({ from: 'SCRIPT_REVIEW', to: 'CONCEPT_REVIEW' }),
    ]);
  });
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

  it('rejects a self-transition for every stage except the three with a modeled technical-retry loop', () => {
    for (const stage of CAMPAIGN_STAGES) {
      const expected = SELF_LOOP_STAGES.has(stage);
      expect(isValidCampaignTransition(stage, stage)).toBe(expected);
    }
  });

  it('the only self-loop stages are COMPOSITING, SOUND_DESIGN, and EXPORTING', () => {
    expect([...SELF_LOOP_STAGES].sort()).toEqual(['COMPOSITING', 'EXPORTING', 'SOUND_DESIGN']);
  });
});

describe('mandatory human approval gates', () => {
  it('gates exactly three transitions: CONCEPT_REVIEW->SCRIPT_REVIEW, HUMAN_SHOT_SELECTION->COMPOSITING, FINAL_APPROVAL->VARIANT_GENERATION', () => {
    const gated = CAMPAIGN_TRANSITIONS.filter((t) => t.requiredApprovalGate !== undefined).map(
      (t) => ({
        from: t.from,
        to: t.to,
        gate: t.requiredApprovalGate,
      }),
    );
    expect(gated).toEqual([
      { from: 'CONCEPT_REVIEW', to: 'SCRIPT_REVIEW', gate: 'CONCEPT' },
      { from: 'HUMAN_SHOT_SELECTION', to: 'COMPOSITING', gate: 'SHOT_SELECTION' },
      { from: 'FINAL_APPROVAL', to: 'VARIANT_GENERATION', gate: 'FINAL' },
    ]);
  });

  it('STRATEGY_REVIEW and SCRIPT_REVIEW forward edges carry no approval gate', () => {
    const strategyForward = CAMPAIGN_TRANSITIONS.find(
      (t) => t.from === 'STRATEGY_REVIEW' && t.to === 'CONCEPT_REVIEW',
    );
    const scriptForward = CAMPAIGN_TRANSITIONS.find(
      (t) => t.from === 'SCRIPT_REVIEW' && t.to === 'ASSET_COLLECTION',
    );
    expect(strategyForward?.requiredApprovalGate).toBeUndefined();
    expect(scriptForward?.requiredApprovalGate).toBeUndefined();
  });

  it('no transition bypasses a mandatory gate: the only FORWARD edge into SCRIPT_REVIEW, COMPOSITING, and VARIANT_GENERATION is their gated edge', () => {
    // A REVISION edge back into the stage just downstream of a gate (e.g.
    // VARIANT_QA -> VARIANT_GENERATION) is not a bypass — VARIANT_GENERATION
    // itself is still only *first* reachable via the gate; this asserts no
    // edge skips the gate to enter from somewhere further upstream.
    const forwardInto = (stage: CampaignStage) =>
      CAMPAIGN_TRANSITIONS.filter((t) => t.to === stage && t.kind === 'FORWARD');
    expect(forwardInto('SCRIPT_REVIEW')).toEqual([
      expect.objectContaining({ from: 'CONCEPT_REVIEW', requiredApprovalGate: 'CONCEPT' }),
    ]);
    expect(forwardInto('COMPOSITING')).toEqual([
      expect.objectContaining({
        from: 'HUMAN_SHOT_SELECTION',
        requiredApprovalGate: 'SHOT_SELECTION',
      }),
    ]);
    expect(forwardInto('VARIANT_GENERATION')).toEqual([
      expect.objectContaining({ from: 'FINAL_APPROVAL', requiredApprovalGate: 'FINAL' }),
    ]);
  });
});

describe('performance stages are not part of this state machine', () => {
  it('CAMPAIGN_STAGES has exactly 20 stages and excludes PERFORMANCE_COLLECTION/ITERATION_PLANNING', () => {
    expect(CAMPAIGN_STAGES).toHaveLength(20);
    expect(CAMPAIGN_STAGES).not.toContain('PERFORMANCE_COLLECTION');
    expect(CAMPAIGN_STAGES).not.toContain('ITERATION_PLANNING');
  });

  it('DISTRIBUTED has no forward edge to any performance/iteration stage — the workflow can complete', () => {
    const outOfDistributed = CAMPAIGN_TRANSITIONS.filter((t) => t.from === 'DISTRIBUTED');
    expect(outOfDistributed).toEqual([
      expect.objectContaining({ to: 'READY_FOR_DISTRIBUTION', kind: 'REVISION' }),
    ]);
  });
});

describe('listValidNextStages', () => {
  it('matches the transition table for a sample of stages', () => {
    expect(listValidNextStages('DRAFT')).toEqual(['STRATEGY_REVIEW']);
    expect(listValidNextStages('VISUAL_QA')).toEqual(['CONTINUITY_QA', 'SHOT_GENERATION']);
    expect(listValidNextStages('DISTRIBUTED')).toEqual(['READY_FOR_DISTRIBUTION']);
  });

  it('every stage has at least one outgoing transition', () => {
    for (const stage of CAMPAIGN_STAGES) {
      expect(listValidNextStages(stage).length).toBeGreaterThan(0);
    }
  });
});
