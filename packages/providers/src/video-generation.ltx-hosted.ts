import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import { describeReferenceProvenance, gateReferenceImages } from './comfyui/reference-rights';
import {
  LtxHttpClient,
  LtxRequestError,
  redactUrl,
  type LtxFailureKind,
  type LtxHostAllowance,
} from './ltx/http-client';
import {
  assertSupportedLtxDuration,
  assertSupportedLtxFps,
  assertSupportedLtxModel,
  assertSupportedLtxResolution,
  ltxGenerationCostCents,
  LTX_PRICING_PROFILE_VERSION,
  LtxModelSupportError,
  type LtxModel,
} from './ltx/models';
import { classifyLtxJobState, LTX_RESPONSE_CONTRACT_STATUS } from './ltx/protocol';
import type { JobStatus } from './types';
import type {
  GeneratedCandidateRef,
  GenerationJobHandle,
  ReferenceImageInput,
  VideoGenerationCapabilities,
  VideoGenerationFailure,
  VideoGenerationProvider,
  VideoGenerationSubmitInput,
  VideoGenerationUsage,
} from './video-generation';
import { VideoGenerationError } from './video-generation';

/**
 * The LTX hosted image-to-video adapter, behind the existing
 * `VideoGenerationProvider` interface.
 *
 * This is the first adapter in this repository that can spend real money, so
 * the properties that matter are the refusals:
 *
 * **It cannot be constructed without a key, and the key never escapes it.** No
 * method returns it, no artefact receives it, and every URL that reaches an
 * error message is reduced to host and pathname first — an LTX upload target
 * is a signed URL, and a signed URL in a log is a credential in a log.
 *
 * **It never retries a paid call on its own.** A failed generation stays
 * failed. Automatic retry of a billable request is how a transient network
 * blip becomes a doubled invoice, and the caller — a person, at a CLI — is the
 * only thing here allowed to decide to pay twice.
 *
 * **Provider success is not a usable file.** `fetchResult` downloads
 * immediately, because remote results expire, then hashes and refuses an empty
 * body. Whether the bytes are a playable 1080x1920 clip is decided above this
 * by ffprobe, not by the provider's own word.
 */

export const LTX_PROVIDER_NAME = 'ltx-hosted' as const;

/** How often a running job is polled, per the vendor's guidance. */
export const LTX_POLL_INTERVAL_MS = 5_000;

export interface LtxHostedProviderOptions {
  /** Read from validated env by the composition root. Never logged or persisted. */
  readonly apiKey: string;
  readonly model: LtxModel;
  readonly baseUrl?: string;
  /** End-to-end deadline for one generation, from submission to a retrievable result. */
  readonly outputTimeoutMs: number;
  /** Per-HTTP-request deadline. Much shorter than the generation deadline. */
  readonly requestTimeoutMs?: number;
  /** Absolute path. Where downloaded originals are written. */
  readonly outputDirectory: string;
  readonly fetchImpl?: typeof fetch;
  readonly hostAllowance?: LtxHostAllowance;
  readonly now?: () => Date;
}

interface TrackedJob {
  readonly jobId: string;
  readonly shotId: string;
  readonly idempotencyKey: string;
  readonly submittedAt: number;
  readonly requestedDurationSeconds: number;
  readonly resolution: string;
  readonly aspectRatio: string;
  readonly promptSha256: string;
  readonly referenceProvenance: readonly { assetId: string; role: string; usageClass: string }[];
  cancelled: boolean;
  failure?: VideoGenerationFailure;
  resultVideoUrl?: string;
}

/** How a transport failure becomes a typed provider failure. */
export function mapLtxFailureKind(kind: LtxFailureKind): {
  reason: VideoGenerationFailure['reason'];
  retryable: boolean;
} {
  switch (kind) {
    case 'TIMEOUT':
      return { reason: 'PROVIDER_TIMEOUT', retryable: true };
    case 'UNREACHABLE':
    case 'SERVER_ERROR':
      return { reason: 'PROVIDER_ERROR', retryable: true };
    case 'RATE_LIMITED':
      // Retryable as a fact about the transport. Nothing in this adapter acts
      // on it — a paid call is never re-sent without a person asking.
      return { reason: 'PROVIDER_ERROR', retryable: true };
    case 'REJECTED':
    case 'UNAUTHORIZED':
    case 'PAYMENT_REQUIRED':
    case 'EXPIRED':
    case 'MALFORMED_RESPONSE':
      return { reason: 'PROVIDER_REJECTED', retryable: false };
  }
}

/** Preserved so the CLI above can map a transport failure onto its own exit code. */
export class LtxVideoGenerationError extends VideoGenerationError {
  constructor(
    failure: VideoGenerationFailure,
    public readonly ltxKind: LtxFailureKind | 'UNSUPPORTED_REQUEST',
    public readonly retryAfterSeconds?: number,
  ) {
    super(failure);
    this.name = 'LtxVideoGenerationError';
  }
}

