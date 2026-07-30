import { StoryboardVideoError } from '../storyboard-video/failures';
import type { NotificationBrief } from './acceptance-brief';

/**
 * The notification's animation, as data.
 *
 * The whole treatment is a short list of complete, statically-composed states
 * with disjoint time windows, and that is a deliberate consequence of what
 * FFmpeg can and cannot do rather than a simplification. `drawbox` cannot
 * animate at all — its `t` is the box *thickness*, not the timestamp — and
 * `scale` has no per-frame evaluation. What both of them can do is show a
 * different, already-correct picture on each frame. So the entrance is not
 * interpolated at render time: every step is rendered at its own scale by a
 * real layout engine, which means the type is rasterised sharp at every size
 * it is ever seen at instead of being resampled from one master.
 *
 * The entrance is deliberately step-count-matched to the frame grid. Eighteen
 * hundredths of a second at 24fps is between four and five frames, so five
 * steps means one state per frame and no state that is shown twice while
 * another is skipped. A step count that does not divide onto the grid produces
 * a stutter that looks like a dropped frame.
 *
 * Nothing here decides anything creative. Timings, distances, colours, the
 * easing and the copy all arrive from the brief; this module turns them into
 * the windows the compositor plays.
 */

/**
 * The treatment's own version. It covers the state model, the easing
 * implementations, the pulse shape and the surface layout — everything a
 * reader of an artefact would need to reproduce what a run produced. Changing
 * any of them is a bump, not an edit in place: two runs citing v2 that cannot
 * be told apart in their artefacts are one change away from disagreeing.
 */
export const NOTIFICATION_TREATMENT_VERSION = 3 as const;

/**
 * Where the accent pulse peaks, as a fraction of its own window.
 *
 * Front-loaded on purpose: a pulse that peaks in the middle and decays
 * symmetrically reads as a slow throb, and a notification accent is a note
 * struck once. This is motion grammar rather than creative copy, so it lives
 * with the treatment version and not in the brief.
 */
export const PULSE_PEAK_FRACTION = 0.35;

/**
 * The scale at a point in the entrance: rise, one controlled overshoot, settle.
 *
 * Two eased segments rather than a spring, because a spring is a family of
 * curves with a damping constant and this is a single authored gesture with a
 * stated peak. `entrancePeakScale` is bounded to a few thousandths above rest:
 * that reads as weight arriving. A few hundredths reads as a bounce, and a
 * bounce is the template effect the art direction refuses.
 *
 * It is monotonic on each side of the peak, so there is exactly one excursion
 * and a second one is not expressible — which is what makes "no repeated
 * bounce" a property of the model rather than a promise.
 */
export function settleScale(brief: NotificationBrief, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  const peak = brief.entrancePeakFraction;
  if (p <= peak) {
    const t = peak === 0 ? 1 : p / peak;
    return (
      brief.entranceStartScale +
      (brief.entrancePeakScale - brief.entranceStartScale) * ease(brief.entranceEasing, t)
    );
  }
  const t = (p - peak) / (1 - peak);
  return brief.entrancePeakScale + (1 - brief.entrancePeakScale) * ease(brief.entranceEasing, t);
}

/**
 * The accent's opacity at an instant — one envelope over the whole timeline.
 *
 * It is a function of time rather than a property of the pulse *states* so the
 * accent can be synchronised to the settle: the pulse peaks as the card lands,
 * which means its rise happens while the card is still arriving. With a
 * per-state pulse the accent could only ever begin after the entrance was over,
 * and an accent that fires once the card is already at rest reads as a second
 * event rather than as part of the arrival.
 */
export function accentOpacityAt(brief: NotificationBrief, atSeconds: number): number {
  if (atSeconds < brief.pulseStartSeconds || atSeconds >= brief.pulseEndSeconds) {
    return brief.accentRestOpacity;
  }
  const span = brief.pulseEndSeconds - brief.pulseStartSeconds;
  const fraction = span <= 0 ? 1 : (atSeconds - brief.pulseStartSeconds) / span;
  return (
    brief.accentRestOpacity +
    (brief.accentPulsePeakOpacity - brief.accentRestOpacity) * pulseIntensity(fraction)
  );
}

