import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import { StoryboardVideoError } from '../storyboard-video/failures';
import { canonicalFrameId, KEYFRAME_COUNT } from '../storyboard-video/keyframe-library';

/**
 * The authoritative high-quality plates, discovered from the operator's own
 * marketing folder.
 *
 * These supersede both the contact-sheet panel extractions and the earlier
 * `FRAME-NN` keyframes. The naming is the operator's — `FRAME1PLATE.png`
 * through `FRAME10PLATE.png` — and this module's whole job is to turn that
 * into the canonical `FRAME-01` … `FRAME-10` identity the rest of the system
 * already speaks, deterministically and with every ambiguity refused rather
 * than resolved.
 *
 * Four refusals, and each of them is a decision this tool declines to make on
 * the operator's behalf:
 *
 * - **One file per number.** `FRAME1PLATE.png` beside `frame1plate.jpg` is
 *   ambiguous. Picking by extension precedence would silently choose which of
 *   two images the campaign is built from.
 * - **A plate-shaped name with an unusable extension is refused, not
 *   ignored.** `FRAME1PLATE.psd` is plainly meant to be the plate; skipping it
 *   and reporting "FRAME-01 is missing" would send an operator looking for a
 *   file that is sitting right there.
 * - **Portrait, measured.** A landscape plate is the exact defect the two
 *   permanently-rejected legacy clips failed on, and it is refused here by
 *   measurement rather than by a reviewer noticing later.
 * - **Inside the authoritative directory, proven after `realpath`.** A symlink
 *   whose target sits elsewhere is refused, so "the plate came from the high
 *   quality folder" is a property of the filesystem rather than of the string
 *   that was passed in.
 *
 * The folder is read-only. Nothing here writes, renames, moves or deletes, and
 * files that are not plate-shaped at all are ignored — a marketing folder
 * legitimately holds other work.
 */

export const PLATE_COUNT = KEYFRAME_COUNT;

/** Only these, lowercase-compared. Anything else is an explicit decision. */
export const PLATE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg'];

/** `FRAME1PLATE` … `FRAME10PLATE`, case-insensitive, with or without a leading zero. */
const PLATE_STEM = /^frame(\d{1,2})plate$/i;

/**
 * Clips this repository may never use again, refused by **location**.
 *
 * Two landscape clips under a `generated-clips` folder failed portrait
 * fidelity and are permanently rejected. The rule is the directory segment
 * rather than the two filenames, for the same reason `references/` is refused
 * by location: a filename is renameable and a structural rule is not. Nothing
 * on this path may stage, compare against or fall back to material from there.
 */
export const PERMANENTLY_REJECTED_PATH_SEGMENTS: readonly string[] = ['generated-clips'];

export const PERMANENTLY_REJECTED_CLIP_NOTE =
  'The previously delivered FRAME-01 and FRAME-07 clips are landscape, failed portrait fidelity, and are permanently rejected. They are refused by directory segment, not by filename, so renaming one does not readmit it.';

export interface ResolvedPlate {
  readonly sceneNumber: number;
  /** `FRAME-01` … `FRAME-10`, always the canonical spelling. */
  readonly frameId: string;
  readonly absolutePath: string;
  /** The name as it sits on disk, so a report matches what the operator sees. */
  readonly fileName: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly mimeType: string;
  readonly orientation: 'PORTRAIT';
  /** Width divided by height, to six places. Recorded, never corrected. */
  readonly aspectRatio: number;
}

export interface PlateLibrary {
  readonly platesDirectory: string;
  readonly plates: readonly ResolvedPlate[];
  /** Present but not plate-shaped. Recorded, never an error. */
  readonly ignoredFiles: readonly string[];
}

/** Refuses a path that sits under a permanently-rejected directory. */
export function findPermanentlyRejectedSegment(path: string): string | null {
  const segments = path.split(/[\\/]/).map((segment) => segment.toLowerCase());
  return PERMANENTLY_REJECTED_PATH_SEGMENTS.find((banned) => segments.includes(banned)) ?? null;
}

export function assertNotPermanentlyRejected(path: string, what: string): void {
  const segment = findPermanentlyRejectedSegment(path);
  if (!segment) return;
  throw new StoryboardVideoError(
    'NO_USABLE_SOURCE',
    `${what} resolves under a "${segment}" directory. ${PERMANENTLY_REJECTED_CLIP_NOTE}`,
  );
}

export interface ResolvePlateLibraryOptions {
  readonly platesDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
}

