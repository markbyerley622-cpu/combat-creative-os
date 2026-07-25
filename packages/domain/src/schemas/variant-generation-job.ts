import { z } from 'zod';
import {
  VariantGenerationAttemptStatusSchema,
  VariantGenerationFailureReasonSchema,
  VariantGenerationJobStatusSchema,
} from './shared-enums';

/**
 * M12 — groups the bounded-retry render attempts for one
 * `VariantSpecification`. Mutable status row; one job per specification (the
 * same "mutable status row, immutable attempt history" split
 * `ShotGenerationJob`/`CompositionJob` already establish).
 */
export const VariantGenerationJobSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  variantSpecificationId: z.string().uuid(),
  status: VariantGenerationJobStatusSchema,
  maxAttempts: z.number().int().positive(),
  attemptCount: z.number().int().nonnegative().default(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type VariantGenerationJob = z.infer<typeof VariantGenerationJobSchema>;

/**
 * One immutable, append-only variant-render attempt. Carries the provider
 * project/job ids, the budget reservation and actual usage, and terminal
 * failure detail — the full provider/budget provenance for one dispatch.
 * `idempotencyKey` is unique per job, so a replayed Activity call never
 * double-submits or double-reserves.
 */
export const VariantGenerationAttemptSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  variantGenerationJobId: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  providerId: z.string().min(1),
  providerProjectId: z.string().optional(),
  providerJobId: z.string().optional(),
  status: VariantGenerationAttemptStatusSchema,
  budgetReservationId: z.string().optional(),
  estimatedCostCents: z.number().int().nonnegative().optional(),
  actualCostCents: z.number().int().nonnegative().optional(),
  /** The registered VARIANT asset, set once the attempt SUCCEEDED. */
  outputAssetId: z.string().uuid().optional(),
  failureReason: VariantGenerationFailureReasonSchema.optional(),
  failureRetryable: z.boolean().optional(),
  failureMessage: z.string().optional(),
  startedAt: z.date(),
  completedAt: z.date().optional(),
  createdAt: z.date(),
});
export type VariantGenerationAttempt = z.infer<typeof VariantGenerationAttemptSchema>;
