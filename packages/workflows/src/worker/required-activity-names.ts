import { CAMPAIGN_PRODUCTION_ACTIVITY_NAMES } from '../workflows/campaign-production-workflow-activities';
import { COMPOSITING_ACTIVITY_NAMES } from '../workflows/compositing-workflow-activities';
import { PERFORMANCE_ANALYSIS_ACTIVITY_NAMES } from '../workflows/performance-analysis-workflow-activities';
import { PING_ACTIVITY_NAMES } from '../workflows/ping-workflow-activities';
import { SHOT_GENERATION_ACTIVITY_NAMES } from '../workflows/shot-generation-workflow-activities';
import { VARIANT_ACTIVITY_NAMES } from '../workflows/variant-workflow-activities';
import type { WorkerActivities } from './worker-activities';

/**
 * Every executable workflow, paired with the Activity names its own contract
 * declares. Assembled from the canonical contract tuples — there is no second
 * list of names anywhere in the repository, and each tuple is compile-time
 * proven to cover its interface exactly (see `activity-name-contract.ts`).
 *
 * `pingWorkflow` is included because it is a real, registered workflow: it is
 * how the Worker/workflow/Activity round trip is smoke-tested against a live
 * Temporal server, so an unregistered `pingActivity` would break the very
 * check meant to prove the wiring works.
 */
export const WORKFLOW_ACTIVITY_CONTRACTS: readonly {
  readonly workflow: string;
  readonly activityNames: readonly (keyof WorkerActivities)[];
}[] = [
  { workflow: 'pingWorkflow', activityNames: PING_ACTIVITY_NAMES },
  { workflow: 'campaignProductionWorkflow', activityNames: CAMPAIGN_PRODUCTION_ACTIVITY_NAMES },
  { workflow: 'shotGenerationWorkflow', activityNames: SHOT_GENERATION_ACTIVITY_NAMES },
  { workflow: 'compositingWorkflow', activityNames: COMPOSITING_ACTIVITY_NAMES },
  { workflow: 'variantWorkflow', activityNames: VARIANT_ACTIVITY_NAMES },
  { workflow: 'performanceAnalysisWorkflow', activityNames: PERFORMANCE_ANALYSIS_ACTIVITY_NAMES },
];

/** The flattened, de-duplicated set of Activity names a Worker must register to run every executable workflow. */
export const REQUIRED_WORKER_ACTIVITY_NAMES: readonly (keyof WorkerActivities)[] = [
  ...new Set(WORKFLOW_ACTIVITY_CONTRACTS.flatMap((contract) => contract.activityNames)),
];
