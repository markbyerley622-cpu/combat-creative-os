import { z } from 'zod';
import { DeliveryPlatformSchema } from '@combat/domain';
import { CriterionScoreSchema, QualityFindingSchema } from '../shared/quality-finding';

export const FinalQaControllerInputSchema = z.object({
  technicalProbe: z.object({
    durationSeconds: z.number().positive(),
    resolutionWidth: z.number().int().positive(),
    resolutionHeight: z.number().int().positive(),
    integratedLoudnessLufs: z.number(),
    hasBurnedInCaptions: z.boolean(),
  }),
  deliverySpecification: z.object({
    platform: DeliveryPlatformSchema,
    aspectRatio: z.string().min(1),
    durationSeconds: z.number().int().positive(),
    captionBurnRequired: z.boolean().default(false),
    targetLoudnessLufs: z.number().default(-14),
  }),
});
export type FinalQaControllerInput = z.infer<typeof FinalQaControllerInputSchema>;

/** Mirrors `@combat/domain`'s `QualityAssessment` + `QualityFailure` content fields. */
export const FinalQaControllerResultSchema = z.object({
  criterionScores: z.array(CriterionScoreSchema).min(1),
  findings: z.array(QualityFindingSchema).default([]),
});
export type FinalQaControllerResult = z.infer<typeof FinalQaControllerResultSchema>;
