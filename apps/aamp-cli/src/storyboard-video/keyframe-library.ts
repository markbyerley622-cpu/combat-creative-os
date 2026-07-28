import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import { StoryboardVideoError } from './failures';

/**
 * The ten approved production keyframes, resolved from the operator's own
 * marketing folder.
 *
 * These images are **authoritative** and supersede the contact-sheet panel
 * extractions the locked-storyboard proof used. The distinction matters: a
 * panel cut out of a contact sheet is 470px of a review artefact, while these
 * are the finished frames the campaign was signed off on. Generation quality is
 * bounded by its input, so a generation run seeded from a contact-sheet crop
 * would be a worse advertisement made from a better process.
 *
 * Three rules, and all three are refusals rather than repairs:
 *
 * - **Exactly one file per number.** `FRAME-03.png` beside `FRAME-03.jpg` is
 *   ambiguous, and picking one by extension precedence would silently decide
 *   which of two images the operator meant. It is refused by name.
 * - **All ten or none.** A run that generated nine scenes and quietly skipped
 *   the tenth would produce a fifteen-second file with a hole in it.
 * - **The folder is read-only.** Nothing here writes, renames, moves or copies
 *   inside it. Files that are not `FRAME-NN` are ignored rather than rejected —
 *   a marketing folder legitimately holds other work, and refusing a run
 *   because a storyboard JPEG sits beside the frames would be a guard nobody
 *   could satisfy.
 */

export const KEYFRAME_COUNT = 10;

/** Only these, lowercase-compared. A `.webp` is a decision somebody should make explicitly. */
export const KEYFRAME_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg'];

/** `FRAME-01` … `FRAME-10`, and nothing else. Case-insensitive on the stem. */
const FRAME_STEM = /^frame-(\d{2})$/i;

export interface ResolvedKeyframe {
  readonly sceneNumber: number;
  /** `FRAME-01` … `FRAME-10`, always in the canonical spelling. */
  readonly frameId: string;
  readonly absolutePath: string;
  /** The name as it actually sits on disk, so a report matches what the operator sees. */
  readonly fileName: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly mimeType: string;
}

export interface KeyframeLibrary {
  readonly framesDirectory: string;
  readonly frames: readonly ResolvedKeyframe[];
  /** Files present but not matching `FRAME-NN`. Recorded, never an error. */
  readonly ignoredFiles: readonly string[];
}

export function canonicalFrameId(sceneNumber: number): string {
  return `FRAME-${String(sceneNumber).padStart(2, '0')}`;
}

export interface ResolveKeyframeLibraryOptions {
  readonly framesDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
}

/**
 * Reads the folder, binds one file to each of the ten numbers, and proves each
 * one is a decodable image at a real pixel size.
 *
 * The probe is the point of the last step. A zero-byte `FRAME-05.png`, a
 * truncated download and an HTML error page saved with a `.png` extension are
 * all files that exist, and all three would reach an upload before anything
 * noticed.
 */
export async function resolveKeyframeLibrary(
  options: ResolveKeyframeLibraryOptions,
): Promise<KeyframeLibrary> {
  const framesDirectory = resolve(options.framesDirectory);

  let entries: string[];
  try {
    entries = await readdir(framesDirectory);
  } catch (error) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `the keyframe directory ${framesDirectory} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const bySceneNumber = new Map<number, string[]>();
  const ignoredFiles: string[] = [];

  for (const entry of [...entries].sort()) {
    const extension = extname(entry).toLowerCase();
    const stem = entry.slice(0, entry.length - extension.length);
    const match = FRAME_STEM.exec(stem);
    if (!match || !KEYFRAME_EXTENSIONS.includes(extension)) {
      ignoredFiles.push(entry);
      continue;
    }
    const sceneNumber = Number(match[1]);
    if (!Number.isInteger(sceneNumber) || sceneNumber < 1 || sceneNumber > KEYFRAME_COUNT) {
      ignoredFiles.push(entry);
      continue;
    }
    bySceneNumber.set(sceneNumber, [...(bySceneNumber.get(sceneNumber) ?? []), entry]);
  }

  // Every problem is collected before anything is reported: an operator fixing
  // a folder one error at a time is the failure this exists to avoid.
  const problems: string[] = [];
  for (let sceneNumber = 1; sceneNumber <= KEYFRAME_COUNT; sceneNumber += 1) {
    const matches = bySceneNumber.get(sceneNumber) ?? [];
    if (matches.length === 0) {
      problems.push(
        `${canonicalFrameId(sceneNumber)} is missing — expected one of ${KEYFRAME_EXTENSIONS.join(', ')}`,
      );
    } else if (matches.length > 1) {
      problems.push(
        `${canonicalFrameId(sceneNumber)} is ambiguous: ${matches.join(', ')} all match. Leave exactly one — which of two images was meant is not a decision this tool may make.`,
      );
    }
  }
  if (problems.length > 0) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `the keyframe directory ${framesDirectory} does not hold one usable image per scene:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
  }

  const frames: ResolvedKeyframe[] = [];
  for (let sceneNumber = 1; sceneNumber <= KEYFRAME_COUNT; sceneNumber += 1) {
    const fileName = (bySceneNumber.get(sceneNumber) as string[])[0] as string;
    const absolutePath = join(framesDirectory, fileName);
    // eslint-disable-next-line no-await-in-loop -- ordered so the problem list is stable
    const measured = await measureImage(absolutePath, options);
    frames.push({
      sceneNumber,
      frameId: canonicalFrameId(sceneNumber),
      absolutePath,
      fileName,
      ...measured,
      mimeType: extname(fileName).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
    });
  }

  return { framesDirectory, frames, ignoredFiles };
}

async function measureImage(
  absolutePath: string,
  options: ResolveKeyframeLibraryOptions,
): Promise<{
  checksumSha256: string;
  sizeBytes: number;
  widthPx: number;
  heightPx: number;
}> {
  const stats = await stat(absolutePath).catch(() => null);
  if (!stats || !stats.isFile() || stats.size === 0) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `${absolutePath} is not a readable, non-empty file`,
    );
  }

  const bytes = await readFile(absolutePath);
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');

  const probe = await options.runner.run(
    options.binaries.ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      absolutePath,
    ],
    { timeoutMs: 30_000 },
  );
  if (probe.exitCode !== 0) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `${absolutePath} could not be decoded as an image: ${probe.stderr.trim().slice(-300)}`,
    );
  }

  let widthPx = 0;
  let heightPx = 0;
  try {
    const parsed = JSON.parse(probe.stdout) as {
      streams?: { width?: number; height?: number }[];
    };
    widthPx = parsed.streams?.[0]?.width ?? 0;
    heightPx = parsed.streams?.[0]?.height ?? 0;
  } catch {
    widthPx = 0;
  }
  if (widthPx <= 0 || heightPx <= 0) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `${absolutePath} decoded to no usable pixel dimensions — a file that exists is not the same as an image`,
    );
  }

  return { checksumSha256, sizeBytes: stats.size, widthPx, heightPx };
}
