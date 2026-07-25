import type * as activities from '../activities';

/**
 * The Activity signatures `performanceAnalysisWorkflow` proxies. Exactly one:
 * the analyst run. There is deliberately no stage-advance, approval, asset or
 * export Activity in this contract — the workflow structurally cannot reach
 * production state (see shot-generation-workflow-activities.ts for the
 * type-only-contract rationale).
 */
export interface PerformanceAnalysisActivities {
  runPerformanceAnalystActivity(
    input: activities.RunPerformanceAnalystInput,
  ): Promise<activities.RunPerformanceAnalystOutput>;
}