function toLtxError(error: unknown): LtxVideoGenerationError {
  if (error instanceof LtxVideoGenerationError) return error;
  if (error instanceof LtxRequestError) {
    const mapped = mapLtxFailureKind(error.kind);
    return new LtxVideoGenerationError(
      { ...mapped, message: error.message },
      error.kind,
      error.retryAfterSeconds,
    );
  }
  if (error instanceof LtxModelSupportError) {
    return new LtxVideoGenerationError(
      { reason: 'UNSUPPORTED_CAPABILITY', retryable: false, message: error.message },
      'UNSUPPORTED_REQUEST',
    );
  }
  if (error instanceof VideoGenerationError) {
    // An unsupported capability is a request this adapter refused to make, not
    // a provider rejection — the caller's exit code depends on telling those
    // apart, because only one of them is fixed by editing the request.
    return new LtxVideoGenerationError(
      error.failure,
      error.failure.reason === 'UNSUPPORTED_CAPABILITY' ? 'UNSUPPORTED_REQUEST' : 'REJECTED',
    );
  }
  return new LtxVideoGenerationError(
    {
      reason: 'PROVIDER_ERROR',
      retryable: true,
      message: error instanceof Error ? error.message : String(error),
    },
    'UNREACHABLE',
  );
}

export class LtxHostedVideoGenerationProvider implements VideoGenerationProvider {
  readonly name = LTX_PROVIDER_NAME;
  readonly model: LtxModel;
  /** Documented, not executed, until the opt-in live test passes. */
  readonly responseContractStatus = LTX_RESPONSE_CONTRACT_STATUS;

  private readonly client: LtxHttpClient;
  private readonly options: LtxHostedProviderOptions;
  private readonly now: () => Date;
  private readonly jobs = new Map<string, TrackedJob>();

