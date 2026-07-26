import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import {
  ComfyUIHttpClient,
  ComfyUIRequestError,
  type ComfyUIFailureKind,
} from './comfyui/http-client';
import {
  describeHistoryFailure,
  extractVideoOutputs,
  type ComfyUIHistoryEntry,
  type ComfyUISavedResult,
} from './comfyui/protocol';
import { describeReferenceProvenance, gateReferenceImages } from './comfyui/reference-rights';
import {
  deriveFilenamePrefix,
  effectiveDurationSeconds,
  sha256Hex,
  translateSubmitInput,
} from './comfyui/request-translation';
import {
  getComfyUIWorkflowProfile,
  largestDeviceVramGb,
  type ComfyUIEnvironmentFacts,
  type ComfyUIWorkflowProfile,
  type ComfyUIWorkflowProfileKey,
} from './comfyui/workflow-profiles';
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
 * A real ComfyUI adapter behind the existing `VideoGenerationProvider`
 * interface (AAMP generation vertical slice 2).
 *
 * Three properties are worth stating up front, because they are what separate
 * this from a thin HTTP wrapper.
 *
 * **The job id is ComfyUI's own `prompt_id`, derived deterministically from
 * the attempt's idempotency key.** That makes the whole adapter survive a
 * worker restart: `getStatus`/`fetchResult` reconstruct everything they need
 * from `/history` and `/queue`, so an attempt persisted before a crash is
 * still pollable afterwards. It is also what makes resubmission idempotent —
 * a retried `submit()` finds the job already in history or in the queue and
 * returns the existing handle instead of paying for a second render.
 *
 * **Callers cannot author graphs.** `submit()` takes the vendor-neutral
 * request shape and hands it to a versioned, provider-owned workflow profile.
 * There is no code path from an API body to a ComfyUI node, which is the
 * difference between "generate a video" and "run arbitrary Python on the
 * render host".
 *
 * **Provider success is not the same as a usable file.** `fetchResult`
 * downloads the bytes, hashes them, and refuses an empty or missing output.
 * The asset only becomes READY after the calling Activity measures the file
 * with ffprobe — this adapter proves bytes exist, not that they are good.
 */

export interface ComfyUIVideoGenerationOptions {
  readonly baseUrl: string;
  readonly profileKey: ComfyUIWorkflowProfileKey;
  /** Stable per-process identity ComfyUI associates the websocket/queue with. */
  readonly clientId: string;
  /** End-to-end deadline for one generation, from queueing to retrievable output. */
  readonly outputTimeoutMs: number;
  /** Per-HTTP-request deadline. Much shorter than the generation deadline. */
  readonly requestTimeoutMs?: number;
  /** Where retrieved video bytes are written. Created on demand. */
  readonly outputDirectory: string;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Cost attributed per second of produced footage. Self-hosted ComfyUI has no
   * per-call price, so this defaults to 0 and the budget ledger records a real
   * zero rather than a fabricated charge. A rented GPU endpoint should set it.
   */
  readonly costCentsPerSecond?: number;
  /** Injected so tests are not wall-clock dependent. */
  readonly now?: () => Date;
}

interface TrackedJob {
  readonly promptId: string;
  readonly shotId: string;
  readonly idempotencyKey: string;
  readonly submittedAt: number;
  readonly graphDurationSeconds: number;
  readonly aspectRatio: string;
  readonly seed: number;
  readonly promptSha256: string;
  readonly negativePromptSha256: string;
  readonly referenceProvenance: readonly { assetId: string; role: string; usageClass: string }[];
  cancelled: boolean;
  failure?: VideoGenerationFailure;
}

/** How a transport failure becomes a typed provider failure. */
function mapTransportFailure(kind: ComfyUIFailureKind): {
  reason: VideoGenerationFailure['reason'];
  retryable: boolean;
} {
  switch (kind) {
    case 'TIMEOUT':
      return { reason: 'PROVIDER_TIMEOUT', retryable: true };
    case 'UNREACHABLE':
    case 'SERVER_ERROR':
      return { reason: 'PROVIDER_ERROR', retryable: true };
    case 'REJECTED':
    case 'UNAUTHORIZED':
    case 'MALFORMED_RESPONSE':
      return { reason: 'PROVIDER_REJECTED', retryable: false };
  }
}

