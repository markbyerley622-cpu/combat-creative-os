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

/**
 * Applies the result of the VISUAL_QA assessment Activity
 * (`runVisualQualityAssessmentsActivity`), run before every AUTO_FORWARD
 * attempt out of VISUAL_QA. Success leaves state unchanged — the caller then
 * either proceeds to AUTO_FORWARD (all shots passed) or issues an AUTO_RETRY
 * (a shot failed) based on `allPassed`. Any Activity-level failure escalates
 * straight to BLOCKED, matching every other pre-forward hook in this reducer.
 */
export function applyRunVisualQualityAssessmentsResult(
  state: CampaignProductionWorkflowState,
  result: activities.RunVisualQualityAssessmentsOutput,
): CampaignProductionWorkflowState {
  if (result.ok) {
    return state;
  }
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `VISUAL_QA assessment failed (${result.reason}): ${describeQaFailure(result)}`,
  };
}

/**
 * Applies the result of the CONTINUITY_QA assessment Activity
 * (`runContinuityAssessmentActivity`) — same shape as the VISUAL_QA reducer
 * above.
 */
export function applyRunContinuityAssessmentResult(
  state: CampaignProductionWorkflowState,
  result: activities.RunContinuityAssessmentOutput,
): CampaignProductionWorkflowState {
  if (result.ok) {
    return state;
  }
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `CONTINUITY_QA assessment failed (${result.reason}): ${describeQaFailure(result)}`,
  };
}

function describeQaFailure(
  result: Extract<
    activities.RunVisualQualityAssessmentsOutput | activities.RunContinuityAssessmentOutput,
    { ok: false }
  >,
): string {
  if (result.reason === 'AGENT_FAILED') {
    return 'shotId' in result
      ? `${result.agentName} (shot ${result.shotId}): ${result.detail}`
      : `${result.agentName}: ${result.detail}`;
  }
  return 'shotId' in result ? `${result.detail} (shot ${result.shotId})` : result.detail;
}

/**
 * Applies the result of an AUTO_RETRY advance attempt (a failed visual/
 * continuity assessment routing back to SHOT_GENERATION). A successful retry
 * moves `currentStage` to SHOT_GENERATION and stays RUNNING so the loop
 * regenerates. Any rejection — the bounded `visualQARetryAllowed`/
 * `continuityQARetryAllowed` fact being false (retries exhausted), a budget
 * rejection, or the edge being disallowed — escalates to BLOCKED rather than
 * looping forever (CLAUDE.md: "Bound retries explicitly ... escalate to a
 * human state").
 */
export function applyAutoRetryResult(
  state: CampaignProductionWorkflowState,
  result: activities.AdvanceCampaignStageOutput,
): CampaignProductionWorkflowState {
  if (result.ok) {
    return { ...state, currentStage: result.toStage, status: 'RUNNING', pendingGate: null };
  }
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `Automated QA retry blocked (${describeFailure(result)})`,
  };
}

/**
 * Applies the result of the `CompositingWorkflow` child run for one COMPOSITING
 * visit (M9). COMPLETED leaves state unchanged (the normal AUTO_FORWARD then
 * finds `compositingComplete` true and advances to ROUGH_CUT); BLOCKED/CANCELLED
 * escalates straight to BLOCKED — no rough-cut/sound work begins, because the
 * AUTO_FORWARD loop never runs again once `status` leaves 'RUNNING'.
 */
export function applyCompositingWorkflowResult(
  state: CampaignProductionWorkflowState,
  result: {
    status: 'COMPLETED' | 'BLOCKED' | 'CANCELLED';
    failureReason?: string;
    failureMessage?: string;
  },
): CampaignProductionWorkflowState {
  if (result.status === 'COMPLETED') {
    return state;
  }
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `COMPOSITING child workflow ended ${result.status}: ${
      result.failureMessage ?? result.failureReason ?? 'no detail'
    }`,
  };
}

/**
 * Applies the result of the SOUND_DESIGN artifact-generation Activity
 * (`runSoundDirectorActivity`), run before every AUTO_FORWARD attempt out of
 * SOUND_DESIGN. Success leaves state unchanged — the caller's normal
 * AUTO_FORWARD then finds `soundDesignComplete` true and advances to FINAL_QA.
 * Any Activity-level failure escalates straight to BLOCKED.
 */
