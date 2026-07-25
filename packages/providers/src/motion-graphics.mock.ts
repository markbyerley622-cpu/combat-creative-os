import { createHash } from 'node:crypto';
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
import { DEFAULT_MOTION_GRAPHICS_CAPABILITIES } from './motion-graphics-profiles';
import type { JobStatus } from './types';

/** Small deterministic per-frame render cost, mirroring the video mock's per-second cost. */
const DEFAULT_COST_CENTS_PER_FRAME = 2;

export interface MockMotionGraphicsOptions {
  /** Defaults to a deliberately generous profile so most requests succeed unless a test narrows it. */
  capabilities?: MotionGraphicsCapabilities;
  costCentsPerFrame?: number;
  /**
   * Number of `getStatus` calls that report a non-terminal state before the
   * render resolves — deterministic "latency" keyed by call count, never wall
   * clock, so tests are fast and reproducible. 0 (default) resolves on the
   * first poll.
   */
  pollsUntilTerminal?: number;
  /**
   * Force a specific `idempotencyKey` (the submitRender key) to fail (or time
   * out) instead of succeeding once its poll budget is exhausted — the
   * failure-injection mechanism, mirroring MockVideoGenerationProvider.
   */
  forcedFailures?: Readonly<Record<string, MotionGraphicsFailure>>;
}

interface InternalProject {
  handle: CompositionProjectHandle;
}

interface InternalRender {
  handle: MotionGraphicsRenderHandle;
  timeline: MotionGraphicsTimeline;
  pollCount: number;
  pollsUntilTerminal: number;
  forcedFailure?: MotionGraphicsFailure;
  cancelled: boolean;
  /** Test-only override forcing a terminal status regardless of poll budget. */
  forcedTerminal?: Extract<JobStatus, 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT'>;
}

/**
 * Deterministic, in-memory, no binary output ever written — `fetchRenderOutput`
 * returns stable metadata-only refs derived from `jobId`, not random values,
 * so repeated polls/fetches for the same render are byte-identical.
 * `createProject`/`submitRender` are idempotent by `idempotencyKey` (same key
 * -> same handle, no second submission), matching every other provider mock
 * in this codebase. Mirrors `MockVideoGenerationProvider` in spirit.
 */
export class MockMotionGraphicsProvider implements MotionGraphicsProvider {
  readonly name = 'mock-motion-graphics';
  private readonly capabilities: MotionGraphicsCapabilities;
  private readonly costCentsPerFrame: number;
  private readonly defaultPollsUntilTerminal: number;
  private readonly forcedFailures: Readonly<Record<string, MotionGraphicsFailure>>;
  private readonly projectsByIdempotencyKey = new Map<string, InternalProject>();
  private readonly rendersByIdempotencyKey = new Map<string, InternalRender>();

  constructor(options: MockMotionGraphicsOptions = {}) {
    this.capabilities = options.capabilities ?? DEFAULT_MOTION_GRAPHICS_CAPABILITIES;
    this.costCentsPerFrame = options.costCentsPerFrame ?? DEFAULT_COST_CENTS_PER_FRAME;
    this.defaultPollsUntilTerminal = options.pollsUntilTerminal ?? 0;
    this.forcedFailures = options.forcedFailures ?? {};
  }

  getCapabilities(): MotionGraphicsCapabilities {
    return this.capabilities;
  }

