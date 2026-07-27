import type {
  CampaignStrategistResult,
  CreativeDirectorResult,
  ScriptTimingDirectorResult,
  ShotPromptEngineerResult,
} from '@combat/agents';

import type { CampaignPlan } from '../plan-campaign';
import type { ScriptedShot } from '../source-selection';
import { HUMAN_PLAN_VERSION, type HumanCreativePlan } from './human-plan';

/**
 * Projects a human-authored plan onto the shape the rest of the pipeline
 * already speaks.
 *
 * `CampaignPlan` is what originality evaluation, the run's `agent-outputs.json`
 * and the provenance record all consume. Rebuilding those three around a second
 * plan shape would be a parallel pipeline; projecting once, here, means the
 * originality gate, the artefacts and the reports work on a human plan exactly
 * as they work on a model's.
 *
 * **No reasoning provider is touched.** This is a total function from a
 * validated plan to a validated shape — no I/O, no clock, no randomness. That
 * is the mechanism behind "zero reasoning calls": there is no code path from
 * here to a provider, so there is nothing to remember not to call.
 *
 * `agentVersions` records `human-plan@v1` rather than an agent name, because
 * no agent ran. Writing a plausible agent version here would make the run
 * indistinguishable from a planned one in exactly the artefact a reviewer
 * checks first.
 */

export const HUMAN_PLAN_AGENT_VERSION = `human-plan@v${HUMAN_PLAN_VERSION}` as const;

const FRAME_RATE = 30;

/**
 * How a beat's motion maps onto the coarse intensity the shot brief carries.
 *
 * The brief's `motionIntensity` is a four-value vocabulary shared with the
 * generation providers; the catalogue's is a continuous 0–1. This is the
 * documented lossy edge between them, kept in one place rather than inferred
 * at each use.
 */
export function coarseMotionIntensity(
  treatment: string,
  intensity: number,
): 'STATIC' | 'LOW' | 'MEDIUM' | 'HIGH' {
  if (treatment === 'STATIC_HOLD' || intensity === 0) return 'STATIC';
  if (intensity < 0.34) return 'LOW';
  if (intensity < 0.67) return 'MEDIUM';
  return 'HIGH';
}

/** The catalogue's transition vocabulary, in the brief's coarser one. */
export function coarseTransition(
  kind: string | undefined,
): 'CUT' | 'DISSOLVE' | 'WIPE' | 'FADE_IN' | 'FADE_OUT' {
  switch (kind) {
    case 'CROSSFADE':
      return 'DISSOLVE';
    case 'DIP_TO_BLACK':
      return 'FADE_OUT';
    case 'MASKED_UI_REVEAL':
      return 'WIPE';
    case 'WHIP_PAN':
      return 'WIPE';
    case undefined:
      return 'FADE_IN';
    default:
      return 'CUT';
  }
}

/** The scripted beat vocabulary the existing selector and manifest builder use. */
function scriptedBeatFor(role: string): string {
  switch (role) {
    case 'HOOK':
      return 'HOOK';
    case 'CTA':
      return 'CTA';
    case 'EVENT_DETAIL':
      return 'PROMISE';
    default:
      return 'FEATURE';
  }
}

export function projectHumanPlan(plan: HumanCreativePlan): CampaignPlan {
  const strategy: CampaignStrategistResult = {
    audienceProfile: {
      name: plan.strategy.audienceName,
      demographics: {},
      psychographics: {},
      painPoints: [...plan.strategy.painPoints],
      platformBehavior: {},
    },
    strategy: {
      positioning: plan.strategy.positioning,
      targetAudienceSummary: plan.strategy.targetAudienceSummary,
      keyMessages: [...plan.strategy.keyMessages],
      toneGuidelines: [...plan.strategy.toneGuidelines],
    },
  };

  const concept: CreativeDirectorResult = {
    logline: plan.creativeDirection.logline,
    visualDirection: plan.creativeDirection.visualDirection,
    narrativeArc: plan.creativeDirection.narrativeArc,
    referenceNotes: [...plan.creativeDirection.referenceNotes],
  };

  const script: ScriptTimingDirectorResult = {
    totalDurationFrames: Math.round(plan.targetDurationSeconds * FRAME_RATE),
    shots: plan.beats.map((beat) => ({
      index: beat.index,
      description: beat.description,
      durationFrames: Math.round(beat.durationSeconds * FRAME_RATE),
      beat: scriptedBeatFor(beat.role) as 'HOOK' | 'PROMISE' | 'FEATURE' | 'CTA',
      dependsOnShotIndices: [],
    })),
  };

  const shots: ScriptedShot[] = plan.beats.map((beat) => ({
    index: beat.index,
    description: beat.description,
    durationSeconds: beat.durationSeconds,
    beat: scriptedBeatFor(beat.role),
  }));

  const shotBriefs: ShotPromptEngineerResult[] = plan.beats.map((beat) => ({
    // `source-library` and never a generation provider id: nothing here is a
    // prompt for a model, and labelling it as one would be the beginning of a
    // path to sending it to one.
    providerId: 'source-library',
    promptText: beat.description,
    params: {},
    visualObjective: beat.caption?.text ?? beat.description,
    action: beat.description,
    subject: `${beat.role} beat from the human-authored plan`,
    environment: plan.creativeDirection.visualDirection,
    cameraMovement: `${beat.motion.treatment} at intensity ${beat.motion.intensity}`,
    lensFraming: '9:16 vertical, cover framing',
    lighting: 'as captured in the owned source material',
    colorTreatment: `brand primary ${plan.brandConstraints.primaryColorHex}, accent ${plan.brandConstraints.accentColorHex}`,
    motionIntensity: coarseMotionIntensity(beat.motion.treatment, beat.motion.intensity),
    transitionIn: coarseTransition(beat.transitionIn?.kind),
    transitionOut: 'CUT',
    textSafeAreas: ['TOP', 'BOTTOM'],
    continuityRequirements: [],
    qualityRubric: [],
  }));

  const captionLines = plan.beats.map((beat) => beat.caption?.text ?? '');

  return {
    strategy,
    concept,
    script,
    shots,
    shotBriefs,
    captionLines,
    agentVersions: [HUMAN_PLAN_AGENT_VERSION],
    // No Creative Memory context was resolved, because no agent was invoked.
    // An empty list is the accurate record; a fabricated entry would claim a
    // retrieval that never happened.
    roleContexts: [],
  };
}
