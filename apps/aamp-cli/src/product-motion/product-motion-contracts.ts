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

const DocumentSchema = z
  .object({
    id: z.string().min(1).max(60),
    /** Relative to the assets root. */
    file: z.string().min(1).max(200),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
    /**
     * Extension above the capture, drawn from its own top rows. A handset
     * screen taller than the captured viewport really does show more above the
     * application header; this is that band, and it is also what gives a short
     * capture room to scroll.
     */
    headroomPx: z.number().int().min(0).max(4000),
    /**
     * Present when the capture has to be shown larger and cropped to fill a
     * screen taller than the viewport it was taken at. Absent means the
     * capture is used at its own size, which is only possible when it is
     * already as wide as the canvas.
     */
    fit: z
      .object({
        scaleWidthPx: z.number().int().positive(),
        scaleHeightPx: z.number().int().positive(),
        cropXPx: z.number().int().min(0),
      })
      .strict()
      .optional(),
    description: z.string().min(1).max(300),
  })
  .strict();
export type DocumentPlan = z.infer<typeof DocumentSchema>;

export const PRODUCT_STATES = [
  'EVENT_DISCOVERY',
  'EVENT_SELECTION',
  'FIGHTER_COMPARISON',
  'PREDICTION_SELECTION',
  'PREDICTION_TAP',
  'PREDICTION_CONFIRMED',
  'PREDICTOR_RANK_REWARD',
] as const;
export type ProductState = (typeof PRODUCT_STATES)[number];

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
    /** Authored in the capture's own pixels — the space an operator can measure. */
    captureRect: z
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
    uiCanvas: z
      .object({ widthPx: z.literal(1080), heightPx: z.number().int().min(1920).max(6000) })
      .strict(),
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
