import { z } from 'zod';
import {
  VariantGenerationAttemptStatusSchema,
  VariantGenerationFailureReasonSchema,
} from '../schemas/shared-enums';

/** M12 defaults for the VariantWorkflow child (mirrors the compositing contract's default block). */
export const DEFAULT_MAX_VARIANT_ATTEMPTS = 3;
export const DEFAULT_VARIANT_POLL_INTERVAL_MS = 2000;

/**
 * Deterministic Temporal workflow ID for a campaign's VariantWorkflow child —
 * derived from the campaign business key (not the parent's random
 * `workflowRunId`) so `apps/api`'s cancel endpoint can target the exact child
 * execution the parent started. Both the parent (`executeChild` workflowId)
 * and the API (cancel signal) MUST use this. Same rationale as
 * `compositingChildWorkflowId`.
 */
export function variantChildWorkflowId(campaignId: string): string {
  return `variants:${campaignId}`;
}

export const VariantWorkflowInputSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  workflowRunId: z.string().min(1),
  /** The delivery profile key whose durations drive how many variants are cut. */
  deliveryProfileKey: z.string().min(1).default('VERTICAL_SHORT_FORM_V1'),
  /** 1-based; distinguishes each VARIANT_GENERATION visit (a VARIANT_QA repair revisit re-cuts). */
  revisionAttempt: z.number().int().positive().default(1),
  motionGraphicsProviderId: z.string().min(1).default('mock-motion-graphics'),
  maxAttempts: z.number().int().positive().default(DEFAULT_MAX_VARIANT_ATTEMPTS),
  pollIntervalMs: z.number().int().positive().default(DEFAULT_VARIANT_POLL_INTERVAL_MS),
});
export type VariantWorkflowInput = z.infer<typeof VariantWorkflowInputSchema>;

export const VARIANT_WORKFLOW_STATUSES = ['COMPLETED', 'BLOCKED', 'CANCELLED'] as const;
export const VariantWorkflowStatusSchema = z.enum(VARIANT_WORKFLOW_STATUSES);
export type VariantWorkflowStatus = z.infer<typeof VariantWorkflowStatusSchema>;

export const VariantWorkflowResultEntrySchema = z.object({
  variantSpecificationId: z.string().uuid(),
  targetDurationSeconds: z.number().int().positive(),
  creativeVariantId: z.string().uuid().optional(),
  variantAssetId: z.string().uuid().optional(),
  /** Whether this variant's Final QA re-run passed. */
  qaPassed: z.boolean(),
  failureReason: VariantGenerationFailureReasonSchema.optional(),
  failureMessage: z.string().optional(),
});
export type VariantWorkflowResultEntry = z.infer<typeof VariantWorkflowResultEntrySchema>;

export const VariantWorkflowOutputSchema = z.object({
  status: VariantWorkflowStatusSchema,
  /** True only when every requested duration produced a variant that passed its Final QA re-run. */
  allVariantsPassed: z.boolean(),
  variants: z.array(VariantWorkflowResultEntrySchema).default([]),
  failureReason: z.string().optional(),
  failureMessage: z.string().optional(),
});
export type VariantWorkflowOutput = z.infer<typeof VariantWorkflowOutputSchema>;

export const VariantProgressEntrySchema = z.object({
  targetDurationSeconds: z.number().int().positive(),
  phase: z.enum(['PENDING', 'DISPATCH', 'POLLING', 'QA', 'DONE', 'FAILED']),
  attemptNumber: z.number().int().nonnegative(),
  attemptStatus: VariantGenerationAttemptStatusSchema.optional(),
  qaPassed: z.boolean().optional(),
  lastFailureReason: VariantGenerationFailureReasonSchema.optional(),
});
export type VariantProgressEntry = z.infer<typeof VariantProgressEntrySchema>;

export const VariantProgressSchema = z.object({
  phase: z.enum(['VARIANT_GENERATOR', 'RENDERING', 'DONE']),
  cancelled: z.boolean(),
  entries: z.array(VariantProgressEntrySchema).default([]),
});
export type VariantProgress = z.infer<typeof VariantProgressSchema>;
