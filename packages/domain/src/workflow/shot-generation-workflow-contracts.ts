import { z } from 'zod';

/**
 * Serializable contracts for `ShotGenerationWorkflow` — mirrors
 * `campaign-production-workflow-contracts.ts`'s doc comment: parsed at the
 * boundary where untrusted/over-the-wire data enters the system, never
 * inside `packages/workflows/src/workflows/*` itself (workflow files import
 * these shapes with `import type` only).
 */

/** Matches `MAX_SHOT_GENERATION_ATTEMPTS` (packages/database's transition-facts.ts) — kept as an independent default here since this package may not depend on `@combat/database`. */
export const DEFAULT_MAX_GENERATION_ATTEMPTS = 3;
/** "Bounded parallel batches" (M6 requirement 5) — how many shots this workflow dispatches/polls concurrently at once. */
export const DEFAULT_GENERATION_BATCH_SIZE = 3;
export const DEFAULT_POLL_INTERVAL_MS = 2000;

export const ShotGenerationWorkflowInputSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  workflowRunId: z.string().min(1),
  shotSpecificationIds: z.array(z.string().uuid()).min(1),
  maxAttempts: z.number().int().positive().default(DEFAULT_MAX_GENERATION_ATTEMPTS),
  batchSize: z.number().int().positive().default(DEFAULT_GENERATION_BATCH_SIZE),
  pollIntervalMs: z.number().int().positive().default(DEFAULT_POLL_INTERVAL_MS),
});
export type ShotGenerationWorkflowInput = z.infer<typeof ShotGenerationWorkflowInputSchema>;

export const SHOT_GENERATION_WORKFLOW_STATUSES = ['COMPLETED', 'BLOCKED', 'CANCELLED'] as const;
export const ShotGenerationWorkflowStatusSchema = z.enum(SHOT_GENERATION_WORKFLOW_STATUSES);
export type ShotGenerationWorkflowStatus = z.infer<typeof ShotGenerationWorkflowStatusSchema>;

export const ShotGenerationShotResultSchema = z.object({
  shotSpecificationId: z.string().uuid(),
  status: z.enum(['SUCCEEDED', 'FAILED', 'RETRY_EXHAUSTED', 'CANCELLED']),
  candidateAssetIds: z.array(z.string().uuid()).default([]),
  failureReason: z.string().optional(),
  failureMessage: z.string().optional(),
});
export type ShotGenerationShotResult = z.infer<typeof ShotGenerationShotResultSchema>;

export const ShotGenerationWorkflowOutputSchema = z.object({
  status: ShotGenerationWorkflowStatusSchema,
  shotResults: z.array(ShotGenerationShotResultSchema),
});
export type ShotGenerationWorkflowOutput = z.infer<typeof ShotGenerationWorkflowOutputSchema>;