function toVideoGenerationError(error: unknown): VideoGenerationError {
  if (error instanceof VideoGenerationError) return error;
  if (error instanceof ComfyUIRequestError) {
    const { reason, retryable } = mapTransportFailure(error.kind);
    return new VideoGenerationError({
      reason,
      retryable,
      message: error.message,
      detail: error.detail,
    });
  }
  return new VideoGenerationError({
    reason: 'PROVIDER_ERROR',
    retryable: true,
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * ComfyUI's `prompt_id` for an attempt. A UUIDv4-shaped string derived from the
 * idempotency key: ComfyUI accepts a client-supplied id, and deriving rather
 * than randomising is what makes a retry land on the same job.
 */
export function derivePromptId(idempotencyKey: string): string {
  const hex = sha256Hex(`prompt:${idempotencyKey}`);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

export class ComfyUIVideoGenerationProvider implements VideoGenerationProvider {
  readonly name: string;
  private readonly client: ComfyUIHttpClient;
  private readonly profile: ComfyUIWorkflowProfile;
  private readonly options: ComfyUIVideoGenerationOptions;
  private readonly now: () => Date;
  private readonly jobs = new Map<string, TrackedJob>();

  constructor(options: ComfyUIVideoGenerationOptions) {
    this.options = options;
    this.profile = getComfyUIWorkflowProfile(options.profileKey);
    this.name = `comfyui:${options.profileKey}`;
    this.now = options.now ?? (() => new Date());
    this.client = new ComfyUIHttpClient({
      baseUrl: options.baseUrl,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  getCapabilities(): VideoGenerationCapabilities {
    return this.profile.capabilities;
  }

  /**
   * Asks the live endpoint whether this profile can actually run there —
   * required node classes installed, enough VRAM reported.
   *
   * Separate from `getCapabilities()` on purpose: capabilities are what the
   * profile *declares*, this is what the server can *do*. A profile existing is
   * never evidence that the model behind it is installed.
   */
  async verifyEnvironment(): Promise<{ compatible: boolean; problems: readonly string[] }> {
    try {
      const [objectInfo, stats] = await Promise.all([
        this.client.getObjectInfo(),
        this.client.getSystemStats(),
      ]);
      const facts: ComfyUIEnvironmentFacts = {
        installedNodes: new Set(Object.keys(objectInfo)),
        ...(largestDeviceVramGb(stats.devices) === undefined
          ? {}
          : { vramGb: largestDeviceVramGb(stats.devices) }),
      };
      return this.profile.validateEnvironment(facts);
    } catch (error) {
      const mapped = toVideoGenerationError(error);
      return { compatible: false, problems: [mapped.failure.message] };
    }
  }

  async submit(input: VideoGenerationSubmitInput): Promise<GenerationJobHandle> {
    const promptId = derivePromptId(input.idempotencyKey);
    const existing = this.jobs.get(input.idempotencyKey);
    if (existing) {
      return { jobId: existing.promptId, shotId: existing.shotId };
    }

    const references = gateReferenceImages(input.referenceImages ?? [], { now: this.now() });

    let graphInput;
    let graph: Record<string, unknown>;
    let uploadedNames: string[] = [];
    try {
      // References are uploaded before translation so the graph can address
      // them by the name ComfyUI actually stored them under.
      uploadedNames = await this.uploadReferences(references);
      graphInput = translateSubmitInput(input, this.profile, {
        referenceImageFilenames: uploadedNames,
      });
      graph = this.profile.buildGraph(graphInput);
    } catch (error) {
      throw toVideoGenerationError(error);
    }

    // A retry after a crash between "ComfyUI queued it" and "we recorded it"
    // must not queue a second render. Both the queue and history are checked
    // before posting.
    try {
      const alreadyKnown = await this.findExistingJob(promptId);
      if (!alreadyKnown) {
        await this.client.queuePrompt(graph, this.options.clientId, promptId);
      }
    } catch (error) {
      throw toVideoGenerationError(error);
    }

    this.jobs.set(input.idempotencyKey, {
      promptId,
      shotId: input.shotId,
      idempotencyKey: input.idempotencyKey,
      submittedAt: this.now().getTime(),
      graphDurationSeconds: effectiveDurationSeconds(graphInput),
      aspectRatio: input.params.aspectRatio,
      seed: graphInput.seed,
      promptSha256: sha256Hex(graphInput.promptText),
      negativePromptSha256: sha256Hex(graphInput.negativePrompt),
      referenceProvenance: describeReferenceProvenance(references),
      cancelled: false,
    });

    return { jobId: promptId, shotId: input.shotId };
  }

  async getStatus(handle: GenerationJobHandle): Promise<JobStatus> {
    const tracked = this.findTracked(handle);
    if (tracked?.cancelled) return 'CANCELLED';

    let entry: ComfyUIHistoryEntry | null;
    try {
      entry = await this.client.getHistoryEntry(handle.jobId);
    } catch (error) {
      throw toVideoGenerationError(error);
    }

    if (entry) {
      const statusString = entry.status?.status_str;
      if (statusString === 'error') {
        this.recordFailure(tracked, {
          reason: 'PROVIDER_ERROR',
          retryable: true,
          message: describeHistoryFailure(entry) ?? 'ComfyUI reported an execution error',
        });
        return 'FAILED';
      }
      // ComfyUI writes the history entry when execution ends; an entry with
      // outputs and no error is a completed run.
      if (entry.status?.completed === true || extractVideoOutputs(entry).length > 0) {
        return 'SUCCEEDED';
      }
    }

    const queued = await this.isQueued(handle.jobId);

    if (tracked && this.hasExceededDeadline(tracked)) {
      // Stop the run before reporting the timeout, so an abandoned job does
      // not keep occupying the GPU after we have given up on it.
      await this.cancelRemote(handle.jobId).catch(() => undefined);
      this.recordFailure(tracked, {
        reason: 'PROVIDER_TIMEOUT',
        retryable: true,
        message: `ComfyUI job ${handle.jobId} did not produce output within ${this.options.outputTimeoutMs}ms`,
      });
      return 'TIMED_OUT';
    }

    if (queued) return 'POLLING';
    if (entry) return 'POLLING';

    if (tracked) {
      // Tracked, not in the queue, not in history: ComfyUI dropped it (a
      // restart clears the queue). Retryable — the attempt can be redispatched.
      this.recordFailure(tracked, {
        reason: 'PROVIDER_ERROR',
        retryable: true,
        message: `ComfyUI has no record of job ${handle.jobId} — it was dropped before producing output`,
      });
      return 'FAILED';
    }

    // Untracked and unknown to the server. Reported as still-queued rather
    // than failed, because this process may simply have restarted between
    // dispatch and the first poll.
    return 'QUEUED';
  }

  async getFailure(handle: GenerationJobHandle): Promise<VideoGenerationFailure | null> {
    const tracked = this.findTracked(handle);
    if (tracked?.cancelled) {
      return { reason: 'PROVIDER_REJECTED', retryable: false, message: 'job was cancelled' };
    }
    if (tracked?.failure) return tracked.failure;

    const entry = await this.client.getHistoryEntry(handle.jobId).catch(() => null);
    if (entry?.status?.status_str === 'error') {
      return {
        reason: 'PROVIDER_ERROR',
        retryable: true,
        message: describeHistoryFailure(entry) ?? 'ComfyUI reported an execution error',
      };
    }
    return null;
  }

  /**
   * Downloads every produced clip, writes it under `outputDirectory`, and
   * returns refs carrying the measured size and checksum.
   *
   * Refuses a job whose history has no video output, and refuses a zero-byte
   * download — "the provider said SUCCEEDED" is not evidence that a playable
   * file exists, and an empty file that reached the renderer would fail much
   * later and much less legibly.
   */
  async fetchResult(handle: GenerationJobHandle): Promise<GeneratedCandidateRef[]> {
    const tracked = this.findTracked(handle);
    if (tracked?.cancelled) return [];

    let entry: ComfyUIHistoryEntry | null;
    try {
      entry = await this.client.getHistoryEntry(handle.jobId);
    } catch (error) {
      throw toVideoGenerationError(error);
    }

    if (!entry) {
      throw new VideoGenerationError({
        reason: 'PROVIDER_ERROR',
        retryable: true,
        message: `ComfyUI has no history entry for job ${handle.jobId}`,
      });
    }

    const saved = extractVideoOutputs(entry);
    if (saved.length === 0) {
      throw new VideoGenerationError({
        reason: 'PROVIDER_REJECTED',
        retryable: false,
        message: `ComfyUI job ${handle.jobId} completed with no video output`,
      });
    }

    const directory = resolve(this.options.outputDirectory, handle.shotId, handle.jobId);
    await mkdir(directory, { recursive: true });

    const refs: GeneratedCandidateRef[] = [];
    for (let index = 0; index < saved.length; index += 1) {
      const result = saved[index] as ComfyUISavedResult;
      // eslint-disable-next-line no-await-in-loop -- candidates are written in order so candidateIndex stays stable across replays
      const bytes = await this.downloadOrThrow(result, handle.jobId);
      if (bytes.byteLength === 0) {
        throw new VideoGenerationError({
          reason: 'PROVIDER_REJECTED',
          retryable: false,
          message: `ComfyUI returned a zero-byte file for job ${handle.jobId} (${result.filename})`,
        });
      }

      const checksum = createHash('sha256').update(bytes).digest('hex');
      // The destination name is ours, derived from the checksum — the server's
      // filename is never used as a path component.
      const extension = safeExtension(result.filename);
      const localPath = join(directory, `${index}-${checksum.slice(0, 16)}${extension}`);
      // eslint-disable-next-line no-await-in-loop -- same ordering rationale
      await writeFile(localPath, bytes);

      refs.push({
        assetId: checksum,
        s3Key: `comfyui/${handle.shotId}/${handle.jobId}/${index}${extension}`,
        candidateIndex: index,
        ...(tracked ? { seed: tracked.seed + index } : {}),
        durationSeconds: tracked?.graphDurationSeconds ?? 0,
        aspectRatio: tracked?.aspectRatio ?? '9:16',
        localPath,
        sizeBytes: bytes.byteLength,
        checksumSha256: checksum,
        mimeType: extension === '.webm' ? 'video/webm' : 'video/mp4',
        provenance: {
          providerName: this.name,
          modelIdentifier: this.profile.modelIdentifier,
          workflowProfileKey: this.profile.key,
          templateVersion: this.profile.templateVersion,
          promptSha256: tracked?.promptSha256 ?? '',
          ...(tracked?.negativePromptSha256
            ? { negativePromptSha256: tracked.negativePromptSha256 }
            : {}),
          ...(tracked ? { seed: tracked.seed + index } : {}),
          referenceAssets: tracked?.referenceProvenance ?? [],
        },
      });
    }

    return refs;
  }

  async getUsage(handle: GenerationJobHandle): Promise<VideoGenerationUsage> {
    const tracked = this.findTracked(handle);
    const costPerSecond = this.options.costCentsPerSecond ?? 0;
    if (!tracked || tracked.cancelled || tracked.failure) {
      return { costCents: 0, currency: 'USD' };
    }
    return {
      costCents: Math.ceil(tracked.graphDurationSeconds * costPerSecond),
      currency: 'USD',
      computeUnits: Math.max(0, Math.round((this.now().getTime() - tracked.submittedAt) / 1000)),
    };
  }

  /** Cancellation reaches ComfyUI: a pending job is dequeued, a running one interrupted. */
  async cancel(handle: GenerationJobHandle): Promise<void> {
    const tracked = this.findTracked(handle);
    if (tracked) tracked.cancelled = true;
    try {
      await this.cancelRemote(handle.jobId);
    } catch (error) {
      throw toVideoGenerationError(error);
    }
  }

  private async cancelRemote(promptId: string): Promise<void> {
    // Delete first: a job still pending never starts, and `/interrupt` only
    // affects whatever is executing right now.
    await this.client.deleteQueued(promptId).catch(() => undefined);
    await this.client.interrupt();
  }

  private async uploadReferences(references: readonly ReferenceImageInput[]): Promise<string[]> {
    const names: string[] = [];
    for (const reference of references) {
      if (!reference.localPath) {
        throw new VideoGenerationError({
          reason: 'PROVIDER_REJECTED',
          retryable: false,
          message: `Reference asset ${reference.assetId} has no localPath — ComfyUI needs the bytes to upload`,
        });
      }
      // eslint-disable-next-line no-await-in-loop -- reference order determines which node each binds to
      const bytes = await readFile(reference.localPath);
      const checksum = createHash('sha256').update(bytes).digest('hex');
      const filename = `combat-ref-${checksum.slice(0, 32)}${safeExtension(reference.localPath)}`;
      // eslint-disable-next-line no-await-in-loop -- same ordering rationale
      const uploaded = await this.client.uploadImage(
        new Uint8Array(bytes),
        filename,
        reference.mimeType ?? 'image/png',
      );
      names.push(uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name);
    }
    return names;
  }

  private async downloadOrThrow(result: ComfyUISavedResult, jobId: string): Promise<Uint8Array> {
    try {
      return await this.client.viewFile(result);
    } catch (error) {
      if (error instanceof ComfyUIRequestError && error.kind === 'REJECTED') {
        throw new VideoGenerationError({
          reason: 'PROVIDER_REJECTED',
          retryable: false,
          message: `ComfyUI job ${jobId} reported output "${result.filename}" but it could not be retrieved`,
          detail: error.message,
        });
      }
      throw toVideoGenerationError(error);
    }
  }

  private async findExistingJob(promptId: string): Promise<boolean> {
    const entry = await this.client.getHistoryEntry(promptId);
    if (entry) return true;
    return this.isQueued(promptId);
  }

  private async isQueued(promptId: string): Promise<boolean> {
    const queue = await this.client.getQueue().catch(() => null);
    if (!queue) return false;
    const contains = (entries: readonly unknown[][]): boolean =>
      entries.some((entry) => entry[1] === promptId);
    return contains(queue.queue_running) || contains(queue.queue_pending);
  }

  /**
   * Locates the tracked job for a handle, refusing a handle whose `shotId`
   * disagrees with the one the job was submitted for.
   *
   * That mismatch means a stale or crossed handle — the shape of bug where a
   * superseded attempt's late completion gets attributed to the shot that
   * replaced it. Returning `undefined` keeps the caller on the stateless
   * `/history` path rather than letting it inherit another shot's provenance.
   */
  private findTracked(handle: GenerationJobHandle): TrackedJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.promptId !== handle.jobId) continue;
      return job.shotId === handle.shotId ? job : undefined;
    }
    return undefined;
  }

  private hasExceededDeadline(job: TrackedJob): boolean {
    return this.now().getTime() - job.submittedAt > this.options.outputTimeoutMs;
  }

  private recordFailure(job: TrackedJob | undefined, failure: VideoGenerationFailure): void {
    if (job && !job.failure) job.failure = failure;
  }
}

/** Extension allowlist — anything unexpected becomes `.mp4` rather than a path fragment. */
function safeExtension(filename: string): string {
  const extension = extname(basename(filename)).toLowerCase();
  return /^\.(mp4|webm|mkv|mov|gif|png|jpg|jpeg)$/.test(extension) ? extension : '.mp4';
}

/** Re-exported so callers can build the deterministic output prefix without importing the internal module. */
export { deriveFilenamePrefix };
