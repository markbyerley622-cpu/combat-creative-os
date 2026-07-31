import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  compileCompanionComposite,
  compilePlateMotion,
  compileSheetOverlay,
  compileUiSceneComposite,
  type CameraMove,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';

import { loadMarkDataUri } from '../product-motion/mobile-documents';
import { buildInterfaceDocument } from './interface-documents';
import { calibrateSceneScreen, type CalibratedSceneScreen } from './screen-calibration-set';
import { buildScreenTreatment } from './screen-treatments';
import { renderSheetSequences, type SheetSequenceRequest } from './sheet-sequence';
import {
  ProductStoryError,
  type ProductStoryPlan,
  type ScreenTreatment,
  type StoryScene,
} from './story-contracts';

/**
 * Building the corrected picture for every scene the story plan names.
 *
 * Three shapes, and the plan's discriminator decides which one a scene gets:
 *
 *   - `PLATE_UI_COMPOSITE` — the operator's authoritative plate, full-frame and
 *     moving, with the mobile-native product document warped onto the handset's
 *     calibrated screen. This is what replaces the 470px landscape storyboard
 *     cards that were floating inside a portrait frame.
 *   - `PLATE_DETERMINISTIC_MOTION` — the plate alone, moving. Scene 1, whose
 *     generated take a named reviewer rejected.
 *   - `FOOTAGE_TREATMENT` — footage the source precedence already resolved,
 *     graded and given a screen-space treatment.
 *
 * Nothing here generates, buys, retries or replaces footage, and no provider,
 * credential or network call exists on this path. What it does is composite
 * pixels that are already on disk.
 */

export const STORY_SCENE_DIRECTORY = 'product-story-scenes';

export interface StoryPlateSource {
  readonly frameId: string;
  readonly absolutePath: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly checksumSha256: string;
}

export interface StorySceneInput {
  readonly sceneNumber: number;
  /** The already-prepared moving clip, for a footage-treatment scene. */
  readonly clipPath?: string;
  /** The scene's window in the finished cut, handles included. */
  readonly durationSeconds: number;
}

export interface BuiltStoryScene {
  readonly sceneNumber: number;
  readonly kind: StoryScene['kind'];
  readonly outputPath: string;
  readonly checksumSha256: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly durationSeconds: number;
  readonly frameCount: number;
  readonly calibration: CalibratedSceneScreen | null;
  readonly screenTreatment: ScreenTreatment | null;
  readonly plateFrameId: string | null;
  readonly plateChecksumSha256: string | null;
  readonly gradeApplied: boolean;
  readonly ffmpegPasses: number;
}

