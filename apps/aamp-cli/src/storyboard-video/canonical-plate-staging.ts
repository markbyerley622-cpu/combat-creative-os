import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import {
  resolvePlateLibrary,
  type PlateLibrary,
  type ResolvedPlate,
} from '../scene-acceptance/plate-library';
import { StoryboardVideoError } from './failures';
import { canonicalFrameId, KEYFRAME_COUNT } from './keyframe-library';

/**
 * The ten authoritative plates, copied into a directory this run owns and
 * named the way the rest of the system already speaks.
 *
 * `resolvePlateLibrary` discovers `FRAME1PLATE` … `FRAME10PLATE` in the
 * operator's marketing folder and refuses every ambiguity — two files for one
 * number, a plate-shaped name with an unusable extension, a landscape plate, a
 * symlink leaving the folder, an undecodable file. `resolveKeyframeLibrary`
 * reads `FRAME-01` … `FRAME-10`. This module is the bridge, and it is a bridge
 * rather than a rename for two reasons:
 *
 * - **The operator's folder is read-only.** Renaming ten files in it to satisfy
 *   a tool would be this pipeline editing the operator's own marketing
 *   library. Nothing here writes, renames, moves or deletes outside the run
 *   directory.
 * - **The run must own its inputs.** A run that pointed FFmpeg at a folder
 *   somebody could edit mid-render has no defensible claim about which pixels
 *   it used. The copy is checksummed on arrival against the source's own
 *   hash, so "this is the plate that was discovered" is a fact about bytes.
 *
 * The staged directory holds exactly the ten canonical files and a manifest of
 * what came from where. It is written under the run directory, so it is not
 * committed and a second run rebuilds it from the same source.
 */

export const STAGED_PLATES_DIRECTORY = 'staged-plates';
export const STAGED_PLATE_MANIFEST = 'staged-plates.json';

export interface StagedPlate {
  readonly sceneNumber: number;
  /** `FRAME-01` … `FRAME-10`. */
  readonly frameId: string;
  /** The operator's own file name, so a report matches what they see on disk. */
  readonly sourceFileName: string;
  readonly sourceAbsolutePath: string;
  readonly stagedAbsolutePath: string;
  readonly stagedFileName: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly aspectRatio: number;
  readonly mimeType: string;
}

export interface StagedPlateLibrary {
  readonly sourceDirectory: string;
  readonly stagedDirectory: string;
  readonly plates: readonly StagedPlate[];
  /** Present in the source folder but not plate-shaped. Recorded, never an error. */
  readonly ignoredSourceFiles: readonly string[];
}

export interface StageCanonicalPlatesOptions {
  readonly platesDirectory: string;
  readonly outputDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

export async function stageCanonicalPlates(
  options: StageCanonicalPlatesOptions,
): Promise<StagedPlateLibrary> {
  let library: PlateLibrary;
  try {
    library = await resolvePlateLibrary({
      platesDirectory: options.platesDirectory,
      runner: options.runner,
      binaries: options.binaries,
    });
  } catch (error) {
    // Re-typed so an operator reads "the plates could not be staged" with the
    // discovery's own diagnosis inside it, rather than a keyframe error from a
    // directory they never named.
    throw new StoryboardVideoError(
      'PLATE_STAGING_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }

  const stagedDirectory = resolve(options.outputDirectory, STAGED_PLATES_DIRECTORY);
  await mkdir(stagedDirectory, { recursive: true });
  options.onProgress?.(
    `staging ${library.plates.length} authoritative plate(s) from ${library.platesDirectory} as run-owned ${canonicalFrameId(1)} … ${canonicalFrameId(KEYFRAME_COUNT)}`,
  );

  const plates: StagedPlate[] = [];
  for (const plate of library.plates) {
    // eslint-disable-next-line no-await-in-loop -- ordered so the manifest is stable
    plates.push(await stageOne(plate, stagedDirectory));
  }

  const manifest: StagedPlateLibrary = {
    sourceDirectory: library.platesDirectory,
    stagedDirectory,
    plates,
    ignoredSourceFiles: library.ignoredFiles,
  };

  await writeFile(
    join(options.outputDirectory, STAGED_PLATE_MANIFEST),
    `${JSON.stringify(
      {
        notice:
          'The source directory is read-only. Every file below is a verified copy: the copy was re-hashed from the bytes that landed and compared to the source before anything used it.',
        ...manifest,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return manifest;
}

async function stageOne(plate: ResolvedPlate, stagedDirectory: string): Promise<StagedPlate> {
  const bytes = await readFile(plate.absolutePath);
  const sourceChecksum = createHash('sha256').update(bytes).digest('hex');
  if (sourceChecksum !== plate.checksumSha256) {
    throw new StoryboardVideoError(
      'PLATE_STAGING_FAILED',
      `${plate.fileName} changed between discovery and staging (${plate.checksumSha256.slice(0, 16)}… became ${sourceChecksum.slice(0, 16)}…). Nothing has been generated.`,
    );
  }

  const extension = plate.mimeType === 'image/png' ? '.png' : '.jpg';
  const stagedFileName = `${plate.frameId}${extension}`;
  const stagedAbsolutePath = join(stagedDirectory, stagedFileName);
  await writeFile(stagedAbsolutePath, bytes);

  const stagedChecksum = createHash('sha256')
    .update(await readFile(stagedAbsolutePath))
    .digest('hex');
  if (stagedChecksum !== sourceChecksum) {
    throw new StoryboardVideoError(
      'PLATE_STAGING_FAILED',
      `the staged copy of ${plate.fileName} does not hash to its source. Nothing has been generated.`,
    );
  }

  return {
    sceneNumber: plate.sceneNumber,
    frameId: plate.frameId,
    sourceFileName: plate.fileName,
    sourceAbsolutePath: plate.absolutePath,
    stagedAbsolutePath,
    stagedFileName,
    checksumSha256: stagedChecksum,
    sizeBytes: bytes.byteLength,
    widthPx: plate.widthPx,
    heightPx: plate.heightPx,
    aspectRatio: plate.aspectRatio,
    mimeType: plate.mimeType,
  };
}

/** One line per plate, for the operator to read before anything is spent. */
export function describeStagedPlates(library: StagedPlateLibrary): string {
  return library.plates
    .map(
      (plate) =>
        `  ${plate.frameId}  ${plate.sourceFileName.padEnd(18)} ${String(plate.widthPx).padStart(4)}x${String(plate.heightPx).padEnd(5)} ${plate.checksumSha256.slice(0, 16)}…`,
    )
    .join('\n');
}
