import { z } from 'zod';

/**
 * The authored product story.
 *
 * The corrected cut is one continuous demonstration — notification, breadth,
 * schedule, rankings, comparison, prediction, submission, result, discussion,
 * call to action — and every creative decision in it belongs to a person. This
 * file is the schema for where those decisions live: which plate a scene uses,
 * where that plate's handset screen actually is, which product surface it
 * shows, how far the camera moves, what the screen-space treatment says, and
 * how the exposure is lifted.
 *
 * Application code owns the discipline and nothing else. It proves the quads
 * are mappable, that the interface covers the screen without clipping, that a
 * grade cannot raise the black floor, that no scene is left with an empty
 * handset or an empty protected region — and it refuses rather than repairing.
 * It does not choose a timing, a colour, a magnitude or a word.
 */

export const PRODUCT_STORY_VERSION = 1 as const;

/** Everything this path produces is labelled with it, in every artefact. */
export const PRODUCT_STORY_LABEL = 'FULL_LENGTH_UI_COMPOSITED_REVIEW' as const;

export class ProductStoryError extends Error {
  constructor(
    public readonly code: ProductStoryErrorCode,
    message: string,
    public readonly sceneNumber?: number,
  ) {
    super(message);
    this.name = 'ProductStoryError';
  }
}

export const PRODUCT_STORY_ERROR_CODES = [
  'INVALID_STORY_PLAN',
  'SCREEN_NOT_MAPPABLE',
  'INTERFACE_DOES_NOT_FIT',
  'EXPOSURE_UNREADABLE',
  'EMPTY_PROTECTED_REGION',
  'COMPOSITE_FAILED',
  'PLATE_NOT_FOUND',
] as const;
export type ProductStoryErrorCode = (typeof PRODUCT_STORY_ERROR_CODES)[number];

const PointSchema = z.object({ xPx: z.number().finite(), yPx: z.number().finite() }).strict();

const QuadSchema = z
  .object({
    topLeft: PointSchema,
    topRight: PointSchema,
    bottomLeft: PointSchema,
    bottomRight: PointSchema,
  })
  .strict();

const RectSchema = z
  .object({
    xPx: z.number().int().min(0),
    yPx: z.number().int().min(0),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
  })
  .strict();
export type StoryRect = z.infer<typeof RectSchema>;

/**
 * The product surfaces a scene may show.
 *
 * Closed, and it lists only what is implemented. Each member corresponds to
 * one authored mobile-native document and one line of the human authorisation
 * that permits it — a surface with no document behind it would be a
 * discriminator that never renders anything.
 */
export const PRODUCT_SURFACES = [
  'EVENTS_AND_SCHEDULE',
  'FIGHTER_RANKINGS',
  'PREDICTION',
  'DISCUSSION',
] as const;
export type ProductSurface = (typeof PRODUCT_SURFACES)[number];

/**
 * The screen-space treatments, and it is closed.
 *
 * There is deliberately no `DEBUG_OUTLINE`, no `CALIBRATION_RECTANGLE` and no
 * generic `COLOUR_FLASH`. The cut this corrects carried a hard red rectangle
 * over the prediction scene and an opaque red bar across the discussion scene,
 * both of which were the only marks a filter graph can make. Every member here
 * is a *design*, laid out by a real engine and composited whole.
 */
export const SCREEN_TREATMENTS = [
  'SPORT_STRIP_REVEAL',
  'FIGHTER_COMPARISON_PANEL',
  'SUBMISSION_CONFIRMATION',
  'PREDICTOR_RANK_RESULT',
  'DISCUSSION_GLASS_PANEL',
  'CTA_BRAND_LOCKUP',
] as const;
export type ScreenTreatment = (typeof SCREEN_TREATMENTS)[number];

/**
 * Every word a treatment puts on screen, and when it happens.
 *
 * Authored, always. Application code owns no copy: a headline assigned in a
 * module is the system writing the advertisement, and the one number nobody
 * could argue with would be the one it invented. The rank figures are strings
 * rather than integers on purpose — they are typography, and `#27` is not 27.
 */
const TreatmentCopySchema = z
  .object({
    headline: z.string().min(1).max(80).optional(),
    supporting: z.string().min(1).max(120).optional(),
    rankFrom: z.string().min(1).max(12).optional(),
    rankTo: z.string().min(1).max(12).optional(),
    rows: z.array(z.string().min(1).max(120)).max(6).optional(),
    strips: z.array(z.string().min(1).max(40)).max(6).optional(),
    leftName: z.string().min(1).max(60).optional(),
    leftRecord: z.string().min(1).max(20).optional(),
    leftForm: z.string().min(1).max(24).optional(),
    rightName: z.string().min(1).max(60).optional(),
    rightRecord: z.string().min(1).max(20).optional(),
    rightForm: z.string().min(1).max(24).optional(),
    ctaHeadline: z.string().min(1).max(80).optional(),
    ctaAction: z.string().min(1).max(60).optional(),
  })
  .strict();

