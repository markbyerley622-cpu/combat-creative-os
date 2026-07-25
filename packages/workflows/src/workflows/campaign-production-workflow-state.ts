import type {
  ApprovalGate,
  CampaignStage,
  GateApprovalSignalPayload,
  WorkflowRunStatus,
} from '@combat/domain';
import type * as activities from '../activities';

/**
 * Pure, Temporal-runtime-free reducer for `campaignProductionWorkflow`'s
 * branching decisions — every signal/Activity-result outcome expressed as a
 * plain function over plain state, so it is unit-testable with vitest alone
 * (no `TestWorkflowEnvironment`, no native test-server download — see
 * `packages/testing/src/temporal-test-environment.ts` for why that path is
 * unavailable in this environment). `campaign-production-workflow.ts` is the
 * thin Temporal-SDK shim (`proxyActivities`/`setHandler`/`condition`) wired
 * around these functions; this file has no `@temporalio/workflow` import at
 * all, only type-only `@combat/domain` and sibling-activity-type imports.
 */

export interface CampaignProductionWorkflowState {
  readonly currentStage: CampaignStage;
  readonly status: WorkflowRunStatus;
  readonly pendingGate: ApprovalGate | null;
  readonly blockedReason?: string;
  readonly revisionCounts: Readonly<Record<ApprovalGate, number>>;
  readonly processedApprovalIds: ReadonlySet<string>;
}

export function initialCampaignProductionState(
  initialStage: CampaignStage,
): CampaignProductionWorkflowState {
  return {
    currentStage: initialStage,
    status: 'RUNNING',
    pendingGate: null,
    blockedReason: undefined,
    revisionCounts: { CONCEPT: 0, SHOT_SELECTION: 0, FINAL: 0 },
    processedApprovalIds: new Set(),
  };
}

function describeFailure(
  result: Extract<activities.AdvanceCampaignStageOutput, { ok: false }>,
): string {
  return 'detail' in result ? `${result.reason}: ${result.detail}` : result.reason;
}

/** Applies the result of an AUTO_FORWARD advance attempt made from `state.currentStage`. */
export function applyAutoForwardResult(
  state: CampaignProductionWorkflowState,
  result: activities.AdvanceCampaignStageOutput,
): CampaignProductionWorkflowState {
  if (result.ok) {
    return { ...state, currentStage: result.toStage };
  }
  if (result.reason === 'TERMINAL') {
    return { ...state, status: 'COMPLETED' };
  }
  if (result.reason === 'GATE_REQUIRED') {
    return { ...state, status: 'AWAITING_APPROVAL', pendingGate: result.gate };
  }
  return { ...state, status: 'BLOCKED', blockedReason: describeFailure(result) };
}

/**
 * Applies the result of the STRATEGY_REVIEW artifact-generation Activity
 * (`runStrategyConceptScriptActivity`), run before every AUTO_FORWARD
 * attempt out of STRATEGY_REVIEW. Success leaves state unchanged — the
 * caller proceeds to its normal `advanceCampaignStageActivity` call, which
 * will now find `conceptDrafted` true. Failure escalates straight to
 * BLOCKED, matching every other Activity-failure path in this reducer
 * (CLAUDE.md: "escalate to a human state rather than retrying forever").
 */
export function applyRunStrategyConceptScriptResult(
  state: CampaignProductionWorkflowState,
  result: activities.RunStrategyConceptScriptOutput,
): CampaignProductionWorkflowState {
  if (result.ok) {
    return state;
  }
  const detail =
    result.reason === 'AGENT_FAILED' ? `${result.agentName}: ${result.detail}` : result.detail;
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `STRATEGY_REVIEW artifact generation failed (${result.reason}): ${detail}`,
  };
}

/**
 * Applies the result of the PROMPTING artifact-generation Activity
 * (`runShotPromptEngineerActivity`), run before every AUTO_FORWARD attempt
 * out of PROMPTING — same shape as `applyRunStrategyConceptScriptResult`
 * above: success leaves state unchanged (the normal AUTO_FORWARD call now
 * finds `allShotsHavePrompts` true), failure escalates straight to BLOCKED.
 */
export function applyRunShotPromptEngineerResult(
  state: CampaignProductionWorkflowState,
  result: activities.RunShotPromptEngineerOutput,
): CampaignProductionWorkflowState {
  if (result.ok) {
    return state;
  }
  const detail =
    result.reason === 'AGENT_FAILED'
      ? `${result.agentName} (shot ${result.shotId}): ${result.detail}`
      : result.reason === 'UNLICENSED_REFERENCE_ASSET'
        ? `${result.detail} (asset ${result.assetId})`
        : result.detail;
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `PROMPTING artifact generation failed (${result.reason}): ${detail}`,
  };
}

/**
 * Applies the result of resolving which `ShotSpecification`s the current
 * SHOT_GENERATION visit targets (`loadLatestShotSpecificationsActivity`),
 * run before starting `ShotGenerationWorkflow` as a child. Failure escalates
 * straight to BLOCKED, same as every other pre-AUTO_FORWARD Activity in this
 * reducer.
 */
export function applyLoadLatestShotSpecificationsResult(
  state: CampaignProductionWorkflowState,
  result: activities.LoadLatestShotSpecificationsOutput,
): CampaignProductionWorkflowState {
  if (result.ok) {
    return state;
  }
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `SHOT_GENERATION could not resolve shot specifications (${result.reason}): ${result.detail}`,
  };
}

