import { describe, expect, it } from 'vitest';
import { AGENT_REGISTRY, type SpecialistAgentName } from './registry';

/**
 * One valid input+result sample per implemented agent, used to prove every
 * agent's schemas accept a well-formed payload. Kept intentionally minimal
 * (not tied to the Combat Reviews fixture — see `handoff.test.ts` for the
 * end-to-end golden-fixture path) so this file stays a fast, focused schema
 * contract check.
 */
const VALID_SAMPLES: Partial<Record<SpecialistAgentName, { input: unknown; result: unknown }>> = {
  'campaign-strategist': {
    input: {
      brandName: 'Combat Reviews',
      objective: 'Drive installs',
      targetPlatforms: ['TIKTOK'],
      durationsSeconds: [15],
      budgetCents: 1000,
      keyMessages: [],
      mandatories: [],
      priorLearnings: [],
    },
    result: {
      audienceProfile: { name: 'fans', demographics: {}, psychographics: {}, painPoints: ['x'], platformBehavior: {} },
      strategy: { positioning: 'p', targetAudienceSummary: 't', keyMessages: ['a'], toneGuidelines: ['b'] },
    },
  },
  'creative-director': {
    input: {
      brandName: 'Combat Reviews',
      strategy: { positioning: 'p', targetAudienceSummary: 't', keyMessages: ['a'], toneGuidelines: ['b'] },
      mandatories: [],
      durationsSeconds: [15],
    },
    result: { logline: 'l', visualDirection: 'v', narrativeArc: 'n', referenceNotes: [] },
  },
  'script-timing-director': {
    input: {
      logline: 'l',
      visualDirection: 'v',
      narrativeArc: 'n',
      targetDurationsSeconds: [15],
      keyMessages: [],
      callToAction: 'Download Free',
      frameRate: 30,
    },
    result: {
      totalDurationFrames: 30,
      shots: [{ index: 0, description: 'd', durationFrames: 30, beat: 'HOOK', dependsOnShotIndices: [] }],
    },
  },
  'shot-prompt-engineer': {
    input: { shot: { index: 0, description: 'd', durationFrames: 30 }, visualDirection: 'v', providerId: 'mock' },
    result: { providerId: 'mock', promptText: 'prompt', params: {} },
  },
  'visual-quality-controller': {
    input: { shot: { index: 0, description: 'd', durationFrames: 30 }, providerId: 'mock', candidateRef: 'c1', frameCount: 3 },
    result: { criterionScores: [{ criterionId: 'subject-fidelity', pass: true, score: 1 }], findings: [] },
  },
  'continuity-controller': {
    input: {
      scriptShots: [{ index: 0, description: 'd' }],
      selectedCandidateSummaries: [{ shotIndex: 0, providerId: 'mock', visualSummary: 's' }],
    },
    result: { criterionScores: [{ criterionId: 'visual-consistency', pass: true, score: 1 }], conflicts: [] },
  },
  'edit-director': {
    input: {
      frameRate: 30,
      selectedShots: [{ shotIndex: 0, durationFrames: 30 }],
      targetTotalDurationFrames: 30,
    },
    result: { frameRate: 30, durationFrames: 30, entries: [{ shotIndex: 0, order: 0, startFrame: 0, durationFrames: 30 }] },
  },
  'sound-director': {
    input: {
      frameRate: 30,
      durationFrames: 30,
      timelineEntries: [{ shotIndex: 0, startFrame: 0, durationFrames: 30 }],
      brandAudioGuidelines: [],
    },
    result: { musicBrief: 'm', mixNotes: 'n', cues: [{ type: 'MUSIC', startFrame: 0, durationFrames: 30 }] },
  },
  'final-qa-controller': {
    input: {
      technicalProbe: {
        durationSeconds: 15,
        resolutionWidth: 1080,
        resolutionHeight: 1920,
        integratedLoudnessLufs: -14,
        hasBurnedInCaptions: true,
      },
      deliverySpecification: {
        platform: 'TIKTOK',
        aspectRatio: '9:16',
        durationSeconds: 15,
        captionBurnRequired: true,
        targetLoudnessLufs: -14,
      },
    },
    result: { criterionScores: [{ criterionId: 'technical-delivery-spec', pass: true, score: 1 }], findings: [] },
  },
  'variant-generator': {
    input: {
      finalMasterDurationFrames: 450,
      frameRate: 30,
      deliverySpecificationId: '00000000-0000-0000-0000-000000000000',
      targetDurationSeconds: 6,
      platform: 'TIKTOK',
      mustKeepFrameRanges: [],
    },
    result: { durationSeconds: 6, cutPoints: [{ startFrame: 0, endFrame: 180 }] },
  },
  'performance-analyst': {
    input: {
      metrics: [
        { platform: 'TIKTOK', impressions: 1000, clicks: 50, conversions: 5, spendCents: 2000, ctr: 0.05 },
      ],
    },
    result: { learnings: [{ insight: 'TikTok outperformed on CTR', appliesTo: 'strategy', tags: ['tiktok'] }] },
  },
};

describe('agent schema contracts', () => {
  const implementedNames = Object.keys(VALID_SAMPLES) as SpecialistAgentName[];

  it('covers every implemented agent with a valid sample', () => {
    const implemented = Object.values(AGENT_REGISTRY).filter((d) => d.implemented).map((d) => d.name);
    expect(implementedNames.sort()).toEqual([...implemented].sort());
  });

  it.each(implementedNames)('%s accepts its valid input and result sample', (name) => {
    const definition = AGENT_REGISTRY[name];
    const sample = VALID_SAMPLES[name]!;
    expect(definition.inputSchema.safeParse(sample.input).success).toBe(true);
    expect(definition.resultSchema.safeParse(sample.result).success).toBe(true);
  });

  it.each(implementedNames)('%s rejects an empty object as input', (name) => {
    const definition = AGENT_REGISTRY[name];
    expect(definition.inputSchema.safeParse({}).success).toBe(false);
  });

  it.each(implementedNames)('%s rejects an empty object as result', (name) => {
    const definition = AGENT_REGISTRY[name];
    expect(definition.resultSchema.safeParse({}).success).toBe(false);
  });
});
