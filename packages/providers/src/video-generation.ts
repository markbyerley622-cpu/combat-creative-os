import type { AssetRef, IdempotencyKey, JobStatus } from './types';

/**
 * Provider-neutral interface for video generation providers (docs/architecture.md
 * §5). Veo is the preferred future hero-footage provider; Runway is the
 * preferred future alternative-take/shot-repair provider (§7.1 resolved
 * default #1). Neither has a real adapter yet — only this interface, the
 * illustrative capability profiles in video-generation-profiles.ts, and the
 * deterministic mock in video-generation.mock.ts exist at this milestone.
 * Kept vendor-neutral by construction so a local ComfyUI/Wan adapter can be
 * added later without touching `ShotGenerationWorkflow` — every field here
 * is either universal (duration, aspect ratio, seed) or explicitly typed-but-
 * open (`providerOptions`) for the handful of settings that don't
 * generalize across vendors.
 */
export const VIDEO_GENERATION_MODES = ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO'] as const;
export type VideoGenerationMode = (typeof VIDEO_GENERATION_MODES)[number];

export interface ReferenceImageInput {
  readonly assetId: string;
  readonly weight?: number;
}

/**
 * Metadata-only description of a stylistic reference — never an uploaded
 * video file. "Optional reference-video metadata without uploading
 * copyrighted footage" (M6 requirement 1): a provider that supports
 * reference-video style transfer is told what the reference looks like in
 * words, never given bytes this system has no clear redistribution rights
 * to hand a third-party API.
 */
export interface ReferenceVideoMetadata {
  readonly description: string;
  readonly styleNotes?: string;
  /** Optional pointer to a licensed internal Asset for provenance — still never uploaded to the provider, just referenced in our own records. */
  readonly sourceAssetId?: string;
}

export interface VideoGenerationParams {
  readonly durationSeconds: number;
  /** e.g. '9:16' — matches packages/domain's AspectRatioSchema values. */
  readonly aspectRatio: string;
  readonly resolution?: string;
  readonly frameRate?: number;
  readonly seed?: number;
  readonly negativePrompt?: string;
  /** Provider-specific knobs that don't fit the vendor-neutral shape above — typed-but-open so a new provider never forces a core-contract change. */
  readonly providerOptions?: Record<string, unknown>;
}

export interface VideoGenerationSubmitInput {
  readonly idempotencyKey: IdempotencyKey;
  readonly shotId: string;
  readonly mode: VideoGenerationMode;
  readonly promptText: string;
  readonly negativePrompt?: string;
  readonly referenceImages?: readonly ReferenceImageInput[];
  readonly referenceVideo?: ReferenceVideoMetadata;
  readonly candidateCount: number;
  readonly params: VideoGenerationParams;
}

export interface GenerationJobHandle {
  readonly jobId: string;
  readonly shotId: string;
}

export interface GeneratedCandidateRef extends AssetRef {
  readonly candidateIndex: number;
  readonly seed?: number;
  readonly durationSeconds: number;
  readonly aspectRatio: string;
}

export interface VideoGenerationUsage {
  readonly costCents: number;
  readonly currency: string;
  readonly computeUnits?: number;
}

export interface VideoGenerationCapabilities {
  readonly supportedModes: readonly VideoGenerationMode[];
  readonly supportsReferenceImages: boolean;
  readonly maxReferenceImages: number;
  readonly supportsReferenceVideo: boolean;
  readonly supportedAspectRatios: readonly string[];
  readonly supportedResolutions: readonly string[];
  readonly minDurationSeconds: number;
  readonly maxDurationSeconds: number;
  readonly supportedFrameRates: readonly number[];
  readonly supportsSeed: boolean;
  readonly supportsNegativePrompt: boolean;
  readonly maxCandidateCount: number;
}

export const VIDEO_GENERATION_FAILURE_REASONS = [
  'UNSUPPORTED_CAPABILITY',
  'PROVIDER_TIMEOUT',
  'PROVIDER_REJECTED',
  'PROVIDER_ERROR',
] as const;
export type VideoGenerationFailureReason = (typeof VIDEO_GENERATION_FAILURE_REASONS)[number];

export interface VideoGenerationFailure {
  readonly reason: VideoGenerationFailureReason;
  readonly retryable: boolean;
  readonly message: string;
  readonly detail?: unknown;
}

/** Thrown by `submit()` for request-shape problems (e.g. an unsupported capability combination) that never reach the provider at all — never a polled/terminal job state. */
export class VideoGenerationError extends Error {
  constructor(public readonly failure: VideoGenerationFailure) {
    super(failure.message);
    this.name = 'VideoGenerationError';
  }
}

export interface VideoGenerationProvider {
  readonly name: string;
  getCapabilities(): VideoGenerationCapabilities;
  submit(input: VideoGenerationSubmitInput): Promise<GenerationJobHandle>;
  getStatus(handle: GenerationJobHandle): Promise<JobStatus>;
  /** Non-null only once `getStatus` has reached a FAILED/TIMED_OUT/CANCELLED terminal state. */
  getFailure(handle: GenerationJobHandle): Promise<VideoGenerationFailure | null>;
  fetchResult(handle: GenerationJobHandle): Promise<GeneratedCandidateRef[]>;
  getUsage(handle: GenerationJobHandle): Promise<VideoGenerationUsage>;
  cancel(handle: GenerationJobHandle): Promise<void>;
}
