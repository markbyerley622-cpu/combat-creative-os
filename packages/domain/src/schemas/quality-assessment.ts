import { z } from 'zod';
import { CampaignStageSchema } from '../workflow/campaign-stage';
import {
  AssessedBySchema,
  QualityFailureCategorySchema,
  QualityFailureSeveritySchema,
} from './shared-enums';

/**
 * Assesses either a GenerationCandidate (per-shot QA) or a stage-output Asset
 * (compositing/rough-cut/sound-design/final-master QA) — exactly one of
 * `generationCandidateId` / `assetId` is set. This is an application-level
 * invariant (checked by the repository layer before insert); Postgres CHECK
 * constraints for cross-column XOR are not modeled declaratively in the
 * current Prisma version, so it's enforced in code and covered by tests
 * rather than by a database constraint.
 *
 * `subjectStage` disambiguates *which* stage's output this assessment
 * concerns, since several stages (VISUAL_QA/CONTINUITY_QA for a candidate;
 * COMPOSITING/ROUGH_CUT/SOUND_DESIGN/FINAL_QA for an asset) can all produce
 * assessments over the same generic subject shape — see
 * docs/domain-model.md §5 and `transition-facts.ts` for how this field
 * prevents an assessment produced for one stage from being mistaken for
 * another's.
 */
export const QualityAssessmentSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    generationCandidateId: z.string().uuid().optional(),
    assetId: z.string().uuid().optional(),
    subjectStage: CampaignStageSchema.optional(),
    pass: z.boolean(),
    scores: z.record(z.string(), z.number()).default({}),
    assessedBy: AssessedBySchema,
    createdAt: z.date(),
  })
  .refine((qa) => Boolean(qa.generationCandidateId) !== Boolean(qa.assetId), {
    message: 'exactly one of generationCandidateId or assetId must be set',
  });
export type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;

export const QualityFailureSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  qualityAssessmentId: z.string().uuid(),
  category: QualityFailureCategorySchema,
  severity: QualityFailureSeveritySchema,
  description: z.string().min(1),
  suggestedAction: z.string().optional(),
  createdAt: z.date(),
});
export type QualityFailure = z.infer<typeof QualityFailureSchema>;
