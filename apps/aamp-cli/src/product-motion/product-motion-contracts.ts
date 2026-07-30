import { z } from 'zod';

/**
 * The Product Motion Proof plan.
 *
 * The creative decisions in this file's instances — which plate, which product
 * state, how long each beat runs, where each cut lands — are a person's, and
 * they live in committed JSON rather than in application code for the same
 * reason the zero-cost preview's plan does: code that chooses a timing is code
 * writing the advertisement. What the application owns is the discipline —
 * that the screens are really screens, that the states cover the sequence
 * without a gap, that no transition is a dissolve between two product states.
 *
 * Asset locations are *relative* and resolved against roots supplied at
 * invocation. A plan that hardcoded an operator's folder would be a plan only
 * that operator could run, and the pack-path rule exists precisely so external
 * material stays out of the repository.
 */

export const PRODUCT_MOTION_PLAN_VERSION = 1 as const;

/** Everything this path produces is labelled with it, in every artefact. */
export const PRODUCT_MOTION_LABEL = 'PRODUCT_MOTION_PROOF';

export class ProductMotionError extends Error {
  constructor(
    public readonly code: ProductMotionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProductMotionError';
  }
}

export const PRODUCT_MOTION_ERROR_CODES = [
  'INVALID_PLAN',
  'ASSET_NOT_FOUND',
  'SCREEN_NOT_MAPPABLE',
  'TIMELINE_INCOHERENT',
  'RENDER_FAILED',
  'QA_FAILED',
  'FFMPEG_UNAVAILABLE',
] as const;
export type ProductMotionErrorCode = (typeof PRODUCT_MOTION_ERROR_CODES)[number];

const PointSchema = z.object({ xPx: z.number(), yPx: z.number() }).strict();

const ScreenSchema = z
  .object({
    topLeft: PointSchema,
    topRight: PointSchema,
    bottomLeft: PointSchema,
    bottomRight: PointSchema,
  })
  .strict();

const PlateSchema = z
  .object({
    id: z.string().min(1).max(60),
    /** Relative to the plates root. */
    file: z.string().min(1).max(200),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
    /** Corner positions in the plate's own pixels, measured by an operator. */
    screen: ScreenSchema,
    description: z.string().min(1).max(300),
  })
  .strict();
export type PlatePlan = z.infer<typeof PlateSchema>;

/**
 * A product document is *named*, not located.
 *
 * It carries no file, no width, no height and no preparation. Those fields are
 * gone deliberately: every one of them was a way to make a source that did not
 * fit the screen appear to fit it, and between them they produced the clipped
 * headings and black bands the first proof was rejected for. A document is now
 * rendered at the canonical phone viewport and measured, so its geometry is a
 * result rather than a declaration.
 */
const DocumentSchema = z
  .object({
    id: z.string().min(1).max(60),
    surface: z.enum(['EVENT_LIST', 'FIGHT_CARD', 'LEADERBOARD']),
    description: z.string().min(1).max(300),
  })
  .strict();
export type DocumentPlan = z.infer<typeof DocumentSchema>;

/**
 * The seven beats, in the order they must read:
 * find this weekend's events → inspect a fight → make a prediction → improve
 * your rank.
 */
export const PRODUCT_STATES = [
  'EVENT_SCHEDULE_SCROLL',
  'EVENT_SELECTED',
  'FIGHTER_COMPARISON',
  'PREDICTION_READY',
  'PREDICTION_TAP',
  'PREDICTION_CONFIRMED',
  'PREDICTOR_RANK_REWARD',
] as const;
export type ProductState = (typeof PRODUCT_STATES)[number];

/**
 * The prediction interaction is one decision, not a page to sit on.
 *
 * Ready, tap and confirmed together may not exceed this. The first proof spent
 * 1.72s on them and only 1.32s on the schedule, which inverted what the
 * sequence is about: the product's claim is that it consolidates the weekend,
 * and the prediction is the thing you do once you are there.
 */
export const PREDICTION_INTERACTION_MAX_SECONDS = 1.0;

/** The opening beat has to carry the schedule claim, so it gets the most time. */
export const EVENT_SCHEDULE_MIN_SECONDS = 1.5;

