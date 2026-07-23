import { TestWorkflowEnvironment } from '@temporalio/testing';

/**
 * Thin wrapper around @temporalio/testing's time-skipping test environment.
 * Not exercised by this milestone's automated verification run: it downloads
 * a native test-server binary on first use, which this environment cannot
 * reliably validate without network/time guarantees. It is provided now so
 * packages/workflows (and future workflow packages) have a single, shared,
 * correctly-configured entry point once that verification is done locally or
 * in CI with the download available.
 */
export async function createTimeSkippingTestEnvironment(): Promise<TestWorkflowEnvironment> {
  return TestWorkflowEnvironment.createTimeSkipping();
}