export interface BuildStoryScenesOptions {
  readonly plan: ProductStoryPlan;
  readonly scenes: readonly StorySceneInput[];
  readonly plates: ReadonlyMap<string, StoryPlateSource>;
  readonly logoPath: string;
  readonly outputDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly accentHex: string;
  readonly onProgress?: (message: string) => void;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Every intermediate is encoded at CRF 14.
 *
 * Deliberately below the master's own rate factor. An intermediate is decoded
 * and re-encoded at least once more before delivery, and generation loss on a
 * dark gradient — which is most of this cut — is what banding looks like.
 */
const INTERMEDIATE_CRF = '14';

/**
 * Two frames more than the scene needs, on every composite.
 *
 * A scene's window is its beat plus a transition handle at each end, and those
 * three numbers add up to the duration exactly — with no slack at all. Quantise
 * that onto the frame grid and the encoded file can come back a few
 * milliseconds short, which strips the tail handle and makes the segment
 * selector refuse a scene whose picture is perfectly fine, two stages from the
 * cause. The pad is declared in the artefacts rather than hidden: the clip
 * really is longer than the cut needs, and the selector trims it.
 */
const TAIL_PAD_FRAMES = 2;

function paddedFrameCount(durationSeconds: number, frameRate: number): number {
  return Math.max(1, Math.round(durationSeconds * frameRate)) + TAIL_PAD_FRAMES;
}

async function encode(input: {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly args: readonly string[];
  readonly what: string;
  readonly sceneNumber: number;
}): Promise<void> {
  const result = await input.runner.run(input.binaries.ffmpeg, [...input.args], {
    timeoutMs: 600_000,
  });
  if (result.exitCode !== 0) {
    throw new ProductStoryError(
      'COMPOSITE_FAILED',
      `scene ${input.sceneNumber}: ${input.what} failed:\n${result.stderr.trim().slice(-1200)}`,
      input.sceneNumber,
    );
  }
}

export async function buildStoryScenes(
  options: BuildStoryScenesOptions,
): Promise<readonly BuiltStoryScene[]> {
  const { plan } = options;
  const delivery = { widthPx: plan.output.widthPx, heightPx: plan.output.heightPx };
  const frameRate = plan.output.frameRate;
  const workDirectory = join(options.outputDirectory, STORY_SCENE_DIRECTORY);
  await mkdir(workDirectory, { recursive: true });
  const sheetRoot = join(workDirectory, 'sheets');
  await mkdir(sheetRoot, { recursive: true });

  const inputBySceneNumber = new Map(options.scenes.map((scene) => [scene.sceneNumber, scene]));
  const markDataUri = await loadMarkDataUri(options.logoPath);

  // ---- 1. every rasterised sequence, in one browser -------------------------
  //
  // Interface layers and treatment sheets together: a Chromium launch is by far
  // the most expensive thing on this path, and the sequences are independent.
  const calibrations = new Map<number, CalibratedSceneScreen>();
  const sequenceRequests: SheetSequenceRequest[] = [];

  for (const scene of plan.scenes) {
    const input = inputBySceneNumber.get(scene.sceneNumber);
    if (!input) {
      throw new ProductStoryError(
        'INVALID_STORY_PLAN',
        `the story plan declares scene ${scene.sceneNumber} but the run supplied no input for it`,
        scene.sceneNumber,
      );
    }
    const frameCount = paddedFrameCount(input.durationSeconds, frameRate);

    if (scene.kind === 'PLATE_UI_COMPOSITE') {
      const calibration = calibrateSceneScreen(scene, delivery);
      calibrations.set(scene.sceneNumber, calibration);
      const document = buildInterfaceDocument({
        surface: scene.surface,
        viewport: calibration.viewport,
        markDataUri,
        timeline: scene.uiTimeline,
      });
      sequenceRequests.push({
        id: `ui-${String(scene.sceneNumber).padStart(2, '0')}`,
        html: document.html,
        widthPx: calibration.interfaceCanvas.widthPx,
        heightPx: calibration.interfaceCanvas.heightPx,
        cssWidthPx: calibration.viewport.cssWidthPx,
        cssHeightPx: calibration.viewport.cssHeightPx,
        deviceScaleFactor: calibration.viewport.deviceScaleFactor,
        frameCount,
        frameRate,
        startSeconds: 0,
        // The interface fills the handset's glass; it is a screen, not an
        // overlay, so it is opaque.
        transparent: false,
        outputDirectory: sheetRoot,
      });
    }

    if (scene.treatment) {
      const region =
        scene.treatment.region ??
        (scene.kind === 'FOOTAGE_TREATMENT' ? (scene.protectedRegion ?? null) : null);
      sequenceRequests.push({
        id: `sheet-${String(scene.sceneNumber).padStart(2, '0')}`,
        html: buildScreenTreatment({
          treatment: scene.treatment.key,
          frameWidthPx: delivery.widthPx,
          frameHeightPx: delivery.heightPx,
          region,
          copy: { ...scene.treatment.copy, markDataUri },
          timing: { ...scene.treatment.timing, durationSeconds: input.durationSeconds },
          accentHex: options.accentHex,
        }),
        widthPx: delivery.widthPx,
        heightPx: delivery.heightPx,
        frameCount,
        frameRate,
        startSeconds: 0,
        transparent: true,
        outputDirectory: sheetRoot,
      });
    }
  }

  const sequences = new Map(
    (await renderSheetSequences(sequenceRequests, options.onProgress)).map((entry) => [
      entry.id,
      entry,
    ]),
  );

  // ---- 2. one FFmpeg invocation per pass, per scene -------------------------
  const built: BuiltStoryScene[] = [];

  for (const scene of plan.scenes) {
    const input = inputBySceneNumber.get(scene.sceneNumber) as StorySceneInput;
    const label = String(scene.sceneNumber).padStart(2, '0');
    const frameCount = paddedFrameCount(input.durationSeconds, frameRate);
    const builtDurationSeconds = Number((frameCount / frameRate).toFixed(6));
    const basePath = join(workDirectory, `scene-${label}-base.mp4`);
    let passes = 0;
    let plate: StoryPlateSource | null = null;

    if (scene.kind === 'PLATE_UI_COMPOSITE') {
      plate = options.plates.get(scene.frameId) ?? null;
      if (!plate) {
        throw new ProductStoryError(
          'PLATE_NOT_FOUND',
          `scene ${scene.sceneNumber} needs plate ${scene.frameId}, which the run has not staged`,
          scene.sceneNumber,
        );
      }
      const calibration = calibrations.get(scene.sceneNumber) as CalibratedSceneScreen;
      const sequence = sequences.get(`ui-${label}`);
      if (!sequence) {
        throw new ProductStoryError(
          'COMPOSITE_FAILED',
          `scene ${scene.sceneNumber}: its interface sequence was not rasterised`,
          scene.sceneNumber,
        );
      }
      const move: CameraMove = {
        startZoom: scene.move.startZoom,
        endZoom: scene.move.endZoom,
        panCentreU: 0.5 + scene.move.offsetU,
        panCentreV: 0.5 + scene.move.offsetV,
        frames: frameCount,
      };
      const compiled = compileUiSceneComposite({
        sceneId: `scene${label}`,
        plateInputIndex: 0,
        uiInputIndex: 1,
        outputWidthPx: delivery.widthPx,
        outputHeightPx: delivery.heightPx,
        uiCanvasWidthPx: calibration.interfaceCanvas.widthPx,
        uiCanvasHeightPx: calibration.interfaceCanvas.heightPx,
        frameRate,
        durationSeconds: builtDurationSeconds,
        quad: calibration.normalised,
        move,
        ...(scene.plateGrade
          ? {
              plateGrade: {
                midtonePoints: scene.plateGrade.midtonePoints,
                saturation: scene.plateGrade.saturation,
              },
            }
          : {}),
      });
      // eslint-disable-next-line no-await-in-loop -- scenes build in order so progress is legible
      await encode({
        runner: options.runner,
        binaries: options.binaries,
        sceneNumber: scene.sceneNumber,
        what: 'the plate-and-interface composite',
        args: [
          '-nostdin',
          '-v',
          'error',
          '-loop',
          '1',
          '-i',
          plate.absolutePath,
          '-framerate',
          String(frameRate),
          '-i',
          sequence.patternPath,
          '-filter_complex',
          compiled.graph,
          '-map',
          `[${compiled.outputLabel}]`,
          '-frames:v',
          String(frameCount),
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-crf',
          INTERMEDIATE_CRF,
          '-pix_fmt',
          'yuv420p',
          '-fflags',
          '+bitexact',
          '-flags:v',
          '+bitexact',
          '-y',
          basePath,
        ],
      });
      passes += 1;
    } else if (scene.kind === 'PLATE_DETERMINISTIC_MOTION') {
      plate = options.plates.get(scene.frameId) ?? null;
      if (!plate) {
        throw new ProductStoryError(
          'PLATE_NOT_FOUND',
          `scene ${scene.sceneNumber} needs plate ${scene.frameId}, which the run has not staged`,
          scene.sceneNumber,
        );
      }
      const compiled = compilePlateMotion({
        sceneId: `scene${label}`,
        plateInputIndex: 0,
        outputWidthPx: delivery.widthPx,
        outputHeightPx: delivery.heightPx,
        frameRate,
        durationSeconds: builtDurationSeconds,
        move: {
          startZoom: scene.move.startZoom,
          endZoom: scene.move.endZoom,
          panCentreU: 0.5 + scene.move.offsetU,
          panCentreV: 0.5 + scene.move.offsetV,
          frames: frameCount,
        },
        ...(scene.plateGrade
          ? {
              plateGrade: {
                midtonePoints: scene.plateGrade.midtonePoints,
                saturation: scene.plateGrade.saturation,
              },
            }
          : {}),
      });
      // eslint-disable-next-line no-await-in-loop -- see above
      await encode({
        runner: options.runner,
        binaries: options.binaries,
        sceneNumber: scene.sceneNumber,
        what: 'the deterministic plate move',
        args: [
          '-nostdin',
          '-v',
          'error',
          '-loop',
          '1',
          '-i',
          plate.absolutePath,
          '-filter_complex',
          compiled.graph,
          '-map',
          `[${compiled.outputLabel}]`,
          '-frames:v',
          String(frameCount),
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-crf',
          INTERMEDIATE_CRF,
          '-pix_fmt',
          'yuv420p',
          '-fflags',
          '+bitexact',
          '-flags:v',
          '+bitexact',
          '-y',
          basePath,
        ],
      });
      passes += 1;
    } else {
      if (!input.clipPath) {
        throw new ProductStoryError(
          'COMPOSITE_FAILED',
          `scene ${scene.sceneNumber} is a footage treatment but the run resolved no moving clip for it`,
          scene.sceneNumber,
        );
      }
      const companionPlate = scene.companionFrameId
        ? (options.plates.get(scene.companionFrameId) ?? null)
        : null;
      if (scene.companionFrameId && !companionPlate) {
        throw new ProductStoryError(
          'PLATE_NOT_FOUND',
          `scene ${scene.sceneNumber} names companion plate ${scene.companionFrameId}, which the run has not staged`,
          scene.sceneNumber,
        );
      }

      if (companionPlate && scene.companionClipRect) {
        plate = companionPlate;
        const compiled = compileCompanionComposite({
          sceneId: `scene${label}`,
          plateInputIndex: 0,
          clipInputIndex: 1,
          outputWidthPx: delivery.widthPx,
          outputHeightPx: delivery.heightPx,
          frameRate,
          durationSeconds: builtDurationSeconds,
          clipRect: scene.companionClipRect,
          // The same grade on both layers, deliberately. Two exposures in one
          // frame reads as a composite, which is the one thing a coordinated
          // reveal must not look like.
          ...(scene.grade
            ? {
                clipGrade: {
                  midtonePoints: scene.grade.midtonePoints,
                  saturation: scene.grade.saturation,
                },
                plateGrade: {
                  midtonePoints: scene.grade.midtonePoints,
                  saturation: scene.grade.saturation,
                },
              }
            : {}),
        });
        // eslint-disable-next-line no-await-in-loop -- see above
        await encode({
          runner: options.runner,
          binaries: options.binaries,
          sceneNumber: scene.sceneNumber,
          what: 'the companion-plate composite',
          args: [
            '-nostdin',
            '-v',
            'error',
            '-loop',
            '1',
            '-i',
            companionPlate.absolutePath,
            '-i',
            input.clipPath,
            '-filter_complex',
            compiled.graph,
            '-map',
            `[${compiled.outputLabel}]`,
            '-frames:v',
            String(frameCount),
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            INTERMEDIATE_CRF,
            '-pix_fmt',
            'yuv420p',
            '-fflags',
            '+bitexact',
            '-flags:v',
            '+bitexact',
            '-y',
            basePath,
          ],
        });
        passes += 1;
      } else {
        const compiled = compileSheetOverlay({
          sceneId: `scene${label}g`,
          baseInputIndex: 0,
          sheetInputIndex: null,
          outputWidthPx: delivery.widthPx,
          outputHeightPx: delivery.heightPx,
          frameRate,
          durationSeconds: builtDurationSeconds,
          ...(scene.grade
            ? {
                grade: {
                  midtonePoints: scene.grade.midtonePoints,
                  saturation: scene.grade.saturation,
                },
              }
            : {}),
        });
        // eslint-disable-next-line no-await-in-loop -- see above
        await encode({
          runner: options.runner,
          binaries: options.binaries,
          sceneNumber: scene.sceneNumber,
          what: 'the scene grade',
          args: [
            '-nostdin',
            '-v',
            'error',
            '-i',
            input.clipPath,
            '-filter_complex',
            compiled.graph,
            '-map',
            `[${compiled.outputLabel}]`,
            '-frames:v',
            String(frameCount),
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            INTERMEDIATE_CRF,
            '-pix_fmt',
            'yuv420p',
            '-fflags',
            '+bitexact',
            '-flags:v',
            '+bitexact',
            '-y',
            basePath,
          ],
        });
        passes += 1;
      }
    }

    // ---- the screen-space treatment, last ----------------------------------
    //
    // After the picture is finished, always. A treatment composited before the
    // grade would be graded with it, and lifting a fighter out of the shadows
    // must never touch the typography sitting over them.
    let finalPath = basePath;
    const sheet = scene.treatment ? sequences.get(`sheet-${label}`) : undefined;
    if (sheet) {
      finalPath = join(workDirectory, `scene-${label}.mp4`);
      const compiled = compileSheetOverlay({
        sceneId: `scene${label}s`,
        baseInputIndex: 0,
        sheetInputIndex: 1,
        outputWidthPx: delivery.widthPx,
        outputHeightPx: delivery.heightPx,
        frameRate,
        durationSeconds: builtDurationSeconds,
      });
      // eslint-disable-next-line no-await-in-loop -- see above
      await encode({
        runner: options.runner,
        binaries: options.binaries,
        sceneNumber: scene.sceneNumber,
        what: `the ${scene.treatment?.key ?? ''} screen treatment`,
        args: [
          '-nostdin',
          '-v',
          'error',
          '-i',
          basePath,
          '-framerate',
          String(frameRate),
          '-i',
          sheet.patternPath,
          '-filter_complex',
          compiled.graph,
          '-map',
          `[${compiled.outputLabel}]`,
          '-frames:v',
          String(frameCount),
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-crf',
          INTERMEDIATE_CRF,
          '-pix_fmt',
          'yuv420p',
          '-fflags',
          '+bitexact',
          '-flags:v',
          '+bitexact',
          '-y',
          finalPath,
        ],
      });
      passes += 1;
    }

    options.onProgress?.(
      `scene ${scene.sceneNumber}: ${scene.kind} built in ${passes} pass(es)${
        scene.treatment ? ` with ${scene.treatment.key}` : ''
      }`,
    );

    built.push({
      sceneNumber: scene.sceneNumber,
      kind: scene.kind,
      outputPath: finalPath,
      // eslint-disable-next-line no-await-in-loop -- see above
      checksumSha256: await sha256(finalPath),
      widthPx: delivery.widthPx,
      heightPx: delivery.heightPx,
      durationSeconds: builtDurationSeconds,
      frameCount,
      calibration: calibrations.get(scene.sceneNumber) ?? null,
      screenTreatment: scene.treatment?.key ?? null,
      plateFrameId: plate?.frameId ?? null,
      plateChecksumSha256: plate?.checksumSha256 ?? null,
      gradeApplied:
        scene.kind === 'FOOTAGE_TREATMENT' ? Boolean(scene.grade) : Boolean(scene.plateGrade),
      ffmpegPasses: passes,
    });
  }

  return built;
}
