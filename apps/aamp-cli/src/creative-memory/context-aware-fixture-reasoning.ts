import type {
  CreativeDivergenceRecord,
  CreativeMemoryAgentRole,
  CreativeMemoryContext,
} from '@combat/domain';
import type {
  ReasoningInvokeInput,
  ReasoningModelMeta,
  ReasoningProvider,
} from '@combat/providers';

/**
 * A deterministic reasoning provider that actually *reads* the Creative Memory
 * context it is given.
 *
 * It exists to answer one question honestly: does injecting benchmark
 * intelligence change the campaign, or only the paperwork? The committed
 * fixture provider cannot answer it — it replays golden results and ignores its
 * input entirely — so an ON/OFF comparison driven by that provider would show
 * an identical plan and prove nothing.
 *
 * Every output below is a pure function of the agent's input. When
 * `creativeMemory` is absent it produces a plain baseline; when present it
 * derives the hook latency, the beat count, the transition mechanic and the
 * shot specification from the context's **measurements**, and returns a
 * divergence record. That is the same shape of influence a real model would
 * have, made deterministic so a test can assert it.
 *
 * **This is not creative quality.** It is a mechanism demonstration. It says
 * nothing about whether a real model would use the context well, and it must
 * never be presented as a campaign result — it lives in `apps/aamp-cli`,
 * outside `packages/providers`, so no worker configuration value can select it.
 *
 * It deliberately derives from numbers and enums rather than echoing any
 * retrieved prose. Reproducing a reviewer's wording is exactly what the
 * originality evaluator blocks, and a demonstration fixture that tripped its
 * own governance check would be testing the wrong thing.
 */

export const CONTEXT_AWARE_FIXTURE_MODEL = 'deterministic-context-aware-fixture';

interface AgentEnvelope {
  readonly input: Record<string, unknown>;
}

function parseEnvelope(input: ReasoningInvokeInput): AgentEnvelope {
  const first = input.messages[0];
  const raw = typeof first?.content === 'string' ? first.content : '{}';
  const parsed = JSON.parse(raw) as { input?: Record<string, unknown> };
  return { input: parsed.input ?? {} };
}

function contextOf(input: Record<string, unknown>): CreativeMemoryContext | undefined {
  const value = input.creativeMemory;
  return value && typeof value === 'object' ? (value as CreativeMemoryContext) : undefined;
}

/**
 * The divergence record this fixture returns.
 *
 * Written in the fixture's own words and expressed as measurements, so it
 * demonstrates a transformation rather than a restatement — which is what the
 * evaluator is looking for.
 */
function divergenceFor(
  agentRole: CreativeMemoryAgentRole,
  context: CreativeMemoryContext,
  transformation: string,
  changed: readonly string[],
): CreativeDivergenceRecord {
  return {
    agentRole,
    principlesUsed: context.items.map((item) => ({
      referenceId: item.referenceId,
      principleSummary: `Structural evidence at rank ${item.finalRank}: ${item.measurements.pacing} pacing, ${item.measurements.cutsPerSecond.toFixed(2)} cuts per second over ${item.measurements.advertisementDurationSeconds}s.`,
    })),
    campaignSpecificTransformation: transformation,
    elementsDeliberatelyChanged: [...changed],
    prohibitedElementsAvoided: [
      'No reference wording was reused; every derived value came from a measurement.',
      'The beat sequence was recomputed for this campaign duration rather than replayed.',
      'No agency, studio or existing campaign was named.',
    ],
    originalityRiskLevel: 'LOW',
    rationale:
      'Only numeric craft measurements crossed into this output, and each was recomputed against this campaign’s own duration and brief.',
  };
}

/** Top-ranked item, which is the one the derivations key off. */
function lead(context: CreativeMemoryContext): CreativeMemoryContext['items'][number] {
  return context.items[0] as CreativeMemoryContext['items'][number];
}

