import { describe, expect, it } from 'vitest';

import {
  CREATIVE_MEMORY_NOTICE,
  CREATIVE_MEMORY_USAGE_DIRECTIVE,
} from './creative-memory-injection';
import type { CreativeMemoryContext } from './creative-memory-injection';
import {
  evaluateOriginality,
  type OriginalityEvaluationEntry,
} from './creative-memory-originality';

/**
 * The originality evaluator, exercised on the things it actually claims to
 * detect. It is a governance signal, so the tests below check that each signal
 * fires on the case it names and, just as importantly, that ordinary compliant
 * output does not trip it.
 */

const REFERENCE_A = '11111111-1111-4111-8111-111111111111';
const REFERENCE_B = '44444444-4444-4444-8444-444444444444';

const PRINCIPLE =
  'A rapid vertical hype opening earns attention through cut density and crowd energy rather than through explanation.';

function item(referenceId: string, sceneDurations: number[], rank: number) {
  return {
    referenceId,
    annotationId: '22222222-2222-4222-8222-222222222222',
    annotationVersion: 1,
    sceneId: `3333333${rank}-3333-4333-8333-333333333333`,
    contributingRole: 'CAMPAIGN_STRATEGY' as const,
    retrievalScore: 0.8,
    rerankScore: 0.6,
    finalRank: rank,
    measurements: {
      advertisementDurationSeconds: 6,
      sceneDurationSeconds: 1,
      sceneCount: sceneDurations.length,
      cutsPerSecond: 0.83,
      aspectRatio: '9:16',
      pacing: 'FAST' as const,
      sceneDurationsSeconds: sceneDurations,
    },
    observations: { hookMechanism: 'Opens on crowd energy before any explanation is offered.' },
    craftPrinciple: PRINCIPLE,
    intendedApplication: 'Use as evidence about hook strategy.',
    riskWarning: 'Do not reproduce the execution directly.',
  };
}

function context(items: ReturnType<typeof item>[]): CreativeMemoryContext {
  return {
    contextVersion: 1,
    agentRole: 'SCRIPT_TIMING_DIRECTOR',
    planKey: 'SCRIPT_TIMING_DIRECTOR_CRAFT_V1',
    planVersion: 1,
    benchmarkProfileName: 'combat-reviews-benchmark',
    benchmarkProfileVersion: 1,
    retrievalProfile: 'STRUCTURAL_BASELINE_V1',
    rerankingProfile: 'structural-reranker',
    fallbackStatus: 'FALLBACK_STRUCTURAL_RERANKING',
    queryHash: 'a'.repeat(64),
    focusAreas: ['beat density'],
    items,
    usageDirective: CREATIVE_MEMORY_USAGE_DIRECTIVE,
    notice: CREATIVE_MEMORY_NOTICE,
  };
}

const DIVERGENCE = {
  agentRole: 'SCRIPT_TIMING_DIRECTOR' as const,
  principlesUsed: [{ referenceId: REFERENCE_A, principleSummary: 'measured cut density' }],
  campaignSpecificTransformation: 'Recomputed the beat plan for a 15s cut.',
  elementsDeliberatelyChanged: ['Beat count derived from this duration.'],
  prohibitedElementsAvoided: ['No wording reused.'],
  originalityRiskLevel: 'LOW' as const,
  rationale: 'Only measurements crossed over.',
};

function evaluate(overrides: Partial<OriginalityEvaluationEntry>) {
  return evaluateOriginality([
    {
      agentRole: 'SCRIPT_TIMING_DIRECTOR',
      context: context([item(REFERENCE_A, [1, 1, 1, 1, 1, 1], 1)]),
      divergence: DIVERGENCE,
      outputText: ['Open on arena energy.', 'Close on the download call to action.'],
      ...overrides,
    },
  ]);
}

describe('compliant output is LOW risk', () => {
  it('produces no signals and does not block', () => {
    const assessment = evaluate({});
    expect(assessment.signals).toEqual([]);
    expect(assessment.riskLevel).toBe('LOW');
    expect(assessment.blocked).toBe(false);
    expect(assessment.requiresHumanReview).toBe(false);
  });

  it('never claims to be a copyright assessment', () => {
    expect(evaluate({}).notice).toMatch(/Not a comprehensive copyright/i);
  });
});

