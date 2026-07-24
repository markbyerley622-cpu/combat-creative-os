import { z } from 'zod';
import { QualityFailureSeveritySchema } from '@combat/domain';
import { CriterionScoreSchema } from '../shared/quality-finding';

export const ContinuityControllerInputSchema = z.object({
  scriptShots: z
    .array(z.object({ index: z.number().int().nonnegative(), description: z.string().min(1) }))
    .min(1),
  selectedCandidateSummaries: z
    .array(
      z.object({
        shotIndex: z.number().int().nonnegative(),
        providerId: z.string().min(1),
        visualSummary: z.string().min(1),
      }),
    )
    .min(1),
});
export type ContinuityControllerInput = z.infer<typeof ContinuityControllerInputSchema>;

export const ContinuityConflictSchema = z.object({
  shotIndices: z.array(z.number().int().nonnegative()).min(1),
  issue: z.string().min(1),
  severity: QualityFailureSeveritySchema,
});
export type ContinuityConflict = z.infer<typeof ContinuityConflictSchema>;

export const ContinuityControllerResultSchema = z.object({
  criterionScores: z.array(CriterionScoreSchema).min(1),
  conflicts: z.array(ContinuityConflictSchema).default([]),
});
export type ContinuityControllerResult = z.infer<typeof ContinuityControllerResultSchema>;
