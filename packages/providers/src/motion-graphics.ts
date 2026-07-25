import type { IdempotencyKey, JobStatus } from './types';

/**
 * After Effects / aerender — resolved per review (docs/architecture.md §5,
 * §7.1 resolved default #2): treated strictly as an external Windows render
 * worker, never containerized. Only this provider-neutral interface, the
 * illustrative capability profile in motion-graphics-profiles.ts, and the
 * deterministic mock in motion-graphics.mock.ts exist at this milestone (M9,
 * compositing / rough-edit); the real Windows-worker adapter is a later
 * milestone and maps onto this shape without touching the workflow layer.
 *
 * Kept vendor-neutral by construction — the M9 compositing Activity maps a
 * domain `RoughEditSpecification` onto the provider-neutral
 * `MotionGraphicsTimeline` below, so the render surface never learns a
 * domain type and a different renderer (aerender, ffmpeg concat, a hosted
 * editor API) can be substituted behind the same interface.
 */

export const MOTION_GRAPHICS_TRANSITIONS = [
  'CUT',
  'DISSOLVE',
  'WIPE',
  'FADE_IN',
  'FADE_OUT',
] as const;
export type MotionGraphicsTransition = (typeof MOTION_GRAPHICS_TRANSITIONS)[number];

export interface MotionGraphicsCapabilities {
  /** e.g. ['mp4','mov']. */
  readonly outputFormats: readonly string[];
  /** e.g. ['9:16','1:1','16:9']. */
  readonly aspectRatios: readonly string[];
  readonly maxDurationFrames: number;
  readonly maxClips: number;
  /** Subset of MOTION_GRAPHICS_TRANSITIONS the renderer can honor. */
  readonly supportedTransitions: readonly string[];
}

export interface CompositionProjectHandle {
  readonly projectId: string;
}

export interface MotionGraphicsRenderHandle {
  readonly jobId: string;
}

export const MOTION_GRAPHICS_FAILURE_REASONS = [
  'UNSUPPORTED_CAPABILITY',
  'PROVIDER_TIMEOUT',
  'PROVIDER_REJECTED',
  'PROVIDER_ERROR',
] as const;
export type MotionGraphicsFailureReason = (typeof MOTION_GRAPHICS_FAILURE_REASONS)[number];

export interface MotionGraphicsFailure {
  readonly reason: MotionGraphicsFailureReason;
  readonly message: string;
}

export interface MotionGraphicsUsage {
  readonly costCents: number;
  readonly currency: string;
  readonly computeUnits: number;
}

export interface MotionGraphicsClip {
  readonly order: number;
  /** Reference to an input Asset (e.g. a selected VIDEO_CANDIDATE) — never inline bytes. */
  readonly sourceRef: string;
  readonly inFrame: number;
  readonly outFrame: number;
  readonly transitionIn?: string;
}

export interface MotionGraphicsOverlay {
  /** e.g. 'LOWER_THIRD', 'LOGO', 'CAPTION' — free-form so overlay categories can grow without a contract change. */
  readonly kind: string;
  /** Optional reference to a design/overlay Asset exported via DesignProvider. */
  readonly ref?: string;
}

/**
 * A provider-neutral timeline the render consumes. The M9 compositing
 * Activity maps a domain `RoughEditSpecification` onto this — the provider
 * never sees a domain type.
 */
export interface MotionGraphicsTimeline {
  readonly aspectRatio: string;
  readonly outputFormat: string;
  readonly durationFrames: number;
  readonly clips: readonly MotionGraphicsClip[];
  readonly overlays?: readonly MotionGraphicsOverlay[];
}

/**
 * Thrown by `createProject`/`submitRender` for request-shape problems (an
 * unsupported capability combination) that never reach the render worker at
 * all — never a polled/terminal job state. Mirrors `VideoGenerationError`.
 */
export class MotionGraphicsProviderError extends Error {
  constructor(
    public readonly reason: MotionGraphicsFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'MotionGraphicsProviderError';
  }
}

export interface MotionGraphicsProvider {
  readonly name: string;
  getCapabilities(): MotionGraphicsCapabilities;
  /** Idempotent by idempotencyKey: a replay returns the same project. */
  createProject(input: {
    idempotencyKey: IdempotencyKey;
    campaignId: string;
    name: string;
    context?: Record<string, unknown>;
  }): Promise<CompositionProjectHandle>;
  /**
   * Idempotent by idempotencyKey. Validates `timeline` against
   * getCapabilities() and REJECTS (throws MotionGraphicsProviderError with
   * reason UNSUPPORTED_CAPABILITY) BEFORE recording state when: an unknown
   * outputFormat/aspectRatio, > maxClips, > maxDurationFrames, or an
   * unsupported transition.
   */
  submitRender(input: {
    idempotencyKey: IdempotencyKey;
    projectId: string;
    timeline: MotionGraphicsTimeline;
    dataBindings?: Record<string, unknown>;
  }): Promise<MotionGraphicsRenderHandle>;
  getStatus(handle: MotionGraphicsRenderHandle): Promise<JobStatus>;
  /** Non-null only once `getStatus` has reached a terminal-failed state. */
  getFailure(handle: MotionGraphicsRenderHandle): Promise<MotionGraphicsFailure | null>;
  /** Never real bytes — returns metadata only. */
  fetchRenderOutput(handle: MotionGraphicsRenderHandle): Promise<{
    s3Key: string;
    checksum: string;
    durationFrames: number;
    format: string;
  }>;
  getUsage(handle: MotionGraphicsRenderHandle): Promise<MotionGraphicsUsage>;
  cancel(handle: MotionGraphicsRenderHandle): Promise<void>;
}
