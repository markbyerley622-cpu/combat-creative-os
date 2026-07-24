import { z } from 'zod';

/**
 * The explicit rubric a QA-category agent (visual-quality-controller,
 * continuity-controller, final-qa-controller) evaluates against —
 * requirement 13: "QA agents must evaluate against explicit rubrics."
 * Attached to those agents' `AgentDefinition.rubric`; a registry-level test
 * asserts every QA-category agent has one and every non-QA agent does not.
 */
export const QualityRubricCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /** Relative weight within the rubric; need not sum to 1 across criteria. */
  weight: z.number().positive(),
});
export type QualityRubricCriterion = z.infer<typeof QualityRubricCriterionSchema>;

export const QualityRubricSchema = z.object({
  id: z.string().min(1),
  criteria: z.array(QualityRubricCriterionSchema).min(1),
});
export type QualityRubric = z.infer<typeof QualityRubricSchema>;

/**
 * The scored result of evaluating a subject against a `QualityRubric`. A QA
 * agent's structured output embeds one of these (see e.g.
 * `visual-quality-controller/schema.ts`) so a pass/fail decision is always
 * traceable to per-criterion scores rather than an opaque boolean.
 */
export const AgentEvaluationSchema = z.object({
  rubricId: z.string().min(1),
  overallPass: z.boolean(),
  criterionScores: z.array(
    z.object({
      criterionId: z.string().min(1),
      pass: z.boolean(),
      score: z.number(),
      note: z.string().optional(),
    }),
  ),
});
export type AgentEvaluation = z.infer<typeof AgentEvaluationSchema>;