const StateSchema = z
  .object({
    id: z.string().min(1).max(60),
    state: z.enum(PRODUCT_STATES),
    documentId: z.string().min(1),
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    entrance: z.enum(['NONE', 'PUSH_UP']),
    entranceSeconds: z.number().min(0).max(1.5).default(0),
    scroll: z
      .object({
        fromPx: z.number().min(0),
        toPx: z.number().min(0),
        startSeconds: z.number().min(0),
        endSeconds: z.number().positive(),
        easing: z.enum(['LINEAR', 'EASE_OUT_CUBIC', 'EASE_IN_OUT_CUBIC']),
      })
      .strict(),
    /** What a viewer should understand from this beat, in the author's words. */
    intent: z.string().min(1).max(400),
  })
  .strict();
export type StatePlan = z.infer<typeof StateSchema>;

const AccentSchema = z
  .object({
    id: z.string().min(1).max(60),
    key: z.enum(['SELECTION_OUTLINE', 'PRESS_OUTLINE', 'CONFIRM_BAR', 'FOCUS_UNDERLINE']),
    documentId: z.string().min(1),
    /**
     * Authored in the rendered document's own device pixels — the space an
     * operator measures directly in `documents/document-*.png`. There is no
     * scale or crop term between it and the screen, because there is no longer
     * any preparation step between them.
     */
    documentRect: z
      .object({
        xPx: z.number(),
        yPx: z.number(),
        widthPx: z.number().positive(),
        heightPx: z.number().positive(),
      })
      .strict(),
    /** The scroll position at which this accent is shown; it must be at rest there. */
    atScrollPx: z.number().min(0),
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    intent: z.string().min(1).max(300),
  })
  .strict();
export type AccentPlan = z.infer<typeof AccentSchema>;

/**
 * The transition vocabulary, and it is closed.
 *
 * There is deliberately no `CROSSFADE` and no `DISSOLVE`. Dissolving between
 * two product states tells a viewer the states are interchangeable, and the
 * whole point of a demonstration is that one leads to the next. What is left
 * are cuts that carry meaning: one matched on screen position, one landing on
 * the tap, and one where the handset itself sweeps the frame.
 */
export const SHOT_TRANSITIONS = ['OPENING', 'SCREEN_POSITION_MATCH_CUT', 'TAP_CUT'] as const;
export type ShotTransition = (typeof SHOT_TRANSITIONS)[number];

const ShotSchema = z
  .object({
    id: z.string().min(1).max(60),
    plateId: z.string().min(1),
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    transitionIn: z.enum(SHOT_TRANSITIONS),
    transitionNote: z.string().min(1).max(400),
    move: z
      .object({
        startZoom: z.number().min(1).max(2.5),
        endZoom: z.number().min(1).max(2.5),
        /** Offsets the pan away from the screen's own centre, in frame widths. */
        offsetU: z.number().min(-0.5).max(0.5).default(0),
        offsetV: z.number().min(-0.5).max(0.5).default(0),
      })
      .strict(),
  })
  .strict();
export type ShotPlan = z.infer<typeof ShotSchema>;

const AudioCueSchema = z
  .object({
    id: z.string().min(1).max(60),
    file: z.string().min(1).max(200),
    atSeconds: z.number().min(0),
    gainDb: z.number().min(-40).max(0),
    intent: z.string().min(1).max(200),
  })
  .strict();

const PlanSchema = z
  .object({
    planVersion: z.literal(PRODUCT_MOTION_PLAN_VERSION),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case and filesystem-safe'),
    authoredBy: z.string().min(1).max(200),
    brief: z.string().min(1).max(4000),
    output: z
      .object({
        widthPx: z.literal(1080),
        heightPx: z.literal(1920),
        frameRate: z.literal(30),
        durationSeconds: z.number().min(4).max(8),
      })
      .strict(),
    /**
     * The brand mark, relative to the assets root. The only product asset this
     * path reads: the documents are laid out, not composited from captures.
     */
    brandMarkFile: z.string().min(1).max(200),
    plates: z.array(PlateSchema).min(1).max(8),
    documents: z.array(DocumentSchema).min(1).max(8),
    states: z.array(StateSchema).min(2).max(16),
    accents: z.array(AccentSchema).max(24),
    shots: z.array(ShotSchema).min(1).max(8),
    audio: z
      .object({
        bedFile: z.string().min(1).max(200),
        bedGainDb: z.number().min(-40).max(0),
        cues: z.array(AudioCueSchema).max(16),
        integratedLufs: z.number().min(-24).max(-8),
        truePeakDbtp: z.number().min(-6).max(0),
      })
      .strict(),
  })
  .strict();

