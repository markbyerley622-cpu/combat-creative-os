import type * as activities from '../activities';
import type { Equal, Expect } from './activity-name-contract';

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

export const PERFORMANCE_ANALYSIS_ACTIVITY_NAMES = [
  'runPerformanceAnalystActivity',
] as const satisfies readonly (keyof PerformanceAnalysisActivities)[];

export type _AssertPerformanceAnalysisNames = Expect<
  Equal<keyof PerformanceAnalysisActivities, (typeof PERFORMANCE_ANALYSIS_ACTIVITY_NAMES)[number]>
>;
