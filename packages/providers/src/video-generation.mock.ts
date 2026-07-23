import { randomUUID } from 'node:crypto';
import type {
  GeneratedCandidateRef,
  GenerationJobHandle,
  VideoGenerationProvider,
  VideoGenerationSubmitInput,
} from './video-generation';
import type { JobStatus } from './types';

interface InternalJob {
  handle: GenerationJobHandle;
  status: JobStatus;
  candidateCount: number;
}

/**
 * Deterministic, in-memory mock: submitting resolves synchronously to
 * SUCCEEDED (no artificial delay) so tests stay fast, and calling submit
 * twice with the same idempotencyKey returns the same job instead of creating
 * a second one — the property real activities depend on to be replay-safe.
 */
export class MockVideoGenerationProvider implements VideoGenerationProvider {
  readonly name = 'mock-video-generation';
  private readonly jobsByIdempotencyKey = new Map<string, InternalJob>();

  async submit(input: VideoGenerationSubmitInput): Promise<GenerationJobHandle> {
    const existing = this.jobsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return existing.handle;
    }

    const job: InternalJob = {
      handle: { jobId: randomUUID(), shotId: input.shotId },
      status: 'SUCCEEDED',
      candidateCount: input.candidateCount,
    };
    this.jobsByIdempotencyKey.set(input.idempotencyKey, job);
    return job.handle;
  }

  async getStatus(handle: GenerationJobHandle): Promise<JobStatus> {
    const job = this.findByJobId(handle.jobId);
    if (!job) {
      throw new Error(`Unknown generation job: ${handle.jobId}`);
    }
    return job.status;
  }

  async fetchResult(handle: GenerationJobHandle): Promise<GeneratedCandidateRef[]> {
    const job = this.findByJobId(handle.jobId);
    if (!job) {
      throw new Error(`Unknown generation job: ${handle.jobId}`);
    }
    return Array.from({ length: job.candidateCount }, (_, candidateIndex) => ({
      assetId: randomUUID(),
      s3Key: `mock/${handle.shotId}/${handle.jobId}/${candidateIndex}.mp4`,
      candidateIndex,
    }));
  }

  async cancel(handle: GenerationJobHandle): Promise<void> {
    const job = this.findByJobId(handle.jobId);
    if (job) {
      job.status = 'FAILED';
    }
  }

  private findByJobId(jobId: string): InternalJob | undefined {
    return Array.from(this.jobsByIdempotencyKey.values()).find((j) => j.handle.jobId === jobId);
  }
}
