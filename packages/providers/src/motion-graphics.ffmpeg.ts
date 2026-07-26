import { createHash } from 'node:crypto';

import {
  NodeCommandRunner,
  parseRenderManifest,
  renderAdvertisement,
  resolveFfmpegBinaries,
  type CommandRunner,
  type FfmpegBinaries,
  type RenderManifest,
  type RenderResult,
} from '@combat/media';

import type {
  CompositionProjectHandle,
  MotionGraphicsCapabilities,
  MotionGraphicsFailure,
  MotionGraphicsProvider,
  MotionGraphicsRenderHandle,
  MotionGraphicsTimeline,
  MotionGraphicsUsage,
} from './motion-graphics';
import { MotionGraphicsProviderError } from './motion-graphics';
import type { IdempotencyKey, JobStatus } from './types';

/**
 * The real renderer behind the unchanged `MotionGraphicsProvider` interface —
 * docs/aamp-architecture.md §9's `FfmpegMotionGraphicsProvider`. The
 * compositing Activity is untouched: it still creates a project, submits a
 * timeline, polls, and fetches an output ref. What changes is that
 * `fetchRenderOutput` now describes bytes that exist.
 *
 * The provider-neutral `MotionGraphicsTimeline` carries clip order,
 * transitions and duration but has no vocabulary for captions, licensing,
 * audio mixing or a CTA. Those travel in the interface's existing
 * `dataBindings` slot as a `RenderManifest`, which is parsed and validated
 * here. That keeps the seam intact — no interface change, no domain type
 * leaking into the render surface — while giving the renderer the complete
 * contract it needs.
 *
 * `submitRender` starts the encode and returns immediately, exactly as a
 * hosted render API would; `getStatus` reports real progress. A render whose
 * actual-media QA fails reaches `FAILED`, never `SUCCEEDED` — the provider
 * cannot hand back an output ref for a file that failed a binding check.
 */

export const RENDER_MANIFEST_BINDING_KEY = 'renderManifest';

export interface FfmpegMotionGraphicsOptions {
  /** Every artefact this provider writes lives under here. */
  readonly outputRoot: string;
  /** Relative manifest source paths resolve against this. */
  readonly manifestDir: string;
  readonly allowedSourceRoots: readonly string[];
  readonly binaries?: FfmpegBinaries;
  readonly runner?: CommandRunner;
  readonly renderTimeoutMs?: number;
  /** Injected so the provider stays testable and free of hidden clock reads. */
  readonly clock?: () => Date;
}

const FFMPEG_CAPABILITIES: MotionGraphicsCapabilities = {
  outputFormats: ['mp4'],
  aspectRatios: ['9:16'],
  // 10 minutes at 30 fps — the encoder's practical ceiling for one cut, not a
  // vendor quota.
  maxDurationFrames: 18_000,
  maxClips: 64,
  supportedTransitions: ['CUT', 'DISSOLVE', 'WIPE', 'FADE_IN', 'FADE_OUT'],
};

interface InternalRender {
  readonly handle: MotionGraphicsRenderHandle;
  readonly timeline: MotionGraphicsTimeline;
  readonly abort: AbortController;
  status: JobStatus;
  result: RenderResult | null;
  failure: MotionGraphicsFailure | null;
}

export class FfmpegMotionGraphicsProvider implements MotionGraphicsProvider {
  readonly name = 'ffmpeg-motion-graphics';

  private readonly runner: CommandRunner;
  private readonly binaries: FfmpegBinaries;
  private readonly clock: () => Date;
  private readonly projectsByIdempotencyKey = new Map<string, CompositionProjectHandle>();
  private readonly rendersByIdempotencyKey = new Map<string, InternalRender>();
  private readonly rendersByJobId = new Map<string, InternalRender>();

  constructor(private readonly options: FfmpegMotionGraphicsOptions) {
    this.runner = options.runner ?? new NodeCommandRunner();
    this.binaries = options.binaries ?? resolveFfmpegBinaries(process.env);
    this.clock = options.clock ?? ((): Date => new Date());
  }

