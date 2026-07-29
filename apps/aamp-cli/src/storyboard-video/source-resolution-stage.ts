import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import { loadCampaignRequest } from '../campaign-request';
import {
  LOCKED_SCENE_ROLES,
  verifyStoryboardV2,
  type VerifiedStoryboardV2,
} from '../flagship/storyboard-v2';
import { loadHumanPlan, type HumanCreativePlan } from '../preview/human-plan';
import { parseProductionAssetManifest, type ProductionAssetManifest } from '../production-assets';
import { StoryboardVideoError } from './failures';
import { readFootagePack, type FootagePack } from './footage-pack';
import { resolveKeyframeLibrary, type KeyframeLibrary } from './keyframe-library';
import {
  DEFAULT_PRE_GENERATED_SUBDIRECTORY,
  resolvePreGeneratedClips,
  type PreGeneratedClipLibrary,
} from './pre-generated-clips';
import { assertPromptsAreSafe } from './prompt-safety';
import { SCENE_TRIM_HANDLE_SECONDS } from './scene-media';
import { modeReachesGenerationProvider, type SceneManifest } from './scene-manifest';
import { loadSceneManifest } from './scene-manifest';
import { resolveSceneSources, type SceneSourceDecision } from './source-precedence';

/**
 * Everything a run knows before it decides whether to spend money.
 *
 * This was the first six stages of `runStoryboardVideo` and is now its own
 * function, because the motion review needs exactly the same picture of the
 * world and must reach it without a second implementation. Two resolvers that
 * agreed today would disagree the first time one of them was fixed, and the
 * review would then be reviewing a different set of clips from the ones the
 * render uses — which is the one way a review gate can be worse than no gate
 * at all.
 *
 * Nothing here constructs a provider, reads an API key or makes a request. The
 * whole stage is filesystem reads, FFmpeg probes and pure decisions, which is
 * what lets the review command run for free.
 */

