import { z } from 'zod';
import { QualityFailureCategorySchema, QualityFailureSeveritySchema } from '@combat/domain';

/**
 * Shared shape for a single QA finding, reused by every QA-category agent
 * (visual-quality-controller, continuity-controller, final-qa-controller).
 * Mirrors `@combat/domain`'s `QualityFailureSchema` content fields (minus
 * `id`/`workspaceId`/`qualityAssessmentId`/`createdAt`, which a future
 * Activity assigns at persistence time).
 */
export const QualityFindingSchema = z.object({
  category: QualityFailureCategorySchema,
  severity: QualityFailureSeveritySchema,
  description: z.string().min(1),
  suggestedAction: z.string().optional(),
});
export type QualityFinding = z.infer<typeof QualityFindingSchema>;

export const CriterionScoreSchema = z.object({
  criterionId: z.string().min(1),
  pass: z.boolean(),
  score: z.number(),
  note: z.string().optional(),
});
export type CriterionScore = z.infer<typeof CriterionScoreSchema>;