export type ProductMotionPlan = z.infer<typeof PlanSchema>;

/**
 * Parses, then checks the things a schema cannot: that the shots tile the
 * whole cut with no gap and no overlap, that the states do the same, that
 * every reference resolves, and that every accent is held still while it is on
 * screen.
 *
 * That last rule is the one worth stating out loud. `drawbox` cannot animate,
 * so an accent drawn while its document is scrolling would sit at a fixed
 * canvas position while the row it is meant to mark slides out from under it.
 * Refusing it here is cheaper than discovering it in the extracted frames.
 */
export function parseProductMotionPlan(value: unknown, path?: string): ProductMotionPlan {
  const result = PlanSchema.safeParse(value);
  if (!result.success) {
    throw new ProductMotionError(
      'INVALID_PLAN',
      `the product-motion plan${path ? ` at ${path}` : ''} is invalid:\n${result.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  const plan = result.data;
  const failures: string[] = [];

  const plateIds = new Set(plan.plates.map((plate) => plate.id));
  const documentIds = new Set(plan.documents.map((document) => document.id));

  const covers = (
    label: string,
    spans: readonly {
      readonly id: string;
      readonly startSeconds: number;
      readonly endSeconds: number;
    }[],
  ): void => {
    const ordered = [...spans].sort((a, b) => a.startSeconds - b.startSeconds);
    let cursor = 0;
    for (const span of ordered) {
      if (span.endSeconds <= span.startSeconds) {
        failures.push(`${label} "${span.id}" ends at or before it starts`);
        continue;
      }
      if (Math.abs(span.startSeconds - cursor) > 1e-6) {
        failures.push(
          `${label} "${span.id}" starts at ${span.startSeconds}s but the previous one ended at ${cursor}s; ` +
            'the cut would have a gap or an overlap',
        );
      }
      cursor = span.endSeconds;
    }
    if (Math.abs(cursor - plan.output.durationSeconds) > 1e-6) {
      failures.push(
        `${label}s end at ${cursor}s but the cut is ${plan.output.durationSeconds}s long`,
      );
    }
  };

  covers('shot', plan.shots);
  covers('state', plan.states);

  // The narrative weighting, enforced rather than trusted. Both of these were
  // wrong in the first proof and neither is visible in a timing table until
  // somebody adds up the columns.
  const durationOf = (state: ProductState): number =>
    plan.states
      .filter((candidate) => candidate.state === state)
      .reduce((total, candidate) => total + (candidate.endSeconds - candidate.startSeconds), 0);

  const predictionSeconds =
    durationOf('PREDICTION_READY') +
    durationOf('PREDICTION_TAP') +
    durationOf('PREDICTION_CONFIRMED');
  if (predictionSeconds > PREDICTION_INTERACTION_MAX_SECONDS + 1e-6) {
    failures.push(
      `the prediction interaction runs ${predictionSeconds.toFixed(2)}s, above the ` +
        `${PREDICTION_INTERACTION_MAX_SECONDS}s ceiling; ready → tap → confirmed is one decisive action`,
    );
  }
  const scheduleSeconds = durationOf('EVENT_SCHEDULE_SCROLL');
  if (scheduleSeconds < EVENT_SCHEDULE_MIN_SECONDS - 1e-6) {
    failures.push(
      `the schedule scroll runs ${scheduleSeconds.toFixed(2)}s, below the ` +
        `${EVENT_SCHEDULE_MIN_SECONDS}s floor; the opening beat carries the product's claim`,
    );
  }
  for (const required of PRODUCT_STATES) {
    if (!plan.states.some((state) => state.state === required)) {
      failures.push(`no state covers ${required}; all seven beats must be present`);
    }
  }

  plan.shots.forEach((shot, index) => {
    if (!plateIds.has(shot.plateId)) {
      failures.push(`shot "${shot.id}" names unknown plate "${shot.plateId}"`);
    }
    if (index === 0 && shot.transitionIn !== 'OPENING') {
      failures.push(`the first shot must declare transitionIn OPENING, not ${shot.transitionIn}`);
    }
    if (index > 0 && shot.transitionIn === 'OPENING') {
      failures.push(`shot "${shot.id}" is not the first shot and cannot be an OPENING`);
    }
  });

  const documentsById = new Map(plan.documents.map((document) => [document.id, document]));
  plan.states.forEach((state) => {
    if (!documentIds.has(state.documentId)) {
      failures.push(`state "${state.id}" names unknown document "${state.documentId}"`);
    }
    if (state.entrance === 'PUSH_UP' && state.entranceSeconds <= 0) {
      failures.push(`state "${state.id}" declares PUSH_UP with no entrance duration`);
    }
    if (state.scroll.startSeconds < state.startSeconds - 1e-6) {
      failures.push(`state "${state.id}" scrolls before it is on screen`);
    }
    if (state.scroll.endSeconds > state.endSeconds + 1e-6) {
      failures.push(`state "${state.id}" is still scrolling after it leaves the screen`);
    }
  });

  // An accent may span several consecutive states — a selection that stays
  // selected through the tap and the confirmation is one mark, not three — but
  // every state it crosses has to be showing the same document, at the same
  // resting scroll, and not moving. `drawbox` cannot animate, so an accent over
  // a scrolling document sits still while the row it marks slides out from
  // under it.
  plan.accents.forEach((accent) => {
    const document = documentsById.get(accent.documentId);
    if (!document) {
      failures.push(`accent "${accent.id}" names unknown document "${accent.documentId}"`);
      return;
    }
    const overlapping = plan.states.filter(
      (state) =>
        state.startSeconds < accent.endSeconds - 1e-6 &&
        state.endSeconds > accent.startSeconds + 1e-6,
    );
    if (overlapping.length === 0) {
      failures.push(
        `accent "${accent.id}" is on screen from ${accent.startSeconds}s to ${accent.endSeconds}s, when no state is`,
      );
      return;
    }
    for (const state of overlapping) {
      if (state.documentId !== accent.documentId) {
        failures.push(
          `accent "${accent.id}" is on screen during state "${state.id}", which is showing document ` +
            `"${state.documentId}" rather than "${accent.documentId}"`,
        );
        continue;
      }
      const moving = state.scroll.fromPx !== state.scroll.toPx;
      if (moving && accent.startSeconds < state.scroll.endSeconds - 1e-6) {
        failures.push(
          `accent "${accent.id}" appears at ${accent.startSeconds}s while state "${state.id}" is still ` +
            `scrolling until ${state.scroll.endSeconds}s; a drawn accent cannot follow a moving row`,
        );
      }
      if (state.entrance === 'PUSH_UP') {
        const settled = state.startSeconds + state.entranceSeconds;
        if (accent.startSeconds < settled - 1e-6) {
          failures.push(
            `accent "${accent.id}" appears at ${accent.startSeconds}s while state "${state.id}" is still ` +
              `entering until ${settled}s`,
          );
        }
      }
      if (Math.abs(accent.atScrollPx - state.scroll.toPx) > 1e-6) {
        failures.push(
          `accent "${accent.id}" is positioned for scroll ${accent.atScrollPx}px but state "${state.id}" ` +
            `rests at ${state.scroll.toPx}px`,
        );
      }
    }
  });

  if (failures.length > 0) {
    throw new ProductMotionError(
      'TIMELINE_INCOHERENT',
      `the product-motion plan${path ? ` at ${path}` : ''} does not describe a coherent cut:\n${failures
        .map((failure) => `  - ${failure}`)
        .join('\n')}`,
    );
  }

  return plan;
}
