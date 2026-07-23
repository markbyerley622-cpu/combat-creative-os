import type { AssetRef, IdempotencyKey, JobStatus } from './types';

/**
 * After Effects / aerender — resolved per review (docs/architecture.md §5,
 * §7.1 resolved default #2): treated strictly as an external Windows render
 * worker, never containerized. Only this interface and the deterministic mock
 * exist at this milestone; the real worker integration is a later milestone.
 */
export interface RenderJobHandle {
  jobId: string;
}

export interface MotionGraphicsProvider {
  readonly name: string;
  submitRenderJob(input: {
    idempotencyKey: IdempotencyKey;
    template: string;
    dataBindings: Record<string, unknown>;
  }): Promise<RenderJobHandle>;
  getRenderStatus(handle: RenderJobHandle): Promise<JobStatus>;
  fetchRenderOutput(handle: RenderJobHandle): Promise<AssetRef>;
}