  async createProject(input: {
    idempotencyKey: string;
    campaignId: string;
    name: string;
    context?: Record<string, unknown>;
  }): Promise<CompositionProjectHandle> {
    const existing = this.projectsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return existing.handle;
    }
    const project: InternalProject = {
      handle: { projectId: stableId('project', input.idempotencyKey) },
    };
    this.projectsByIdempotencyKey.set(input.idempotencyKey, project);
    return project.handle;
  }

  async submitRender(input: {
    idempotencyKey: string;
    projectId: string;
    timeline: MotionGraphicsTimeline;
    dataBindings?: Record<string, unknown>;
  }): Promise<MotionGraphicsRenderHandle> {
    const existing = this.rendersByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return existing.handle;
    }

    // Reject unsupported capability combinations BEFORE recording any state.
    this.assertSupported(input.timeline);

    const render: InternalRender = {
      handle: { jobId: stableId('render', input.idempotencyKey) },
      timeline: input.timeline,
      pollCount: 0,
      pollsUntilTerminal: this.defaultPollsUntilTerminal,
      forcedFailure: this.forcedFailures[input.idempotencyKey],
      cancelled: false,
    };
    this.rendersByIdempotencyKey.set(input.idempotencyKey, render);
    return render.handle;
  }

  async getStatus(handle: MotionGraphicsRenderHandle): Promise<JobStatus> {
    const render = this.getOrThrow(handle);
    if (render.cancelled) return 'CANCELLED';
    if (render.forcedTerminal) return render.forcedTerminal;

    if (render.pollCount < render.pollsUntilTerminal) {
      render.pollCount += 1;
      return render.pollCount === 1 ? 'SUBMITTED' : 'POLLING';
    }
    render.pollCount += 1;

    if (render.forcedFailure) {
      return render.forcedFailure.reason === 'PROVIDER_TIMEOUT' ? 'TIMED_OUT' : 'FAILED';
    }
    return 'SUCCEEDED';
  }

  async getFailure(handle: MotionGraphicsRenderHandle): Promise<MotionGraphicsFailure | null> {
    const render = this.getOrThrow(handle);
    if (render.cancelled) {
      return { reason: 'PROVIDER_REJECTED', message: 'render was cancelled' };
    }
    if (render.forcedTerminal === 'FAILED') {
      return render.forcedFailure ?? { reason: 'PROVIDER_ERROR', message: 'render failed' };
    }
    if (render.forcedTerminal === 'TIMED_OUT') {
      return render.forcedFailure ?? { reason: 'PROVIDER_TIMEOUT', message: 'render timed out' };
    }
    return render.forcedFailure ?? null;
  }

  async fetchRenderOutput(handle: MotionGraphicsRenderHandle): Promise<{
    s3Key: string;
    checksum: string;
    durationFrames: number;
    format: string;
  }> {
    const render = this.getOrThrow(handle);
    return {
      s3Key: `mock/rough-edit/${handle.jobId}.mp4`,
      checksum: stableChecksum(handle.jobId, render.timeline),
      durationFrames: render.timeline.durationFrames,
      format: render.timeline.outputFormat,
    };
  }

  async getUsage(handle: MotionGraphicsRenderHandle): Promise<MotionGraphicsUsage> {
    const render = this.getOrThrow(handle);
    if (render.cancelled || render.forcedFailure || render.forcedTerminal === 'FAILED') {
      return { costCents: 0, currency: 'USD', computeUnits: 0 };
    }
    const frames = render.timeline.durationFrames;
    return {
      costCents: Math.ceil(frames * this.costCentsPerFrame),
      currency: 'USD',
      computeUnits: frames,
    };
  }

  async cancel(handle: MotionGraphicsRenderHandle): Promise<void> {
    const render = this.getOrThrow(handle);
    render.cancelled = true;
  }

  /**
   * Test-only: force a submitted render to a terminal status regardless of its
   * poll budget. Mirrors the intent of the video mock's forced-failure
   * injection but drives an already-submitted job directly. Not part of the
   * MotionGraphicsProvider interface.
   */
  forceTerminalStatus(
    handle: MotionGraphicsRenderHandle,
    status: Extract<JobStatus, 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT'>,
  ): void {
    const render = this.getOrThrow(handle);
    render.forcedTerminal = status;
  }

  private assertSupported(timeline: MotionGraphicsTimeline): void {
    const cap = this.capabilities;
    const reject = (message: string): never => {
      throw new MotionGraphicsProviderError('UNSUPPORTED_CAPABILITY', message);
    };

    if (!cap.outputFormats.includes(timeline.outputFormat)) {
      reject(`outputFormat "${timeline.outputFormat}" is not supported`);
    }
    if (!cap.aspectRatios.includes(timeline.aspectRatio)) {
      reject(`aspectRatio "${timeline.aspectRatio}" is not supported`);
    }
    if (timeline.clips.length > cap.maxClips) {
      reject(`clip count ${timeline.clips.length} exceeds the maximum of ${cap.maxClips}`);
    }
    if (timeline.durationFrames > cap.maxDurationFrames) {
      reject(
        `durationFrames ${timeline.durationFrames} exceeds the maximum of ${cap.maxDurationFrames}`,
      );
    }
    for (const clip of timeline.clips) {
      if (clip.transitionIn && !cap.supportedTransitions.includes(clip.transitionIn)) {
        reject(`transition "${clip.transitionIn}" is not supported`);
      }
    }
  }

  private getOrThrow(handle: MotionGraphicsRenderHandle): InternalRender {
    const render = Array.from(this.rendersByIdempotencyKey.values()).find(
      (r) => r.handle.jobId === handle.jobId,
    );
    if (!render) {
      throw new Error(`Unknown render job: ${handle.jobId}`);
    }
    return render;
  }
}

function stableId(prefix: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${prefix}:${idempotencyKey}`).digest('hex').slice(0, 32);
}

function stableChecksum(jobId: string, timeline: MotionGraphicsTimeline): string {
  return createHash('sha256')
    .update(`checksum:${jobId}:${timeline.durationFrames}:${timeline.outputFormat}`)
    .digest('hex');
}
