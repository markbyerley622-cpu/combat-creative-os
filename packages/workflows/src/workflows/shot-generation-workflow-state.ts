import type * as activities from '../activities';

/**
 * Pure, Temporal-runtime-free reducer for `shotGenerationWorkflow`'s
 * branching decisions — mirrors `campaign-production-workflow-state.ts`'s
 * split (this file has no `@temporalio/workflow` import at all; the
 * workflow file is only the async orchestration + Temporal-SDK shim around
 * these functions).
 */

export const SHOT_GENERATION_SHOT_STATUSES = [
  'PENDING',
  'DISPATCHING',
  'POLLING',
  'SUCCEEDED',
  'FAILED',
  'RETRY_EXHAUSTED',
  'CANCELLED',
] as const;
export type ShotGenerationShotStatus = (typeof SHOT_GENERATION_SHOT_STATUSES)[number];

export interface ShotGenerationShotState {
  readonly shotSpecificationId: string;
  readonly status: ShotGenerationShotStatus;
  readonly attemptNumber: number;
  readonly attemptId?: string;
  readonly candidateAssetIds?: readonly string[];
  readonly lastFailureReason?: string;
  readonly lastFailureMessage?: string;
}

export interface ShotGenerationProgress {
  readonly shots: readonly ShotGenerationShotState[];
  readonly cancelled: boolean;
}

export interface ShotGenerationState {
  readonly perShot: Readonly<Record<string, ShotGenerationShotState>>;
  readonly cancelled: boolean;
}

export function initialShotGenerationState(
  shotSpecificationIds: readonly string[],
): ShotGenerationState {
  const perShot: Record<string, ShotGenerationShotState> = {};
  for (const id of shotSpecificationIds) {
    perShot[id] = { shotSpecificationId: id, status: 'PENDING', attemptNumber: 0 };
  }
  return { perShot, cancelled: false };
}

function updateShot(
  state: ShotGenerationState,
  shotSpecificationId: string,
  patch: Partial<ShotGenerationShotState>,
): ShotGenerationState {
  const current = state.perShot[shotSpecificationId];
  if (!current) return state;
  return {
    ...state,
    perShot: { ...state.perShot, [shotSpecificationId]: { ...current, ...patch } },
  };
}

export function applyCancelSignal(state: ShotGenerationState): ShotGenerationState {
  return { ...state, cancelled: true };
}

/** Applies the result of dispatching one attempt. A successful submission moves to POLLING; every failure reason here is terminal for the attempt (no retry inside dispatch itself — retry is the workflow re-dispatching a new attemptNumber). */
export function applyDispatchResult(
  state: ShotGenerationState,
  shotSpecificationId: string,
  attemptNumber: number,
  result: activities.DispatchShotGenerationOutput,
): ShotGenerationState {
  if (result.ok) {
    return updateShot(state, shotSpecificationId, {
      status: 'POLLING',
      attemptNumber,
      attemptId: result.attemptId,
    });
  }
  return updateShot(state, shotSpecificationId, {
    status: 'FAILED',
    attemptNumber,
    lastFailureReason: result.reason,
    lastFailureMessage: result.detail,
  });
}

export function applyPolling(
  state: ShotGenerationState,
  shotSpecificationId: string,
): ShotGenerationState {
  return updateShot(state, shotSpecificationId, { status: 'POLLING' });
}

export function applySucceeded(
  state: ShotGenerationState,
  shotSpecificationId: string,
  candidateAssetIds: readonly string[],
): ShotGenerationState {
  return updateShot(state, shotSpecificationId, { status: 'SUCCEEDED', candidateAssetIds });
}

export function applyCancelled(
  state: ShotGenerationState,
  shotSpecificationId: string,
): ShotGenerationState {
  return updateShot(state, shotSpecificationId, { status: 'CANCELLED' });
}

/**
 * Applies one attempt's terminal FAILED/TIMED_OUT outcome. Returns whether
 * the workflow should dispatch another attempt (`retry: true`, when
 * `attemptNumber < maxAttempts`) or give up on this shot for good
 * (`retry: false` -> the caller marks RETRY_EXHAUSTED). Bounded per
 * CLAUDE.md "Bound retries explicitly ... escalate to a human state rather
 * than retrying forever" — `maxAttempts` is `MAX_SHOT_GENERATION_ATTEMPTS`
 * (packages/database's transition-facts.ts), passed in rather than imported,
 * since this file must stay dependency-free of the database package.
 */
export function applyAttemptFailed(
  state: ShotGenerationState,
  shotSpecificationId: string,
  attemptNumber: number,
  maxAttempts: number,
  failureReason: string,
  failureMessage: string,
): { state: ShotGenerationState; retry: boolean } {
  const retry = attemptNumber < maxAttempts;
  const nextState = updateShot(state, shotSpecificationId, {
    status: retry ? 'FAILED' : 'RETRY_EXHAUSTED',
    lastFailureReason: failureReason,
    lastFailureMessage: failureMessage,
  });
  return { state: nextState, retry };
}

export function toProgress(state: ShotGenerationState): ShotGenerationProgress {
  return { shots: Object.values(state.perShot), cancelled: state.cancelled };
}

export function allShotsSucceeded(state: ShotGenerationState): boolean {
  return Object.values(state.perShot).every((s) => s.status === 'SUCCEEDED');
}

export function anyShotFailed(state: ShotGenerationState): boolean {
  return Object.values(state.perShot).some(
    (s) => s.status === 'RETRY_EXHAUSTED' || s.status === 'FAILED',
  );
}
