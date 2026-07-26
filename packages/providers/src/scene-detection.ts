/**
 * Provider-neutral shot-boundary detection for Creative Memory.
 *
 * Two real implementations exist. `FfmpegSceneDetectionProvider` uses the
 * FFmpeg toolchain this repository already pins and documents, so scene
 * detection works today with no new dependency. `PySceneDetectProvider` shells
 * out to a pinned PySceneDetect release when the operator has installed one,
 * for its adaptive detector and richer statistics.
 *
 * Neither ever parses human-formatted terminal output: both request a
 * machine-readable format (`ffprobe -of json`, `scenedetect list-scenes -f
 * csv`) and parse that. A detector that scrapes a progress bar is a detector
 * that breaks silently on the next release.
 */

export const SCENE_DETECTION_FAILURE_KINDS = [
  /** The detector binary is not installed or not runnable. */
  'DETECTOR_UNAVAILABLE',
  /** The detector ran but exceeded its deadline. */
  'TIMEOUT',
  /** The detector was cancelled by the caller. */
  'CANCELLED',
  /** The detector ran and failed (bad input, unreadable media). */
  'DETECTION_FAILED',
  /** The detector produced output this adapter could not parse. */
  'MALFORMED_OUTPUT',
] as const;
export type SceneDetectionFailureKind = (typeof SCENE_DETECTION_FAILURE_KINDS)[number];

export class SceneDetectionError extends Error {
  constructor(
    public readonly kind: SceneDetectionFailureKind,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'SceneDetectionError';
  }
}

export interface DetectedScene {
  readonly sceneIndex: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationSeconds: number;
  /** Detector-reported score for the cut that opened this scene, when available. */
  readonly confidence?: number;
}

export interface SceneDetectionRequest {
  /** Absolute path to the reference file. Never modified. */
  readonly filePath: string;
  /** Measured duration, used to close the final scene. */
  readonly durationSeconds: number;
  /**
   * Cut sensitivity, 0-1. Lower detects more cuts. Advertisements cut fast, so
   * the defaults below are deliberately more sensitive than a film default.
   */
  readonly threshold?: number;
  /** Scenes shorter than this are merged into the previous one. */
  readonly minSceneSeconds?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SceneDetectionResult {
  readonly method: string;
  readonly toolVersion: string;
  readonly detectorConfig: Record<string, unknown>;
  readonly scenes: readonly DetectedScene[];
  /** The exact argv executed, for provenance. Empty for a fake. */
  readonly command: string;
}

export interface SceneDetectionProvider {
  readonly name: string;
  /** Cheap probe so a CLI can report an actionable "not installed" before doing work. */
  isAvailable(): Promise<boolean>;
  detectScenes(request: SceneDetectionRequest): Promise<SceneDetectionResult>;
}

/**
 * Turns detected cut timestamps into closed scene intervals.
 *
 * Shared by both real providers because the arithmetic is where the subtle
 * bugs live: a cut list is a set of *boundaries*, and turning N boundaries
 * into N+1 scenes while merging sub-threshold fragments and closing the last
 * scene on the measured duration is worth writing once.
 */
export function cutsToScenes(
  cutSeconds: readonly number[],
  durationSeconds: number,
  minSceneSeconds: number,
  confidenceByCut?: ReadonlyMap<number, number>,
): DetectedScene[] {
  const boundaries = [...new Set(cutSeconds)]
    .filter((cut) => cut > 0 && cut < durationSeconds)
    .sort((a, b) => a - b);

  const starts: number[] = [0];
  for (const boundary of boundaries) {
    const previous = starts[starts.length - 1] ?? 0;
    // Merge a fragment rather than emitting a scene too short to be a shot.
    if (boundary - previous >= minSceneSeconds) starts.push(boundary);
  }

  const scenes: DetectedScene[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const startSeconds = starts[index] as number;
    const endSeconds = index + 1 < starts.length ? (starts[index + 1] as number) : durationSeconds;
    if (endSeconds - startSeconds <= 0) continue;
    const confidence = confidenceByCut?.get(startSeconds);
    scenes.push({
      sceneIndex: scenes.length,
      startSeconds: Number(startSeconds.toFixed(3)),
      endSeconds: Number(endSeconds.toFixed(3)),
      durationSeconds: Number((endSeconds - startSeconds).toFixed(3)),
      ...(confidence === undefined ? {} : { confidence }),
    });
  }

  // A file with no detected cut is still one scene: the whole advertisement.
  if (scenes.length === 0 && durationSeconds > 0) {
    scenes.push({
      sceneIndex: 0,
      startSeconds: 0,
      endSeconds: Number(durationSeconds.toFixed(3)),
      durationSeconds: Number(durationSeconds.toFixed(3)),
    });
  }

  return scenes;
}

export const DEFAULT_SCENE_THRESHOLD = 0.27;
export const DEFAULT_MIN_SCENE_SECONDS = 0.25;
export const DEFAULT_SCENE_DETECTION_TIMEOUT_MS = 10 * 60_000;
