import { z } from 'zod';
import { ShotGenerationJobStatusSchema } from './shared-enums';

/**
 * Groups the bounded-retry attempt sequence (`ShotGenerationAttempt` rows)
 * for one `ShotSpecification`. Mutable status/updatedAt row — same pattern
 * already established by `RenderJob`/`CreativeVariant` in this package —
 * because a job's status legitimately changes as attempts are dispatched
 * and resolved, unlike the immutable/versioned entities elsewhere in this
 * schema. One job exists per `shotSpecificationId` (the *latest*
 * ShotSpecification version for a shot); a stale-version specification never
 * gets a new job — see `runShotPromptEngineerActivity`'s stale-version
 * rejection.
 */
export const ShotGenerationJobSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  shotSpecificationId: z.string().uuid(),
  status: ShotGenerationJobStatusSchema,
  requestedCandidateCount: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  attemptCount: z.number().int().nonnegative().default(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ShotGenerationJob = z.infer<typeof ShotGenerationJobSchema>;
