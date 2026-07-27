import type { AudioCueRole, AudioDesign, RenderManifest } from '@combat/media';

import type { ResolvedAsset } from '../asset-resolution';

/**
 * The deterministic audio mix: which sounds exist, where they land, and the
 * gain, ducking, fade and peak rules that combine them.
 *
 * Every number here is a decision applied literally. Nothing measures the
 * material and adapts, because a mix that reacts to its inputs is a mix two
 * runs of the same plan can disagree about. What *is* measured is the finished
 * master — integrated loudness, true peak, clipping, silence, layout and rate
 * — by `@combat/media`'s audio QA, from the produced file.
 */

export const AUDIO_CUE_ROLE_KEYS = [
  'FIGHT_BELL',
  'CROWD',
  'IMPACT',
  'UI_CLICK',
  'CONFIRMATION_PULSE',
  'CTA_EMPHASIS',
] as const;
export type AudioCueRoleKey = (typeof AUDIO_CUE_ROLE_KEYS)[number];

/**
 * The house rules for each kind of sound.
 *
 * A bell announces and should cut through, so it ducks the bed. A crowd is
 * atmosphere and sits well under it, so it does not. An impact is short and
 * loud; a UI click is short and quiet; a confirmation pulse marks a moment the
 * viewer is meant to register; CTA emphasis lifts the end card. Stating these
 * once, as data, is what stops six slightly different opinions about a bell
 * accumulating across a codebase.
 */
export interface CueMixRule {
  /** Gain floor and ceiling the plan's own value is clamped into. */
  readonly minimumGainDb: number;
  readonly maximumGainDb: number;
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
  /** Longest the event is allowed to run; anything longer is trimmed. */
  readonly maximumDurationSeconds: number;
  /** Whether this role ducks the music bed by default. */
  readonly ducksMusic: boolean;
  readonly rationale: string;
}

export const CUE_MIX_RULES: Readonly<Record<AudioCueRoleKey, CueMixRule>> = {
  FIGHT_BELL: {
    minimumGainDb: -18,
    maximumGainDb: 0,
    fadeInSeconds: 0.005,
    fadeOutSeconds: 0.25,
    maximumDurationSeconds: 2.5,
    ducksMusic: true,
    rationale: 'a bell announces; it is allowed to open a hole in the bed',
  },
  CROWD: {
    minimumGainDb: -30,
    maximumGainDb: -8,
    fadeInSeconds: 0.4,
    fadeOutSeconds: 0.6,
    maximumDurationSeconds: 12,
    ducksMusic: false,
    rationale: 'atmosphere sits under the bed and never ducks it',
  },
  IMPACT: {
    minimumGainDb: -16,
    maximumGainDb: 0,
    fadeInSeconds: 0.002,
    fadeOutSeconds: 0.18,
    maximumDurationSeconds: 1.2,
    ducksMusic: true,
    rationale: 'short and loud, on the beat it punctuates',
  },
  UI_CLICK: {
    minimumGainDb: -26,
    maximumGainDb: -8,
    fadeInSeconds: 0.001,
    fadeOutSeconds: 0.06,
    maximumDurationSeconds: 0.4,
    ducksMusic: false,
    rationale: 'a click is a detail, not an event',
  },
  CONFIRMATION_PULSE: {
    minimumGainDb: -22,
    maximumGainDb: -4,
    fadeInSeconds: 0.01,
    fadeOutSeconds: 0.3,
    maximumDurationSeconds: 1.5,
    ducksMusic: false,
    rationale: 'marks a moment the viewer is meant to register',
  },
  CTA_EMPHASIS: {
    minimumGainDb: -18,
    maximumGainDb: 0,
    fadeInSeconds: 0.02,
    fadeOutSeconds: 0.5,
    maximumDurationSeconds: 3,
    ducksMusic: true,
    rationale: 'lifts the end card so the call to action is not the quietest moment',
  },
};

export function clampCueGain(role: AudioCueRoleKey, requestedDb: number): number {
  const rule = CUE_MIX_RULES[role];
  return Math.min(rule.maximumGainDb, Math.max(rule.minimumGainDb, requestedDb));
}

export interface PlannedAudioCue {
  readonly id: string;
  readonly role: AudioCueRoleKey;
  readonly assetId: string;
  readonly atSeconds: number;
  readonly gainDb: number;
  readonly clampedFromDb: number | null;
  readonly durationSeconds: number;
  readonly ducksMusic: boolean;
  readonly rationale: string;
}

export interface AudioPlanInput {
  readonly cues: readonly {
    readonly role: AudioCueRoleKey;
    readonly assetId: string;
    readonly atSeconds: number;
    readonly gainDb: number;
    readonly ducksMusic: boolean;
    readonly beatId: string;
  }[];
  readonly assetsById: ReadonlyMap<string, ResolvedAsset>;
  readonly sourceAudioGainDb: number;
  readonly cueDuckingDb: number;
  readonly musicCrossfadeSeconds: number;
  readonly peakCeilingDbtp: number;
  readonly outputDurationSeconds: number;
}

export interface AudioPlan {
  readonly cues: readonly PlannedAudioCue[];
  readonly design: AudioDesign;
  /** Human-readable mix decisions, for `audio-plan.json`. */
  readonly decisions: readonly string[];
}