describe('HIGH-risk signals block production planning', () => {
  it('detects an eight-word run reproduced from a reference craft note', () => {
    const assessment = evaluate({
      outputText: [`Our plan: ${PRINCIPLE}`],
    });
    expect(assessment.signals.map((signal) => signal.code)).toContain('COPIED_REFERENCE_PHRASE');
    expect(assessment.blocked).toBe(true);
  });

  it('does not fire on a short incidental overlap', () => {
    expect(evaluate({ outputText: ['cut density and crowd energy'] }).riskLevel).toBe('LOW');
  });

  it('detects a beat plan that reproduces a reference scene sequence exactly', () => {
    const assessment = evaluate({ beatDurationsSeconds: [1, 1, 1, 1, 1, 1] });
    expect(assessment.signals.map((signal) => signal.code)).toContain('IDENTICAL_BEAT_SEQUENCE');
    expect(assessment.blocked).toBe(true);
  });

  it('allows a beat plan of the same length with different lengths', () => {
    expect(evaluate({ beatDurationsSeconds: [0.8, 1.2, 1, 1, 1, 1] }).riskLevel).toBe('LOW');
  });

  it('detects an affirmative instruction to imitate an agency', () => {
    const assessment = evaluate({
      outputText: ['Shoot the opening in the style of their agency reel.'],
    });
    expect(assessment.signals.map((signal) => signal.code)).toContain('NAMED_AGENCY_IMITATION');
    expect(assessment.blocked).toBe(true);
  });

  it('does not flag an agent restating the prohibition it was given', () => {
    // Agents routinely echo their constraints. Punishing that would train the
    // model away from the behaviour the prompt asks for.
    expect(
      evaluate({ outputText: ['This concept does not imitate any agency or existing campaign.'] })
        .riskLevel,
    ).toBe('LOW');
  });

  it('detects a path or URL escaping into an output field', () => {
    const assessment = evaluate({ outputText: ['Match the framing in C:\\analysis\\hype.mp4'] });
    expect(assessment.signals.map((signal) => signal.code)).toContain('FORBIDDEN_FIELD_IN_OUTPUT');
    expect(assessment.blocked).toBe(true);
  });

  it('takes an agent at its word when it declares HIGH risk', () => {
    const assessment = evaluate({
      divergence: { ...DIVERGENCE, originalityRiskLevel: 'HIGH' },
    });
    expect(assessment.signals.map((signal) => signal.code)).toContain('AGENT_DECLARED_HIGH_RISK');
    expect(assessment.blocked).toBe(true);
  });
});

describe('MEDIUM-risk signals are recorded for review without blocking', () => {
  it('flags a missing divergence record when context was injected', () => {
    const assessment = evaluateOriginality([
      {
        agentRole: 'SCRIPT_TIMING_DIRECTOR',
        context: context([item(REFERENCE_A, [1, 1, 1, 1, 1, 1], 1)]),
        outputText: ['Open on arena energy.'],
      },
    ]);
    expect(assessment.signals.map((signal) => signal.code)).toContain('MISSING_DIVERGENCE_RECORD');
    expect(assessment.riskLevel).toBe('MEDIUM');
    expect(assessment.blocked).toBe(false);
    expect(assessment.requiresHumanReview).toBe(true);
  });

  it('flags dependence on one reference when the context offered more', () => {
    const assessment = evaluate({
      context: context([item(REFERENCE_A, [1, 1, 1, 1, 1, 1], 1), item(REFERENCE_B, [3, 3, 2], 2)]),
      divergence: {
        ...DIVERGENCE,
        principlesUsed: [
          { referenceId: REFERENCE_A, principleSummary: 'cut density' },
          { referenceId: REFERENCE_A, principleSummary: 'hook latency' },
        ],
      },
    });
    expect(assessment.signals.map((signal) => signal.code)).toContain('SINGLE_SOURCE_DEPENDENCE');
    expect(assessment.riskLevel).toBe('MEDIUM');
  });

  it('flags a citation of a reference that was never in the context', () => {
    const assessment = evaluate({
      divergence: {
        ...DIVERGENCE,
        principlesUsed: [{ referenceId: REFERENCE_B, principleSummary: 'invented' }],
      },
    });
    expect(assessment.signals.map((signal) => signal.code)).toContain('UNKNOWN_REFERENCE_CITED');
    expect(assessment.blocked).toBe(false);
  });
});

describe('roles that received no context', () => {
  it('are still checked for leaked expressive material', () => {
    const assessment = evaluateOriginality([
      {
        agentRole: 'CREATIVE_DIRECTOR',
        outputText: ['Grade it like https://example.com/spot.'],
      },
    ]);
    expect(assessment.signals.map((signal) => signal.code)).toContain('FORBIDDEN_FIELD_IN_OUTPUT');
  });

  it('are not asked for a divergence record they had nothing to diverge from', () => {
    const assessment = evaluateOriginality([
      { agentRole: 'CREATIVE_DIRECTOR', outputText: ['A clean, high-contrast vertical concept.'] },
    ]);
    expect(assessment.signals).toEqual([]);
    expect(assessment.rolesWithContext).toEqual([]);
  });
});
