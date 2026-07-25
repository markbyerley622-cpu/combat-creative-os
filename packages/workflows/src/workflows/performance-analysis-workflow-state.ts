import type {
  PerformanceAnalysisLearningSummary,
  PerformanceAnalysisProgress,
  PerformanceAnalysisWorkflowOutput,
} from '@combat/domain';
import type * as activities from '../activities';

/**
 * Pure, Temporal-runtime-free reducer for `performanceAnalysisWorkflow` — same
 * pattern as the other workflow reducers, unit-testable with vitest alone.
 *
 * The state shape is deliberately narrow: a phase, some counters, and the
 * learnings produced. There is **no campaign stage, no approval, no asset and
 * no export field anywhere in it**, which is the structural reason this
 * workflow cannot alter production state — it has nowhere to put such a
 * decision and no Activity that would accept one.
 */
export interface PerformanceAnalysisState {
  readonly phase: PerformanceAnalysisProgress['phase'];
  readonly status: 'RUNNING' | 'COMPLETED' | 'SKIPPED' | 'BLOCKED';
  readonly observationsLoaded: number;
  readonly learnings: readonly PerformanceAnalysisLearningSummary[];
  readonly skippedReason?: string;
  readonly blockedReason?: string;
}

export function initialPerformanceAnalysisState(): PerformanceAnalysisState {
  return { phase: 'LOADING', status: 'RUNNING', observationsLoaded: 0, learnings: [] };
}

/**
 * Applies the Performance Analyst run.
 *
 * `INSUFFICIENT_OBSERVATIONS` is a **SKIPPED**, not a failure: "there is not
 * enough completed performance data yet" is the expected outcome of an
 * early-scheduled analysis, not an error a human needs to look at. Every other
 * failure — a missing campaign, an agent failure, or an insight citing evidence
 * that was never supplied — blocks.
 */
export function applyPerformanceAnalystResult(
  state: PerformanceAnalysisState,
  result: activities.RunPerformanceAnalystOutput,
): PerformanceAnalysisState {
  if (result.ok) {
    return {
      ...state,
      phase: 'DONE',
      status: 'COMPLETED',
      observationsLoaded: result.observationsAnalyzed,
      learnings: result.learnings.map((l) => ({
        learningRecordId: l.learningRecordId,
        learningKey: l.learningKey,
        version: l.version,
        scope: l.scope,
        confidence: l.confidence,
        evidenceCount: l.evidenceCount,
      })),
    };
  }
  if (result.reason === 'INSUFFICIENT_OBSERVATIONS') {
    return {
      ...state,
      phase: 'DONE',
      status: 'SKIPPED',
      observationsLoaded: result.observationsAvailable,
      skippedReason: result.detail,
    };
  }
  return {
    ...state,
    phase: 'DONE',
    status: 'BLOCKED',
    blockedReason: `Performance analysis failed (${result.reason}): ${result.detail}`,
  };
}

export function toProgress(state: PerformanceAnalysisState): PerformanceAnalysisProgress {
  return {
    phase: state.phase,
    observationsLoaded: state.observationsLoaded,
    learningsPersisted: state.learnings.length,
  };
}

export function toOutput(state: PerformanceAnalysisState): PerformanceAnalysisWorkflowOutput {
  return {
    status: state.status === 'RUNNING' ? 'BLOCKED' : state.status,
    observationsAnalyzed: state.observationsLoaded,
    learnings: [...state.learnings],
    skippedReason: state.skippedReason,
    failureReason: state.blockedReason ? 'PERFORMANCE_ANALYSIS_FAILED' : undefined,
    failureMessage: state.blockedReason,
  };
}
