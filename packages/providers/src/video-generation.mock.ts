import { createHash } from 'node:crypto';
import type {
  GeneratedCandidateRef,
  GenerationJobHandle,
  VideoGenerationCapabilities,
  VideoGenerationFailure,
  VideoGenerationProvider,
  VideoGenerationSubmitInput,
  VideoGenerationUsage,
} from './video-generation';
import { VideoGenerationError } from './video-generation';
import type { JobStatus } from './types';

const DEFAULT_CAPABILITIES: VideoGenerationCapabilities = {
  supportedModes: ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO'],
  supportsReferenceImages: true,
  maxReferenceImages: 3,
  supportsReferenceVideo: true,
  supportedAspectRatios: ['9:16', '1:1', '4:5', '16:9'],
  supportedResolutions: ['1280x720', '1920x1080', '720x1280', '1080x1920'],
  minDurationSeconds: 1,
  maxDurationSeconds: 15,
  supportedFrameRates: [24, 30],
  supportsSeed: true,
  supportsNegativePrompt: true,
  maxCandidateCount: 4,
};

const DEFAULT_COST_CENTS_PER_SECOND = 50;

export interface MockVideoGenerationOptions {
  /** Defaults to a deliberately generous profile so most requests succeed unless a test narrows it. */
  capabilities?: VideoGenerationCapabilities;
  costCentsPerSecond?: number;
  /**
   * Number of `getStatus` calls that report a non-terminal state before the
   * job resolves — deterministic "latency" keyed by call count, never wall
   * clock, so tests are fast and reproducible. 0 (default) resolves on the
   * first poll.
   */
  pollsUntilTerminal?: number;
  /**
   * Force a specific `idempotencyKey` to fail (or time out) instead of
   * succeeding once its poll budget is exhausted — the failure-injection
   * mechanism requirement 2 asks for ("configurable failure modes").
   */
  forcedFailures?: Readonly<Record<string, VideoGenerationFailure>>;
}

interface InternalJob {
  handle: GenerationJobHandle;
  input: VideoGenerationSubmitInput;
  pollCount: number;
  pollsUntilTerminal: number;
  forcedFailure?: VideoGenerationFailure;
  cancelled: boolean;
}

/**
 * Deterministic, in-memory, no binary output ever written (M6 requirement 2:
 * "never creates large binary video files") — `fetchResult` returns stable
 * metadata-only refs derived from `(jobId, candidateIndex)`, not random
 * values, so repeated polls/fetches for the same job are byte-identical.
 * `submit` is idempotent by `idempotencyKey` (same key -> same job, no
 * second submission), matching every other provider mock in this codebase.
 */
export class MockVideoGenerationProvider implements VideoGenerationProvider {
  readonly name = 'mock-video-generation';
  private readonly capabilities: VideoGenerationCapabilities;
  private readonly costCentsPerSecond: number;
  private readonly defaultPollsUntilTerminal: number;
  private readonly forcedFailures: Readonly<Record<string, VideoGenerationFailure>>;
  private readonly jobsByIdempotencyKey = new Map<string, InternalJob>();

  constructor(options: MockVideoGenerationOptions = {}) {
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.costCentsPerSecond = options.costCentsPerSecond ?? DEFAULT_COST_CENTS_PER_SECOND;
    this.defaultPollsUntilTerminal = options.pollsUntilTerminal ?? 0;
    this.forcedFailures = options.forcedFailures ?? {};
  }

  getCapabilities(): VideoGenerationCapabilities {
    return this.capabilities;
  }

  async submit(input: VideoGenerationSubmitInput): Promise<GenerationJobHandle> {
    const existing = this.jobsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return existing.handle;
    }

    this.assertSupported(input);

