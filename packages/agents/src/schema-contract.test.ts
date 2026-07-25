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
      audienceProfile: {
        name: 'fans',
        demographics: {},
        psychographics: {},
        painPoints: ['x'],
        platformBehavior: {},
      },
      strategy: {
        positioning: 'p',
        targetAudienceSummary: 't',
        keyMessages: ['a'],
        toneGuidelines: ['b'],
      },
    },
  },
  'creative-director': {
    input: {
      brandName: 'Combat Reviews',
      strategy: {
        positioning: 'p',
        targetAudienceSummary: 't',
        keyMessages: ['a'],
        toneGuidelines: ['b'],
      },
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
      shots: [
        { index: 0, description: 'd', durationFrames: 30, beat: 'HOOK', dependsOnShotIndices: [] },
      ],
    },
  },
  'shot-prompt-engineer': {
    input: {
      shot: { index: 0, description: 'd', durationFrames: 30 },
      visualDirection: 'v',
      providerId: 'mock',
    },
    result: {
      providerId: 'mock',
      promptText: 'prompt',
      params: {},
      visualObjective: 'o',
      action: 'a',
      subject: 's',
      environment: 'e',
      cameraMovement: 'static',
      lensFraming: 'wide',
      lighting: 'soft',
      colorTreatment: 'neutral',
      motionIntensity: 'LOW',
      transitionIn: 'CUT',
      transitionOut: 'CUT',
    },
  },
  'visual-quality-controller': {
    input: {
      shot: { index: 0, description: 'd', durationFrames: 30 },
      providerId: 'mock',
      candidateRef: 'c1',
      frameCount: 3,
    },
    result: {
      criterionScores: [{ criterionId: 'subject-fidelity', pass: true, score: 1 }],
      findings: [],
    },
  },
  'continuity-controller': {
    input: {
      scriptShots: [{ index: 0, description: 'd' }],
      selectedCandidateSummaries: [{ shotIndex: 0, providerId: 'mock', visualSummary: 's' }],
    },
    result: {
      criterionScores: [{ criterionId: 'visual-consistency', pass: true, score: 1 }],
      conflicts: [],
    },
  },
  'edit-director': {
    input: {
      frameRate: 30,
      aspectRatio: '9:16',
      platform: 'INSTAGRAM_REELS',
      targetTotalDurationFrames: 30,
      brandTokens: ['#0A0A0A'],
      selectedShots: [
        {
          shotIndex: 0,
          beat: 'HOOK',
          description: 'Boxer throws a jab',
          durationFrames: 30,
          sourceAssetRef: 'asset-0',
        },
      ],
    },
    result: {
      frameRate: 30,
      durationFrames: 30,
      entries: [
        {
          shotIndex: 0,
          order: 0,
          startFrame: 0,
          durationFrames: 30,
          sourceInFrame: 0,
          sourceOutFrame: 30,
          transitionIn: 'CUT',
        },
      ],
      pacingNotes: 'fast',
      overlays: [{ kind: 'CTA', shotIndex: 0, description: 'Sign up' }],
      captionPlaceholder: 'captions TBD',
      musicPlaceholder: 'music TBD',
      sfxPlaceholder: 'sfx TBD',
      editRationale: 'hook first',
    },
  },
  'sound-director': {
    input: {
      frameRate: 30,
      durationFrames: 30,
      timelineEntries: [{ shotIndex: 0, startFrame: 0, durationFrames: 30 }],
      brandAudioGuidelines: [],
    },
    result: {
      musicBrief: 'm',
      mixNotes: 'n',
      cues: [{ type: 'MUSIC', startFrame: 0, durationFrames: 30 }],
    },
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
    result: {
      criterionScores: [{ criterionId: 'technical-delivery-spec', pass: true, score: 1 }],
      findings: [],
    },
  },
  'variant-generator': {
    input: {
      masterDurationFrames: 450,
      frameRate: 30,
      targetDurationSeconds: 6,
      platform: 'TIKTOK',
      aspectRatio: '9:16',
      resolutionWidth: 1080,
      resolutionHeight: 1920,
      timelineSegments: [
        {
          order: 0,
          shotId: '00000000-0000-0000-0000-000000000001',
          shotIndex: 0,
          description: 'Hook',
          beat: 'HOOK',
          startFrame: 0,
          endFrame: 180,
        },
        {
          order: 1,
          shotId: '00000000-0000-0000-0000-000000000002',
          shotIndex: 1,
          description: 'CTA',
          beat: 'CTA',
          startFrame: 180,
          endFrame: 450,
        },
      ],
      discreteAudioCues: [],
      captionSegments: [],
      captionBurnRequired: true,
      safeAreas: ['BOTTOM'],
    },
    result: {
      targetDurationSeconds: 6,
      cutPoints: [{ order: 0, sourceStartFrame: 0, sourceEndFrame: 180, variantStartFrame: 0 }],
      retainedShotIds: ['00000000-0000-0000-0000-000000000001'],
      retainedCaptions: [
        { text: 'Hook line', variantStartFrame: 0, variantEndFrame: 180, safeArea: 'BOTTOM' },
      ],
      ctaPlacement: { present: false },
      cutRationale: 'Kept the hook; the 6s target is exempt from the CTA rule.',
      removedRationale: ['Dropped the CTA segment to hit 6s.'],
      qualityRubric: [],
    },
  },
  'performance-analyst': {
    input: {
      observations: [
        {
          observationId: '00000000-0000-0000-0000-0000000000a1',
          platform: 'TIKTOK',
          durationSeconds: 15,
          periodStart: '2026-07-18T00:00:00.000Z',
          periodEnd: '2026-07-25T00:00:00.000Z',
          impressions: 30000,
          clicks: 1500,
          conversions: 90,
          spendCents: 60000,
          clickThroughRate: 0.05,
          conversionRate: 0.06,
        },
      ],
    },
    result: {
      learnings: [
        {
          learningKey: 'short-hook-holds-attention',
          insight: 'The 15s TikTok cut reached a 5% click-through rate across 30000 impressions.',
          appliesTo: 'strategy',
          tags: ['hook'],
          platforms: ['TIKTOK'],
          durationsSeconds: [15],
          evidenceObservationIds: ['00000000-0000-0000-0000-0000000000a1'],
        },
      ],
    },
  },
};

describe('agent schema contracts', () => {
  const implementedNames = Object.keys(VALID_SAMPLES) as SpecialistAgentName[];

  it('covers every implemented agent with a valid sample', () => {
    const implemented = Object.values(AGENT_REGISTRY)
      .filter((d) => d.implemented)
      .map((d) => d.name);
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
