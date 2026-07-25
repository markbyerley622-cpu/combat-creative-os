import type { DeliveryProfile } from '../schemas/delivery-profile';
import type {
  CtaPlacement,
  RetainedCaption,
  RetainedClip,
  RetainedCue,
  VariantCutPoint,
} from '../schemas/variant-specification';

/**
 * M12 — deterministic, I/O-free validation that a proposed variant cut is a
 * *legal re-cut* of an approved master rather than an arbitrary time slice.
 *
 * Everything here is checked against **persisted** structures — the parent
 * `Timeline`'s entries, the `EditDecisionList`'s entries, and the
 * `SoundDesignPlan`'s `SoundCue`s — never against a duration guess. A cut is
 * legal only when every boundary it introduces coincides with a boundary the
 * approved master already had, which is what guarantees no clip, caption, CTA
 * or audio cue is split.
 *
 * Pure and exported so it is unit-testable against fixture timelines
 * independently of any agent, provider or database.
 */

export const VARIANT_CUT_VIOLATIONS = [
  'NO_CUT_POINTS',
  'DURATION_MISMATCH',
  'CUT_NOT_ON_TIMELINE_BOUNDARY',
  'CUT_SPLITS_CLIP',
  'CUT_SPLITS_CAPTION',
  'CUT_SPLITS_CTA',
  'CUT_SPLITS_AUDIO_CUE',
  'OVERLAPPING_CUT_POINTS',
  'NARRATIVE_ORDER_VIOLATED',
  'VARIANT_TIMELINE_NOT_CONTIGUOUS',
  'CTA_MISSING',
  'CTA_NOT_IN_TAIL',
  'CAPTIONS_REQUIRED_BUT_ABSENT',
  'CAPTION_OUTSIDE_SAFE_AREA',
  'SAFE_AREA_METADATA_MISSING',
  'RETAINED_CLIP_NOT_ON_TIMELINE',
] as const;
export type VariantCutViolationCode = (typeof VARIANT_CUT_VIOLATIONS)[number];

export interface VariantCutViolation {
  readonly code: VariantCutViolationCode;
  readonly detail: string;
}

/** A parent-timeline segment a cut may start or end on — one per `TimelineEntry`. */
export interface TimelineBoundarySegment {
  readonly order: number;
  readonly shotId: string;
  readonly startFrame: number;
  /** Exclusive. */
  readonly endFrame: number;
  readonly beat?: string;
}

/**
 * A parent `SoundCue` expressed on the parent timeline; a cut may not land
 * inside one.
 *
 * Callers pass only **discrete** cues (SFX / VOICEOVER) here. A continuous
 * MUSIC bed spanning the whole master is deliberately excluded: it is re-mixed
 * to the variant's length rather than being a hard cut boundary, so treating
 * it as one would make every cutdown illegal by construction. Which cue types
 * are hard boundaries is the caller's decision (see
 * `run-variant-generator-activity.ts`), not this pure function's.
 */
export interface AudioCueSegment {
  readonly soundCueId: string;
  readonly startFrame: number;
  /** Exclusive. */
  readonly endFrame: number;
}

/** A parent caption/overlay span on the parent timeline; a cut may not land inside one. */
export interface CaptionSegment {
  readonly startFrame: number;
  /** Exclusive. */
  readonly endFrame: number;
}

export interface VariantCutValidationInput {
  readonly profile: Pick<
    DeliveryProfile,
    | 'frameRate'
    | 'captionBurnRequired'
    | 'safeAreas'
    | 'ctaTailSeconds'
    | 'ctaMinimumDurationSeconds'
    | 'durationToleranceFrames'
  >;
  readonly targetDurationSeconds: number;
  readonly cutPoints: readonly VariantCutPoint[];
  readonly retainedClips: readonly RetainedClip[];
  readonly retainedCues: readonly RetainedCue[];
  readonly retainedCaptions: readonly RetainedCaption[];
  readonly ctaPlacement: CtaPlacement;
  readonly safeAreas: readonly string[];
  /** Legal boundaries, from the parent Timeline's entries (ordered). */
  readonly timelineSegments: readonly TimelineBoundarySegment[];
  /** Parent sound cues — a cut boundary may not fall strictly inside one. */
  readonly audioCues: readonly AudioCueSegment[];
  /** Parent caption spans — a cut boundary may not fall strictly inside one. */
  readonly captionSegments: readonly CaptionSegment[];
  /** The parent's CTA span, when the master had one. */
  readonly parentCtaSegment?: CaptionSegment;
}

