import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  NodeCommandRunner,
  probeMedia,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';

import { permitsOutput, type ProductionAssetManifest } from '../production-assets';

/**
 * The preflight over an externally-supplied asset root.
 *
 * An operator's real Combat Reviews library lives outside this repository —
 * brand marks, app captures, fight footage, audio, and the reference material
 * that must never reach an output. Pointing the pipeline at that directory
 * means accepting operator-supplied paths, which is exactly where containment
 * has to be proven rather than assumed.
 *
 * What this adds over `resolveProductionAssets`, which it wraps rather than
 * replaces:
 *
 * - **Canonical containment.** The path is resolved *and* `realpath`-ed, so a
 *   symlink inside the root that points outside it is caught. Resolving alone
 *   is not enough: `assets/clips/legal.mp4` can be a link to anywhere.
 * - **Duplicate detection by content.** Two manifest entries pointing at the
 *   same bytes are reported, because the same clip under two ids defeats the
 *   selector's "spread the library" rule without anyone noticing.
 * - **Sufficiency for the cut.** A clip too short to fill any beat is a
 *   problem to report at preflight, not to discover when the timeline cannot
 *   be balanced.
 * - **Reference isolation.** Anything under a `references/` directory is
 *   counted and reported, and refused entry to the production manifest — the
 *   structural half of "analysis-only material can never reach an output".
 */

export const PREFLIGHT_FAILURE_KINDS = [
  'ASSET_ROOT_MISSING',
  'ASSET_ROOT_NOT_A_DIRECTORY',
  'PATH_ESCAPES_ASSET_ROOT',
  'SYMLINK_ESCAPES_ASSET_ROOT',
  'FILE_MISSING',
  'FILE_EMPTY',
  'CHECKSUM_MISMATCH',
  'DUPLICATE_CONTENT',
  'UNREADABLE_MEDIA',
  'KIND_MISMATCH',
  'RIGHTS_NOT_PERMITTED',
  'REFERENCE_MATERIAL_IN_PRODUCTION_MANIFEST',
  'INSUFFICIENT_CLIP_DURATION',
  'MISSING_AUDIO_STREAM',
  'UNSUPPORTED_CODEC',
  'DIMENSIONS_TOO_SMALL',
] as const;
export type PreflightFailureKind = (typeof PREFLIGHT_FAILURE_KINDS)[number];

export interface PreflightProblem {
  readonly assetId: string;
  readonly kind: PreflightFailureKind;
  readonly detail: string;
}

export class AssetRootPreflightError extends Error {
  constructor(public readonly problems: readonly PreflightProblem[]) {
    super(
      `The external asset root cannot be used:\n${problems
        .map((problem) => `  - ${problem.assetId} [${problem.kind}]: ${problem.detail}`)
        .join('\n')}`,
    );
    this.name = 'AssetRootPreflightError';
  }
}

/** The five directories a Combat Reviews asset root is expected to contain. */
export const EXPECTED_ASSET_DIRECTORIES = [
  'brand',
  'app-ui',
  'combat-clips',
  'audio',
  /** Analysis-only. Counted, reported, and structurally barred from output. */
  'references',
] as const;

/** Directories whose contents may never contribute bytes to an advertisement. */
export const ANALYSIS_ONLY_DIRECTORIES: readonly string[] = ['references'];

export interface PreflightAsset {
  readonly assetId: string;
  readonly canonicalPath: string;
  /** Relative to the asset root, forward-slashed, so reports stay portable. */
  readonly relativePath: string;
  readonly directory: string;
  readonly kind: 'VIDEO' | 'IMAGE' | 'AUDIO';
  readonly role: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly rightsClassification: string;
  readonly outputEligible: boolean;
  readonly measuredDurationSeconds?: number;
  readonly measuredWidthPx?: number;
  readonly measuredHeightPx?: number;
  readonly measuredFrameRate?: number;
  readonly measuredVideoCodec?: string;
  readonly hasAudio?: boolean;
  readonly discrepancies: readonly string[];
}

export interface AssetRootPreflightReport {
  readonly assetRoot: string;
  readonly canonicalAssetRoot: string;
  readonly directoriesPresent: readonly string[];
  readonly directoriesMissing: readonly string[];
  readonly assets: readonly PreflightAsset[];
  readonly outputEligibleCount: number;
  readonly analysisOnlyReferenceCount: number;
  /** Non-fatal observations worth printing before a run starts. */
  readonly warnings: readonly string[];
  readonly notice: string;
}

