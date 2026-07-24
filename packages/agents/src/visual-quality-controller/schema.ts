import { z } from 'zod';
import { CriterionScoreSchema, QualityFindingSchema } from '../shared/quality-finding';

export const VisualQualityControllerInputSchema = z.object({
  shot: z.object({
    index: z.number().int().nonnegative(),
    description: z.string().min(1),
    durationFrames: z.number().int().positive(),
  }),
  providerId: z.string().min(1),
  candidateRef: z.string().min(1),
  /** How many frames were extracted as `attachments` for this assessment. */
  frameCount: z.number().int().positive(),
});
export type VisualQualityControllerInput = z.infer<typeof VisualQualityControllerInputSchema>;

/**
 * Mirrors `@combat/domain`'s `QualityAssessment` + `QualityFailure` content
 * fields. `pass` is deliberately *not* asked for directly from the model —
 * see `agent.ts`'s `deriveEvaluation`, which computes it as the AND of every
 * `criterionScores` entry so the rubric, not a separately-stated boolean, is
 * the single source of truth for pass/fail (requirement 13).
 */
export const VisualQualityControllerResultSchema = z.object({
  criterionScores: z.array(CriterionScoreSchema).min(1),
  findings: z.array(QualityFindingSchema).default([]),
});
export type VisualQualityControllerResult = z.infer<typeof VisualQualityControllerResultSchema>;
