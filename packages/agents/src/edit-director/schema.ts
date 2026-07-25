import { z } from 'zod';
import {
  DeliveryPlatformSchema,
  RoughEditOverlayKindSchema,
  ShotBeatSchema,
  TransitionTypeSchema,
} from '@combat/domain';

/**
 * M9 (prompt v2) — extended from the thin v1 (order/startFrame/transition only)
 * to the full creative rough-edit brief. The Edit Director now receives the
 * approved, licensed source asset ref + beat for each selected shot and the
 * delivery context, and produces the creative half of the
 * `RoughEditSpecification`: per-clip in/out timing, transitions, continuity
 * notes, overlays (graphic/app-interface/typography/CTA/caption), pacing/beat
 * structure, downstream placeholders, edit rationale, and a quality rubric.
 * The Activity assembles this with the persisted output-format/resolution and
 * source-asset provenance into the canonical `RoughEditSpecification`.
 */
export const EditDirectorSelectedShotSchema = z.object({
  shotIndex: z.number().int().nonnegative(),
  beat: ShotBeatSchema,
  description: z.string().min(1),
  durationFrames: z.number().int().positive(),
  /** The SELECTED candidate's registered source asset (opaque ref, never a storage key). */
  sourceAssetRef: z.string().min(1),
});

export const EditDirectorInputSchema = z.object({
  frameRate: z.number().int().positive().default(30),
  aspectRatio: z.string().min(1),
  platform: DeliveryPlatformSchema,
  targetTotalDurationFrames: z.number().int().positive(),
  brandTokens: z.array(z.string()).default([]),
  selectedShots: z.array(EditDirectorSelectedShotSchema).min(1),
});
export type EditDirectorInput = z.infer<typeof EditDirectorInputSchema>;

export const TimelineEntryPlanSchema = z.object({
  shotIndex: z.number().int().nonnegative(),
  order: z.number().int().nonnegative(),
  startFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
  sourceInFrame: z.number().int().nonnegative(),
  sourceOutFrame: z.number().int().positive(),
  transitionIn: TransitionTypeSchema.optional(),
  continuityNote: z.string().optional(),
});
export type TimelineEntryPlan = z.infer<typeof TimelineEntryPlanSchema>;

export const EditDirectorOverlaySchema = z.object({
  kind: RoughEditOverlayKindSchema,
  shotIndex: z.number().int().nonnegative().optional(),
  description: z.string().min(1),
});
export type EditDirectorOverlay = z.infer<typeof EditDirectorOverlaySchema>;

export const EditDirectorResultSchema = z.object({
  frameRate: z.number().int().positive(),
  durationFrames: z.number().int().positive(),
  entries: z.array(TimelineEntryPlanSchema).min(1),
  pacingNotes: z.string().min(1),
  beatStructure: z
    .array(z.object({ beat: ShotBeatSchema, shotIndices: z.array(z.number().int().nonnegative()) }))
    .default([]),
  continuityNotes: z.array(z.string()).default([]),
  overlays: z.array(EditDirectorOverlaySchema).default([]),
  captionPlaceholder: z.string().min(1),
  musicPlaceholder: z.string().min(1),
  sfxPlaceholder: z.string().min(1),
  editRationale: z.string().min(1),
  qualityRubric: z.array(z.string()).default([]),
});
export type EditDirectorResult = z.infer<typeof EditDirectorResultSchema>;