export function applyRunSoundDirectorResult(
  state: CampaignProductionWorkflowState,
  result: activities.RunSoundDirectorOutput,
): CampaignProductionWorkflowState {
  if (result.ok) {
    return state;
  }
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `SOUND_DESIGN plan generation failed (${result.reason}): ${result.detail}`,
  };
}

/**
 * Applies the result of the Final QA Controller run for one FINAL_QA visit
 * (M11). A passing master leaves state unchanged (the normal AUTO_FORWARD then
 * finds `finalQAPassed` true and advances to FINAL_APPROVAL, where the FINAL
 * human gate still applies); a failing master also leaves state unchanged so
 * the caller can issue the AUTO_RETRY to `result.repairTarget`. Every `ok:
 * false` outcome — including a failure with no routable repair category —
 * escalates to BLOCKED rather than advancing or retrying blindly.
 */
export function applyRunFinalQaControllerResult(
  state: CampaignProductionWorkflowState,
  result: activities.RunFinalQaControllerOutput,
): CampaignProductionWorkflowState {
  if (result.ok) {
    return state;
  }
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `FINAL_QA assessment failed (${result.reason}): ${result.detail}`,
  };
}

/**
 * Applies the result of the `VariantWorkflow` child run for one
 * VARIANT_GENERATION visit (M12). COMPLETED means every required variant was
 * cut, rendered AND passed its Final QA re-run — the normal AUTO_FORWARD then
 * finds `variantsGenerated` true and advances to VARIANT_QA. A BLOCKED child
 * leaves state RUNNING when at least one variant exists, so the parent can
 * route the documented VARIANT_QA -> VARIANT_GENERATION repair edge; a child
 * that produced nothing at all (an illegal cut, a stale master, a budget
 * refusal) escalates straight to BLOCKED, because there is nothing to repair.
 */
export function applyVariantWorkflowResult(
  state: CampaignProductionWorkflowState,
  result: {
    status: 'COMPLETED' | 'BLOCKED' | 'CANCELLED';
    allVariantsPassed?: boolean;
    variants?: readonly { qaPassed: boolean }[];
    failureReason?: string;
    failureMessage?: string;
  },
): CampaignProductionWorkflowState {
  if (result.status === 'COMPLETED') {
    return state;
  }
  if (result.status === 'BLOCKED' && (result.variants?.length ?? 0) > 0) {
    // Variants exist but not all passed — repairable through the transition table.
    return state;
  }
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `VARIANT_GENERATION child workflow ended ${result.status}: ${
      result.failureMessage ?? result.failureReason ?? 'no detail'
    }`,
  };
}

/**
 * Applies the bound on the automated VARIANT_QA -> VARIANT_GENERATION repair
 * loop (M12). `variantQAFailed` stays true for as long as a failing variant
 * row exists, so unlike the shot-generation retries this loop cannot exhaust
 * itself — the bound has to live here, and exceeding it escalates to a human
 * state rather than retrying forever (CLAUDE.md workflow-idempotency rule).
 */
export function applyVariantRepairBoundExceeded(
  state: CampaignProductionWorkflowState,
  maxVariantRepairAttempts: number,
): CampaignProductionWorkflowState {
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `VARIANT_QA repair bound exceeded (${maxVariantRepairAttempts} re-cut attempts) — a human must intervene`,
  };
}

/**
 * Applies the SHOT_SELECTION-gate re-verification at COMPOSITING entry — the
 * persisted selection set must still be valid before the CompositingWorkflow
 * starts. An invalid set escalates to BLOCKED (a human must re-approve).
 */
export function applyCompositingSelectionCheck(
  state: CampaignProductionWorkflowState,
  valid: boolean,
  detail: string,
): CampaignProductionWorkflowState {
  if (valid) return state;
  return {
    ...state,
    status: 'BLOCKED',
    blockedReason: `COMPOSITING could not start — approved selection is no longer valid: ${detail}`,
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

export function buildAutoRetryIdempotencyKey(
  workflowRunId: string,
  stage: CampaignStage,
  attempt: number,
): string {
  return `${workflowRunId}:RETRY:${stage}:${attempt}`;
}