function strategistResult(input: Record<string, unknown>): Record<string, unknown> {
  const context = contextOf(input);
  const brand = String(input.brandName ?? 'the brand');
  const baseMessages = [
    'Every fight on one card, in one place.',
    'Predictions and scorecards the community argues over.',
  ];

  if (!context) {
    return {
      audienceProfile: {
        name: 'Combat sports followers',
        demographics: {},
        psychographics: {},
        painPoints: ['Coverage is scattered across too many places.'],
        platformBehavior: {},
      },
      strategy: {
        positioning: `${brand} is where a fight weekend is followed end to end.`,
        targetAudienceSummary: 'Fans who follow multiple promotions and argue about results.',
        keyMessages: baseMessages,
        toneGuidelines: ['Direct, short sentences.', 'No jargon.'],
      },
    };
  }

  const item = lead(context);
  const hookLatency = item.measurements.firstCutSeconds ?? item.measurements.sceneDurationSeconds;
  return {
    audienceProfile: {
      name: 'Combat sports followers',
      demographics: {},
      psychographics: {},
      painPoints: [
        'Coverage is scattered across too many places.',
        'The first seconds of most feed video say nothing.',
      ],
      platformBehavior: {},
    },
    strategy: {
      positioning: `${brand} is where a fight weekend is followed end to end.`,
      targetAudienceSummary: 'Fans who follow multiple promotions and argue about results.',
      keyMessages: [
        `Land the proposition inside the first ${hookLatency.toFixed(1)} seconds, before the first cut.`,
        ...baseMessages,
      ],
      toneGuidelines: [
        'Direct, short sentences.',
        'No jargon.',
        `Sustain a ${item.measurements.pacing.toLowerCase()} rhythm throughout.`,
      ],
    },
    creativeMemoryDivergence: divergenceFor(
      'CAMPAIGN_STRATEGIST',
      context,
      `Hook strategy was set to a ${hookLatency.toFixed(1)}s proposition window, derived from measured first-cut latency and applied to this campaign's own facts.`,
      ['Added a measured hook-latency constraint that the baseline strategy did not carry.'],
    ),
  };
}

function directorResult(input: Record<string, unknown>): Record<string, unknown> {
  const context = contextOf(input);
  const base = {
    logline: 'One weekend of fights, followed from first bell to final scorecard.',
    narrativeArc: 'Hook, then the weekend, then the app, then the call to act.',
    referenceNotes: [],
  };

  if (!context) {
    return {
      ...base,
      visualDirection:
        'Vertical 9:16 throughout. High-contrast arena footage against clean app screens.',
    };
  }

  const item = lead(context);
  return {
    ...base,
    visualDirection: `Vertical 9:16 throughout. High-contrast arena footage against clean app screens. Attention pattern: ${item.measurements.pacing.toLowerCase()} cutting at roughly ${item.measurements.cutsPerSecond.toFixed(2)} cuts per second, hierarchy led by one readable line per beat.`,
    creativeMemoryDivergence: divergenceFor(
      'CREATIVE_DIRECTOR',
      context,
      'Pacing philosophy was expressed as an explicit cut-rate target for this concept rather than as an adjective.',
      ['Made the attention pattern numeric and checkable by a later stage.'],
    ),
  };
}

/**
 * Distributes `totalFrames` across `beats`, front-loading the hook.
 *
 * The hook gets the shortest slot and the remainder is spread evenly with the
 * rounding difference landing on the last beat, so the frames always sum
 * exactly — a script whose beats do not add up is rejected downstream, and
 * silently absorbing the difference somewhere in the middle would hide it.
 */
function distributeFrames(totalFrames: number, beats: number, hookFrames: number): number[] {
  const remaining = totalFrames - hookFrames;
  const each = Math.floor(remaining / (beats - 1));
  const frames = [hookFrames];
  for (let index = 1; index < beats; index += 1) {
    frames.push(index === beats - 1 ? remaining - each * (beats - 2) : each);
  }
  return frames;
}

function scriptResult(input: Record<string, unknown>): Record<string, unknown> {
  const context = contextOf(input);
  const frameRate = Number(input.frameRate ?? 30);
  const durations = (input.targetDurationsSeconds as number[] | undefined) ?? [15];
  const totalSeconds = durations[0] ?? 15;
  const totalFrames = Math.round(totalSeconds * frameRate);

  const beatNames = (count: number): string[] => {
    const names = ['HOOK', 'PROMISE'];
    while (names.length < count - 1) names.push('FEATURE');
    names.push('CTA');
    return names.slice(0, count);
  };

  const describe = (beat: string, index: number): string => {
    switch (beat) {
      case 'HOOK':
        return 'Open on arena energy with the weekend proposition on screen.';
      case 'PROMISE':
        return 'Show the weekend’s card laid out in one view.';
      case 'CTA':
        return 'Close on the download call to action.';
      default:
        return `Show app screen ${index} carrying one informational point.`;
    }
  };

  const build = (count: number, hookFrames: number): Record<string, unknown> => {
    const names = beatNames(count);
    const frames = distributeFrames(totalFrames, count, hookFrames);
    return {
      totalDurationFrames: totalFrames,
      shots: names.map((beat, index) => ({
        index,
        description: describe(beat, index),
        durationFrames: frames[index] as number,
        beat,
        dependsOnShotIndices: [],
      })),
    };
  };

  if (!context) return build(4, Math.round(totalSeconds * frameRate * 0.25));

  const item = lead(context);
  // Beat count from the measured cut rate, bounded so a very fast reference
  // cannot produce a cut nobody can read. Recomputed against *this* campaign's
  // duration, so it is never the reference's own sequence replayed.
  const beats = Math.min(
    8,
    Math.max(3, Math.round(item.measurements.cutsPerSecond * totalSeconds) + 1),
  );
  const hookSeconds = Math.max(0.6, item.measurements.firstCutSeconds ?? 1);
  return {
    ...build(beats, Math.round(hookSeconds * frameRate)),
    creativeMemoryDivergence: divergenceFor(
      'SCRIPT_TIMING_DIRECTOR',
      context,
      `Beat count and hook length were recomputed for a ${totalSeconds}s cut from the measured cut rate and first-cut latency, producing ${beats} beats specific to this brief.`,
      [
        'Beat lengths were derived for this duration rather than taken from any reference sequence.',
        'The hook slot was shortened relative to the baseline plan.',
      ],
    ),
  };
}

