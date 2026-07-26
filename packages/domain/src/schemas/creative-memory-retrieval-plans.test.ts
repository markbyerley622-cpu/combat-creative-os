import { describe, expect, it } from 'vitest';

import { CREATIVE_MEMORY_AGENT_ROLES } from './creative-memory-injection';
import { MAX_QUERY_CHARACTERS } from './creative-memory-retrieval';
import {
  buildRetrievalQuery,
  CREATIVE_MEMORY_RETRIEVAL_PLANS,
  narrativeStageForBeat,
  type RetrievalPlanInputs,
} from './creative-memory-retrieval-plans';

const INPUTS: RetrievalPlanInputs = {
  campaignPrompt: 'Promote this weekend’s coverage. Hook on the number of events, then details.',
  factualConstraints: ['PRODUCT — Coverage: every promotion in one place'],
  objective: 'Drive installs',
  targetAudience: 'Fans who follow multiple promotions',
  brandSystem: 'primary #0B0B0F, accent #FF3B30, caption type Arial, 9:16 vertical',
  platform: 'TIKTOK',
  targetDurationSeconds: 15,
  ctaHeadline: 'Download Free',
  strategy: {
    positioning: 'Where a fight weekend is followed end to end.',
    targetAudienceSummary: 'Multi-promotion followers.',
    keyMessages: ['One card, one place.'],
    toneGuidelines: ['Direct.'],
  },
  concept: {
    logline: 'One weekend of fights.',
    visualDirection: 'Vertical, high contrast.',
    narrativeArc: 'Hook, weekend, app, CTA.',
  },
};

describe('the four retrieval plans are genuinely role-specific', () => {
  it('covers exactly the four Creative Memory agent roles', () => {
    expect(Object.keys(CREATIVE_MEMORY_RETRIEVAL_PLANS).sort()).toEqual(
      [...CREATIVE_MEMORY_AGENT_ROLES].sort(),
    );
  });

  it('gives each role a distinct plan key and focus set', () => {
    const plans = Object.values(CREATIVE_MEMORY_RETRIEVAL_PLANS);
    expect(new Set(plans.map((plan) => plan.planKey)).size).toBe(plans.length);
    expect(new Set(plans.map((plan) => plan.focusAreas.join('|'))).size).toBe(plans.length);
  });

  it('queries different Creative Memory roles per agent', () => {
    const roles = Object.values(CREATIVE_MEMORY_RETRIEVAL_PLANS).map((plan) =>
      [...plan.referenceRoles].sort().join('|'),
    );
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('permits different observation fields per agent', () => {
    const { CAMPAIGN_STRATEGIST, SHOT_PROMPT_ENGINEER } = CREATIVE_MEMORY_RETRIEVAL_PLANS;
    // The Strategist has no business being told how a camera moved, and the
    // Shot-Prompt Engineer has no business being told what the hook argued.
    expect(CAMPAIGN_STRATEGIST.permittedObservations).not.toContain('cameraMovement');
    expect(SHOT_PROMPT_ENGINEER.permittedObservations).not.toContain('hookMechanism');
    expect(SHOT_PROMPT_ENGINEER.permittedObservations).toContain('cameraMovement');
  });

  it('requires an approved, active profile in every plan', () => {
    for (const plan of Object.values(CREATIVE_MEMORY_RETRIEVAL_PLANS)) {
      expect(plan.minimumGovernanceStatus).toBe('APPROVED_AND_ACTIVE');
      expect(plan.tieBreak).toBe('RANK_THEN_REFERENCE_ID_THEN_SCENE_ID');
      expect(plan.fallbackBehaviour).toBe('CONTINUE_WITHOUT_CONTEXT');
    }
  });
});

describe('query construction', () => {
  it('is deterministic for the same plan and inputs', () => {
    const plan = CREATIVE_MEMORY_RETRIEVAL_PLANS.CAMPAIGN_STRATEGIST;
    expect(buildRetrievalQuery(plan, INPUTS).text).toBe(buildRetrievalQuery(plan, INPUTS).text);
  });

  it('produces a different query for a different campaign prompt', () => {
    const plan = CREATIVE_MEMORY_RETRIEVAL_PLANS.CAMPAIGN_STRATEGIST;
    const other = buildRetrievalQuery(plan, {
      ...INPUTS,
      campaignPrompt: 'Promote the prediction game. Hook on a disputed scorecard.',
    });
    expect(other.text).not.toBe(buildRetrievalQuery(plan, INPUTS).text);
  });

  it('produces a different query for each role from the same campaign', () => {
    const texts = Object.values(CREATIVE_MEMORY_RETRIEVAL_PLANS).map(
      (plan) =>
        buildRetrievalQuery(plan, {
          ...INPUTS,
          shot: { index: 0, description: 'Open on arena energy.', beat: 'HOOK' },
        }).text,
    );
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('records inputs a plan asked for but did not receive', () => {
    const plan = CREATIVE_MEMORY_RETRIEVAL_PLANS.SCRIPT_TIMING_DIRECTOR;
    const { concept: _dropped, ...withoutConcept } = INPUTS;
    expect(buildRetrievalQuery(plan, withoutConcept).missingInputs).toContain('CONCEPT_OUTPUT');
  });

  it('never exceeds the query ceiling', () => {
    const plan = CREATIVE_MEMORY_RETRIEVAL_PLANS.CREATIVE_DIRECTOR;
    const built = buildRetrievalQuery(plan, { ...INPUTS, campaignPrompt: 'x'.repeat(8000) });
    expect(built.text.length).toBeLessThanOrEqual(MAX_QUERY_CHARACTERS);
  });

  it('derives the narrative stage from the shot beat when one is supplied', () => {
    const plan = CREATIVE_MEMORY_RETRIEVAL_PLANS.SHOT_PROMPT_ENGINEER;
    expect(
      buildRetrievalQuery(plan, {
        ...INPUTS,
        shot: { index: 3, description: 'Close on the CTA.', beat: 'CTA' },
      }).narrativeStage,
    ).toBe('CALL_TO_ACTION');
  });

  it('maps every scripted beat onto a narrative stage', () => {
    expect(narrativeStageForBeat('HOOK')).toBe('HOOK');
    expect(narrativeStageForBeat('PROMISE')).toBe('SETUP');
    expect(narrativeStageForBeat('FEATURE')).toBe('DEMONSTRATION');
    expect(narrativeStageForBeat('CTA')).toBe('CALL_TO_ACTION');
  });
});