  constructor(options: LtxHostedProviderOptions) {
    this.options = options;
    this.model = assertSupportedLtxModel(options.model);
    this.now = options.now ?? (() => new Date());
    this.client = new LtxHttpClient({
      apiKey: options.apiKey,
      requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.hostAllowance ? { hostAllowance: options.hostAllowance } : {}),
    });
  }

  getCapabilities(): VideoGenerationCapabilities {
    return {
      supportedModes: ['IMAGE_TO_VIDEO'],
      supportsReferenceImages: true,
      // A start frame, and optionally a last frame. Nothing else.
      maxReferenceImages: 2,
      supportsReferenceVideo: false,
      supportedAspectRatios: ['9:16'],
      supportedResolutions: ['1080x1920'],
      minDurationSeconds: 6,
      maxDurationSeconds: 10,
      supportedFrameRates: [24],
      supportsSeed: false,
      supportsNegativePrompt: false,
      maxCandidateCount: 1,
    };
  }

  /**
   * Uploads the start frame, then submits one generation.
   *
   * The upload happens first because the API addresses the image by the
   * `storage_uri` it hands back — there is no path from a local filename into
   * the request body.
   */
  async submit(input: VideoGenerationSubmitInput): Promise<GenerationJobHandle> {
    const existing = this.jobs.get(input.idempotencyKey);
    if (existing) return { jobId: existing.jobId, shotId: existing.shotId };

    try {
      if (input.mode !== 'IMAGE_TO_VIDEO') {
        throw new VideoGenerationError({
          reason: 'UNSUPPORTED_CAPABILITY',
          retryable: false,
          message: `the LTX hosted adapter generates from a start frame only; mode ${input.mode} is refused`,
        });
      }
      if (input.candidateCount !== 1) {
        throw new VideoGenerationError({
          reason: 'UNSUPPORTED_CAPABILITY',
          retryable: false,
          message: `the LTX hosted adapter produces one clip per job; candidateCount ${input.candidateCount} is refused`,
        });
      }

      const duration = assertSupportedLtxDuration(input.params.durationSeconds);
      const resolution = assertSupportedLtxResolution(
        input.params.resolution ?? 'unspecified resolution',
      );
      const fps = assertSupportedLtxFps(input.params.frameRate ?? 0);

      // Same rights gate the ComfyUI adapter uses. Rights policy lives in one
      // place so two adapters cannot become two policies.
      const references = gateReferenceImages(input.referenceImages ?? [], { now: this.now() });
      const startFrame = references.find((reference) => reference.role !== 'CONTINUITY');
      const lastFrame = references.find((reference) => reference.role === 'CONTINUITY');
      if (!startFrame) {
        throw new VideoGenerationError({
          reason: 'UNSUPPORTED_CAPABILITY',
          retryable: false,
          message: 'image-to-video needs a start frame, and none was supplied',
        });
      }

      const imageUri = await this.uploadReference(startFrame);
      const lastFrameUri = lastFrame ? await this.uploadReference(lastFrame) : undefined;

      const options = readProviderOptions(input.params.providerOptions);
      const submission = await this.client.submitImageToVideo(
        {
          image_uri: imageUri,
          prompt: input.promptText,
          model: this.model,
          duration,
          resolution,
          fps,
          generate_audio: options.generateAudio,
          ...(lastFrameUri ? { last_frame_uri: lastFrameUri } : {}),
          ...(options.cameraMotion ? { camera_motion: options.cameraMotion } : {}),
        },
        input.idempotencyKey,
      );

      this.jobs.set(input.idempotencyKey, {
        jobId: submission.id,
        shotId: input.shotId,
        idempotencyKey: input.idempotencyKey,
        submittedAt: this.now().getTime(),
        requestedDurationSeconds: duration,
        resolution,
        aspectRatio: input.params.aspectRatio,
        promptSha256: createHash('sha256').update(input.promptText, 'utf8').digest('hex'),
        referenceProvenance: describeReferenceProvenance(references),
        cancelled: false,
      });

      return { jobId: submission.id, shotId: input.shotId };
    } catch (error) {
      throw toLtxError(error);
    }
  }

  async getStatus(handle: GenerationJobHandle): Promise<JobStatus> {
    const tracked = this.findTracked(handle);
    if (tracked?.cancelled) return 'CANCELLED';

    let status;
    try {
      status = await this.client.getJob(handle.jobId);
    } catch (error) {
      throw toLtxError(error);
    }

    const kind = classifyLtxJobState(status.status);
    if (kind === 'COMPLETED') {
      if (tracked && status.result?.video_url) tracked.resultVideoUrl = status.result.video_url;
      return 'SUCCEEDED';
    }
    if (kind === 'FAILED') {
      this.recordFailure(tracked, {
        reason: 'PROVIDER_ERROR',
        retryable: false,
        message: `LTX job ${handle.jobId} failed: ${status.error ?? 'no reason was given'}`,
      });
      return 'FAILED';
    }
    if (kind === 'CANCELLED') {
      if (tracked) tracked.cancelled = true;
      return 'CANCELLED';
    }
    if (kind === 'EXPIRED') {
      this.recordFailure(tracked, {
        reason: 'PROVIDER_REJECTED',
        retryable: false,
        message: `LTX job ${handle.jobId} expired before its result was retrieved`,
      });
      return 'FAILED';
    }

    if (tracked && this.now().getTime() - tracked.submittedAt > this.options.outputTimeoutMs) {
      // Stop the job before reporting the timeout, so an abandoned generation
      // is not still being billed after we have given up on it.
      await this.client.cancelJob(handle.jobId).catch(() => undefined);
      this.recordFailure(tracked, {
        reason: 'PROVIDER_TIMEOUT',
        retryable: false,
        message: `LTX job ${handle.jobId} did not complete within ${this.options.outputTimeoutMs}ms`,
      });
      return 'TIMED_OUT';
    }

    return kind === 'PENDING' ? 'QUEUED' : 'POLLING';
  }

  async getFailure(handle: GenerationJobHandle): Promise<VideoGenerationFailure | null> {
    const tracked = this.findTracked(handle);
    if (tracked?.cancelled) {
      return { reason: 'PROVIDER_REJECTED', retryable: false, message: 'job was cancelled' };
    }
    return tracked?.failure ?? null;
  }

  /**
   * Downloads the finished clip into the run directory and returns a ref
   * carrying its measured size and checksum.
   *
   * Downloaded on first sight, deliberately: an LTX result URL is short-lived,
   * so "fetch it later when the renderer needs it" is a design that works in
   * testing and loses footage in production.
   */
  async fetchResult(handle: GenerationJobHandle): Promise<GeneratedCandidateRef[]> {
    const tracked = this.findTracked(handle);
    if (tracked?.cancelled) return [];

    try {
      const status = await this.client.getJob(handle.jobId);
      if (classifyLtxJobState(status.status) !== 'COMPLETED') {
        throw new VideoGenerationError({
          reason: 'PROVIDER_REJECTED',
          retryable: false,
          message: `LTX job ${handle.jobId} is ${status.status}, not completed — there is nothing to download`,
        });
      }
      const videoUrl = status.result?.video_url;
      if (!videoUrl) {
        throw new VideoGenerationError({
          reason: 'PROVIDER_REJECTED',
          retryable: false,
          message: `LTX job ${handle.jobId} completed with no video_url`,
        });
      }

      const bytes = await this.client.downloadResult(videoUrl);
      const checksum = createHash('sha256').update(bytes).digest('hex');
      const directory = resolve(this.options.outputDirectory, handle.shotId);
      await mkdir(directory, { recursive: true });
      // The destination name is ours, derived from the checksum. A filename the
      // provider chose never becomes a path component.
      const localPath = join(directory, `${handle.jobId}-${checksum.slice(0, 16)}.mp4`);
      await writeFile(localPath, bytes);

      return [
        {
          assetId: checksum,
          s3Key: `ltx-hosted/${handle.shotId}/${handle.jobId}.mp4`,
          candidateIndex: 0,
          durationSeconds: status.result?.duration ?? tracked?.requestedDurationSeconds ?? 0,
          aspectRatio: tracked?.aspectRatio ?? '9:16',
          localPath,
          sizeBytes: bytes.byteLength,
          checksumSha256: checksum,
          mimeType: 'video/mp4',
          provenance: {
            providerName: this.name,
            modelIdentifier: this.model,
            workflowProfileKey: `${this.model}@${tracked?.resolution ?? '1080x1920'}`,
            templateVersion: LTX_PRICING_PROFILE_VERSION,
            promptSha256: tracked?.promptSha256 ?? '',
            referenceAssets: tracked?.referenceProvenance ?? [],
          },
        },
      ];
    } catch (error) {
      throw toLtxError(error);
    }
  }

  /**
   * What this job costs, from the declared rate card.
   *
   * Billed against the *requested* duration, not the used one: LTX produces a
   * six-second minimum and a scene that keeps two seconds of it still paid for
   * six. Reporting the used duration would understate the invoice.
   */
  async getUsage(handle: GenerationJobHandle): Promise<VideoGenerationUsage> {
    const tracked = this.findTracked(handle);
    if (!tracked || tracked.cancelled || tracked.failure) {
      return { costCents: 0, currency: 'USD' };
    }
    return {
      costCents: ltxGenerationCostCents(
        this.model,
        tracked.resolution,
        tracked.requestedDurationSeconds,
      ),
      currency: 'USD',
      computeUnits: tracked.requestedDurationSeconds,
    };
  }

  async cancel(handle: GenerationJobHandle): Promise<void> {
    const tracked = this.findTracked(handle);
    if (tracked) tracked.cancelled = true;
    try {
      await this.client.cancelJob(handle.jobId);
    } catch (error) {
      throw toLtxError(error);
    }
  }

  private async uploadReference(reference: ReferenceImageInput): Promise<string> {
    if (!reference.localPath) {
      throw new VideoGenerationError({
        reason: 'PROVIDER_REJECTED',
        retryable: false,
        message: `reference asset ${reference.assetId} has no localPath — LTX needs the bytes to upload`,
      });
    }
    const bytes = await readFile(reference.localPath);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const contentType = reference.mimeType ?? 'image/png';
    // Checksum-derived, so nothing an author wrote reaches a remote filename.
    const filename = `combat-frame-${checksum.slice(0, 32)}${safeExtension(reference.localPath)}`;

    const ticket = await this.client.createUploadTicket({
      filename,
      contentType,
      sizeBytes: bytes.byteLength,
    });
    await this.client.putUpload(ticket, new Uint8Array(bytes), contentType);
    return ticket.storage_uri;
  }

  private findTracked(handle: GenerationJobHandle): TrackedJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.jobId !== handle.jobId) continue;
      return job.shotId === handle.shotId ? job : undefined;
    }
    return undefined;
  }

  private recordFailure(job: TrackedJob | undefined, failure: VideoGenerationFailure): void {
    if (job && !job.failure) job.failure = failure;
  }
}

