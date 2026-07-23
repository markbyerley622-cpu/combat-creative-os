/**
 * Every provider call in the real system is wrapped by the calling Activity
 * with an idempotency key derived from (workflowRunId, stage, entityId,
 * attempt) — see docs/architecture.md §5. Mocks accept and honor it so tests
 * can assert idempotent-resubmission behavior before any real provider exists.
 */
export type IdempotencyKey = string;

export type JobStatus = 'QUEUED' | 'SUBMITTED' | 'POLLING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';

export interface AssetRef {
  assetId: string;
  s3Key: string;
}