const TreatmentSchema = z
  .object({
    key: z.enum(SCREEN_TREATMENTS),
    copy: TreatmentCopySchema,
    timing: z
      .object({
        enterAtSeconds: z.number().min(0),
        settleSeconds: z.number().gt(0).max(1.2),
        /** The second half of a two-part treatment: a rank change, a sweep. */
        eventAtSeconds: z.number().min(0),
      })
      .strict(),
    /** Where the treatment sits, in output pixels. */
    region: RectSchema.optional(),
    intent: z.string().min(1).max(300),
  })
  .strict();
export type StoryTreatment = z.infer<typeof TreatmentSchema>;

const GradeSchema = z
  .object({
    /**
     * Control points strictly inside the unit square. The endpoints are pinned
     * at 0/0 and 1/1 by the compiler, so a grade lifts midtones and can never
     * raise the black floor or clip a highlight.
     */
    midtonePoints: z
      .array(z.object({ x: z.number().gt(0).lt(1), y: z.number().gt(0).lt(1) }).strict())
      .min(1)
      .max(4),
    saturation: z.number().min(0.6).max(1.4).default(1),
    intent: z.string().min(1).max(300),
  })
  .strict();
export type StoryGrade = z.infer<typeof GradeSchema>;

const MoveSchema = z
  .object({
    startZoom: z.number().min(1).max(1.6),
    endZoom: z.number().min(1).max(1.6),
    /** Offsets the framing away from the plate's own centre, in frame widths. */
    offsetU: z.number().min(-0.4).max(0.4).default(0),
    offsetV: z.number().min(-0.4).max(0.4).default(0),
    intent: z.string().min(1).max(300),
  })
  .strict();
export type StoryMove = z.infer<typeof MoveSchema>;

/**
 * The prediction interaction is one decision, not a page to sit on.
 *
 * Contact to press may not exceed this. It is a stated requirement of the
 * correction and it is enforced rather than trusted, because a tap that takes
 * a second and a half reads as hesitation rather than as the product being
 * quick.
 */
export const PREDICTION_INTERACTION_MAX_SECONDS = 0.9;

/**
 * When the interface moves, in the scene's own seconds.
 *
 * Authored, with no defaults for anything that decides pace. A scroll nobody
 * specified is a scroll nobody approved, and the cadence a row reveals at is
 * art direction, not a constant that happens to look acceptable.
 */
const UiTimelineSchema = z
  .object({
    scroll: z
      .object({
        fromPx: z.number().min(0),
        toPx: z.number().min(0),
        startSeconds: z.number().min(0),
        endSeconds: z.number().positive(),
        easing: z.enum(['LINEAR', 'EASE_OUT_CUBIC', 'EASE_IN_OUT_CUBIC']),
      })
      .strict()
      .optional(),
    reveal: z
      .object({
        count: z.number().int().min(1).max(12),
        firstAtSeconds: z.number().min(0),
        intervalSeconds: z.number().gt(0).max(0.5),
        settleSeconds: z.number().gt(0).max(0.6),
      })
      .strict()
      .optional(),
    interaction: z
      .object({
        contactAtSeconds: z.number().min(0),
        selectedAtSeconds: z.number().min(0),
        pressAtSeconds: z.number().min(0),
        releasedAtSeconds: z.number().min(0),
      })
      .strict()
      .optional(),
  })
  .strict();
export type UiTimeline = z.infer<typeof UiTimelineSchema>;

/**
 * A scene whose picture is the operator's authoritative plate carrying a
 * mapped product interface.
 *
 * This is what replaces the 470px landscape storyboard cards. The plate fills
 * the frame, its four screen corners are calibrated, and the mobile-native
 * document is warped onto them. `fallbackToStoryboardPanel` does not exist and
 * must never be added: a scene that cannot be mapped fails visibly, because a
 * silent return to the card is the defect being corrected.
 */
const UiCompositeSceneSchema = z
  .object({
    kind: z.literal('PLATE_UI_COMPOSITE'),
    sceneNumber: z.number().int().min(1).max(10),
    frameId: z.string().regex(/^FRAME-\d{2}$/),
    plateWidthPx: z.number().int().positive(),
    plateHeightPx: z.number().int().positive(),
    /** Corner positions in the plate's own pixels, measured by an operator. */
    screen: QuadSchema,
    surface: z.enum(PRODUCT_SURFACES),
    uiTimeline: UiTimelineSchema,
    move: MoveSchema,
    plateGrade: GradeSchema.optional(),
    /** Composited over the finished scene, after the interface has landed. */
    treatment: TreatmentSchema.optional(),
    /**
     * The region of the delivery frame that must not read as empty, in output
     * pixels. For a UI scene it is the handset; the check refuses a scene whose
     * screen came out dark, which is what an unmapped interface looks like.
     */
    subjectRegion: RectSchema,
    intent: z.string().min(1).max(400),
  })
  .strict();

