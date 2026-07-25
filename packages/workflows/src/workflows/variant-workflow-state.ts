import type {
  VariantProgress,
  VariantProgressEntry,
  VariantWorkflowOutput,
  VariantWorkflowResultEntry,
} from '@combat/domain';
import type * as activities from '../activities';

/**
 * Pure, Temporal-runtime-free reducer for `variantWorkflow` — every branching
 * decision as a plain function over plain state, unit-testable with vitest
 * alone (same pattern as compositing-workflow-state.ts). The workflow file is
 * the thin `proxyActivities`/`sleep` loop around these.
 */
export interface VariantEntryState {
  readonly variantSpecificationId: string;
  readonly targetDurationSeconds: number;
  readonly phase: VariantProgressEntry['phase'];
  readonly attemptNumber: number;
  readonly attemptStatus?: VariantProgressEntry['attemptStatus'];
  readonly creativeVariantId?: string;
  readonly variantAssetId?: string;
  readonly qaPassed?: boolean;
  readonly lastFailureReason?: VariantProgressEntry['lastFailureReason'];
  readonly lastFailureMessage?: string;
}

export interface VariantState {
  readonly phase: VariantProgress['phase'];
  readonly status: 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'CANCELLED';
  readonly entries: readonly VariantEntryState[];
  readonly cancelled: boolean;
  readonly blockedReason?: string;
}

export function initialVariantState(): VariantState {
  return { phase: 'VARIANT_GENERATOR', status: 'RUNNING', entries: [], cancelled: false };
}

export function applyCancelSignal(state: VariantState): VariantState {
  return { ...state, cancelled: true };
}

export function applyCancelled(state: VariantState): VariantState {
  return { ...state, status: 'CANCELLED', phase: 'DONE' };
}

/**
 * Applies the Variant Generator's result. Every requested duration becomes one
 * pending entry; any failure — including an illegal cut — blocks the whole
 * child rather than rendering a partial set, because the campaign may only
 * advance once *all* required variants exist.
 */
export function applyVariantGeneratorResult(
  state: VariantState,
  result: activities.RunVariantGeneratorOutput,
): VariantState {
  if (result.ok) {
    return {
      ...state,
      phase: 'RENDERING',
      entries: result.specifications.map((s) => ({
        variantSpecificationId: s.variantSpecificationId,
        targetDurationSeconds: s.targetDurationSeconds,
        phase: 'PENDING' as const,
        attemptNumber: 0,
      })),
    };
  }
  const detail =
    result.reason === 'INVALID_CUT'
      ? `${result.detail} [${result.violations.map((v) => v.code).join(', ')}]`
      : result.detail;
  return {
    ...state,
    status: 'BLOCKED',
    phase: 'DONE',
    blockedReason: `Variant generation failed (${result.reason}): ${detail}`,
  };
}

function patchEntry(
  state: VariantState,
  variantSpecificationId: string,
  patch: Partial<VariantEntryState>,
): VariantState {
  return {
    ...state,
    entries: state.entries.map((e) =>
      e.variantSpecificationId === variantSpecificationId ? { ...e, ...patch } : e,
    ),
  };
}

export function applyDispatchResult(
  state: VariantState,
  variantSpecificationId: string,
  attemptNumber: number,
  result: activities.DispatchVariantRenderOutput,
): VariantState {
  if (result.ok) {
    return patchEntry(state, variantSpecificationId, {
      phase: 'POLLING',
      attemptNumber,
      attemptStatus: 'SUBMITTED',
    });
  }
  const reason =
    result.reason === 'BUDGET_EXCEEDED'
      ? 'BUDGET_EXCEEDED'
      : result.reason === 'UNSUPPORTED_CAPABILITY'
        ? 'UNSUPPORTED_CAPABILITY'
        : 'PROVIDER_ERROR';
  return patchEntry(state, variantSpecificationId, {
    phase: 'FAILED',
    attemptNumber,
    attemptStatus: 'FAILED',
    lastFailureReason: reason,
    lastFailureMessage: result.detail,
  });
}

export function applyPolling(
  state: VariantState,
  variantSpecificationId: string,
  status: VariantProgressEntry['attemptStatus'],
): VariantState {
  return patchEntry(state, variantSpecificationId, { attemptStatus: status });
}

