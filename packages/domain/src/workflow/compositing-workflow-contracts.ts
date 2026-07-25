import { z } from 'zod';
import {
  CompositionAttemptStatusSchema,
  CompositionFailureReasonSchema,
} from '../schemas/shared-enums';

/** M9 defaults for the CompositingWorkflow child (mirrors the shot-generation contract's default block). */
export const DEFAULT_MAX_COMPOSITION_ATTEMPTS = 3;
export const DEFAULT_COMPOSITION_POLL_INTERVAL_MS = 2000;

/**
 * Deterministic Temporal workflow ID for a campaign's CompositingWorkflow
 * child — derived from the campaign business key (not the parent's random
 * `workflowRunId`) so `apps/api`'s cancel endpoint can target the exact child
 * execution the parent started, without a WorkflowRun mapping table. Both the
 * parent (`executeChild` workflowId) and the API (cancel signal) MUST use this.
 */
export function compositingChildWorkflowId(campaignId: string): string {
  return `compositing:${campaignId}`;
}

export const CompositingWorkflowInputSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  workflowRunId: z.string().min(1),
  /** The human-approved selection set this rough edit is composed from. */
  shotSelectionSetId: z.string().uuid(),
  motionGraphicsProviderId: z.string().min(1).default('mock-motion-graphics'),
  maxAttempts: z.number().int().positive().default(DEFAULT_MAX_COMPOSITION_ATTEMPTS),
  pollIntervalMs: z.number().int().positive().default(DEFAULT_COMPOSITION_POLL_INTERVAL_MS),
});
export type CompositingWorkflowInput = z.infer<typeof CompositingWorkflowInputSchema>;

export const COMPOSITING_WORKFLOW_STATUSES = ['COMPLETED', 'BLOCKED', 'CANCELLED'] as const;
export const CompositingWorkflowStatusSchema = z.enum(COMPOSITING_WORKFLOW_STATUSES);
export type CompositingWorkflowStatus = z.infer<typeof CompositingWorkflowStatusSchema>;

export const CompositingWorkflowOutputSchema = z.object({
  status: CompositingWorkflowStatusSchema,
  roughEditSpecificationId: z.string().uuid().optional(),
  roughEditAssetId: z.string().uuid().optional(),
  failureReason: z.string().optional(),
  failureMessage: z.string().optional(),
});
export type CompositingWorkflowOutput = z.infer<typeof CompositingWorkflowOutputSchema>;

export const CompositingProgressSchema = z.object({
  phase: z.enum(['EDIT_DIRECTOR', 'DISPATCH', 'POLLING', 'REGISTERING', 'DONE']),
  attemptNumber: z.number().int().nonnegative(),
  attemptStatus: CompositionAttemptStatusSchema.optional(),
  cancelled: z.boolean(),
  lastFailureReason: CompositionFailureReasonSchema.optional(),
});
export type CompositingProgress = z.infer<typeof CompositingProgressSchema>;