/**
 * Applies the result of the `ShotGenerationWorkflow` child run for one
 * SHOT_GENERATION visit. COMPLETED leaves state unchanged (the normal
 * AUTO_FORWARD call now finds `allShotsHaveCandidate` true); BLOCKED/
 * CANCELLED escalates straight to BLOCKED — no compositing begins, because
 * the AUTO_FORWARD loop never runs again once `status` leaves 'RUNNING'
 * (CLAUDE.md: "escalate to a human state rather than retrying forever").
 */
export function applyShotGenerationWorkflowResult(
  state: CampaignProductionWorkflowState,
  result: {
    status: 'COMPLETED' | 'BLOCKED' | 'CANCELLED';
    shotResults: readonly { shotSpecificationId: string; status: string; failureReason?: string }[];
  },
): CampaignProductionWorkflowState {
  if (result.status === 'COMPLETED') {
    return state;
  }
  const failedShots = result.shotResults
    .filter((s) => s.status !== 'SUCCEEDED')
    .map(
      (s) => `${s.shotSpecificationId}:${s.status}${s.failureReason ? `(${s.failureReason})` : ''}`,
    )
    .join(', ');
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `SHOT_GENERATION child workflow ended ${result.status}: ${failedShots}`,
  };
}

export type GateSignalDecision =
  { readonly kind: 'IGNORE' } | { readonly kind: 'VERIFY'; readonly approvalId: string };

/**
 * Decides whether a dequeued signal payload is worth spending a verify
 * Activity call on, or should be dropped outright: a payload for a gate
 * other than the one currently pending — including a stale signal queued
 * for a gate that has since closed and only later reopened via a revision
 * loop (e.g. SCRIPT_REVIEW -> CONCEPT_REVIEW can reopen the CONCEPT gate) —
 * or one whose `approvalId` this workflow run has already consumed, is
 * never trusted at face value.
 */
export function decideGateSignal(
  state: CampaignProductionWorkflowState,
  payload: GateApprovalSignalPayload,
): GateSignalDecision {
  if (state.pendingGate === null || payload.gate !== state.pendingGate) {
    return { kind: 'IGNORE' };
  }
  if (state.processedApprovalIds.has(payload.approvalId)) {
    return { kind: 'IGNORE' };
  }
  return { kind: 'VERIFY', approvalId: payload.approvalId };
}

export type VerifyOutcome =
  | { readonly kind: 'IGNORE' }
  | { readonly kind: 'BOUND_EXCEEDED' }
  | { readonly kind: 'ADVANCE'; readonly approval: activities.VerifiedHumanApproval };

/**
 * Decides what a verify-Activity result means, including the bounded-
 * revisions escalation: a non-approved decision at a gate that has already
 * exhausted `maxRevisionsPerGate` never reaches the advance Activity at all
 * — the workflow escalates straight to BLOCKED instead of applying yet
 * another revision transition (CLAUDE.md workflow-idempotency rule: "Bound
 * retries explicitly ... escalate to a human state rather than retrying
 * forever").
 */
export function decideVerifyResult(
  state: CampaignProductionWorkflowState,
  gate: ApprovalGate,
  maxRevisionsPerGate: number,
  result: activities.VerifyHumanApprovalOutput,
): VerifyOutcome {
  if (!result.found || !result.matchesGate) {
    return { kind: 'IGNORE' };
  }
  const { approval } = result;
  if (approval.decision !== 'APPROVED' && state.revisionCounts[gate] >= maxRevisionsPerGate) {
    return { kind: 'BOUND_EXCEEDED' };
  }
  return { kind: 'ADVANCE', approval };
}

export function applyBoundExceeded(
  state: CampaignProductionWorkflowState,
  gate: ApprovalGate,
  maxRevisionsPerGate: number,
): CampaignProductionWorkflowState {
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `Gate ${gate} exceeded max revisions (${maxRevisionsPerGate})`,
  };
}

/** Applies the result of a GATE_DECISION advance attempt for `approval` at `gate`. */
export function applyGateAdvanceResult(
  state: CampaignProductionWorkflowState,
  gate: ApprovalGate,
  approval: activities.VerifiedHumanApproval,
  result: activities.AdvanceCampaignStageOutput,
): CampaignProductionWorkflowState {
  const processedApprovalIds = new Set(state.processedApprovalIds);
  processedApprovalIds.add(approval.id);

  if (!result.ok) {
    return {
      ...state,
      status: 'BLOCKED',
      blockedReason: describeFailure(result),
      processedApprovalIds,
    };
  }

  const revisionCounts =
    approval.decision === 'APPROVED'
      ? state.revisionCounts
      : { ...state.revisionCounts, [gate]: state.revisionCounts[gate] + 1 };

  return {
    ...state,
    currentStage: result.toStage,
    status: 'RUNNING',
    pendingGate: null,
    revisionCounts,
    processedApprovalIds,
  };
}

export function buildAutoForwardIdempotencyKey(
  workflowRunId: string,
  stage: CampaignStage,
  attempt: number,
): string {
  return `${workflowRunId}:AUTO:${stage}:${attempt}`;
}

export function buildGateIdempotencyKey(
  workflowRunId: string,
  gate: ApprovalGate,
  approvalId: string,
): string {
  return `${workflowRunId}:GATE:${gate}:${approvalId}`;
}