export interface ResolveStoryboardVideoContextOptions {
  readonly storyboardRoot: string;
  readonly framesDirectory: string;
  readonly workPackRoot: string;
  readonly campaignDirectory: string;
  readonly footagePackRoot?: string;
  readonly preGeneratedClipsDirectory?: string;
  readonly sceneManifestPath?: string;
  /** Where the provisional request is materialised. Nothing else is written. */
  readonly scratchDirectory: string;
  readonly regenerateScenes: ReadonlySet<number>;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

export interface StoryboardVideoContext {
  readonly storyboard: VerifiedStoryboardV2;
  readonly sceneManifest: SceneManifest;
  readonly sceneManifestPath: string;
  readonly basePlan: HumanCreativePlan;
  readonly keyframes: KeyframeLibrary;
  readonly preGeneratedClips: PreGeneratedClipLibrary;
  readonly footagePack: FootagePack | null;
  readonly captureLibrary: ProductionAssetManifest | null;
  readonly decisions: readonly SceneSourceDecision[];
  readonly requiredSecondsByScene: ReadonlyMap<number, number>;
  readonly checkedPrompts: ReturnType<typeof assertPromptsAreSafe>;
  readonly campaignDirectory: string;
  readonly workPackRoot: string;
  readonly libraryManifestPath: string;
}

export async function resolveStoryboardVideoContext(
  options: ResolveStoryboardVideoContextOptions,
): Promise<StoryboardVideoContext> {
  options.onProgress?.('verifying the locked storyboard package');
  const storyboard = await verifyStoryboardV2(options.storyboardRoot);

  const campaignDirectory = resolve(options.campaignDirectory);
  const workPackRoot = resolve(options.workPackRoot);
  const libraryManifestPath = join(workPackRoot, 'asset-root', 'assets.json');

  let captureLibrary: ProductionAssetManifest | null = null;
  try {
    captureLibrary = parseProductionAssetManifest(
      JSON.parse(await readFile(libraryManifestPath, 'utf8')),
      libraryManifestPath,
    );
  } catch {
    captureLibrary = null;
  }

  const basePlan = await loadBasePlan(
    campaignDirectory,
    options.scratchDirectory,
    libraryManifestPath,
  );

  const sceneManifestPath =
    options.sceneManifestPath ?? join(campaignDirectory, 'scene-manifest.json');
  options.onProgress?.('reading the ordered scene manifest');
  const sceneManifest = await loadSceneManifest(sceneManifestPath, storyboard);

  const requiredSecondsByScene = buildRequiredSeconds(basePlan);
  const requiredFor = (sceneNumber: number): number => requiredSecondsByScene.get(sceneNumber) ?? 0;

  options.onProgress?.(`resolving the ten approved keyframes from ${options.framesDirectory}`);
  const keyframes = await resolveKeyframeLibrary({
    framesDirectory: options.framesDirectory,
    runner: options.runner,
    binaries: options.binaries,
  });

  const preGeneratedDirectory =
    options.preGeneratedClipsDirectory ??
    join(options.framesDirectory, DEFAULT_PRE_GENERATED_SUBDIRECTORY);
  const preGeneratedClips = await resolvePreGeneratedClips({
    directory: preGeneratedDirectory,
    runner: options.runner,
    binaries: options.binaries,
    requiredSecondsByScene,
  });

  let footagePack: FootagePack | null = null;
  if (options.footagePackRoot) {
    options.onProgress?.('reading the footage acquisition pack');
    footagePack = await readFootagePack({
      packRoot: options.footagePackRoot,
      runner: options.runner,
      binaries: options.binaries,
    });
  }

  const checkedPrompts = assertPromptsAreSafe(sceneManifest.scenes, (scene) =>
    modeReachesGenerationProvider(scene.generationMode),
  );

  const decisions = resolveSceneSources({
    sceneManifest,
    storyboardRolesBySceneNumber: new Map(
      LOCKED_SCENE_ROLES.map((role, index) => [index + 1, role]),
    ),
    keyframes,
    footagePack,
    preGeneratedClips,
    regenerateScenes: options.regenerateScenes,
    captureLibrary,
    requiredSourceSecondsForScene: (scene) => requiredFor(scene.sceneNumber),
  });

  return {
    storyboard,
    sceneManifest,
    sceneManifestPath,
    basePlan,
    keyframes,
    preGeneratedClips,
    footagePack,
    captureLibrary,
    decisions,
    requiredSecondsByScene,
    checkedPrompts,
    campaignDirectory,
    workPackRoot,
    libraryManifestPath,
  };
}

/**
 * The campaign plan, loaded against a provisional request.
 *
 * `loadHumanPlan` binds a plan to a brief by prompt hash, so the request has to
 * be materialised first even though the render will materialise its own later.
 * Cheap, and it means a plan written for a different brief is refused here
 * rather than after the money has been spent.
 */
export async function loadBasePlan(
  campaignDirectory: string,
  scratchDirectory: string,
  libraryManifestPath: string,
): Promise<HumanCreativePlan> {
  const template = JSON.parse(
    await readFile(join(campaignDirectory, 'request.template.json'), 'utf8'),
  ) as Record<string, unknown> & { promptFile?: string };
  const promptFile = template.promptFile;
  if (typeof promptFile !== 'string') {
    throw new StoryboardVideoError(
      'INVALID_STORYBOARD',
      'the request template must declare a promptFile',
    );
  }
  const campaignPrompt = (await readFile(resolve(campaignDirectory, promptFile), 'utf8')).trim();
  const { promptFile: _omitted, ...rest } = template;
  const target = join(scratchDirectory, 'storyboard-video-request.preflight.json');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    `${JSON.stringify(
      {
        ...rest,
        campaignPrompt,
        sourceAssetManifest: libraryManifestPath,
        outputDirectory: scratchDirectory,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const request = await loadCampaignRequest(target);
  return loadHumanPlan(join(campaignDirectory, 'creative-plan.json'), request);
}

/** Beat duration plus the handles the deterministic selector requires. */
export function buildRequiredSeconds(plan: HumanCreativePlan): Map<number, number> {
  const required = new Map<number, number>();
  plan.beats.forEach((beat, index) => {
    const head = beat.transitionIn ? SCENE_TRIM_HANDLE_SECONDS : 0;
    const tail = plan.beats[index + 1]?.transitionIn ? SCENE_TRIM_HANDLE_SECONDS : 0;
    required.set(index + 1, Number((beat.durationSeconds + head + tail).toFixed(6)));
  });
  return required;
}

/**
 * Where a scene's moving picture actually is, when it has one.
 *
 * Shared by the run and the review so both inspect the same bytes. A scene
 * whose source is a still returns null: there is nothing moving to point at.
 */
export function movingSourcePathFor(input: {
  readonly decision: SceneSourceDecision;
  readonly preGeneratedClips: PreGeneratedClipLibrary;
  readonly footagePack: FootagePack | null;
  readonly generatedPathsByScene?: ReadonlyMap<number, string>;
}): string | null {
  const { decision } = input;
  if (decision.selectedSourceType === 'PRE_GENERATED_MANUAL_CLIP') {
    return (
      input.preGeneratedClips.clips.find((clip) => clip.sceneNumber === decision.sceneNumber)
        ?.absolutePath ?? null
    );
  }
  if (decision.selectedSourceType === 'ACQUIRED_PRODUCTION_FOOTAGE') {
    return (
      input.footagePack?.originals.find((original) => original.assetId === decision.acquiredAssetId)
        ?.absolutePath ?? null
    );
  }
  if (decision.selectedSourceType === 'LTX_GENERATED') {
    return input.generatedPathsByScene?.get(decision.sceneNumber) ?? null;
  }
  return null;
}