export interface VariantCutValidationResult {
  readonly ok: boolean;
  readonly violations: readonly VariantCutViolation[];
  /** Total retained frames — the variant's real duration. */
  readonly variantDurationFrames: number;
}

/** Does `frame` coincide with the start or end of any legal segment? */
function isBoundary(frame: number, segments: readonly TimelineBoundarySegment[]): boolean {
  return segments.some((s) => s.startFrame === frame || s.endFrame === frame);
}

/** Does `frame` fall strictly inside `[start, end)` — i.e. would cutting there split it? */
function splitsSpan(frame: number, span: { startFrame: number; endFrame: number }): boolean {
  return frame > span.startFrame && frame < span.endFrame;
}

/**
 * Validates a proposed variant cut. Returns every violation found rather than
 * the first, so a failing cut can be reported (and repaired) in one pass.
 */
export function validateVariantCut(input: VariantCutValidationInput): VariantCutValidationResult {
  const violations: VariantCutViolation[] = [];
  const { profile, cutPoints, timelineSegments } = input;

  const ordered = [...cutPoints].sort((a, b) => a.order - b.order);
  const variantDurationFrames = ordered.reduce(
    (sum, c) => sum + (c.sourceEndFrame - c.sourceStartFrame),
    0,
  );

  if (ordered.length === 0) {
    return {
      ok: false,
      violations: [{ code: 'NO_CUT_POINTS', detail: 'the cut retains no frames' }],
      variantDurationFrames: 0,
    };
  }

  // --- Duration matches target within the profile's documented tolerance ---
  const targetFrames = input.targetDurationSeconds * profile.frameRate;
  const drift = Math.abs(variantDurationFrames - targetFrames);
  if (drift > profile.durationToleranceFrames) {
    violations.push({
      code: 'DURATION_MISMATCH',
      detail: `variant is ${variantDurationFrames} frames, target ${targetFrames} (tolerance ${profile.durationToleranceFrames}, drift ${drift})`,
    });
  }

  // --- Every cut boundary lands on a real timeline boundary, splits nothing ---
  for (const cut of ordered) {
    if (cut.sourceEndFrame <= cut.sourceStartFrame) {
      violations.push({
        code: 'OVERLAPPING_CUT_POINTS',
        detail: `cut ${cut.order} is empty or inverted (${cut.sourceStartFrame}..${cut.sourceEndFrame})`,
      });
      continue;
    }
    for (const frame of [cut.sourceStartFrame, cut.sourceEndFrame]) {
      if (!isBoundary(frame, timelineSegments)) {
        violations.push({
          code: 'CUT_NOT_ON_TIMELINE_BOUNDARY',
          detail: `frame ${frame} is not a TimelineEntry boundary`,
        });
      }
      const splitClip = timelineSegments.find((s) => splitsSpan(frame, s));
      if (splitClip) {
        violations.push({
          code: 'CUT_SPLITS_CLIP',
          detail: `frame ${frame} falls inside shot ${splitClip.shotId} (${splitClip.startFrame}..${splitClip.endFrame})`,
        });
      }
      const splitCue = input.audioCues.find((c) => splitsSpan(frame, c));
      if (splitCue) {
        violations.push({
          code: 'CUT_SPLITS_AUDIO_CUE',
          detail: `frame ${frame} falls inside sound cue ${splitCue.soundCueId} (${splitCue.startFrame}..${splitCue.endFrame})`,
        });
      }
      const splitCaption = input.captionSegments.find((c) => splitsSpan(frame, c));
      if (splitCaption) {
        violations.push({
          code: 'CUT_SPLITS_CAPTION',
          detail: `frame ${frame} falls inside caption span (${splitCaption.startFrame}..${splitCaption.endFrame})`,
        });
      }
      if (input.parentCtaSegment && splitsSpan(frame, input.parentCtaSegment)) {
        violations.push({
          code: 'CUT_SPLITS_CTA',
          detail: `frame ${frame} falls inside the CTA span (${input.parentCtaSegment.startFrame}..${input.parentCtaSegment.endFrame})`,
        });
      }
    }
  }

  // --- Segments do not overlap, and narrative order is preserved ---
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (cur.sourceStartFrame < prev.sourceEndFrame) {
      violations.push({
        code:
          cur.sourceStartFrame < prev.sourceStartFrame
            ? 'NARRATIVE_ORDER_VIOLATED'
            : 'OVERLAPPING_CUT_POINTS',
        detail: `cut ${cur.order} starts at ${cur.sourceStartFrame}, before cut ${prev.order} ends at ${prev.sourceEndFrame}`,
      });
    }
  }

  // --- The variant's own timeline is gapless and starts at 0 ---
  let expectedStart = 0;
  for (const cut of ordered) {
    if (cut.variantStartFrame !== expectedStart) {
      violations.push({
        code: 'VARIANT_TIMELINE_NOT_CONTIGUOUS',
        detail: `cut ${cut.order} starts at variant frame ${cut.variantStartFrame}, expected ${expectedStart}`,
      });
    }
    expectedStart = cut.variantStartFrame + (cut.sourceEndFrame - cut.sourceStartFrame);
  }

  // --- Retained clips must actually exist on the parent timeline ---
  for (const clip of input.retainedClips) {
    const match = timelineSegments.find(
      (s) =>
        s.shotId === clip.shotId &&
        s.startFrame <= clip.sourceStartFrame &&
        s.endFrame >= clip.sourceEndFrame,
    );
    if (!match) {
      violations.push({
        code: 'RETAINED_CLIP_NOT_ON_TIMELINE',
        detail: `retained clip for shot ${clip.shotId} (${clip.sourceStartFrame}..${clip.sourceEndFrame}) is not a span of any TimelineEntry`,
      });
    }
  }

  // --- CTA retention, and the profile's tail rule where duration permits ---
  const ctaRuleApplies =
    profile.ctaTailSeconds !== undefined &&
    (profile.ctaMinimumDurationSeconds === undefined ||
      input.targetDurationSeconds >= profile.ctaMinimumDurationSeconds);
  if (ctaRuleApplies) {
    if (!input.ctaPlacement.present) {
      violations.push({
        code: 'CTA_MISSING',
        detail: `the ${input.targetDurationSeconds}s variant must retain the master's CTA`,
      });
    } else if (input.ctaPlacement.variantStartFrame !== undefined) {
      const tailStart = variantDurationFrames - profile.ctaTailSeconds! * profile.frameRate;
      const ctaEnd = input.ctaPlacement.variantEndFrame ?? variantDurationFrames;
      if (ctaEnd < tailStart) {
        violations.push({
          code: 'CTA_NOT_IN_TAIL',
          detail: `CTA ends at variant frame ${ctaEnd}, before the final ${profile.ctaTailSeconds}s (starts at frame ${tailStart})`,
        });
      }
    }
  }

  // --- Caption + safe-area requirements ---
  if (profile.captionBurnRequired && input.retainedCaptions.length === 0) {
    violations.push({
      code: 'CAPTIONS_REQUIRED_BUT_ABSENT',
      detail: 'the delivery profile requires burned-in captions but the cut retains none',
    });
  }
  if (input.safeAreas.length === 0) {
    violations.push({
      code: 'SAFE_AREA_METADATA_MISSING',
      detail: 'the variant carries no safe-area metadata',
    });
  }
  const allowedSafeAreas = new Set<string>(profile.safeAreas);
  for (const caption of input.retainedCaptions) {
    if (!allowedSafeAreas.has(caption.safeArea)) {
      violations.push({
        code: 'CAPTION_OUTSIDE_SAFE_AREA',
        detail: `caption safe area ${caption.safeArea} is not one of the profile's (${profile.safeAreas.join(', ')})`,
      });
    }
  }

  return { ok: violations.length === 0, violations, variantDurationFrames };
}

/**
 * Derives the legal cut boundaries a variant may use, from the parent
 * `Timeline`'s entries. Exported so the Activity feeding the agent and the
 * validator checking its answer both work from one definition of "legal
 * boundary" rather than two that could drift apart.
 */
export function timelineBoundaries(
  entries: readonly { shotId: string; order: number; startFrame: number; durationFrames: number }[],
  beatByShotId: Readonly<Record<string, string | undefined>> = {},
): TimelineBoundarySegment[] {
  return [...entries]
    .sort((a, b) => a.order - b.order)
    .map((e) => ({
      order: e.order,
      shotId: e.shotId,
      startFrame: e.startFrame,
      endFrame: e.startFrame + e.durationFrames,
      beat: beatByShotId[e.shotId],
    }));
}
