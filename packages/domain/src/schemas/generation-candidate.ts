import { z } from 'zod';
import { AspectRatioSchema, GenerationCandidateStatusSchema } from './shared-enums';

/**
 * One requested video-generation output (`candidateIndex` within its
 * attempt's `candidateCount`). Identity/provenance is split across two FKs:
 * `shotSpecificationId` pins which generation brief this candidate answers,
 * `shotGenerationAttemptId` pins which specific provider submission (and
 * therefore which provider job id, seed, retry number) produced it —
 * `ShotGenerationAttempt` is the single source of truth for provider job
 * identity, so it is not duplicated here. `assetId` is set only once the
 * candidate's output has been registered through the asset lifecycle
 * (`createAssetWithProvenance`); until then this row exists purely as
 * generation-progress bookkeeping.
 */
export const GenerationCandidateSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  shotSpecificationId: z.string().uuid(),
  shotGenerationAttemptId: z.string().uuid(),
  candidateIndex: z.number().int().nonnegative(),
  assetId: z.string().uuid().optional(),
  providerCandidateRef: z.string().optional(),
  seed: z.number().int().optional(),
  durationSeconds: z.number().positive().optional(),
  aspectRatio: AspectRatioSchema.optional(),
  status: GenerationCandidateStatusSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type GenerationCandidate = z.infer<typeof GenerationCandidateSchema>;
