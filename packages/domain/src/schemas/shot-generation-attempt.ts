import { z } from 'zod';
import {
  ShotGenerationAttemptStatusSchema,
  ShotGenerationFailureReasonSchema,
} from './shared-enums';
import { ShotGenerationParamsSchema } from './shot-specification';

/**
 * One bounded-retry attempt within a `ShotGenerationJob` — the append-only
 * history requirement 8 asks for ("retry history"). `idempotencyKey` is the
 * deterministic `(workflowRunId, stage, shotSpecificationId, attemptNumber)`
 * key handed to both the video-generation provider and the budget
 * reservation for this attempt, so a replayed/retried Activity call is safe
 * (CLAUDE.md workflow-idempotency rules). `budgetReservationId` points at
 * the `BudgetLedgerEntry` RESERVATION row this attempt consumed — the
 * "generation-attempt" budget granularity requirement 6 asks for is
 * satisfied by giving every attempt its own reservation under the existing
 * SHOT/PROVIDER `BudgetLevel`s, not by adding a fifth `BudgetLevel` (the
 * four-level enum is an explicitly resolved decision — docs/domain-model.md
 * §8).
 */
export const ShotGenerationAttemptSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  shotGenerationJobId: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  providerId: z.string().min(1),
  providerJobId: z.string().optional(),
  status: ShotGenerationAttemptStatusSchema,
  requestedCandidateCount: z.number().int().positive(),
  seed: z.number().int().optional(),
  generationParams: ShotGenerationParamsSchema,
  budgetReservationId: z.string().uuid().optional(),
  estimatedCostCents: z.number().int().nonnegative().optional(),
  actualCostCents: z.number().int().nonnegative().optional(),
  failureReason: ShotGenerationFailureReasonSchema.optional(),
  failureRetryable: z.boolean().optional(),
  failureMessage: z.string().optional(),
  startedAt: z.date(),
  completedAt: z.date().optional(),
  createdAt: z.date(),
});
export type ShotGenerationAttempt = z.infer<typeof ShotGenerationAttemptSchema>;
