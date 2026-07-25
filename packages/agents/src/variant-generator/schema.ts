import { z } from 'zod';
import { DeliveryPlatformSchema, ShotBeatSchema, TextSafeAreaSchema } from '@combat/domain';

/**
 * M12 — a legal cut boundary the agent may use, derived by the Activity from
 * the parent master's persisted `Timeline` entries. The agent may only ever
 * start or end a kept range on one of these edges; it never invents a frame
 * number of its own. Descriptions/beats are supplied so the cut is a narrative
 * decision rather than an arithmetic one.
 */
export const VariantTimelineSegmentSchema = z.object({
  order: z.number().int().nonnegative(),
  shotId: z.string().uuid(),
  shotIndex: z.number().int().nonnegative(),
  description: z.string(),
  beat: ShotBeatSchema.optional(),
  startFrame: z.number().int().nonnegative(),
  /** Exclusive. */
  endFrame: z.number().int().positive(),
});
export type VariantTimelineSegment = z.infer<typeof VariantTimelineSegmentSchema>;

export const VariantSpanSchema = z.object({
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
});
export type VariantSpan = z.infer<typeof VariantSpanSchema>;

/**
 * Everything the Variant Generator is allowed to see: the approved master's
 * legal boundaries and delivery requirements, and nothing else. No repository
 * handle, no storage key, no other agent's output — the Activity resolves all
 * of that and passes only this validated, workspace-scoped view.
 *
 * **M12 supersedes the thinner M0 contract** (`finalMasterDurationFrames` +
 * `mustKeepFrameRanges` → a bare `{startFrame,endFrame}[]`), which could not
 * express a legal cut: it had no timeline boundaries to snap to, no caption or
 * CTA plan, and no rationale. Same "the agent's real output is the fuller
 * shape" supersession M6 applied to `ShotPrompt` → `ShotSpecification`
 * (docs/architecture.md §5).
 */
export const VariantGeneratorInputSchema = z.object({
  masterDurationFrames: z.number().int().positive(),
  frameRate: z.number().int().positive().default(30),
  targetDurationSeconds: z.number().int().positive(),
  platform: DeliveryPlatformSchema,
  aspectRatio: z.string().min(1),
  resolutionWidth: z.number().int().positive(),
  resolutionHeight: z.number().int().positive(),
  /** The ONLY legal cut boundaries — ordered, contiguous, from the persisted Timeline. */
  timelineSegments: z.array(VariantTimelineSegmentSchema).min(1),
  /** Discrete SFX/VO cue spans a cut may not land inside (a continuous music bed is excluded — it is re-mixed to length). */
  discreteAudioCues: z.array(VariantSpanSchema).default([]),
  /** Caption spans on the parent timeline a cut may not split. */
  captionSegments: z.array(VariantSpanSchema).default([]),
  /** The parent master's CTA span, when it has one. */
  ctaSegment: VariantSpanSchema.optional(),
  captionBurnRequired: z.boolean().default(true),
  safeAreas: z.array(TextSafeAreaSchema).min(1),
  /** The CTA must remain visible within this many seconds of the variant's end. */
  ctaTailSeconds: z.number().int().positive().optional(),
  /** Below this target duration the CTA-retention rule does not apply. */
  ctaMinimumDurationSeconds: z.number().int().positive().optional(),
});
export type VariantGeneratorInput = z.infer<typeof VariantGeneratorInputSchema>;

/** One retained range, expressed in source-master frames plus its position in the variant. */
export const CutPointSchema = z.object({
  order: z.number().int().nonnegative(),
  sourceStartFrame: z.number().int().nonnegative(),
  sourceEndFrame: z.number().int().positive(),
  variantStartFrame: z.number().int().nonnegative(),
});
export type CutPoint = z.infer<typeof CutPointSchema>;

export const VariantCaptionPlanSchema = z.object({
  text: z.string().min(1),
  variantStartFrame: z.number().int().nonnegative(),
  variantEndFrame: z.number().int().positive(),
  safeArea: TextSafeAreaSchema,
});
export type VariantCaptionPlan = z.infer<typeof VariantCaptionPlanSchema>;

export const VariantCtaPlanSchema = z.object({
  present: z.boolean(),
  variantStartFrame: z.number().int().nonnegative().optional(),
  variantEndFrame: z.number().int().positive().optional(),
  shotId: z.string().uuid().optional(),
  text: z.string().optional(),
});
export type VariantCtaPlan = z.infer<typeof VariantCtaPlanSchema>;

/**
 * Content-only mirror of `@combat/domain`'s `VariantSpecification` — the
 * creative decision (which frames survive, where the CTA and captions land,
 * and why), with no id, workspaceId, version or foreign key. The Activity
 * assigns those, and derives the mechanical `retainedClips`/`retainedCues`
 * pins (source asset, transition, cue asset) by intersecting these cut points
 * with the persisted rough edit and sound-design plan — so the agent never
 * needs to know an asset id, and never writes to the database.
 */
export const VariantGeneratorResultSchema = z.object({
  targetDurationSeconds: z.number().int().positive(),
  cutPoints: z.array(CutPointSchema).min(1),
  /** Shot ids retained, in narrative order — the Activity resolves each to its pinned source asset. */
  retainedShotIds: z.array(z.string().uuid()).min(1),
  retainedCaptions: z.array(VariantCaptionPlanSchema).default([]),
  ctaPlacement: VariantCtaPlanSchema,
  /** Why these frames survived — the reviewable narrative justification. */
  cutRationale: z.string().min(1),
  /** What was dropped and why, one entry per removal. */
  removedRationale: z.array(z.string()).default([]),
  qualityRubric: z.array(z.string()).default([]),
});
export type VariantGeneratorResult = z.infer<typeof VariantGeneratorResultSchema>;