export async function resolvePlateLibrary(
  options: ResolvePlateLibraryOptions,
): Promise<PlateLibrary> {
  const platesDirectory = resolve(options.platesDirectory);
  assertNotPermanentlyRejected(platesDirectory, 'the plate directory');

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(platesDirectory);
  } catch (error) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `the plate directory ${platesDirectory} could not be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let entries: string[];
  try {
    entries = await readdir(canonicalRoot);
  } catch (error) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `the plate directory ${platesDirectory} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const bySceneNumber = new Map<number, string[]>();
  const ignoredFiles: string[] = [];
  const problems: string[] = [];

  for (const entry of [...entries].sort()) {
    const extension = extname(entry).toLowerCase();
    const stem = entry.slice(0, entry.length - extension.length);
    const match = PLATE_STEM.exec(stem);
    if (!match) {
      ignoredFiles.push(entry);
      continue;
    }
    const sceneNumber = Number(match[1]);
    if (!Number.isInteger(sceneNumber) || sceneNumber < 1 || sceneNumber > PLATE_COUNT) {
      problems.push(
        `${entry} is plate-shaped but numbered ${match[1]}, outside 1…${PLATE_COUNT}. There are exactly ${PLATE_COUNT} locked scenes.`,
      );
      continue;
    }
    // A plate-shaped name with an unusable extension is a refusal rather than a
    // skip: reporting the number as "missing" would send an operator hunting
    // for a file that is in front of them.
    if (!PLATE_EXTENSIONS.includes(extension)) {
      problems.push(
        `${entry} is plate-shaped but carries "${extension || 'no extension'}"; supported: ${PLATE_EXTENSIONS.join(', ')}`,
      );
      continue;
    }
    bySceneNumber.set(sceneNumber, [...(bySceneNumber.get(sceneNumber) ?? []), entry]);
  }

  // Every problem is collected before any is reported: an operator fixing a
  // folder one error at a time is the failure this exists to avoid.
  for (let sceneNumber = 1; sceneNumber <= PLATE_COUNT; sceneNumber += 1) {
    const matches = bySceneNumber.get(sceneNumber) ?? [];
    if (matches.length === 0) {
      problems.push(
        `${canonicalFrameId(sceneNumber)} has no plate — expected FRAME${sceneNumber}PLATE with one of ${PLATE_EXTENSIONS.join(', ')}`,
      );
    } else if (matches.length > 1) {
      problems.push(
        `${canonicalFrameId(sceneNumber)} is ambiguous: ${matches.join(', ')} all resolve to it. Leave exactly one — which of two images was meant is not a decision this tool may make.`,
      );
    }
  }
  if (problems.length > 0) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `the plate directory ${platesDirectory} does not hold one usable plate per scene:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
  }

  const plates: ResolvedPlate[] = [];
  for (let sceneNumber = 1; sceneNumber <= PLATE_COUNT; sceneNumber += 1) {
    const fileName = (bySceneNumber.get(sceneNumber) as string[])[0] as string;
    // eslint-disable-next-line no-await-in-loop -- ordered so the report is stable
    const plate = await resolveOnePlate({ canonicalRoot, fileName, sceneNumber, options });
    plates.push(plate);
  }

  return { platesDirectory: canonicalRoot, plates, ignoredFiles };
}

/** The one plate a scene animates from, by canonical frame id. */
export function requirePlate(library: PlateLibrary, frameId: string): ResolvedPlate {
  const plate = library.plates.find((candidate) => candidate.frameId === frameId);
  if (!plate) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `${frameId} is not present in ${library.platesDirectory}`,
    );
  }
  return plate;
}

async function resolveOnePlate(input: {
  canonicalRoot: string;
  fileName: string;
  sceneNumber: number;
  options: ResolvePlateLibraryOptions;
}): Promise<ResolvedPlate> {
  const declaredPath = join(input.canonicalRoot, input.fileName);

  // Canonicalise, then prove containment. A symlink inside the authoritative
  // folder pointing outside it is refused, so the claim "this came from the
  // high quality folder" is a fact about the filesystem.
  let absolutePath: string;
  try {
    absolutePath = await realpath(declaredPath);
  } catch (error) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `${declaredPath} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (absolutePath !== input.canonicalRoot && !absolutePath.startsWith(input.canonicalRoot + sep)) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `${input.fileName} resolves to ${absolutePath}, outside the authoritative plate directory ${input.canonicalRoot}. A plate is refused rather than followed out of the folder it was declared in.`,
    );
  }
  assertNotPermanentlyRejected(absolutePath, `${input.fileName}`);

  const stats = await stat(absolutePath).catch(() => null);
  if (!stats || !stats.isFile() || stats.size === 0) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `${absolutePath} is not a readable, non-empty file`,
    );
  }

  const bytes = await readFile(absolutePath);
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const { widthPx, heightPx } = await measurePlate(absolutePath, input.options);

  if (heightPx <= widthPx) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `${input.fileName} measures ${widthPx}x${heightPx}, which is not portrait. This campaign delivers vertical, and a landscape plate is the exact defect the permanently-rejected legacy clips carried.`,
    );
  }

  const extension = extname(input.fileName).toLowerCase();
  return {
    sceneNumber: input.sceneNumber,
    frameId: canonicalFrameId(input.sceneNumber),
    absolutePath,
    fileName: input.fileName,
    checksumSha256,
    sizeBytes: stats.size,
    widthPx,
    heightPx,
    mimeType: extension === '.png' ? 'image/png' : 'image/jpeg',
    orientation: 'PORTRAIT',
    aspectRatio: Number((widthPx / heightPx).toFixed(6)),
  };
}

/**
 * Decodes the image and reads its real pixel size.
 *
 * The decode is the point. A zero-byte PNG, a truncated download and an HTML
 * error page saved with a `.png` extension are all files that exist, and all
 * three would otherwise reach a paid upload before anything noticed.
 */
async function measurePlate(
  absolutePath: string,
  options: ResolvePlateLibraryOptions,
): Promise<{ widthPx: number; heightPx: number }> {
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
    const parsed = JSON.parse(probe.stdout) as { streams?: { width?: number; height?: number }[] };
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
  return { widthPx, heightPx };
}