    const job: InternalJob = {
      handle: { jobId: stableJobId(input.idempotencyKey), shotId: input.shotId },
      input,
      pollCount: 0,
      pollsUntilTerminal: this.defaultPollsUntilTerminal,
      forcedFailure: this.forcedFailures[input.idempotencyKey],
      cancelled: false,
    };
    this.jobsByIdempotencyKey.set(input.idempotencyKey, job);
    return job.handle;
  }

  async getStatus(handle: GenerationJobHandle): Promise<JobStatus> {
    const job = this.getOrThrow(handle);
    if (job.cancelled) return 'CANCELLED';

    if (job.pollCount < job.pollsUntilTerminal) {
      job.pollCount += 1;
      return job.pollCount === 1 ? 'SUBMITTED' : 'POLLING';
    }
    job.pollCount += 1;

    if (job.forcedFailure) {
      return job.forcedFailure.reason === 'PROVIDER_TIMEOUT' ? 'TIMED_OUT' : 'FAILED';
    }
    return 'SUCCEEDED';
  }

  async getFailure(handle: GenerationJobHandle): Promise<VideoGenerationFailure | null> {
    const job = this.getOrThrow(handle);
    if (job.cancelled) {
      return { reason: 'PROVIDER_REJECTED', retryable: false, message: 'job was cancelled' };
    }
    return job.forcedFailure ?? null;
  }

  async fetchResult(handle: GenerationJobHandle): Promise<GeneratedCandidateRef[]> {
    const job = this.getOrThrow(handle);
    if (job.forcedFailure || job.cancelled) {
      return [];
    }
    return Array.from({ length: job.input.candidateCount }, (_, candidateIndex) => ({
      assetId: stableCandidateId(handle.jobId, candidateIndex),
      s3Key: `mock/${handle.shotId}/${handle.jobId}/${candidateIndex}.mp4`,
      candidateIndex,
      seed:
        job.input.params.seed !== undefined ? job.input.params.seed + candidateIndex : undefined,
      durationSeconds: job.input.params.durationSeconds,
      aspectRatio: job.input.params.aspectRatio,
    }));
  }

  async getUsage(handle: GenerationJobHandle): Promise<VideoGenerationUsage> {
    const job = this.getOrThrow(handle);
    if (job.forcedFailure || job.cancelled) {
      return { costCents: 0, currency: 'USD' };
    }
    const costCents = Math.ceil(
      job.input.params.durationSeconds * job.input.candidateCount * this.costCentsPerSecond,
    );
    return { costCents, currency: 'USD', computeUnits: job.input.candidateCount };
  }

  async cancel(handle: GenerationJobHandle): Promise<void> {
    const job = this.getOrThrow(handle);
    job.cancelled = true;
  }

  private assertSupported(input: VideoGenerationSubmitInput): void {
    const cap = this.capabilities;
    const reject = (message: string): never => {
      throw new VideoGenerationError({
        reason: 'UNSUPPORTED_CAPABILITY',
        retryable: false,
        message,
      });
    };

    if (!cap.supportedModes.includes(input.mode)) {
      reject(`mode "${input.mode}" is not supported`);
    }
    if (!cap.supportedAspectRatios.includes(input.params.aspectRatio)) {
      reject(`aspectRatio "${input.params.aspectRatio}" is not supported`);
    }
    if (input.params.resolution && !cap.supportedResolutions.includes(input.params.resolution)) {
      reject(`resolution "${input.params.resolution}" is not supported`);
    }
    if (input.params.frameRate && !cap.supportedFrameRates.includes(input.params.frameRate)) {
      reject(`frameRate ${input.params.frameRate} is not supported`);
    }
    if (
      input.params.durationSeconds < cap.minDurationSeconds ||
      input.params.durationSeconds > cap.maxDurationSeconds
    ) {
      reject(
        `durationSeconds ${input.params.durationSeconds} is outside the supported ${cap.minDurationSeconds}-${cap.maxDurationSeconds}s range`,
      );
    }
    if (input.params.seed !== undefined && !cap.supportsSeed) {
      reject('seed is not supported by this provider');
    }
    if ((input.negativePrompt || input.params.negativePrompt) && !cap.supportsNegativePrompt) {
      reject('negativePrompt is not supported by this provider');
    }
    if (input.referenceImages && input.referenceImages.length > 0) {
      if (!cap.supportsReferenceImages)
        reject('reference images are not supported by this provider');
      if (input.referenceImages.length > cap.maxReferenceImages) {
        reject(`too many reference images (max ${cap.maxReferenceImages})`);
      }
    }
    if (input.referenceVideo && !cap.supportsReferenceVideo) {
      reject('reference video metadata is not supported by this provider');
    }
    if (input.candidateCount > cap.maxCandidateCount) {
      reject(
        `candidateCount ${input.candidateCount} exceeds the maximum of ${cap.maxCandidateCount}`,
      );
    }
  }

  private getOrThrow(handle: GenerationJobHandle): InternalJob {
    const job = Array.from(this.jobsByIdempotencyKey.values()).find(
      (j) => j.handle.jobId === handle.jobId,
    );
    if (!job) {
      throw new Error(`Unknown generation job: ${handle.jobId}`);
    }
    return job;
  }
}

function stableJobId(idempotencyKey: string): string {
  return createHash('sha256').update(`job:${idempotencyKey}`).digest('hex').slice(0, 32);
}

function stableCandidateId(jobId: string, candidateIndex: number): string {
  return createHash('sha256')
    .update(`candidate:${jobId}:${candidateIndex}`)
    .digest('hex')
    .slice(0, 32);
}