function shotResult(input: Record<string, unknown>): Record<string, unknown> {
  const context = contextOf(input);
  const shot = (input.shot ?? {}) as { index?: number; description?: string };
  const base = {
    providerId: String(input.providerId ?? 'source-library'),
    promptText: `Vertical 9:16 shot ${shot.index ?? 0}: ${shot.description ?? 'campaign beat'}`,
    params: {},
    visualObjective: shot.description ?? 'Carry this beat clearly.',
    action: 'The beat plays out in frame.',
    subject: 'Combat sports content',
    environment: 'Arena or app interface',
    lensFraming: 'Vertical medium',
    lighting: 'High contrast',
    colorTreatment: 'Cool neutral',
    textSafeAreas: [],
    continuityRequirements: [],
    qualityRubric: [],
  };

  if (!context) {
    return {
      ...base,
      cameraMovement: 'static',
      motionIntensity: 'LOW',
      transitionIn: 'CUT',
      transitionOut: 'CUT',
    };
  }

  const item = lead(context);
  // The reviewer's transition wording never reaches the output: it is mapped
  // onto this system's own enum, which is both safe and actually usable by the
  // renderer.
  const category = (item.observations.transitionCategory ?? '').toLowerCase();
  const dissolve = category.includes('fade') || category.includes('dissolve');
  const impact = category.includes('impact') || category.includes('hard');

  return {
    ...base,
    promptText: `${base.promptText}; ${item.measurements.pacing.toLowerCase()} rhythm, ${item.measurements.cutsPerSecond.toFixed(2)} cuts per second reference rate`,
    cameraMovement: impact ? 'fast push in' : dissolve ? 'slow drift' : 'static',
    motionIntensity: impact ? 'HIGH' : dissolve ? 'LOW' : 'MEDIUM',
    transitionIn: dissolve ? 'DISSOLVE' : 'CUT',
    transitionOut: dissolve ? 'DISSOLVE' : 'CUT',
    creativeMemoryDivergence: divergenceFor(
      'SHOT_PROMPT_ENGINEER',
      context,
      `Transition mechanic and motion intensity were chosen for this beat from the reference's transition category, expressed in this system's own transition vocabulary.`,
      [
        'Camera movement and motion intensity differ from the baseline static specification.',
        'No reference framing or frame content was described.',
      ],
    ),
  };
}

/**
 * Dispatches on the input's own shape rather than on a call counter, so the
 * provider stays correct when the pipeline briefs a different number of shots.
 */
function resultFor(input: Record<string, unknown>): Record<string, unknown> {
  if ('shot' in input) return shotResult(input);
  if ('logline' in input) return scriptResult(input);
  if ('strategy' in input) return directorResult(input);
  return strategistResult(input);
}

export class ContextAwareFixtureReasoningProvider implements ReasoningProvider {
  readonly name = 'context-aware-fixture-reasoning';
  readonly calls: ReasoningInvokeInput[] = [];

  async invoke(
    input: ReasoningInvokeInput,
  ): Promise<{ raw: string; modelMeta: ReasoningModelMeta }> {
    this.calls.push(input);
    const { input: agentInput } = parseEnvelope(input);
    return {
      raw: JSON.stringify({
        result: resultFor(agentInput),
        reasoning: { facts: [], decisions: [], assumptions: [], recommendations: [] },
      }),
      modelMeta: {
        model: CONTEXT_AWARE_FIXTURE_MODEL,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
      },
    };
  }
}
