import type { CompositingProgress } from '@combat/domain';
import type * as activities from '../activities';

/**
 * Pure, Temporal-runtime-free reducer for `compositingWorkflow` — every
 * branching decision as a plain function over plain state, unit-testable with
 * vitest alone (same pattern as shot-generation-workflow-state.ts). The
 * workflow file is the thin `proxyActivities`/`sleep` loop around these.
 */
export interface CompositingState {
  readonly phase: CompositingProgress['phase'];
  readonly status: 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'CANCELLED';
  readonly roughEditSpecificationId?: string;
  readonly roughEditAssetId?: string;
  readonly attemptNumber: number;
  readonly attemptStatus?: CompositingProgress['attemptStatus'];
  readonly cancelled: boolean;
  readonly lastFailureReason?: CompositingProgress['lastFailureReason'];
  readonly lastFailureMessage?: string;
  readonly blockedReason?: string;
}

export function initialCompositingState(): CompositingState {
  return { phase: 'EDIT_DIRECTOR', status: 'RUNNING', attemptNumber: 0, cancelled: false };
}

export function applyCancelSignal(state: CompositingState): CompositingState {
  return { ...state, cancelled: true };
}

export function applyEditDirectorResult(
  state: CompositingState,
  result: activities.RunEditDirectorOutput,
): CompositingState {
  if (result.ok) {
    return {
      ...state,
      phase: 'DISPATCH',
      roughEditSpecificationId: result.roughEditSpecificationId,
    };
  }
  const detail =
    result.reason === 'INELIGIBLE_SOURCE'
      ? `${result.detail} [${result.reasons.join(', ')}] (shot ${result.shotId})`
      : result.detail;
  return {
    ...state,
    status: 'BLOCKED',
    phase: 'DONE',
    blockedReason: `Edit Director / selection revalidation failed (${result.reason}): ${detail}`,
  };
}

export function applyDispatchResult(
  state: CompositingState,
  attemptNumber: number,
  result: activities.DispatchCompositionRenderOutput,
): CompositingState {
  if (result.ok) {
    return { ...state, phase: 'POLLING', attemptNumber, attemptStatus: 'SUBMITTED' };
  }
  // Dispatch-time failures (spec not found, capability, budget, provider error
  // before a job existed) are terminal — retrying cannot succeed.
  return {
    ...state,
    status: 'BLOCKED',
    phase: 'DONE',
    attemptNumber,
    lastFailureReason:
      result.reason === 'UNSUPPORTED_CAPABILITY'
        ? 'UNSUPPORTED_CAPABILITY'
        : result.reason === 'BUDGET_EXCEEDED'
          ? 'BUDGET_EXCEEDED'
          : 'PROVIDER_ERROR',
    lastFailureMessage: result.detail,
    blockedReason: `Composition dispatch failed (${result.reason}): ${result.detail}`,
  };
}

export function applyPolling(
  state: CompositingState,
  status: CompositingState['attemptStatus'],
): CompositingState {
  return { ...state, phase: 'POLLING', attemptStatus: status };
}

export function applySucceeded(
  state: CompositingState,
  roughEditAssetId: string,
): CompositingState {
  return {
    ...state,
    phase: 'DONE',
    status: 'COMPLETED',
    attemptStatus: 'SUCCEEDED',
    roughEditAssetId,
  };
}

export function applyCancelled(state: CompositingState): CompositingState {
  return { ...state, phase: 'DONE', status: 'CANCELLED', attemptStatus: 'CANCELLED' };
}

/** Applies a poll-time terminal FAILED/TIMED_OUT; returns whether a retry is allowed (bounded). */
export function applyPollFailed(
  state: CompositingState,
  attemptNumber: number,
  maxAttempts: number,
  failureReason: CompositingProgress['lastFailureReason'],
  failureMessage: string,
): { state: CompositingState; retry: boolean } {
  const retry = attemptNumber < maxAttempts;
  if (retry) {
    return {
      state: {
        ...state,
        phase: 'DISPATCH',
        attemptStatus: 'FAILED',
        lastFailureReason: failureReason,
        lastFailureMessage: failureMessage,
      },
      retry: true,
    };
  }
  return {
    state: {
      ...state,
      phase: 'DONE',
      status: 'BLOCKED',
      attemptStatus: 'FAILED',
      lastFailureReason: failureReason,
      lastFailureMessage: failureMessage,
      blockedReason: `Composition render exhausted ${maxAttempts} attempts (${failureReason}): ${failureMessage}`,
    },
    retry: false,
  };
}

export function toProgress(state: CompositingState): CompositingProgress {
  return {
    phase: state.phase,
    attemptNumber: state.attemptNumber,
    attemptStatus: state.attemptStatus,
    cancelled: state.cancelled,
    lastFailureReason: state.lastFailureReason,
  };
}
