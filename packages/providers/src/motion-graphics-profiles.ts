import type { MotionGraphicsCapabilities } from './motion-graphics';

/**
 * Illustrative capability shape only — no real aerender/Windows-worker
 * adapter exists at this milestone (M9). This documents what a future real
 * adapter's `getCapabilities()` would plausibly declare, so the compositing
 * Activity's capability-check logic and tests have a realistic, renderer-
 * shaped target to validate against without connecting anything real. Values
 * are researched-plausible approximations, not vendor-published guarantees.
 *
 * Used as the default profile by `MockMotionGraphicsProvider`.
 */
export const DEFAULT_MOTION_GRAPHICS_CAPABILITIES: MotionGraphicsCapabilities = {
  outputFormats: ['mp4', 'mov'],
  aspectRatios: ['9:16', '1:1', '4:5', '16:9'],
  // ~10 minutes at 30fps — comfortably above any rough-edit assembly.
  maxDurationFrames: 18000,
  maxClips: 64,
  supportedTransitions: ['CUT', 'DISSOLVE', 'WIPE', 'FADE_IN', 'FADE_OUT'],
};