  getCapabilities(): MotionGraphicsCapabilities {
    return FFMPEG_CAPABILITIES;
  }

  async createProject(input: {
    idempotencyKey: IdempotencyKey;
    campaignId: string;
    name: string;
    context?: Record<string, unknown>;
  }): Promise<CompositionProjectHandle> {
    const existing = this.projectsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) return existing;
    const handle: CompositionProjectHandle = {
      projectId: stableId('project', input.idempotencyKey),
    };
    this.projectsByIdempotencyKey.set(input.idempotencyKey, handle);
    return handle;
  }

  async submitRender(input: {
    idempotencyKey: IdempotencyKey;
    projectId: string;
    timeline: MotionGraphicsTimeline;
    dataBindings?: Record<string, unknown>;
  }): Promise<MotionGraphicsRenderHandle> {
    const existing = this.rendersByIdempotencyKey.get(input.idempotencyKey);
    if (existing) return existing.handle;

    // Reject unsupported request shapes before recording any state — the
    // contract every provider in this package holds to.
    this.assertSupported(input.timeline);
    const manifest = this.readManifest(input.dataBindings);

    const render: InternalRender = {
      handle: { jobId: stableId('render', input.idempotencyKey) },
      timeline: input.timeline,
      abort: new AbortController(),
      status: 'SUBMITTED',
      result: null,
      failure: null,
    };
    this.rendersByIdempotencyKey.set(input.idempotencyKey, render);
    this.rendersByJobId.set(render.handle.jobId, render);

    void this.execute(render, manifest, input.idempotencyKey);
    return render.handle;
  }

  async getStatus(handle: MotionGraphicsRenderHandle): Promise<JobStatus> {
    return this.getOrThrow(handle).status;
  }

  async getFailure(handle: MotionGraphicsRenderHandle): Promise<MotionGraphicsFailure | null> {
    return this.getOrThrow(handle).failure;
  }

  async fetchRenderOutput(handle: MotionGraphicsRenderHandle): Promise<{
    s3Key: string;
    checksum: string;
    durationFrames: number;
    format: string;
  }> {
    const render = this.getOrThrow(handle);
    if (render.status !== 'SUCCEEDED' || !render.result) {
      throw new MotionGraphicsProviderError(
        'PROVIDER_REJECTED',
        `render ${handle.jobId} has no output: status is ${render.status}`,
      );
    }
    const metadata = render.result.asset.mediaMetadata;
    return {
      s3Key: render.result.asset.storageKey,
      checksum: render.result.asset.checksum,
      durationFrames: metadata
        ? Math.round(metadata.durationSeconds * metadata.frameRate)
        : render.timeline.durationFrames,
      format: 'mp4',
    };
  }

  async getUsage(handle: MotionGraphicsRenderHandle): Promise<MotionGraphicsUsage> {
    const render = this.getOrThrow(handle);
    // A local FFmpeg render spends no money with any provider; the honest
    // cost figure is zero, and compute is reported in frames so a budget
    // policy can still bound it.
    return {
      costCents: 0,
      currency: 'USD',
      computeUnits: render.timeline.durationFrames,
    };
  }

  async cancel(handle: MotionGraphicsRenderHandle): Promise<void> {
    const render = this.getOrThrow(handle);
    render.abort.abort();
    if (render.status !== 'SUCCEEDED' && render.status !== 'FAILED') {
      render.status = 'CANCELLED';
    }
  }

  /** Resolves once the render for `handle` has reached a terminal state — for tests and for a synchronous caller. */
  async waitForCompletion(handle: MotionGraphicsRenderHandle): Promise<JobStatus> {
    const render = this.getOrThrow(handle);
    const pending = this.pending.get(render.handle.jobId);
    if (pending) await pending.catch(() => undefined);
    return render.status;
  }

  private readonly pending = new Map<string, Promise<void>>();

  private async execute(
    render: InternalRender,
    manifest: RenderManifest,
    idempotencyKey: IdempotencyKey,
  ): Promise<void> {
    const task = (async (): Promise<void> => {
      render.status = 'POLLING';
      try {
        const result = await renderAdvertisement(this.runner, {
          manifest,
          manifestDir: this.options.manifestDir,
          allowedSourceRoots: this.options.allowedSourceRoots,
          outputRoot: this.options.outputRoot,
          binaries: this.binaries,
          ...(this.options.renderTimeoutMs === undefined
            ? {}
            : { renderTimeoutMs: this.options.renderTimeoutMs }),
          signal: render.abort.signal,
          now: this.clock(),
          idempotencyKey,
        });
        render.result = result;
        // A cancellation that lands while the encoder is still running must
        // not be overwritten by the completion that follows it — otherwise
        // `cancel` would silently succeed and the job would still report a
        // fetchable output.
        if (render.abort.signal.aborted) {
          render.status = 'CANCELLED';
          render.failure = { reason: 'PROVIDER_REJECTED', message: 'render was cancelled' };
          return;
        }
        if (result.status === 'READY') {
          render.status = 'SUCCEEDED';
          return;
        }
        // Actual-media QA is what decides this, not the encoder's exit code:
        // a technically complete file that failed a binding check must not
        // become a fetchable output.
        const failed = result.qaReport.measurements
          .filter((m) => m.verdict === 'FAIL')
          .map((m) => `${m.check} (measured ${String(m.measured)}, expected ${m.expected})`);
        render.status = 'FAILED';
        render.failure = {
          reason: 'PROVIDER_REJECTED',
          message: `actual-media QA failed: ${failed.join('; ')}`,
        };
      } catch (error) {
        if (render.abort.signal.aborted) {
          render.status = 'CANCELLED';
          render.failure = { reason: 'PROVIDER_REJECTED', message: 'render was cancelled' };
          return;
        }
        render.status = 'FAILED';
        render.failure = {
          reason: 'PROVIDER_ERROR',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    this.pending.set(render.handle.jobId, task);
    await task;
  }

  private readManifest(dataBindings: Record<string, unknown> | undefined): RenderManifest {
    const raw = dataBindings?.[RENDER_MANIFEST_BINDING_KEY];
    if (raw === undefined) {
      throw new MotionGraphicsProviderError(
        'UNSUPPORTED_CAPABILITY',
        `dataBindings.${RENDER_MANIFEST_BINDING_KEY} is required: the provider-neutral timeline cannot express captions, licensing, audio or a CTA`,
      );
    }
    try {
      return parseRenderManifest(raw);
    } catch (error) {
      throw new MotionGraphicsProviderError(
        'PROVIDER_REJECTED',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private assertSupported(timeline: MotionGraphicsTimeline): void {
    const capabilities = FFMPEG_CAPABILITIES;
    const reject = (message: string): never => {
      throw new MotionGraphicsProviderError('UNSUPPORTED_CAPABILITY', message);
    };
    if (!capabilities.outputFormats.includes(timeline.outputFormat)) {
      reject(`outputFormat "${timeline.outputFormat}" is not supported`);
    }
    if (!capabilities.aspectRatios.includes(timeline.aspectRatio)) {
      reject(`aspectRatio "${timeline.aspectRatio}" is not supported`);
    }
    if (timeline.clips.length > capabilities.maxClips) {
      reject(`clip count ${timeline.clips.length} exceeds the maximum of ${capabilities.maxClips}`);
    }
    if (timeline.durationFrames > capabilities.maxDurationFrames) {
      reject(
        `durationFrames ${timeline.durationFrames} exceeds the maximum of ${capabilities.maxDurationFrames}`,
      );
    }
    for (const clip of timeline.clips) {
      if (clip.transitionIn && !capabilities.supportedTransitions.includes(clip.transitionIn)) {
        reject(`transition "${clip.transitionIn}" is not supported`);
      }
    }
  }

  private getOrThrow(handle: MotionGraphicsRenderHandle): InternalRender {
    const render = this.rendersByJobId.get(handle.jobId);
    if (!render) {
      throw new Error(`Unknown render job: ${handle.jobId}`);
    }
    return render;
  }
}

function stableId(prefix: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${prefix}:${idempotencyKey}`).digest('hex').slice(0, 32);
}
