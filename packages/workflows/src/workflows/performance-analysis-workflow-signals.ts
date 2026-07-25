import { defineQuery } from '@temporalio/workflow';
import type { PerformanceAnalysisProgress } from '@combat/domain';

/**
 * M13 PerformanceAnalysisWorkflow query definitions — no logic, no I/O.
 *
 * Deliberately **query-only**: this workflow defines no signals at all. It
 * cannot be told to approve anything, advance anything, or act on a campaign,
 * because there is no channel through which such an instruction could arrive.
 */
export const getPerformanceAnalysisProgressQuery = defineQuery<PerformanceAnalysisProgress>(
  'getPerformanceAnalysisProgress',
);