/**
 * A scene whose picture is the plate itself, moving deterministically, with no
 * interface on it.
 *
 * Scene 1 is this: the notification hook's plate is a person looking at their
 * phone, the rejected generated take lifted their gaze to the lens, and the
 * action the beat needs comes from the notification arriving rather than from
 * the subject moving.
 */
const PlateMotionSceneSchema = z
  .object({
    kind: z.literal('PLATE_DETERMINISTIC_MOTION'),
    sceneNumber: z.number().int().min(1).max(10),
    frameId: z.string().regex(/^FRAME-\d{2}$/),
    plateWidthPx: z.number().int().positive(),
    plateHeightPx: z.number().int().positive(),
    move: MoveSchema,
    plateGrade: GradeSchema.optional(),
    treatment: TreatmentSchema.optional(),
    subjectRegion: RectSchema,
    intent: z.string().min(1).max(400),
  })
  .strict();

/**
 * A scene whose picture is existing moving footage, given a grade and a
 * screen-space treatment.
 *
 * Nothing here generates, buys or replaces the footage: the clip is whatever
 * the source precedence already resolved, and this only decides how it is
 * exposed and what is laid over it.
 */
const FootageTreatmentSceneSchema = z
  .object({
    kind: z.literal('FOOTAGE_TREATMENT'),
    sceneNumber: z.number().int().min(1).max(10),
    grade: GradeSchema.optional(),
    treatment: TreatmentSchema.optional(),
    /**
     * A second plate composited beside the footage, when the treatment calls
     * for one — scene 2's sport strips are cut from the scene's own plate.
     */
    companionFrameId: z
      .string()
      .regex(/^FRAME-\d{2}$/)
      .optional(),
    /** Where the moving clip sits inside a companion composite, in output pixels. */
    companionClipRect: RectSchema.optional(),
    subjectRegion: RectSchema,
    /**
     * The region the treatment must fill. Declared so an empty one is a named
     * refusal rather than something a reviewer notices in the frames.
     */
    protectedRegion: RectSchema.optional(),
    intent: z.string().min(1).max(400),
  })
  .strict();

const StorySceneSchema = z.discriminatedUnion('kind', [
  UiCompositeSceneSchema,
  PlateMotionSceneSchema,
  FootageTreatmentSceneSchema,
]);
export type StoryScene = z.infer<typeof StorySceneSchema>;
export type UiCompositeScene = z.infer<typeof UiCompositeSceneSchema>;
export type PlateMotionScene = z.infer<typeof PlateMotionSceneSchema>;
export type FootageTreatmentScene = z.infer<typeof FootageTreatmentSceneSchema>;

/**
 * The named human authorisation for the deterministic interfaces.
 *
 * A `PRODUCT_MOCKUP` is honest only while every artefact says what it is, so
 * the grant is data rather than a comment: who gave it, what it covers, and —
 * the part that matters — what it explicitly does not assert.
 */
const AuthorisationSchema = z
  .object({
    reviewer: z.string().min(1).max(200),
    recordedAt: z.string().min(4).max(40),
    grant: z.string().min(1).max(600),
    coveredSurfaces: z.array(z.string().min(1).max(120)).min(1).max(20),
    notAsserted: z.string().min(1).max(600),
  })
  .strict();
export type ProductMockupAuthorisation = z.infer<typeof AuthorisationSchema>;

const TransitionSchema = z
  .object({
    fromScene: z.number().int().min(1).max(9),
    toScene: z.number().int().min(2).max(10),
    /**
     * Closed vocabulary, and it contains no dissolve and no dip to black. Both
     * were named in the rejection; both say the two shots are interchangeable,
     * and this cut is a sequence where each step causes the next.
     */
    kind: z.enum([
      'ACTION_MATCHED_CUT',
      'SCREEN_POSITION_MATCH_CUT',
      'TAP_CUT',
      'IMPACT_CUT',
      'HANDSET_WIPE',
      'UI_MOTION_CONTINUES',
    ]),
    note: z.string().min(1).max(400),
  })
  .strict();
export type StoryTransition = z.infer<typeof TransitionSchema>;

const PlanSchema = z
  .object({
    storyVersion: z.literal(PRODUCT_STORY_VERSION),
    authoredBy: z.string().min(1).max(200),
    brief: z.string().min(1).max(4000),
    authorisation: AuthorisationSchema,
    output: z
      .object({
        widthPx: z.literal(1080),
        heightPx: z.literal(1920),
        frameRate: z.literal(30),
        /** Passed into the render manifest's v2 quality field. */
        qualityCrf: z.number().int().min(14).max(20),
      })
      .strict(),
    scenes: z.array(StorySceneSchema).min(1).max(10),
    transitions: z.array(TransitionSchema).length(9),
  })
  .strict();

