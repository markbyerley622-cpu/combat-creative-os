import { describe, expect, it } from 'vitest';

import { AGENT_SAFE_FORBIDDEN_KEYS } from './creative-memory-retrieval';
import {
  assertAgentSafeContext,
  CREATIVE_MEMORY_AGENT_ROLES,
  CREATIVE_MEMORY_NOTICE,
  CREATIVE_MEMORY_USAGE_DIRECTIVE,
  CreativeDivergenceRecordSchema,
  CreativeMemoryContextSchema,
  findAgentSafetyViolations,
  UnsafeAgentContextError,
} from './creative-memory-injection';

/**
 * The agent-safe boundary, tested the way it is enforced: by walking a
 * serialised envelope rather than by trusting the type. Every case below is a
 * field a future change could plausibly add.
 */

const ITEM = {
  referenceId: '11111111-1111-4111-8111-111111111111',
  annotationId: '22222222-2222-4222-8222-222222222222',
  annotationVersion: 1,
  sceneId: '33333333-3333-4333-8333-333333333333',
  contributingRole: 'CAMPAIGN_STRATEGY' as const,
  retrievalScore: 0.8,
  rerankScore: 0.6,
  finalRank: 1,
  measurements: {
    advertisementDurationSeconds: 6,
    sceneDurationSeconds: 1,
    sceneCount: 6,
    cutsPerSecond: 0.83,
    aspectRatio: '9:16',
    pacing: 'FAST' as const,
    sceneDurationsSeconds: [1, 1, 1, 1, 1, 1],
  },
  observations: { hookMechanism: 'Opens on crowd energy before any explanation.' },
  craftPrinciple: 'Cut density can carry an opening that explanation would slow down.',
  intendedApplication: 'Use as evidence about hook strategy.',
  riskWarning: 'Do not copy their edit or reproduce the execution directly.',
};

const CONTEXT = {
  contextVersion: 1 as const,
  agentRole: 'CAMPAIGN_STRATEGIST' as const,
  planKey: 'CAMPAIGN_STRATEGIST_CRAFT_V1',
  planVersion: 1,
  benchmarkProfileName: 'combat-reviews-benchmark',
  benchmarkProfileVersion: 1,
  retrievalProfile: 'STRUCTURAL_BASELINE_V1' as const,
  rerankingProfile: 'structural-reranker',
  fallbackStatus: 'FALLBACK_STRUCTURAL_RERANKING' as const,
  queryHash: 'a'.repeat(64),
  focusAreas: ['hook strategy'],
  items: [ITEM],
  usageDirective: CREATIVE_MEMORY_USAGE_DIRECTIVE,
  notice: CREATIVE_MEMORY_NOTICE,
};

describe('the Creative Memory context envelope', () => {
  it('accepts a well-formed, role-scoped context', () => {
    expect(() => CreativeMemoryContextSchema.parse(CONTEXT)).not.toThrow();
  });

  it('is strict, so an unexpected field cannot ride along', () => {
    expect(() =>
      CreativeMemoryContextSchema.parse({ ...CONTEXT, sourceUrl: 'https://example.com/ad' }),
    ).toThrow();
  });

  it('requires the standing usage directive and the rights notice verbatim', () => {
    expect(() =>
      CreativeMemoryContextSchema.parse({ ...CONTEXT, usageDirective: 'do whatever' }),
    ).toThrow();
    expect(() =>
      CreativeMemoryContextSchema.parse({ ...CONTEXT, notice: 'retrieval grants rights' }),
    ).toThrow();
  });
});

describe('the agent-safe boundary fails closed', () => {
  it('passes a legitimate context', () => {
    expect(() => assertAgentSafeContext(CONTEXT, 'test context')).not.toThrow();
  });

  it.each(AGENT_SAFE_FORBIDDEN_KEYS.map((key) => [key]))(
    'rejects a "%s" key anywhere in the envelope',
    (key) => {
      const violations = findAgentSafetyViolations({
        ...CONTEXT,
        items: [{ ...ITEM, [key]: 'anything at all' }],
      });
      expect(violations.map((violation) => violation.reason)).toContain('FORBIDDEN_KEY');
    },
  );

  it.each([
    ['a Windows path', 'C:\\analysis\\combat-hype.mp4'],
    ['a POSIX path', '/home/analysis/reference'],
    ['a URL', 'See https://example.com/spot for the original.'],
    ['a media filename', 'derived from combat-hype.mp4'],
  ])('rejects %s in a value', (_label, value) => {
    const violations = findAgentSafetyViolations({
      ...CONTEXT,
      items: [{ ...ITEM, craftPrinciple: value }],
    });
    expect(violations.map((violation) => violation.reason)).toContain('FORBIDDEN_VALUE_PATTERN');
  });

  it('rejects an instruction to imitate an agency', () => {
    expect(() =>
      assertAgentSafeContext(
        {
          ...CONTEXT,
          items: [{ ...ITEM, craftPrinciple: 'Shoot it in the style of their agency reel.' }],
        },
        'test context',
      ),
    ).toThrow(UnsafeAgentContextError);
  });

  it('does not flag prohibition text, which necessarily names what it forbids', () => {
    // `riskWarning` and the usage directive exist to say "do not imitate".
    // Flagging them would fail closed on the safety machinery itself.
    expect(() => assertAgentSafeContext(CONTEXT, 'test context')).not.toThrow();
    expect(CONTEXT.items[0]?.riskWarning).toMatch(/copy their edit/i);
  });

  it('reports every violation, not just the first', () => {
    const violations = findAgentSafetyViolations({
      ...CONTEXT,
      items: [{ ...ITEM, path: 'C:\\x\\y.mp4', transcript: 'spoken words' }],
    });
    expect(violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the divergence record', () => {
  const RECORD = {
    agentRole: 'CAMPAIGN_STRATEGIST' as const,
    principlesUsed: [{ referenceId: ITEM.referenceId, principleSummary: 'measured cut density' }],
    campaignSpecificTransformation: 'Applied as a hook-latency budget for this brief.',
    elementsDeliberatelyChanged: ['Beat count recomputed for this duration.'],
    prohibitedElementsAvoided: ['No wording reused.'],
    originalityRiskLevel: 'LOW' as const,
    rationale: 'Only measurements crossed over.',
  };

  it('accepts a complete record', () => {
    expect(() => CreativeDivergenceRecordSchema.parse(RECORD)).not.toThrow();
  });

  it('requires a stated transformation and rationale', () => {
    expect(() =>
      CreativeDivergenceRecordSchema.parse({ ...RECORD, campaignSpecificTransformation: '' }),
    ).toThrow();
    expect(() => CreativeDivergenceRecordSchema.parse({ ...RECORD, rationale: '' })).toThrow();
  });

  it('covers exactly the four agent roles Creative Memory reaches', () => {
    expect([...CREATIVE_MEMORY_AGENT_ROLES]).toEqual([
      'CAMPAIGN_STRATEGIST',
      'CREATIVE_DIRECTOR',
      'SCRIPT_TIMING_DIRECTOR',
      'SHOT_PROMPT_ENGINEER',
    ]);
  });
});
