import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import type { PreparedSceneClip } from '../storyboard-video/scene-media';
import {
  buildStoryScenes,
  type BuiltStoryScene,
  type StoryPlateSource,
  type StorySceneInput,
} from './build-story-scenes';
import { parseProductStoryPlan, ProductStoryError, type ProductStoryPlan } from './story-contracts';
import {
  assertSceneExposureReadable,
  measureSceneExposure,
  type SceneExposureRecord,
} from './story-exposure';

/**
 * The product-story stage, run in one place.
 *
 * It sits between the moving sources being prepared and the notification being
 * composited, which is the only point where all three of its inputs exist: the
 * staged plates, the trimmed clips, and the beat durations the cut will
 * actually use. Everything it produces replaces an entry in the prepared map,
 * so the whole path after it — the derived plan, the flagship staging,
 * preflight, rights, segment selection, the filter graph and actual-media QA —
 * runs unchanged.
 *
 * Its refusals are the correction's own acceptance criteria: an unmappable
 * screen, an interface that would not fit its glass, a reserved region with
 * nothing in it, a live-action scene whose subject cannot be read. None of them
 * has a repair path and none has a fallback to the storyboard panel.
 */

export async function loadProductStoryPlan(path: string): Promise<ProductStoryPlan> {
  const absolute = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolute, 'utf8'));
  } catch (error) {
    throw new ProductStoryError(
      'INVALID_STORY_PLAN',
      `the product-story plan at ${absolute} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseProductStoryPlan(raw, absolute);
}

export interface ProductStoryStageResult {
  readonly plan: ProductStoryPlan;
  readonly built: readonly BuiltStoryScene[];
  readonly exposure: readonly SceneExposureRecord[];
  /** Scene number → the clip the render should now use. */
  readonly replacements: ReadonlyMap<number, PreparedSceneClip>;
}

export async function runProductStoryStage(input: {
  readonly plan: ProductStoryPlan;
  readonly prepared: ReadonlyMap<number, PreparedSceneClip>;
  readonly plates: ReadonlyMap<string, StoryPlateSource>;
  readonly beatDurations: ReadonlyMap<number, number>;
  readonly handleSeconds: ReadonlyMap<number, { head: number; tail: number }>;
  readonly logoPath: string;
  readonly outputDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly accentHex: string;
  readonly onProgress?: (message: string) => void;
}): Promise<ProductStoryStageResult> {
  const sceneInputs: StorySceneInput[] = input.plan.scenes.map((scene) => {
    const beat = input.beatDurations.get(scene.sceneNumber);
    const handles = input.handleSeconds.get(scene.sceneNumber) ?? { head: 0, tail: 0 };
    if (beat === undefined) {
      throw new ProductStoryError(
        'INVALID_STORY_PLAN',
        `the story plan declares scene ${scene.sceneNumber}, which the cut has no beat for`,
        scene.sceneNumber,
      );
    }
    const durationSeconds = Number((beat + handles.head + handles.tail).toFixed(6));
    const existing = input.prepared.get(scene.sceneNumber);
    if (scene.kind === 'FOOTAGE_TREATMENT' && !existing) {
      throw new ProductStoryError(
        'COMPOSITE_FAILED',
        `scene ${scene.sceneNumber} is a footage treatment but the run prepared no moving clip for it`,
        scene.sceneNumber,
      );
    }
    return {
      sceneNumber: scene.sceneNumber,
      durationSeconds,
      ...(existing ? { clipPath: existing.absolutePath } : {}),
    };
  });

  const built = await buildStoryScenes({
    plan: input.plan,
    scenes: sceneInputs,
    plates: input.plates,
    logoPath: input.logoPath,
    outputDirectory: input.outputDirectory,
    runner: input.runner,
    binaries: input.binaries,
    accentHex: input.accentHex,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });

  // Measured from the finished scene clips, before assembly. A refusal here
  // means the run has produced no master, which is the point: a reviewer should
  // not be asked to look at a scene nobody can see.
  const exposure = await measureSceneExposure({
    ffmpegPath: input.binaries.ffmpeg,
    scenes: built.map((scene) => {
      const declared = input.plan.scenes.find(
        (candidate) => candidate.sceneNumber === scene.sceneNumber,
      );
      const handles = input.handleSeconds.get(scene.sceneNumber) ?? { head: 0, tail: 0 };
      return {
        sceneNumber: scene.sceneNumber,
        clipPath: scene.outputPath,
        durationSeconds: scene.durationSeconds,
        windowStartSeconds: handles.head,
        windowDurationSeconds: input.beatDurations.get(scene.sceneNumber) ?? scene.durationSeconds,
        profile:
          declared?.kind === 'PLATE_UI_COMPOSITE'
            ? ('PRODUCT_INTERFACE' as const)
            : ('LIVE_ACTION' as const),
        subjectRegion: declared?.subjectRegion ?? {
          xPx: 0,
          yPx: 0,
          widthPx: scene.widthPx,
          heightPx: scene.heightPx,
        },
      };
    }),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });

  assertSceneExposureReadable(exposure);

  const replacements = new Map<number, PreparedSceneClip>();
  for (const scene of built) {
    const handles = input.handleSeconds.get(scene.sceneNumber) ?? { head: 0, tail: 0 };
    const existing = input.prepared.get(scene.sceneNumber);
    replacements.set(scene.sceneNumber, {
      sceneNumber: scene.sceneNumber,
      absolutePath: scene.outputPath,
      checksumSha256: scene.checksumSha256,
      usedInSeconds: existing?.usedInSeconds ?? 0,
      usedDurationSeconds: scene.durationSeconds,
      discardedSeconds: existing?.discardedSeconds ?? 0,
      widthPx: scene.widthPx,
      heightPx: scene.heightPx,
      // The composite was built to span exactly this scene's window plus its
      // handles, so the beat starts one head-handle in. Pinned rather than
      // searched: there is only one legal window in a clip cut for it.
      pinnedInSeconds: handles.head,
    });
  }

  return { plan: input.plan, built, exposure, replacements };
}