export interface AssetRootPreflightOptions {
  readonly manifest: ProductionAssetManifest;
  readonly manifestDir: string;
  /** The operator-supplied root. Every accepted asset must canonicalise inside it. */
  readonly assetRoot: string;
  readonly binaries: FfmpegBinaries;
  readonly now: Date;
  readonly runner?: CommandRunner;
  /** Shortest beat in the plan, so an unusable clip is caught here. */
  readonly shortestBeatSeconds: number;
  /** Minimum accepted picture width, so a thumbnail cannot become a scene. */
  readonly minimumWidthPx?: number;
}

const PREFLIGHT_NOTICE =
  'Preflight establishes that these files exist, decode, are the media they claim to be, and carry output rights. It grants no rights of its own, and no reference material is eligible for output under any circumstances.' as const;

const DEFAULT_MINIMUM_WIDTH_PX = 640;
/** Codecs the deterministic renderer is known to decode without surprises. */
const SUPPORTED_VIDEO_CODECS = ['h264', 'hevc', 'vp9', 'av1', 'mpeg4', 'prores'];
/**
 * Roles that fill a whole 1080-wide frame, and are therefore the only ones the
 * minimum-width floor applies to. A logo is a lockup composited at a few
 * hundred pixels and is *supposed* to be small; failing a library because its
 * logo is not 640px wide would be a rule that only ever fires on correct
 * material.
 */
const FULL_FRAME_ROLES = ['SOURCE_CLIP', 'APP_SCREENSHOT', 'BRAND_CARD'];

/** True when `candidate` is `root` or sits beneath it. */
function isInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The real location of a path, following every symlink.
 *
 * Returns `null` when it cannot be established, which the caller treats as a
 * failure rather than as permission — an unresolvable path is exactly the case
 * a containment check must not wave through.
 */
