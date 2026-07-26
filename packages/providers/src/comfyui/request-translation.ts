import { createHash } from 'node:crypto';
import type {
  ShotCreativeAttributes,
  VideoGenerationCapabilities,
  VideoGenerationSubmitInput,
} from '../video-generation';
import { VideoGenerationError } from '../video-generation';
import {
  snapDimension,
  snapFrameCount,
  type ComfyUIGraphInput,
  type ComfyUIWorkflowProfile,
} from './workflow-profiles';

/**
 * Turns a vendor-neutral generation request into the typed parameters a
 * profile's graph builder accepts.
 *
 * Two rules govern everything here. **The agent's creative intent is
 * preserved** — every structured attribute the Shot Prompt Engineer produced
 * reaches the model, in a stable order, rather than being flattened away.
 * **The provider's capabilities are enforced** — a request the profile cannot
 * honour is rejected with a typed `UNSUPPORTED_CAPABILITY` before anything is
 * queued, rather than being quietly clamped into something the caller did not
 * ask for and would not recognise on review.
 *
 * Nothing authored ever becomes a path, a filename, or a command fragment.
 * Prompt text travels only as a JSON *value* inside a node's `inputs` object;
 * the output filename prefix is derived from a checksum.
 */

export interface TranslationContext {
  /** Names of reference images already uploaded to ComfyUI's input folder. */
  readonly referenceImageFilenames: readonly string[];
}

function unsupported(message: string): never {
  throw new VideoGenerationError({
    reason: 'UNSUPPORTED_CAPABILITY',
    retryable: false,
    message,
  });
}

/**
 * The same capability contract every `VideoGenerationProvider.submit()` is
 * required to enforce, checked against a workflow profile's declared
 * capabilities rather than a hardcoded table.
 */
export function assertProfileSupports(
  input: VideoGenerationSubmitInput,
  capabilities: VideoGenerationCapabilities,
  profileKey: string,
): void {
  const { params } = input;

  if (!capabilities.supportedModes.includes(input.mode)) {
    unsupported(`${profileKey} does not support mode "${input.mode}"`);
  }
  if (!capabilities.supportedAspectRatios.includes(params.aspectRatio)) {
    unsupported(`${profileKey} does not support aspect ratio "${params.aspectRatio}"`);
  }
  if (params.resolution && !capabilities.supportedResolutions.includes(params.resolution)) {
    unsupported(
      `${profileKey} does not support resolution "${params.resolution}" (supported: ${capabilities.supportedResolutions.join(', ')})`,
    );
  }
  if (
    params.frameRate !== undefined &&
    !capabilities.supportedFrameRates.includes(params.frameRate)
  ) {
    unsupported(
      `${profileKey} does not support ${params.frameRate} fps (supported: ${capabilities.supportedFrameRates.join(', ')})`,
    );
  }
  if (
    params.durationSeconds < capabilities.minDurationSeconds ||
    params.durationSeconds > capabilities.maxDurationSeconds
  ) {
    unsupported(
      `${profileKey} supports ${capabilities.minDurationSeconds}-${capabilities.maxDurationSeconds}s shots, not ${params.durationSeconds}s`,
    );
  }
  if (params.seed !== undefined && !capabilities.supportsSeed) {
    unsupported(`${profileKey} does not support an explicit seed`);
  }
  if ((input.negativePrompt || params.negativePrompt) && !capabilities.supportsNegativePrompt) {
    unsupported(`${profileKey} does not support a negative prompt`);
  }
  if (input.referenceVideo) {
    // No profile here accepts reference-video *bytes*; metadata-only style
    // description has no ComfyUI input to bind to either, so it is refused
    // rather than silently dropped.
    unsupported(`${profileKey} does not accept reference video`);
  }
  const referenceCount = input.referenceImages?.length ?? 0;
  if (referenceCount > 0) {
    if (!capabilities.supportsReferenceImages) {
      unsupported(`${profileKey} does not support reference images`);
    }
    if (referenceCount > capabilities.maxReferenceImages) {
      unsupported(
        `${profileKey} accepts at most ${capabilities.maxReferenceImages} reference image(s), got ${referenceCount}`,
      );
    }
  }
  if (input.mode === 'IMAGE_TO_VIDEO' && referenceCount === 0) {
    unsupported('IMAGE_TO_VIDEO was requested without a reference image');
  }
  if (input.candidateCount < 1) {
    unsupported(`candidateCount must be at least 1, got ${input.candidateCount}`);
  }
  if (input.candidateCount > capabilities.maxCandidateCount) {
    unsupported(
      `${profileKey} produces at most ${capabilities.maxCandidateCount} candidate(s) per job, got ${input.candidateCount}`,
    );
  }
}

/** `"1080x1920"` → `{ widthPx: 1080, heightPx: 1920 }`. */
export function parseResolution(resolution: string): { widthPx: number; heightPx: number } | null {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(resolution);
  if (!match) return null;
  return { widthPx: Number(match[1]), heightPx: Number(match[2]) };
}

/**
 * Resolves the pixel dimensions to generate at, snapped to what the model's
 * latent geometry actually accepts. A 9:16 request with no explicit resolution
 * falls back to the profile's first supported resolution rather than inventing
 * one.
 */
