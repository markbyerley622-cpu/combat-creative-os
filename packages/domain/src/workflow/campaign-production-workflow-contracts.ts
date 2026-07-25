import { z } from 'zod';
import { ApprovalDecisionSchema, ApprovalGateSchema } from '../schemas/shared-enums';
import { FINAL_APPROVAL_REPAIR_TARGETS } from '../schemas/human-approval';
import { CampaignStageSchema } from './campaign-stage';

/**
 * Serializable contracts for `CampaignProductionWorkflow` (ADR pending —
 * see docs/architecture.md §3.2/§3.3). These are parsed at the boundary
 * where untrusted or over-the-wire data enters the system — a workflow-client
 * call before `client.workflow.start`/`.signal`, and an activity input before
 * it reaches business logic — never inside `packages/workflows/src/workflows/*`
 * itself, which may not import this package's runtime functions (CLAUDE.md
 * "Architecture boundaries": workflow files import only `@temporalio/workflow`
 * and type-only signatures). Workflow files import these shapes with
 * `import type` only.
 */

/** Bounded revision retries per gate (CLAUDE.md workflow-idempotency rule: "Bound retries explicitly ... escalate to a human state rather than retrying forever"). */
export const DEFAULT_MAX_REVISIONS_PER_GATE = 3;

export const CampaignProductionWorkflowInputSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  workflowRunId: z.string().min(1),
  /** The campaign's persisted stage at the moment this workflow run was started. */
  initialStage: CampaignStageSchema.default('DRAFT'),
  maxRevisionsPerGate: z.number().int().positive().default(DEFAULT_MAX_REVISIONS_PER_GATE),
  /**
   * M6: the `VideoGenerationProvider` the PROMPTING stage's Shot Prompt
   * Engineer targets and SHOT_GENERATION dispatches to. A single
   * campaign-wide default rather than a per-shot or per-workspace provider
   * config — there is no provider-selection mechanism in this milestone
   * (docs/architecture.md §7.1: no real Veo/Runway adapter exists yet, only
   * the deterministic mock), so this is an explicit, documented MVP
   * simplification rather than a hidden constant.
   */
  videoProviderId: z.string().min(1).default('mock-video-generation'),
});
export type CampaignProductionWorkflowInput = z.infer<typeof CampaignProductionWorkflowInputSchema>;

export const WORKFLOW_RUN_STATUSES = [
  'RUNNING',
  'AWAITING_APPROVAL',
  'BLOCKED',
  'COMPLETED',
] as const;
export const WorkflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const CampaignProductionWorkflowOutputSchema = z.object({
  finalStage: CampaignStageSchema,
  status: WorkflowRunStatusSchema,
  blockedReason: z.string().optional(),
});
export type CampaignProductionWorkflowOutput = z.infer<
  typeof CampaignProductionWorkflowOutputSchema
>;

/**
 * The payload every one of the three gate signals (`approveConceptSignal`,
 * `selectShotsSignal`, `approveFinalSignal`) carries. `gate` is included
 * explicitly (rather than left implicit in the signal name) so the workflow
 * can detect a signal fired on the wrong channel for its payload — e.g. a
 * `FINAL` decision delivered on `approveConceptSignal` — and reject it as a
 * wrong-gate decision rather than silently trusting the channel it arrived
 * on. `approvalId` is what lets the workflow require backend-persisted
 * evidence: the signal itself is never trusted at face value, only as a
 * pointer to a `HumanApproval` row an Activity independently re-reads.
 */
export const GateApprovalSignalPayloadSchema = z
  .object({
    approvalId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    gate: ApprovalGateSchema,
    decision: ApprovalDecisionSchema,
    decidedByUserId: z.string().uuid(),
    repairTarget: z.enum(FINAL_APPROVAL_REPAIR_TARGETS).optional(),
  })
  .refine(
    (payload) => {
      const requiresRepairTarget = payload.gate === 'FINAL' && payload.decision !== 'APPROVED';
      return requiresRepairTarget
        ? payload.repairTarget !== undefined
        : payload.repairTarget === undefined;
    },
    {
      message:
        'repairTarget is required for a non-approved FINAL decision, and must be absent for every other gate/decision combination',
    },
  );
export type GateApprovalSignalPayload = z.infer<typeof GateApprovalSignalPayloadSchema>;

export const CampaignProductionStageQuerySchema = CampaignStageSchema;
export const CampaignProductionPendingGateQuerySchema = ApprovalGateSchema.nullable();
export const CampaignProductionRevisionCountQuerySchema = z.number().int().nonnegative();