async function canonicalise(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export async function runAssetRootPreflight(
  options: AssetRootPreflightOptions,
): Promise<AssetRootPreflightReport> {
  const runner = options.runner ?? new NodeCommandRunner();
  const problems: PreflightProblem[] = [];
  const warnings: string[] = [];
  const assets: PreflightAsset[] = [];
  const minimumWidthPx = options.minimumWidthPx ?? DEFAULT_MINIMUM_WIDTH_PX;

  // ---- the root itself ------------------------------------------------------
  const declaredRoot = resolve(options.assetRoot);
  const canonicalRoot = await canonicalise(declaredRoot);
  if (!canonicalRoot) {
    throw new AssetRootPreflightError([
      {
        assetId: '<asset-root>',
        kind: 'ASSET_ROOT_MISSING',
        detail: `${declaredRoot} does not exist or cannot be resolved`,
      },
    ]);
  }
  const rootStats = await stat(canonicalRoot);
  if (!rootStats.isDirectory()) {
    throw new AssetRootPreflightError([
      {
        assetId: '<asset-root>',
        kind: 'ASSET_ROOT_NOT_A_DIRECTORY',
        detail: `${canonicalRoot} is not a directory`,
      },
    ]);
  }

  const directoriesPresent: string[] = [];
  const directoriesMissing: string[] = [];
  for (const directory of EXPECTED_ASSET_DIRECTORIES) {
    const target = resolve(canonicalRoot, directory);
    try {
      const stats = await stat(target);
      if (stats.isDirectory()) directoriesPresent.push(directory);
      else directoriesMissing.push(directory);
    } catch {
      directoriesMissing.push(directory);
    }
  }
  if (directoriesMissing.length > 0) {
    // Not fatal. A library with no `references/` is a perfectly good library,
    // and a missing `audio/` means a silent master rather than a broken run.
    warnings.push(
      `asset root has no ${directoriesMissing.join(', ')} director${directoriesMissing.length === 1 ? 'y' : 'ies'}`,
    );
  }

  // ---- each declared asset --------------------------------------------------
  const seenChecksums = new Map<string, string>();

  for (const asset of options.manifest.assets) {
    const reject = (kind: PreflightFailureKind, detail: string): void => {
      problems.push({ assetId: asset.id, kind, detail });
    };

    // Rights first, before a byte is read: an asset that must not be used is
    // refused without touching it.
    if (!permitsOutput(asset.rights.classification)) {
      reject(
        'RIGHTS_NOT_PERMITTED',
        `classification ${asset.rights.classification} may not contribute to an output`,
      );
      continue;
    }
    if (!asset.rights.permittedOutputUse) {
      reject('RIGHTS_NOT_PERMITTED', 'permittedOutputUse is false');
      continue;
    }

    const declaredPath = isAbsolute(asset.path)
      ? resolve(asset.path)
      : resolve(options.manifestDir, asset.path);

    if (!isInside(declaredPath, canonicalRoot)) {
      reject(
        'PATH_ESCAPES_ASSET_ROOT',
        `${declaredPath} resolves outside the asset root ${canonicalRoot}`,
      );
      continue;
    }

    const canonicalPath = await canonicalise(declaredPath);
    if (!canonicalPath) {
      reject('FILE_MISSING', `${declaredPath} does not exist`);
      continue;
    }
    // The second containment check is the one that matters: the first proved
    // the *declared* path is inside the root, this proves the *real* file is.
    if (!isInside(canonicalPath, canonicalRoot)) {
      reject(
        'SYMLINK_ESCAPES_ASSET_ROOT',
        `${declaredPath} is a link to ${canonicalPath}, which is outside the asset root`,
      );
      continue;
    }

    const relativePath = relative(canonicalRoot, canonicalPath).split(sep).join('/');
    const directory = relativePath.split('/')[0] ?? '';

    // Structural, not advisory: reference material cannot enter an output
    // manifest whatever its declared rights say.
    if (ANALYSIS_ONLY_DIRECTORIES.includes(directory)) {
      reject(
        'REFERENCE_MATERIAL_IN_PRODUCTION_MANIFEST',
        `${relativePath} sits under ${directory}/, which is analysis-only. Reference material may be studied for structure and pacing and may never contribute bytes to an advertisement.`,
      );
      continue;
    }

    let sizeBytes: number;
    try {
      const stats = await stat(canonicalPath);
      if (!stats.isFile()) {
        reject('FILE_MISSING', `${canonicalPath} is not a regular file`);
        continue;
      }
      sizeBytes = stats.size;
    } catch {
      reject('FILE_MISSING', `${canonicalPath} could not be read`);
      continue;
    }
    if (sizeBytes === 0) {
      reject('FILE_EMPTY', `${relativePath} is zero bytes`);
      continue;
    }

    const checksumSha256 = createHash('sha256')
      .update(await readFile(canonicalPath))
      .digest('hex');
    if (asset.checksumSha256 && asset.checksumSha256 !== checksumSha256) {
      reject(
        'CHECKSUM_MISMATCH',
        `declared ${asset.checksumSha256} but the file hashes to ${checksumSha256}`,
      );
      continue;
    }

    const duplicateOf = seenChecksums.get(checksumSha256);
    if (duplicateOf) {
      reject(
        'DUPLICATE_CONTENT',
        `these bytes are already declared as "${duplicateOf}". The same file under two ids defeats the selector's spread across the library without anything looking wrong.`,
      );
      continue;
    }
    seenChecksums.set(checksumSha256, asset.id);

    let probe;
    try {
      probe = await probeMedia(runner, canonicalPath, { ffprobePath: options.binaries.ffprobe });
    } catch (error) {
      reject(
        'UNREADABLE_MEDIA',
        `ffprobe could not decode it: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (probe.mediaType !== asset.kind) {
      reject('KIND_MISMATCH', `declared ${asset.kind} but decodes as ${probe.mediaType}`);
      continue;
    }

    const discrepancies: string[] = [];
    let measuredDurationSeconds: number | undefined;
    let measuredWidthPx: number | undefined;
    let measuredHeightPx: number | undefined;
    let measuredFrameRate: number | undefined;
    let measuredVideoCodec: string | undefined;
    let hasAudio: boolean | undefined;

    if (probe.mediaType === 'VIDEO') {
      measuredDurationSeconds = probe.durationSeconds;
      measuredWidthPx = probe.widthPx;
      measuredHeightPx = probe.heightPx;
      measuredFrameRate = probe.frameRate;
      measuredVideoCodec = probe.videoCodec;
      hasAudio = probe.hasAudio;

      if (!SUPPORTED_VIDEO_CODECS.includes(probe.videoCodec)) {
        reject(
          'UNSUPPORTED_CODEC',
          `decodes as ${probe.videoCodec}; the renderer is verified against ${SUPPORTED_VIDEO_CODECS.join(', ')}`,
        );
        continue;
      }
      if (FULL_FRAME_ROLES.includes(asset.role) && probe.widthPx < minimumWidthPx) {
        reject(
          'DIMENSIONS_TOO_SMALL',
          `${probe.widthPx}×${probe.heightPx} is below the ${minimumWidthPx}px minimum width for a 1080-wide delivery`,
        );
        continue;
      }
      // Only a clip that could fill the shortest beat is usable as footage.
      if (
        asset.role === 'SOURCE_CLIP' &&
        probe.durationSeconds + 1e-6 < options.shortestBeatSeconds
      ) {
        reject(
          'INSUFFICIENT_CLIP_DURATION',
          `runs ${probe.durationSeconds.toFixed(2)}s, shorter than the plan's shortest beat (${options.shortestBeatSeconds.toFixed(2)}s)`,
        );
        continue;
      }
      if (!probe.hasAudio) {
        warnings.push(
          `${asset.id} has no audio stream; any beat using it must not set source audio`,
        );
      }
    } else if (probe.mediaType === 'IMAGE') {
      measuredWidthPx = probe.widthPx;
      measuredHeightPx = probe.heightPx;
      // Only a still that fills the frame has to be frame-sized; a logo is a
      // lockup composited at a few hundred pixels.
      if (FULL_FRAME_ROLES.includes(asset.role) && probe.widthPx < minimumWidthPx) {
        reject(
          'DIMENSIONS_TOO_SMALL',
          `${probe.widthPx}×${probe.heightPx} is below the ${minimumWidthPx}px minimum width`,
        );
        continue;
      }
    } else {
      measuredDurationSeconds = probe.durationSeconds;
      hasAudio = true;
      if (probe.channels === 0) {
        reject('MISSING_AUDIO_STREAM', 'decodes as audio but reports no channels');
        continue;
      }
    }

    if (
      asset.declaredDurationSeconds !== undefined &&
      measuredDurationSeconds !== undefined &&
      Math.abs(asset.declaredDurationSeconds - measuredDurationSeconds) > 0.5
    ) {
      discrepancies.push(
        `declared ${asset.declaredDurationSeconds}s but measured ${measuredDurationSeconds.toFixed(3)}s`,
      );
    }
    if (
      asset.declaredWidthPx !== undefined &&
      measuredWidthPx !== undefined &&
      asset.declaredWidthPx !== measuredWidthPx
    ) {
      discrepancies.push(
        `declared ${asset.declaredWidthPx}px wide but measured ${measuredWidthPx}px`,
      );
    }
    if (
      asset.declaredHeightPx !== undefined &&
      measuredHeightPx !== undefined &&
      asset.declaredHeightPx !== measuredHeightPx
    ) {
      discrepancies.push(
        `declared ${asset.declaredHeightPx}px tall but measured ${measuredHeightPx}px`,
      );
    }

    assets.push({
      assetId: asset.id,
      canonicalPath,
      relativePath,
      directory,
      kind: asset.kind,
      role: asset.role,
      sizeBytes,
      checksumSha256,
      rightsClassification: asset.rights.classification,
      outputEligible: true,
      ...(measuredDurationSeconds === undefined ? {} : { measuredDurationSeconds }),
      ...(measuredWidthPx === undefined ? {} : { measuredWidthPx }),
      ...(measuredHeightPx === undefined ? {} : { measuredHeightPx }),
      ...(measuredFrameRate === undefined ? {} : { measuredFrameRate }),
      ...(measuredVideoCodec === undefined ? {} : { measuredVideoCodec }),
      ...(hasAudio === undefined ? {} : { hasAudio }),
      discrepancies,
    });
  }

  if (problems.length > 0) {
    // All-or-nothing, for the same reason `resolveProductionAssets` is: a
    // library that lists an unusable asset is a library the operator needs to
    // fix, and quietly proceeding with the survivors produces an advertisement
    // missing material somebody deliberately supplied.
    throw new AssetRootPreflightError(problems);
  }

  return {
    assetRoot: declaredRoot,
    canonicalAssetRoot: canonicalRoot,
    directoriesPresent,
    directoriesMissing,
    assets,
    outputEligibleCount: assets.length,
    analysisOnlyReferenceCount: await countReferenceFiles(canonicalRoot),
    warnings,
    notice: PREFLIGHT_NOTICE,
  };
}

/**
 * How much analysis-only material sits in the root.
 *
 * Reported, never resolved. The number exists so an operator can see that the
 * pipeline knows the references are there and is deliberately not touching
 * them — an absent count reads as "it did not look", which is a weaker claim.
 */
async function countReferenceFiles(canonicalRoot: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const directory of ANALYSIS_ONLY_DIRECTORIES) {
    try {
      const entries = await readdir(resolve(canonicalRoot, directory), {
        withFileTypes: true,
        recursive: true,
      });
      total += entries.filter((entry) => entry.isFile()).length;
    } catch {
      // A root with no references directory has no reference files.
    }
  }
  return total;
}