export function resolveDimensions(
  input: VideoGenerationSubmitInput,
  profile: ComfyUIWorkflowProfile,
): { widthPx: number; heightPx: number } {
  const requested = input.params.resolution
    ? parseResolution(input.params.resolution)
    : parseResolution(profile.capabilities.supportedResolutions[0] ?? '');

  if (!requested) {
    unsupported(
      `Could not resolve output dimensions for ${profile.key} from resolution "${input.params.resolution ?? '<unset>'}"`,
    );
  }

  return {
    widthPx: snapDimension(requested.widthPx, profile.dimensionMultiple),
    heightPx: snapDimension(requested.heightPx, profile.dimensionMultiple),
  };
}

/**
 * The order structured attributes are appended in. Fixed so the same shot
 * brief always produces byte-identical prompt text — which is what makes
 * `promptSha256` a meaningful provenance key and a re-submission genuinely
 * idempotent.
 */
const ATTRIBUTE_ORDER: readonly (keyof ShotCreativeAttributes)[] = [
  'subject',
  'action',
  'environment',
  'lensFraming',
  'cameraMovement',
  'lighting',
  'colorTreatment',
  'motionIntensity',
];

const ATTRIBUTE_LABELS: Readonly<Record<string, string>> = {
  subject: 'Subject',
  action: 'Action',
  environment: 'Environment',
  lensFraming: 'Framing',
  cameraMovement: 'Camera',
  lighting: 'Lighting',
  colorTreatment: 'Colour',
  motionIntensity: 'Motion intensity',
};

/**
 * Composes the text sent to the model: the agent's own `promptText` first,
 * then its structured attributes as labelled clauses, then continuity notes.
 *
 * The agent's sentence leads because that is the creative decision; the
 * labelled clauses follow because diffusion text encoders reward explicit,
 * repeated attribute grounding, and because an attribute the agent expressed
 * only in a structured field would otherwise never reach the model at all.
 */
export function composePromptText(input: VideoGenerationSubmitInput): string {
  const parts: string[] = [input.promptText.trim()];
  const attributes = input.creativeAttributes;

  if (attributes) {
    for (const key of ATTRIBUTE_ORDER) {
      const value = attributes[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        parts.push(`${ATTRIBUTE_LABELS[key] ?? key}: ${value.trim()}`);
      }
    }
    const continuity = attributes.continuityRequirements ?? [];
    if (continuity.length > 0) {
      parts.push(`Continuity: ${continuity.map((note) => note.trim()).join('; ')}`);
    }
  }

  return parts.filter((part) => part.length > 0).join('. ');
}

/** The agent's negative prompt wins; the profile's default fills in when it has none. */
export function composeNegativePrompt(
  input: VideoGenerationSubmitInput,
  profile: ComfyUIWorkflowProfile,
): string {
  const authored = (input.negativePrompt ?? input.params.negativePrompt ?? '').trim();
  return authored.length > 0 ? authored : profile.defaultNegativePrompt;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A seed derived from the idempotency key when the caller supplied none.
 *
 * This is what makes an un-seeded request *still* reproducible: the same
 * attempt, retried or replayed, asks the model for the same noise. A random
 * seed here would make every Temporal retry a different clip.
 */
export function deriveSeed(idempotencyKey: string): number {
  // 2^31-1 ceiling: ComfyUI widgets carry seeds as signed 64-bit but many
  // samplers and custom nodes still assume a 32-bit range.
  return parseInt(sha256Hex(`seed:${idempotencyKey}`).slice(0, 8), 16) % 2_147_483_647;
}

/**
 * The output filename prefix ComfyUI writes under. Derived from a checksum, so
 * no authored text — a prompt, a subject line, a campaign name — can influence
 * a path on the render host.
 */
export function deriveFilenamePrefix(idempotencyKey: string): string {
  return `combat/${sha256Hex(`file:${idempotencyKey}`).slice(0, 32)}`;
}

export function translateSubmitInput(
  input: VideoGenerationSubmitInput,
  profile: ComfyUIWorkflowProfile,
  context: TranslationContext,
): ComfyUIGraphInput {
  assertProfileSupports(input, profile.capabilities, profile.key);

  const { widthPx, heightPx } = resolveDimensions(input, profile);
  const frameRate = input.params.frameRate ?? profile.capabilities.supportedFrameRates[0] ?? 24;
  const frameCount = snapFrameCount(
    Math.round(input.params.durationSeconds * frameRate),
    profile.frameCountMultiple,
  );

  const options = input.params.providerOptions ?? {};
  const steps = readPositiveInteger(options.steps) ?? profile.defaultSteps;
  const cfg = readPositiveNumber(options.cfg) ?? profile.defaultCfg;

  return {
    promptText: composePromptText(input),
    negativePrompt: composeNegativePrompt(input, profile),
    widthPx,
    heightPx,
    frameCount,
    frameRate,
    seed: input.params.seed ?? deriveSeed(input.idempotencyKey),
    steps,
    cfg,
    // ComfyUI's batch_size is how a single job yields several candidates.
    batchSize: input.candidateCount,
    referenceImageFilenames: context.referenceImageFilenames,
    filenamePrefix: deriveFilenamePrefix(input.idempotencyKey),
    mode: input.mode,
  };
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Actual clip length after frame snapping — what the render manifest must
 * budget for, which is not always the duration that was requested.
 */
export function effectiveDurationSeconds(graphInput: ComfyUIGraphInput): number {
  return graphInput.frameCount / graphInput.frameRate;
}
