import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { ShotGenerationProgress } from './shot-generation-workflow-state';

/**
 * Signal and query *definitions* for `shotGenerationWorkflow` — no decision
 * logic, no I/O (same rationale as `campaign-production-workflow-signals.ts`,
 * which this file mirrors).
 */
export const cancelShotGenerationSignal = defineSignal('cancelShotGenerationSignal');

export const getShotGenerationProgressQuery = defineQuery<ShotGenerationProgress>(
  'getShotGenerationProgress',
);
