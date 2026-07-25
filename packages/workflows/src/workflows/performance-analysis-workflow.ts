import { proxyActivities, setHandler } from '@temporalio/workflow';
import type {
  PerformanceAnalysisWorkflowInput,
  PerformanceAnalysisWorkflowOutput,
} from '@combat/domain';
import type { PerformanceAnalysisActivities } from './performance-analysis-workflow-activities';
import { getPerformanceAnalysisProgressQuery } from './performance-analysis-workflow-signals';
import {
  applyPerformanceAnalystResult,
  initialPerformanceAnalysisState,
  toOutput,
  toProgress,
  type PerformanceAnalysisState,
} from './performance-analysis-workflow-state';

/**
 * M13 PerformanceAnalysisWorkflow — a **separate top-level workflow**, never a
 * child of `CampaignProductionWorkflow` (docs/architecture.md §3.1: coupling
 * performance analysis into the linear pipeline would force the production
 * workflow to stay open for weeks waiting on ad results, which is the wrong
 * lifetime for a durable execution meant to complete).
 *
 * It is decoupled by construction, not by convention:
 *
 * - it proxies exactly one Activity, `runPerformanceAnalystActivity`, whose only
 *   writes are `LearningRecord` rows;
 * - it defines no signals, so no approval or instruction can reach it;
 * - its state carries no stage, approval, asset or export field;
 * - it never calls `advanceCampaignStageActivity` and holds no Temporal handle
 *   to the production workflow.
 *
 * The consequence is that a performance analysis cannot alter a campaign stage,
 * satisfy or bypass a human gate, modify an approved asset, or trigger an
 * export — the capability simply is not wired in.
 *
 * No I/O, no wall-clock, no Math.random here; the single decision lives in
 * `performance-analysis-workflow-state.ts`.
 */
const { runPerformanceAnalystActivity } = proxyActivities<PerformanceAnalysisActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '2 seconds', backoffCoefficient: 2, maximumAttempts: 5 },
});

export async function performanceAnalysisWorkflow(
  input: PerformanceAnalysisWorkflowInput,
): Promise<PerformanceAnalysisWorkflowOutput> {
  let state: PerformanceAnalysisState = initialPerformanceAnalysisState();

  setHandler(getPerformanceAnalysisProgressQuery, () => toProgress(state));

  const result = await runPerformanceAnalystActivity({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    workflowRunId: input.workflowRunId,
    windowKey: input.windowKey,
    minObservations: input.minObservations,
    analysisAttempt: input.analysisAttempt,
  });
  state = applyPerformanceAnalystResult(state, result);

  return toOutput(state);
}
