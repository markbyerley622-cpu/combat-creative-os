import { randomUUID } from 'node:crypto';
import type { MotionGraphicsProvider, RenderJobHandle } from './motion-graphics';
import type { AssetRef, JobStatus } from './types';

export class MockMotionGraphicsProvider implements MotionGraphicsProvider {
  readonly name = 'mock-motion-graphics';
  private readonly jobs = new Map<string, JobStatus>();

  async submitRenderJob(): Promise<RenderJobHandle> {
    const jobId = randomUUID();
    this.jobs.set(jobId, 'SUCCEEDED');
    return { jobId };
  }

  async getRenderStatus(handle: RenderJobHandle): Promise<JobStatus> {
    const status = this.jobs.get(handle.jobId);
    if (!status) {
      throw new Error(`Unknown render job: ${handle.jobId}`);
    }
    return status;
  }

  async fetchRenderOutput(handle: RenderJobHandle): Promise<AssetRef> {
    return { assetId: randomUUID(), s3Key: `mock/render/${handle.jobId}.mp4` };
  }
}