export type ProductStoryPlan = z.infer<typeof PlanSchema>;

/**
 * Parses, then checks what a schema cannot.
 *
 * The cross-field rules are the ones the rejection turned into requirements: a
 * scene may not be declared twice, every transition must join two consecutive
 * scenes so the story is continuous, a move must actually be a move where the
 * brief says the picture moves, and a scene declaring a protected region must
 * also declare a treatment to fill it — an empty reserved region is one of the
 * named rejection criteria, and refusing it here is cheaper than finding it in
 * the frames.
 */
export function parseProductStoryPlan(value: unknown, path?: string): ProductStoryPlan {
  const result = PlanSchema.safeParse(value);
  if (!result.success) {
    throw new ProductStoryError(
      'INVALID_STORY_PLAN',
      `the product-story plan${path ? ` at ${path}` : ''} is invalid:\n${result.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  const plan = result.data;
  const failures: string[] = [];

  const seen = new Set<number>();
  for (const scene of plan.scenes) {
    if (seen.has(scene.sceneNumber)) {
      failures.push(`scene ${scene.sceneNumber} is declared more than once`);
    }
    seen.add(scene.sceneNumber);

    if (scene.kind !== 'FOOTAGE_TREATMENT') {
      const { startZoom, endZoom } = scene.move;
      if (Math.abs(endZoom - startZoom) > 0.5) {
        failures.push(
          `scene ${scene.sceneNumber} moves from ${startZoom} to ${endZoom}; a move that large is a ` +
            'reframing, not the restrained push this cut is built from',
        );
      }
    }

    if (scene.kind === 'PLATE_UI_COMPOSITE') {
      const interaction = scene.uiTimeline.interaction;
      if (interaction) {
        const ordered =
          interaction.contactAtSeconds <= interaction.selectedAtSeconds &&
          interaction.selectedAtSeconds <= interaction.pressAtSeconds &&
          interaction.pressAtSeconds <= interaction.releasedAtSeconds;
        if (!ordered) {
          failures.push(
            `scene ${scene.sceneNumber}'s interaction does not run contact → selected → press → release in order`,
          );
        }
        const span = interaction.releasedAtSeconds - interaction.contactAtSeconds;
        if (span > PREDICTION_INTERACTION_MAX_SECONDS + 1e-9) {
          failures.push(
            `scene ${scene.sceneNumber}'s interaction runs ${span.toFixed(3)}s, above the ` +
              `${PREDICTION_INTERACTION_MAX_SECONDS}s ceiling; making a prediction is one decisive action`,
          );
        }
      }
      const scroll = scene.uiTimeline.scroll;
      if (scroll && scroll.endSeconds <= scroll.startSeconds) {
        failures.push(`scene ${scene.sceneNumber}'s scroll ends at or before it starts`);
      }
    }

    if (scene.kind === 'FOOTAGE_TREATMENT' && scene.protectedRegion && !scene.treatment) {
      failures.push(
        `scene ${scene.sceneNumber} reserves a protected region but declares no screen treatment to ` +
          'fill it; a reserved region left empty is a rejection criterion',
      );
    }
    if (scene.kind === 'FOOTAGE_TREATMENT' && scene.companionFrameId && !scene.companionClipRect) {
      failures.push(
        `scene ${scene.sceneNumber} names a companion plate but does not say where the moving clip ` +
          'sits inside the frame, so the composite has no dominant action',
      );
    }
    if (scene.treatment && scene.treatment.key !== 'SPORT_STRIP_REVEAL') {
      const region =
        scene.treatment.region ??
        (scene.kind === 'FOOTAGE_TREATMENT' ? scene.protectedRegion : undefined);
      if (!region) {
        failures.push(
          `scene ${scene.sceneNumber}'s ${scene.treatment.key} treatment fills a region of the frame ` +
            'but no region was declared for it',
        );
      }
    }
  }

  plan.transitions.forEach((transition, index) => {
    if (transition.fromScene !== index + 1 || transition.toScene !== index + 2) {
      failures.push(
        `transition ${index + 1} joins scenes ${transition.fromScene}→${transition.toScene}; the nine ` +
          'transitions must join consecutive scenes in order, so the cut reads as one continuous story',
      );
    }
  });

  if (failures.length > 0) {
    throw new ProductStoryError(
      'INVALID_STORY_PLAN',
      `the product-story plan${path ? ` at ${path}` : ''} does not describe a coherent story:\n${failures
        .map((failure) => `  - ${failure}`)
        .join('\n')}`,
    );
  }
  return plan;
}
