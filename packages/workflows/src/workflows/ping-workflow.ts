import { proxyActivities } from '@temporalio/workflow';
import type { PingActivities } from './ping-workflow-activities';

/**
 * Deterministic workflow code only — no I/O, no fetch, no Date.now(), no
 * imports outside @temporalio/workflow and type-only activity imports (the
 * hard boundary from docs/architecture.md §2). This file is what
 * @temporalio/worker bundles into the workflow sandbox; see
 * ping-workflow.bundle.test.ts, which fails if that boundary is violated.
 */
const { pingActivity } = proxyActivities<PingActivities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

export async function pingWorkflow(message: string): Promise<string> {
  return pingActivity(message);
}
