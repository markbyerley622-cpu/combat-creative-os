import type { VideoGenerationCapabilities } from './video-generation';

/**
 * Illustrative capability shapes only — no real Veo/Runway adapter exists
 * (M6 requirement 1: "do not implement real paid adapters or make network
 * calls"). These document what a future real adapter's `getCapabilities()`
 * would plausibly declare, so `ShotGenerationWorkflow`'s capability-check
 * logic and tests have a realistic, vendor-shaped target to validate
 * against without connecting anything real. Values are researched-plausible
 * approximations, not vendor-published guarantees.
 */

/** Veo — preferred future hero-footage provider (docs/architecture.md §7.1 #1). */
export const VEO_CAPABILITY_PROFILE: VideoGenerationCapabilities = {
  supportedModes: ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO'],
  supportsReferenceImages: true,
  maxReferenceImages: 3,
  supportsReferenceVideo: false,
  supportedAspectRatios: ['16:9', '9:16'],
  supportedResolutions: ['1280x720', '1920x1080'],
  minDurationSeconds: 4,
  maxDurationSeconds: 8,
  supportedFrameRates: [24, 30],
  supportsSeed: true,
  supportsNegativePrompt: true,
  maxCandidateCount: 4,
};

/** Runway — preferred future alternative-take/shot-repair provider (docs/architecture.md §7.1 #1). */
export const RUNWAY_CAPABILITY_PROFILE: VideoGenerationCapabilities = {
  supportedModes: ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO'],
  supportsReferenceImages: true,
  maxReferenceImages: 1,
  supportsReferenceVideo: true,
  supportedAspectRatios: ['9:16', '1:1', '16:9'],
  supportedResolutions: ['768x1344', '1344x768'],
  minDurationSeconds: 5,
  maxDurationSeconds: 10,
  supportedFrameRates: [24],
  supportsSeed: false,
  supportsNegativePrompt: false,
  maxCandidateCount: 4,
};
