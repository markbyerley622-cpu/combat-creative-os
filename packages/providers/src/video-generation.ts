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

/**
 * How a reference asset may be used as *generation input*.
 *
 * Mirrors `@combat/media`'s `SOURCE_USAGE_CLASSES` (the render-side gate) and
 * adds `GENERATED`, which only exists on the generation side: a clip this
 * system produced may be fed back in as a reference when its own provenance
 * permits, but it is neither owned footage nor licensed third-party footage.
 *
 * `ANALYSIS_ONLY` is the class every Creative Memory reference carries. It may
 * be studied for pacing and structure and must never be transmitted to a
 * generation provider — see `assertReferenceMayBeGenerationInput`.
 */
export const REFERENCE_USAGE_CLASSES = [
  'OWNED',
  'LICENSED_FOR_OUTPUT',
  'GENERATED',
  'ANALYSIS_ONLY',
] as const;
export type ReferenceUsageClass = (typeof REFERENCE_USAGE_CLASSES)[number];

/** What a reference image is doing in the shot, so an adapter can wire it to the right node. */
export const REFERENCE_IMAGE_ROLES = ['START_FRAME', 'STYLE', 'SUBJECT', 'CONTINUITY'] as const;
export type ReferenceImageRole = (typeof REFERENCE_IMAGE_ROLES)[number];

export interface ReferenceRights {
  readonly usageClass: ReferenceUsageClass;
  readonly rightsHolder: string;
  readonly licenseType: string;
  /** ISO-8601. Absent means perpetual; present and past refuses the reference. */
  readonly expiresAt?: string;
  readonly attribution?: string;
}

export interface ReferenceImageInput {
  readonly assetId: string;
  readonly weight?: number;
  /**
   * Rights metadata. Optional in the type only so the existing mock-backed
   * call sites keep compiling; an adapter that actually transmits bytes
   * **fails closed** when it is absent (M6/AAMP reference rules).
   */
  readonly rights?: ReferenceRights;
  /** Local path to the image bytes. Adapters that upload references need this. */
  readonly localPath?: string;
  readonly mimeType?: string;
  readonly role?: ReferenceImageRole;
}

/**
 * The Shot Prompt Engineer's structured creative intent, carried alongside the
 * composed `promptText` so an adapter can re-compose it for its own model's
 * prompt conventions instead of parsing prose back out of a sentence.
 *
 * Deliberately a structural mirror of `@combat/domain`'s `ShotSpecification`
 * fields rather than an import of them — `packages/providers` does not depend
 * on `packages/domain`, and the dispatching Activity is what maps between the
 * two (the same discipline `ShotGenerationParams` already documents).
 */
export interface ShotCreativeAttributes {
  readonly subject?: string;
  readonly action?: string;
  readonly environment?: string;
  readonly cameraMovement?: string;
  readonly lensFraming?: string;
  readonly lighting?: string;
  readonly colorTreatment?: string;
  /** `SUBTLE` | `MODERATE` | `DYNAMIC` in the domain enum; kept open here. */
  readonly motionIntensity?: string;
  readonly continuityRequirements?: readonly string[];
  readonly visualObjective?: string;
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
  /** Structured creative intent behind `promptText`. Additive — adapters that don't use it ignore it. */
  readonly creativeAttributes?: ShotCreativeAttributes;
}

export interface GenerationJobHandle {
  readonly jobId: string;
  readonly shotId: string;
}

/**
 * What a real adapter can prove about the bytes it produced, and what it used
 * to produce them.
 *
 * Every field is measured or recorded by the adapter itself — none of it is a
 * restatement of the request. `sizeBytes`/`checksumSha256` come from the file
 * on disk; `modelIdentifier`, `workflowProfileKey`, `templateVersion`, `seed`
 * and `promptSha256` are what the asset's provenance record needs in order to
 * answer "what made this?" years later.
 */
export interface GeneratedCandidateProvenance {
  readonly providerName: string;
  readonly modelIdentifier: string;
  readonly workflowProfileKey: string;
  readonly templateVersion: number;
  readonly promptSha256: string;
  readonly negativePromptSha256?: string;
  readonly seed?: number;
  /** Asset ids of every reference that contributed, with the role it played. */
  readonly referenceAssets: readonly { assetId: string; role: string; usageClass: string }[];
}

export interface GeneratedCandidateRef extends AssetRef {
  readonly candidateIndex: number;
  readonly seed?: number;
  readonly durationSeconds: number;
  readonly aspectRatio: string;
  /** Absolute path to the retrieved bytes. Present only for adapters that materialise a real file. */
  readonly localPath?: string;
  readonly sizeBytes?: number;
  /** Lowercase hex sha256 of the retrieved bytes. */
  readonly checksumSha256?: string;
  readonly mimeType?: string;
  readonly provenance?: GeneratedCandidateProvenance;
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
