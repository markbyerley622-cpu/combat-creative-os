import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';
import type {
  GeneratedCandidateRef,
  GenerationJobHandle,
  JobStatus,
  VideoGenerationCapabilities,
  VideoGenerationFailure,
  VideoGenerationProvider,
  VideoGenerationSubmitInput,
  VideoGenerationUsage,
} from '@combat/providers';

/**
 * Synthetic placeholder footage, for demonstrating the pipeline end to end
 * with no GPU and no endpoint.
 *
 * **This is not a video-generation provider and must never be selected in
 * production.** It lives in `apps/aamp-cli` — a demo-and-composition surface —
 * rather than in `packages/providers`, specifically so that no configuration
 * value in `apps/worker` can reach it. `createVideoGenerationProvider` is the
 * only thing the Worker can select from, and this is not in it.
 *
 * It exists because `MockVideoGenerationProvider` returns metadata with no
 * file at all, which makes the last three stages of `aamp:generate` (render,
 * QA, deliverable) unreachable without a GPU. A test pattern is enough to
 * exercise those stages honestly, provided nobody mistakes it for footage —
 * which is what `CliExecutionMode` and the run banner are for.
 *
 * The clips are FFmpeg `lavfi` sources: the same rights-free synthesis
 * `pnpm aamp:fixtures` already uses, so nothing copyrighted and nothing
 * model-generated is involved.
 */

export const FIXTURE_GENERATION_WARNING =
  'VIDEO_GENERATION_PROVIDER=mock: shots are synthetic FFmpeg test patterns, not AI-generated footage.';

export interface FixtureVideoGenerationOptions {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly outputDirectory: string;
  readonly frameRate?: number;
}

interface FixtureJob {
  readonly input: VideoGenerationSubmitInput;
  readonly localPath: string;
  readonly seed: number;
}

const CAPABILITIES: VideoGenerationCapabilities = {
  supportedModes: ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO'],
  supportsReferenceImages: true,
  maxReferenceImages: 1,
  supportsReferenceVideo: false,
  supportedAspectRatios: ['9:16'],
  supportedResolutions: ['1080x1920'],
  minDurationSeconds: 1,
  maxDurationSeconds: 15,
  supportedFrameRates: [30],
  supportsSeed: true,
  supportsNegativePrompt: true,
  maxCandidateCount: 1,
};

/** Deterministic hue per shot, so successive fixture shots are visually distinct. */
function hueFor(idempotencyKey: string): number {
  return parseInt(createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 4), 16) % 360;
}

export class FixtureVideoGenerationProvider implements VideoGenerationProvider {
  readonly name = 'fixture-ffmpeg-testpattern';
  private readonly jobs = new Map<string, FixtureJob>();

  constructor(private readonly options: FixtureVideoGenerationOptions) {}

  getCapabilities(): VideoGenerationCapabilities {
    return CAPABILITIES;
  }

  /**
   * Renders the placeholder immediately, so `getStatus` has something real to
   * report. Idempotent on the key, like every other provider here.
   */
  async submit(input: VideoGenerationSubmitInput): Promise<GenerationJobHandle> {
    const jobId = createHash('sha256')
      .update(`fixture:${input.idempotencyKey}`)
      .digest('hex')
      .slice(0, 32);

    const existing = this.jobs.get(jobId);
    if (existing) return { jobId, shotId: input.shotId };

    const directory = resolve(this.options.outputDirectory, input.shotId, jobId);
    await mkdir(directory, { recursive: true });
    const localPath = join(directory, 'fixture-0.mp4');

    const frameRate = this.options.frameRate ?? 30;
    const seed = input.params.seed ?? hueFor(input.idempotencyKey);
    // `testsrc2` is a moving pattern, so the produced file has genuine motion
    // and behaves like real footage through trim, scale and xfade.
    await this.options.runner.run(
      this.options.binaries.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=1080x1920:rate=${frameRate}:duration=${input.params.durationSeconds.toFixed(3)}`,
        '-vf',
        `hue=h=${seed % 360}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'ultrafast',
        localPath,
      ],
      { timeoutMs: 120_000 },
    );

    this.jobs.set(jobId, { input, localPath, seed });
    return { jobId, shotId: input.shotId };
  }

  async getStatus(handle: GenerationJobHandle): Promise<JobStatus> {
    return this.jobs.has(handle.jobId) ? 'SUCCEEDED' : 'FAILED';
  }

  async getFailure(handle: GenerationJobHandle): Promise<VideoGenerationFailure | null> {
    return this.jobs.has(handle.jobId)
      ? null
      : {
          reason: 'PROVIDER_ERROR',
          retryable: false,
          message: `Unknown fixture job ${handle.jobId}`,
        };
  }

  async fetchResult(handle: GenerationJobHandle): Promise<GeneratedCandidateRef[]> {
    const job = this.jobs.get(handle.jobId);
    if (!job) return [];

    const bytes = await readFile(job.localPath);
    const checksum = createHash('sha256').update(bytes).digest('hex');

    return [
      {
        assetId: checksum,
        s3Key: `fixture/${handle.shotId}/${handle.jobId}/0.mp4`,
        candidateIndex: 0,
        seed: job.seed,
        durationSeconds: job.input.params.durationSeconds,
        aspectRatio: job.input.params.aspectRatio,
        localPath: job.localPath,
        sizeBytes: bytes.byteLength,
        checksumSha256: checksum,
        mimeType: 'video/mp4',
        provenance: {
          providerName: this.name,
          // Named so that anything reading provenance later — a QA report, an
          // audit, a future Creative Memory record — sees immediately that no
          // model was involved.
          modelIdentifier: 'NONE-SYNTHETIC-TEST-PATTERN',
          workflowProfileKey: 'FIXTURE',
          templateVersion: 0,
          promptSha256: createHash('sha256').update(job.input.promptText).digest('hex'),
          seed: job.seed,
          referenceAssets: [],
        },
      },
    ];
  }

  async getUsage(): Promise<VideoGenerationUsage> {
    // No model ran, so nothing is charged. Reporting a fabricated cost here
    // would put a fictional number in the budget ledger.
    return { costCents: 0, currency: 'USD' };
  }

  async cancel(handle: GenerationJobHandle): Promise<void> {
    this.jobs.delete(handle.jobId);
  }
}
