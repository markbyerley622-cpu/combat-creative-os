import { createHash } from 'node:crypto';

import {
  cutsToScenes,
  DEFAULT_MIN_SCENE_SECONDS,
  SceneDetectionError,
  type SceneDetectionProvider,
  type SceneDetectionRequest,
  type SceneDetectionResult,
} from './scene-detection';

/**
 * Deterministic scene detection for tests.
 *
 * Either replays scripted cut lists keyed by filename, or — with nothing
 * scripted — derives evenly-spaced cuts from a hash of the path, so the same
 * file always yields the same segmentation without anyone having to author
 * one. No process is spawned and no media is read.
 */
export interface MockSceneDetectionOptions {
  /** Cut timestamps per file basename. Anything unscripted falls back to the hash. */
  readonly cutsByFile?: Readonly<Record<string, readonly number[]>>;
  /** Force a typed failure, to exercise the pipeline's error paths. */
  readonly failWith?: SceneDetectionError;
  readonly available?: boolean;
}

export class MockSceneDetectionProvider implements SceneDetectionProvider {
  readonly name = 'mock-scene-detection';
  readonly calls: SceneDetectionRequest[] = [];

  constructor(private readonly options: MockSceneDetectionOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return this.options.available ?? true;
  }

  async detectScenes(request: SceneDetectionRequest): Promise<SceneDetectionResult> {
    this.calls.push(request);
    if (this.options.failWith) throw this.options.failWith;

    const key = request.filePath.replace(/\\/g, '/').split('/').pop() ?? request.filePath;
    const scripted = this.options.cutsByFile?.[key];
    const cuts = scripted ?? derivedCuts(key, request.durationSeconds);

    return {
      method: this.name,
      toolVersion: 'mock-1',
      detectorConfig: { scripted: scripted !== undefined },
      scenes: cutsToScenes(
        cuts,
        request.durationSeconds,
        request.minSceneSeconds ?? DEFAULT_MIN_SCENE_SECONDS,
      ),
      command: '',
    };
  }
}

/** 2-4 evenly spaced cuts, chosen by hashing the filename. */
function derivedCuts(key: string, durationSeconds: number): number[] {
  const seed = parseInt(createHash('sha256').update(key).digest('hex').slice(0, 4), 16);
  const cutCount = 2 + (seed % 3);
  const step = durationSeconds / (cutCount + 1);
  return Array.from({ length: cutCount }, (_, index) => Number((step * (index + 1)).toFixed(3)));
}
