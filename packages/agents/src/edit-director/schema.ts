import { z } from 'zod';
import { TransitionTypeSchema } from '@combat/domain';

export const EditDirectorInputSchema = z.object({
  frameRate: z.number().int().positive().default(30),
  selectedShots: z
    .array(
      z.object({
        shotIndex: z.number().int().nonnegative(),
        durationFrames: z.number().int().positive(),
        compositingAssetRef: z.string().optional(),
      }),
    )
    .min(1),
  targetTotalDurationFrames: z.number().int().positive(),
});
export type EditDirectorInput = z.infer<typeof EditDirectorInputSchema>;

export const TimelineEntryPlanSchema = z.object({
  shotIndex: z.number().int().nonnegative(),
  order: z.number().int().nonnegative(),
  startFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
  transitionIn: TransitionTypeSchema.optional(),
});
export type TimelineEntryPlan = z.infer<typeof TimelineEntryPlanSchema>;

/** Mirrors `@combat/domain`'s `TimelineSchema` content fields (entries keyed by shotIndex, not a persisted shotId yet). */
export const EditDirectorResultSchema = z.object({
  frameRate: z.number().int().positive(),
  durationFrames: z.number().int().positive(),
  entries: z.array(TimelineEntryPlanSchema).min(1),
});
export type EditDirectorResult = z.infer<typeof EditDirectorResultSchema>;