export interface DeliveryFrame {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface CardRect {
  readonly xPx: number;
  readonly yPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

export type NotificationStateKind = 'ENTRANCE' | 'PULSE' | 'REST';

export interface NotificationState {
  readonly id: string;
  readonly kind: NotificationStateKind;
  readonly fromSeconds: number;
  readonly toSeconds: number;
  /** 0 at the first entrance step, 1 once settled. */
  readonly entranceProgress: number;
  readonly scale: number;
  /** How far below its resting centre the card still sits, in delivery pixels. */
  readonly riseRemainingPx: number;
  readonly accentOpacity: number;
  /** The card's own rectangle in this state, in delivery pixels. */
  readonly rect: CardRect;
  readonly fileName: string;
}

export interface NotificationTimeline {
  readonly treatmentVersion: typeof NOTIFICATION_TREATMENT_VERSION;
  readonly frame: DeliveryFrame;
  /** The card at rest — the geometry every state is a transform of. */
  readonly restRect: CardRect;
  /**
   * Every pixel the treatment can ever mark, across every state, including the
   * shadow and the accent glow. This is the rectangle the placement measurement
   * checks against the picture: one rectangle that covers the whole animation
   * is a stronger claim than a per-state check a reader has to assemble.
   */
  readonly occupiedRect: CardRect;
  readonly withinSafeBounds: boolean;
  readonly states: readonly NotificationState[];
  /**
   * The accent edge at rest. Scene 2's match transition is meant to grow out of
   * this exact rectangle, so it is recorded rather than left to be re-derived.
   */
  readonly matchTransitionSeed: {
    readonly rect: CardRect;
    readonly colorHex: string;
    readonly fromSeconds: number;
    readonly note: string;
  };
}

export function buildNotificationTimeline(
  brief: NotificationBrief,
  frame: DeliveryFrame,
): NotificationTimeline {
  const restRect = resolveRestRect(brief, frame);
  const states = buildStates(brief, restRect, frame);
  const occupiedRect = resolveOccupiedRect(brief, states, frame);

  const withinSafeBounds =
    occupiedRect.xPx >= brief.safeMarginPx &&
    occupiedRect.yPx >= brief.safeMarginPx &&
    occupiedRect.xPx + occupiedRect.widthPx <= frame.widthPx - brief.safeMarginPx &&
    occupiedRect.yPx + occupiedRect.heightPx <= frame.heightPx - brief.safeMarginPx;

  return {
    treatmentVersion: NOTIFICATION_TREATMENT_VERSION,
    frame,
    restRect,
    occupiedRect,
    withinSafeBounds,
    states,
    matchTransitionSeed: {
      rect: resolveAccentRect(brief, restRect),
      colorHex: brief.accentColorHex,
      fromSeconds: brief.pulseEndSeconds,
      note: 'The accent edge holds at its resting opacity from the end of the pulse to the cut. Scene 2 is intended to grow its transition out of this rectangle; nothing in this milestone renders that transition, and this record is the geometry it would start from.',
    },
  };
}

/** The card at rest, centred horizontally, on even pixels. */
export function resolveRestRect(brief: NotificationBrief, frame: DeliveryFrame): CardRect {
  const widthPx = even(Math.round(frame.widthPx * brief.widthFraction));
  const heightPx = even(brief.cardHeightPx);
  return {
    xPx: even(Math.round((frame.widthPx - widthPx) / 2)),
    yPx: even(Math.round(brief.cardCentreYPx - heightPx / 2)),
    widthPx,
    heightPx,
  };
}

/** The accent edge's own rectangle, inset the same amount as the type. */
export function resolveAccentRect(brief: NotificationBrief, card: CardRect): CardRect {
  if (brief.accentEdge === 'LEFT') {
    return {
      xPx: card.xPx,
      yPx: card.yPx,
      widthPx: brief.accentThicknessPx,
      heightPx: card.heightPx,
    };
  }
  return {
    xPx: card.xPx,
    yPx: card.yPx + card.heightPx - brief.accentThicknessPx,
    widthPx: card.widthPx,
    heightPx: brief.accentThicknessPx,
  };
}

/**
 * The band the supporting line sits in, above where the accent's glow is
 * allowed to reach.
 *
 * Defined against the accent rather than by re-deriving the CSS layout, which
 * would be a second implementation of the type stack that agreed with the first
 * only until somebody changed a margin. The claim it supports is exactly the
 * one the art direction makes: the glow may spread `accentGlowBlurPx` into the
 * card and no further, so above that line there must be no red at all.
 */
export function resolveSupportingCopyBand(brief: NotificationBrief, card: CardRect): CardRect {
  const accentTop = card.yPx + card.heightPx - brief.accentThicknessPx;
  const bandBottom = accentTop - brief.accentGlowBlurPx;
  const heightPx = Math.max(2, Math.round(card.heightPx * 0.2));
  return {
    xPx: card.xPx + brief.horizontalPaddingPx,
    yPx: bandBottom - heightPx,
    widthPx: card.widthPx - 2 * brief.horizontalPaddingPx,
    heightPx,
  };
}

function buildStates(
  brief: NotificationBrief,
  restRect: CardRect,
  frame: DeliveryFrame,
): readonly NotificationState[] {
  const states: NotificationState[] = [];
  const restCentreY = restRect.yPx + restRect.heightPx / 2;

  const rectFor = (scale: number, riseRemainingPx: number): CardRect => {
    const widthPx = Math.round(restRect.widthPx * scale);
    const heightPx = Math.round(restRect.heightPx * scale);
    return {
      xPx: Math.round(frame.widthPx / 2 - widthPx / 2),
      yPx: Math.round(restCentreY + riseRemainingPx - heightPx / 2),
      widthPx,
      heightPx,
    };
  };

  // Every state samples the accent envelope at its own midpoint, whatever kind
  // it is. That is what lets the accent peak on the settle rather than after it.
  const accentAt = (fromSeconds: number, toSeconds: number): number =>
    round6(accentOpacityAt(brief, (fromSeconds + toSeconds) / 2));

  // --- the entrance ----------------------------------------------------------
  const entranceSpan = brief.entranceSettleSeconds - brief.entranceStartSeconds;
  const stepSeconds = entranceSpan / brief.entranceSteps;
  for (let index = 0; index < brief.entranceSteps; index += 1) {
    // Progress is taken at the *start* of each window. Taking it at the end
    // would mean the first frame a viewer sees is already most of the way
    // settled, and the arrival would not read at all.
    const progress = index / brief.entranceSteps;
    const scale = settleScale(brief, progress);
    // The rise does not overshoot even though the scale does. A card that
    // travelled past its resting position and came back would read as a bounce;
    // what is wanted is weight arriving, which is a scale gesture.
    const riseRemainingPx = brief.entranceRisePx * (1 - ease(brief.entranceEasing, progress));
    const fromSeconds = round6(brief.entranceStartSeconds + index * stepSeconds);
    const toSeconds = round6(brief.entranceStartSeconds + (index + 1) * stepSeconds);
    states.push({
      id: `entrance-${String(index + 1).padStart(2, '0')}`,
      kind: 'ENTRANCE',
      fromSeconds,
      toSeconds,
      entranceProgress: round6(progress),
      scale: round6(scale),
      riseRemainingPx: round6(riseRemainingPx),
      accentOpacity: accentAt(fromSeconds, toSeconds),
      rect: rectFor(scale, riseRemainingPx),
      fileName: `surface-entrance-${String(index + 1).padStart(2, '0')}.png`,
    });
  }

  // --- whatever of the accent pulse outlives the settle ----------------------
  // The pulse is synchronised to the settle, so most of it happens during the
  // entrance and is already carried by those states. Only its tail needs states
  // of its own.
  const pulseTailFrom = Math.max(brief.entranceSettleSeconds, brief.pulseStartSeconds);
  if (pulseTailFrom - brief.entranceSettleSeconds > 1e-9) {
    states.push(
      restState({
        id: 'settled',
        fromSeconds: brief.entranceSettleSeconds,
        toSeconds: pulseTailFrom,
        accentOpacity: accentAt(brief.entranceSettleSeconds, pulseTailFrom),
        restRect,
        fileName: 'surface-settled.png',
      }),
    );
  }
  if (brief.pulseEndSeconds - pulseTailFrom > 1e-9) {
    const pulseStepSeconds = (brief.pulseEndSeconds - pulseTailFrom) / brief.pulseSteps;
    for (let index = 0; index < brief.pulseSteps; index += 1) {
      const fromSeconds = round6(pulseTailFrom + index * pulseStepSeconds);
      const toSeconds = round6(pulseTailFrom + (index + 1) * pulseStepSeconds);
      states.push(
        restState({
          id: `pulse-${String(index + 1).padStart(2, '0')}`,
          kind: 'PULSE',
          fromSeconds,
          toSeconds,
          accentOpacity: accentAt(fromSeconds, toSeconds),
          restRect,
          fileName: `surface-pulse-${String(index + 1).padStart(2, '0')}.png`,
        }),
      );
    }
  }

  // --- and it holds to the cut, at rest. There is no fade-out. ---------------
  const restFrom = Math.max(brief.entranceSettleSeconds, brief.pulseEndSeconds);
  states.push(
    restState({
      id: 'rest',
      fromSeconds: round6(restFrom),
      toSeconds: brief.readableUntilSeconds,
      accentOpacity: brief.accentRestOpacity,
      restRect,
      fileName: 'surface-rest.png',
    }),
  );

  return states;
}

function restState(input: {
  id: string;
  kind?: NotificationStateKind;
  fromSeconds: number;
  toSeconds: number;
  accentOpacity: number;
  restRect: CardRect;
  fileName: string;
}): NotificationState {
  return {
    id: input.id,
    kind: input.kind ?? 'REST',
    fromSeconds: input.fromSeconds,
    toSeconds: input.toSeconds,
    entranceProgress: 1,
    scale: 1,
    riseRemainingPx: 0,
    accentOpacity: input.accentOpacity,
    rect: input.restRect,
    fileName: input.fileName,
  };
}

/**
 * Every pixel any state can mark, including the shadow and the accent glow.
 *
 * The shadow is offset downward, so it reaches further below the card than
 * above it, and the accent glow adds to whichever edge carries it. Reporting
 * the card's rectangle alone would understate what the treatment actually
 * covers, which is the number the placement measurement depends on.
 */
function resolveOccupiedRect(
  brief: NotificationBrief,
  states: readonly NotificationState[],
  frame: DeliveryFrame,
): CardRect {
  let left = frame.widthPx;
  let top = frame.heightPx;
  let right = 0;
  let bottom = 0;
  for (const state of states) {
    left = Math.min(left, state.rect.xPx);
    top = Math.min(top, state.rect.yPx);
    right = Math.max(right, state.rect.xPx + state.rect.widthPx);
    bottom = Math.max(bottom, state.rect.yPx + state.rect.heightPx);
  }

  const glowTop = brief.accentEdge === 'BOTTOM' ? 0 : brief.accentGlowBlurPx;
  const glowBottom = brief.accentGlowBlurPx;
  const glowLeft = brief.accentEdge === 'LEFT' ? brief.accentGlowBlurPx : 0;

  left -= Math.max(brief.shadowBlurPx, glowLeft);
  right += brief.shadowBlurPx;
  top -= Math.max(0, brief.shadowBlurPx - brief.shadowOffsetYPx, glowTop);
  bottom += Math.max(brief.shadowBlurPx + brief.shadowOffsetYPx, glowBottom);

  return {
    xPx: Math.floor(left),
    yPx: Math.floor(top),
    widthPx: Math.ceil(right - left),
    heightPx: Math.ceil(bottom - top),
  };
}

/** Front-loaded rise, longer decay. Struck once, not throbbed. */
export function pulseIntensity(fraction: number): number {
  if (fraction <= PULSE_PEAK_FRACTION) return fraction / PULSE_PEAK_FRACTION;
  return Math.max(0, 1 - (fraction - PULSE_PEAK_FRACTION) / (1 - PULSE_PEAK_FRACTION));
}

export function ease(name: NotificationBrief['entranceEasing'], x: number): number {
  const clamped = Math.min(1, Math.max(0, x));
  switch (name) {
    case 'EASE_OUT_CUBIC':
      return 1 - (1 - clamped) ** 3;
    case 'EASE_OUT_QUINT':
      return 1 - (1 - clamped) ** 5;
    default: {
      // Exhaustive over the closed vocabulary. An easing the brief can name and
      // this module cannot execute is refused, never approximated with a
      // nearest-looking curve.
      const unreachable: never = name;
      throw new StoryboardVideoError(
        'FINAL_RENDER_FAILURE',
        `the entrance easing ${String(unreachable)} is declared in the brief but is not implemented`,
      );
    }
  }
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/** h264 will not encode an odd dimension, and a nudged rectangle is a moved one. */
function even(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}
