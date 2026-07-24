import { defineQuery, defineSignal } from '@temporalio/workflow';
import type {
  ApprovalGate,
  CampaignStage,
  GateApprovalSignalPayload,
  WorkflowRunStatus,
} from '@combat/domain';

/**
 * Signal and query *definitions* for `CampaignProductionWorkflow` — no
 * decision logic, no I/O. Kept separate from `campaign-production-
 * workflow.ts` so `packages/workflow-client` can import these definitions
 * (by value — `defineSignal`/`defineQuery` return plain `{name, type}`
 * descriptors, safe to construct and pass to `handle.signal(...)` /
 * `handle.query(...)` outside a Workflow Execution) without importing the
 * workflow implementation itself. Every type referenced here is imported
 * with `import type` from `@combat/domain` (CLAUDE.md "Architecture
 * boundaries": files under `packages/workflows/src/workflows/*` never do
 * I/O and import only `@temporalio/workflow` and type-only signatures).
 *
 * Signal names mirror docs/architecture.md §3.3
 * (`approveConcept`/`selectShots`/`approveFinal`).
 */
export const approveConceptSignal =
  defineSignal<[GateApprovalSignalPayload]>('approveConceptSignal');
export const selectShotsSignal = defineSignal<[GateApprovalSignalPayload]>('selectShotsSignal');
export const approveFinalSignal = defineSignal<[GateApprovalSignalPayload]>('approveFinalSignal');

export const getCurrentStageQuery = defineQuery<CampaignStage>('getCurrentStage');
export const getStatusQuery = defineQuery<WorkflowRunStatus>('getStatus');
export const getPendingGateQuery = defineQuery<ApprovalGate | null>('getPendingGate');
export const getRevisionCountQuery = defineQuery<number, [ApprovalGate]>('getRevisionCount');