export function applyRenderSucceeded(
  state: VariantState,
  variantSpecificationId: string,
  creativeVariantId: string,
  variantAssetId: string,
): VariantState {
  return patchEntry(state, variantSpecificationId, {
    phase: 'QA',
    attemptStatus: 'SUCCEEDED',
    creativeVariantId,
    variantAssetId,
  });
}

/**
 * Applies a failed render poll. Returns `retry: true` while attempts remain —
 * the bound is `maxAttempts` and a non-retryable failure (an unsupported
 * capability) never retries, so a variant can never loop unboundedly.
 */
export function applyPollFailed(
  state: VariantState,
  variantSpecificationId: string,
  attemptNumber: number,
  maxAttempts: number,
  failureReason: VariantProgressEntry['lastFailureReason'],
  failureMessage: string,
): { state: VariantState; retry: boolean } {
  const retryable = failureReason !== 'UNSUPPORTED_CAPABILITY' && failureReason !== 'INVALID_CUT';
  const retry = retryable && attemptNumber < maxAttempts;
  return {
    state: patchEntry(state, variantSpecificationId, {
      phase: retry ? 'PENDING' : 'FAILED',
      attemptStatus: 'FAILED',
      lastFailureReason: failureReason,
      lastFailureMessage: failureMessage,
    }),
    retry,
  };
}

export function applyEntryCancelled(
  state: VariantState,
  variantSpecificationId: string,
): VariantState {
  return patchEntry(state, variantSpecificationId, { phase: 'FAILED', attemptStatus: 'CANCELLED' });
}

/**
 * Applies one variant's Final QA re-run. A pass marks the entry DONE; a fail
 * (or an Activity-level failure) marks it FAILED — the campaign's
 * `variantQAPassed` fact then cannot be satisfied, which is what routes the
 * parent back through the documented VARIANT_QA -> VARIANT_GENERATION repair
 * edge rather than letting a bad variant through.
 */
export function applyVariantQaResult(
  state: VariantState,
  variantSpecificationId: string,
  result: activities.RunVariantFinalQaOutput,
): VariantState {
  if (result.ok) {
    return patchEntry(state, variantSpecificationId, {
      phase: result.pass ? 'DONE' : 'FAILED',
      qaPassed: result.pass,
      lastFailureMessage: result.pass
        ? undefined
        : `variant QA failed (${result.blockingFindingCount} blocking findings)`,
    });
  }
  return patchEntry(state, variantSpecificationId, {
    phase: 'FAILED',
    qaPassed: false,
    lastFailureMessage: `variant QA could not run (${result.reason}): ${result.detail}`,
  });
}

/** Every entry has reached a terminal phase. */
export function allEntriesSettled(state: VariantState): boolean {
  return state.entries.every((e) => e.phase === 'DONE' || e.phase === 'FAILED');
}

export function toProgress(state: VariantState): VariantProgress {
  return {
    phase: state.phase,
    cancelled: state.cancelled,
    entries: state.entries.map((e) => ({
      targetDurationSeconds: e.targetDurationSeconds,
      phase: e.phase,
      attemptNumber: e.attemptNumber,
      attemptStatus: e.attemptStatus,
      qaPassed: e.qaPassed,
      lastFailureReason: e.lastFailureReason,
    })),
  };
}

export function toOutput(state: VariantState): VariantWorkflowOutput {
  const variants: VariantWorkflowResultEntry[] = state.entries.map((e) => ({
    variantSpecificationId: e.variantSpecificationId,
    targetDurationSeconds: e.targetDurationSeconds,
    creativeVariantId: e.creativeVariantId,
    variantAssetId: e.variantAssetId,
    qaPassed: e.qaPassed === true,
    failureReason: e.lastFailureReason,
    failureMessage: e.lastFailureMessage,
  }));
  const allVariantsPassed = variants.length > 0 && variants.every((v) => v.qaPassed);
  const status =
    state.status === 'RUNNING' ? (allVariantsPassed ? 'COMPLETED' : 'BLOCKED') : state.status;
  return {
    status,
    allVariantsPassed,
    variants,
    failureReason: state.blockedReason ? 'VARIANT_PIPELINE_FAILED' : undefined,
    failureMessage:
      state.blockedReason ??
      (status === 'BLOCKED' && variants.length > 0
        ? `not every variant passed QA: ${variants
            .filter((v) => !v.qaPassed)
            .map((v) => `${v.targetDurationSeconds}s`)
            .join(', ')}`
        : undefined),
  };
}