/**
 * Turns planned cue intentions into the renderer's `AudioDesign`.
 *
 * Two things happen here that the plan cannot do for itself. A cue is trimmed
 * to its role's maximum, using the asset's *measured* duration rather than a
 * declared one — an eight-second "click" is a mistake, and letting it play out
 * would bury the bed. And a cue whose gain sits outside its role's range is
 * clamped, with the original recorded: a bell at +9 dB is not a creative
 * choice, it is a typo, and silently honouring it produces a master that fails
 * peak protection for a reason nobody can find.
 */
export function buildAudioPlan(input: AudioPlanInput): AudioPlan {
  const decisions: string[] = [];
  const cues: PlannedAudioCue[] = [];

  for (const [index, cue] of input.cues.entries()) {
    const rule = CUE_MIX_RULES[cue.role];
    const asset = input.assetsById.get(cue.assetId);
    if (!asset) continue;

    const gainDb = clampCueGain(cue.role, cue.gainDb);
    const clampedFromDb = gainDb === cue.gainDb ? null : cue.gainDb;
    if (clampedFromDb !== null) {
      decisions.push(
        `${cue.role} on beat ${cue.beatId}: requested ${clampedFromDb} dB, clamped to ${gainDb} dB (${rule.rationale})`,
      );
    }

    const available = asset.measuredDurationSeconds ?? rule.maximumDurationSeconds;
    // Never run past the end of the cut, and never past the role's ceiling.
    const remaining = Math.max(0, input.outputDurationSeconds - cue.atSeconds);
    const durationSeconds = Number(
      Math.min(rule.maximumDurationSeconds, available, remaining).toFixed(6),
    );
    if (durationSeconds <= 0) continue;
    if (available > rule.maximumDurationSeconds) {
      decisions.push(
        `${cue.role} on beat ${cue.beatId}: source runs ${available.toFixed(2)}s, trimmed to the role's ${rule.maximumDurationSeconds}s ceiling`,
      );
    }

    cues.push({
      id: `cue-${index}-${cue.role.toLowerCase().replace(/_/g, '-')}`,
      role: cue.role,
      assetId: cue.assetId,
      atSeconds: Number(cue.atSeconds.toFixed(6)),
      gainDb,
      clampedFromDb,
      durationSeconds,
      // The plan may ask for a duck; it may not ask a role that never ducks to
      // start doing so.
      ducksMusic: cue.ducksMusic && rule.ducksMusic,
      rationale: rule.rationale,
    });
  }

  decisions.push(
    `scene audio enters the mix at ${input.sourceAudioGainDb} dB`,
    `music ducks ${input.cueDuckingDb} dB under a ducking cue`,
    `a brick-wall limiter holds the master at ${input.peakCeilingDbtp} dBTP before loudness normalisation`,
  );

  const design: AudioDesign = {
    cues: cues.map((cue) => ({
      id: cue.id,
      sourceId: cue.assetId,
      role: cue.role as AudioCueRole,
      atSeconds: cue.atSeconds,
      sourceOffsetSeconds: 0,
      durationSeconds: cue.durationSeconds,
      gainDb: cue.gainDb,
      fadeInSeconds: CUE_MIX_RULES[cue.role].fadeInSeconds,
      fadeOutSeconds: CUE_MIX_RULES[cue.role].fadeOutSeconds,
      ducksMusic: cue.ducksMusic,
    })),
    sourceAudioGainDb: input.sourceAudioGainDb,
    cueDuckingDb: input.cueDuckingDb,
    musicCrossfadeSeconds: input.musicCrossfadeSeconds,
    peakCeilingDbtp: input.peakCeilingDbtp,
    limiterEnabled: true,
  };

  return { cues, design, decisions };
}

/** The rows `audio-plan.json` is built from. */
export function describeAudioPlan(
  plan: AudioPlan,
  manifest: RenderManifest,
): Record<string, unknown> {
  return {
    targetLoudness: manifest.audio?.loudness ?? null,
    peakCeilingDbtp: plan.design.peakCeilingDbtp,
    limiterEnabled: plan.design.limiterEnabled,
    sourceAudioGainDb: plan.design.sourceAudioGainDb,
    cueDuckingDb: plan.design.cueDuckingDb,
    musicCrossfadeSeconds: plan.design.musicCrossfadeSeconds,
    musicTracks: (manifest.audio?.tracks ?? []).map((track) => ({
      id: track.id,
      sourceId: track.sourceId,
      role: track.role,
      gainDb: track.gainDb,
      fadeInSeconds: track.fadeInSeconds,
      fadeOutSeconds: track.fadeOutSeconds,
      loop: track.loop,
    })),
    cues: plan.cues.map((cue) => ({
      id: cue.id,
      role: cue.role,
      assetId: cue.assetId,
      atSeconds: cue.atSeconds,
      durationSeconds: cue.durationSeconds,
      gainDb: cue.gainDb,
      clampedFromDb: cue.clampedFromDb,
      ducksMusic: cue.ducksMusic,
      rationale: cue.rationale,
    })),
    decisions: plan.decisions,
    notice:
      'These are the configured mix decisions. The loudness, peak, clipping and silence figures in the QA report are measured from the produced file and are the binding ones.',
  };
}
