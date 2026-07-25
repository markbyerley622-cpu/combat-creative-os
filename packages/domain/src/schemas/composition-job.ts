import { z } from 'zod';
import {
  CompositionAttemptStatusSchema,
  CompositionFailureReasonSchema,
  CompositionJobStatusSchema,
} from './shared-enums';

/**
 * M9 — groups the bounded-retry render attempts for one
 * `RoughEditSpecification`. Mutable status row (same pattern as
 * ShotGenerationJob); one job per rough-edit specification.
 */
export const CompositionJobSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  roughEditSpecificationId: z.string().uuid(),
  status: CompositionJobStatusSchema,
  maxAttempts: z.number().int().positive(),
  attemptCount: z.number().int().nonnegative().default(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type CompositionJob = z.infer<typeof CompositionJobSchema>;

/**
 * One immutable, append-only render attempt within a `CompositionJob`. Carries
 * the provider composition-project id + render-job id, the budget reservation
 * and actual usage, and terminal-failure detail — the full provider/budget
 * provenance for one dispatch. `idempotencyKey` is unique per job so a replayed
 * Activity call never double-submits or double-reserves.
 */
export const CompositionAttemptSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  compositionJobId: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  providerId: z.string().min(1),
  providerProjectId: z.string().optional(),
  providerJobId: z.string().optional(),
  status: CompositionAttemptStatusSchema,
  budgetReservationId: z.string().optional(),
  estimatedCostCents: z.number().int().nonnegative().optional(),
  actualCostCents: z.number().int().nonnegative().optional(),
  /** The registered rough-edit asset, set once the attempt SUCCEEDED. */
  outputAssetId: z.string().uuid().optional(),
  failureReason: CompositionFailureReasonSchema.optional(),
  failureRetryable: z.boolean().optional(),
  failureMessage: z.string().optional(),
  startedAt: z.date(),
  completedAt: z.date().optional(),
  createdAt: z.date(),
});
export type CompositionAttempt = z.infer<typeof CompositionAttemptSchema>;
