import { z } from 'zod';
import {
  AspectRatioSchema,
  DeliveryPlatformSchema,
  ShotBeatSchema,
  SoundCueTypeSchema,
  TextSafeAreaSchema,
  TransitionTypeSchema,
} from './shared-enums';

/**
 * M12 — one retained segment of the parent master's `Timeline`, expressed as
 * an **exact source frame range plus its position in the variant**. Cut points
 * are never arbitrary time slices: `sourceStartFrame`/`sourceEndFrame` must
 * land on real `TimelineEntry` boundaries (see
 * `workflow/variant-cut-validation.ts`), which is what makes a variant a
 * legal re-cut of the approved master rather than a re-edit of it.
 */
export const VariantCutPointSchema = z.object({
  order: z.number().int().nonnegative(),
  /** Inclusive start frame on the parent Timeline. */
  sourceStartFrame: z.number().int().nonnegative(),
  /** Exclusive end frame on the parent Timeline. */
  sourceEndFrame: z.number().int().positive(),
  /** Where this segment starts in the variant's own timeline. */
  variantStartFrame: z.number().int().nonnegative(),
});
export type VariantCutPoint = z.infer<typeof VariantCutPointSchema>;

/** A parent-timeline clip the cut retained, pinned to the shot and source asset it came from. */
export const RetainedClipSchema = z.object({
  order: z.number().int().nonnegative(),
  shotId: z.string().uuid(),
  shotIndex: z.number().int().nonnegative(),
  /** The SELECTED source asset the parent rough edit pinned — re-checked for currency + licensing before dispatch. */
  sourceAssetId: z.string().uuid(),
  beat: ShotBeatSchema.optional(),
  sourceStartFrame: z.number().int().nonnegative(),
  sourceEndFrame: z.number().int().positive(),
  transitionIn: TransitionTypeSchema.optional(),
});
export type RetainedClip = z.infer<typeof RetainedClipSchema>;

/** A parent `SoundCue` the cut retained, rebased onto the variant's timeline. */
export const RetainedCueSchema = z.object({
  soundCueId: z.string().uuid(),
  type: SoundCueTypeSchema,
  sourceStartFrame: z.number().int().nonnegative(),
  sourceEndFrame: z.number().int().positive(),
  variantStartFrame: z.number().int().nonnegative(),
  assetId: z.string().uuid().optional(),
});
export type RetainedCue = z.infer<typeof RetainedCueSchema>;

/**
 * A caption the variant must burn in. Frame ranges are on the variant's own
 * timeline; `safeArea` is the profile-configured region it must stay inside.
 */
export const RetainedCaptionSchema = z.object({
  text: z.string().min(1),
  variantStartFrame: z.number().int().nonnegative(),
  variantEndFrame: z.number().int().positive(),
  safeArea: TextSafeAreaSchema,
});
export type RetainedCaption = z.infer<typeof RetainedCaptionSchema>;

/**
 * Where the call-to-action lands in the variant. The delivery profile's
 * `ctaTailSeconds` rule is checked against `variantStartFrame` — a CTA that
 * survived the cut but no longer sits in the tail is a cut-point failure, not
 * a rendering problem.
 */
export const CtaPlacementSchema = z.object({
  /** True when the parent master had a CTA beat at all. */
  present: z.boolean(),
  variantStartFrame: z.number().int().nonnegative().optional(),
  variantEndFrame: z.number().int().positive().optional(),
  shotId: z.string().uuid().optional(),
  text: z.string().optional(),
});
export type CtaPlacement = z.infer<typeof CtaPlacementSchema>;

/**
 * M12 — the canonical, immutable, versioned recipe for one delivery variant:
 * exactly which frames of the approved master survive, in what order, with
 * which cues, captions and CTA. One row per (campaign, parent master, target
 * duration, version).
 *
 * Pins the full provenance chain the variant was computed from — parent
 * `FINAL_MASTER`, concept/script/shot-selection/rough-edit/sound-design
 * versions, and the delivery profile version — so a variant is always
 * traceable to the exact approved artifacts behind it, and a stale master or
 * superseded upstream version can be detected rather than silently re-cut.
 *
 * Immutable once approved for export (`approvedForExportAt` set): the
 * repository refuses to supersede or re-version such a row. Content-only
 * fields mirror the Variant Generator agent's structured output; every id,
 * version and provenance field on this schema is assigned by the Activity at
 * persistence time (agents never write to the database).
 */
export const VariantSpecificationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  version: z.number().int().positive(),

  // --- Parent + upstream provenance (all pinned, never re-derived later) ---
  /** The approved FINAL_MASTER asset this variant is cut from. */
  parentMasterAssetId: z.string().uuid(),
  /** The FINAL_QA assessment that passed the parent master. */
  parentFinalQaAssessmentId: z.string().uuid(),
  timelineId: z.string().uuid(),
  timelineVersion: z.number().int().positive(),
  creativeConceptId: z.string().uuid(),
  creativeConceptVersion: z.number().int().positive(),
  scriptId: z.string().uuid(),
  scriptVersion: z.number().int().positive(),
  shotSelectionSetId: z.string().uuid(),
  shotSelectionSetVersion: z.number().int().positive(),
  roughEditSpecificationId: z.string().uuid(),
  roughEditSpecificationVersion: z.number().int().positive(),
  soundDesignPlanId: z.string().uuid(),
  soundDesignPlanVersion: z.number().int().positive(),

  // --- Target delivery profile ---
  deliveryProfileId: z.string().uuid(),
  deliveryProfileKey: z.string().min(1),
  deliveryProfileVersion: z.number().int().positive(),
  /** The per-platform row the resulting CreativeVariant is attached to. */
  deliverySpecificationId: z.string().uuid(),
  platform: DeliveryPlatformSchema,
  targetDurationSeconds: z.number().int().positive(),
  targetDurationFrames: z.number().int().positive(),
  aspectRatio: AspectRatioSchema,
  resolutionWidth: z.number().int().positive(),
  resolutionHeight: z.number().int().positive(),
  frameRate: z.number().int().positive(),

  // --- The cut itself ---
  cutPoints: z.array(VariantCutPointSchema).min(1),
  retainedClips: z.array(RetainedClipSchema).min(1),
  retainedCues: z.array(RetainedCueSchema).default([]),
  retainedCaptions: z.array(RetainedCaptionSchema).default([]),
  ctaPlacement: CtaPlacementSchema,
  captionBurnRequired: z.boolean(),
  safeAreas: z.array(TextSafeAreaSchema).min(1),

  // --- Rationale + rubric ---
  /** Why these frames survived and what was dropped — the reviewable narrative justification. */
  cutRationale: z.string().min(1),
  removedRationale: z.array(z.string()).default([]),
  qualityRubric: z.array(z.string()).default([]),

  // --- Provenance ---
  promptVersionId: z.string().uuid(),
  createdByAgentInvocationId: z.string().uuid(),
  /** Set once the variant passed Final QA and was frozen — the row is immutable from then on. */
  approvedForExportAt: z.date().optional(),
  /** Set when a later version supersedes this one (a VARIANT_QA repair loop). */
  supersededAt: z.date().optional(),
  createdAt: z.date(),
});
export type VariantSpecification = z.infer<typeof VariantSpecificationSchema>;