interface ResolvedProviderOptions {
  readonly generateAudio: boolean;
  readonly cameraMotion?: string;
}

/**
 * The two knobs that do not generalise across vendors, read out of
 * `providerOptions` with types checked rather than assumed.
 */
function readProviderOptions(raw: Record<string, unknown> | undefined): ResolvedProviderOptions {
  const generateAudio = raw?.generateAudio;
  const cameraMotion = raw?.cameraMotion;
  if (generateAudio !== undefined && typeof generateAudio !== 'boolean') {
    throw new VideoGenerationError({
      reason: 'UNSUPPORTED_CAPABILITY',
      retryable: false,
      message: 'providerOptions.generateAudio must be a boolean',
    });
  }
  if (cameraMotion !== undefined && typeof cameraMotion !== 'string') {
    throw new VideoGenerationError({
      reason: 'UNSUPPORTED_CAPABILITY',
      retryable: false,
      message: 'providerOptions.cameraMotion must be a string',
    });
  }
  return {
    generateAudio: generateAudio ?? false,
    ...(cameraMotion && cameraMotion.trim().length > 0
      ? { cameraMotion: cameraMotion.trim() }
      : {}),
  };
}

function safeExtension(filename: string): string {
  const extension = extname(basename(filename)).toLowerCase();
  return /^\.(png|jpg|jpeg|webp)$/.test(extension) ? extension : '.png';
}

export { redactUrl };
