import { z } from 'zod';
import { DeliveryPlatformSchema } from '@combat/domain';

export const VariantGeneratorInputSchema = z.object({
  finalMasterDurationFrames: z.number().int().positive(),
  frameRate: z.number().int().positive().default(30),
  deliverySpecificationId: z.string().uuid(),
  targetDurationSeconds: z.number().int().positive(),
  platform: DeliveryPlatformSchema,
  /** Frame ranges the Script Director marked HOOK/CTA — must survive every cutdown. */
  mustKeepFrameRanges: z
    .array(z.object({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() }))
    .default([]),
});
export type VariantGeneratorInput = z.infer<typeof VariantGeneratorInputSchema>;

export const CutPointSchema = z.object({
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
});
export type CutPoint = z.infer<typeof CutPointSchema>;

/** Content-only mirror of `@combat/domain`'s `CreativeVariantSchema` (no id/assetId/status — assigned by the Activity that renders it). */
export const VariantGeneratorResultSchema = z.object({
  durationSeconds: z.number().int().positive(),
  cutPoints: z.array(CutPointSchema).min(1),
});
export type VariantGeneratorResult = z.infer<typeof VariantGeneratorResultSchema>;
