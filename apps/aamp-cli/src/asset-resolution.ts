import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  NodeCommandRunner,
  probeMedia,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';

import {
  permitsOutput,
  type AssetKind,
  type ProductionAsset,
  type ProductionAssetManifest,
} from './production-assets';

/**
 * Turns a parsed asset manifest into assets that have been *proven* usable:
 * the file exists, sits inside an allowed root, matches its declared checksum,
 * decodes as the media kind it claims, and carries unexpired output rights.
 *
 * The ordering matters. Rights and containment are checked before the file is
 * read, so an asset that must not be used is refused without touching its
 * bytes; checksum and probe come after, because they are the expensive checks
 * and there is no reason to spend them on an asset already disqualified.
 *
 * Measurements come from ffprobe, never from the manifest's declared values.
 * A declared duration that disagrees with the file is reported as a discrepancy
 * and the *measured* value is what selection and the timeline use — the same
 * "measurements from the produced file are binding" rule the renderer applies,
 * pointed at inputs instead of outputs.
 */

export const ASSET_REJECTION_REASONS = [
  'RIGHTS_NOT_PERMITTED',
  'LICENCE_EXPIRED',
  'UNSAFE_PATH',
  'FILE_MISSING',
  'CHECKSUM_MISMATCH',
  'UNSUPPORTED_MEDIA',
  'KIND_MISMATCH',
] as const;
export type AssetRejectionReason = (typeof ASSET_REJECTION_REASONS)[number];

export interface AssetRejection {
  readonly assetId: string;
  readonly reason: AssetRejectionReason;
  readonly detail: string;
}

export class AssetResolutionError extends Error {
  constructor(public readonly rejections: readonly AssetRejection[]) {
    super(
      `Production assets could not be used:\n${rejections
        .map((rejection) => `  - ${rejection.assetId} [${rejection.reason}]: ${rejection.detail}`)
        .join('\n')}`,
    );
    this.name = 'AssetResolutionError';
  }
}

export interface ResolvedAsset {
  readonly asset: ProductionAsset;
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  /** Measured. Absent for stills, which have no duration. */
  readonly measuredDurationSeconds?: number;
  readonly measuredWidthPx?: number;
  readonly measuredHeightPx?: number;
  readonly measuredCodec?: string;
  /** Non-fatal disagreements between declared and measured metadata. */
  readonly discrepancies: readonly string[];
}

export interface ResolveAssetsOptions {
  readonly manifest: ProductionAssetManifest;
  /** Directory the manifest was loaded from; relative asset paths resolve against it. */
  readonly manifestDir: string;
  /** Every root a resolved path is permitted to sit inside. */
  readonly allowedRoots: readonly string[];
  readonly binaries: FfmpegBinaries;
  /** Instant licence expiry is measured against. Supplied, never `Date.now()` here. */
  readonly now: Date;
  readonly runner?: CommandRunner;
}

function isContained(absolute: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const normalised = resolve(root);
    return (
      absolute === normalised ||
      absolute.startsWith(`${normalised}\\`) ||
      absolute.startsWith(`${normalised}/`)
    );
  });
}

/** Maps a probed media type onto the manifest's declared kind vocabulary. */
function probedKind(mediaType: string): AssetKind | undefined {
  if (mediaType === 'VIDEO' || mediaType === 'IMAGE' || mediaType === 'AUDIO') return mediaType;
  return undefined;
}

export async function resolveProductionAssets(
  options: ResolveAssetsOptions,
): Promise<readonly ResolvedAsset[]> {
  const runner = options.runner ?? new NodeCommandRunner();
  const rejections: AssetRejection[] = [];
  const resolved: ResolvedAsset[] = [];

  for (const asset of options.manifest.assets) {
    const reject = (reason: AssetRejectionReason, detail: string): void => {
      rejections.push({ assetId: asset.id, reason, detail });
    };

    // --- rights, before any byte is read ---------------------------------
    if (!permitsOutput(asset.rights.classification)) {
      reject(
        'RIGHTS_NOT_PERMITTED',
        `classification ${asset.rights.classification} may not contribute to an output`,
      );
      continue;
    }
    if (asset.rights.expiresAt) {
      const expiry = new Date(asset.rights.expiresAt);
      if (Number.isNaN(expiry.getTime())) {
        reject('LICENCE_EXPIRED', `unparseable licence expiry "${asset.rights.expiresAt}"`);
        continue;
      }
      if (expiry.getTime() <= options.now.getTime()) {
        reject('LICENCE_EXPIRED', `licence expired at ${expiry.toISOString()}`);
        continue;
      }
    }

    // --- containment -------------------------------------------------------
    const absolutePath = isAbsolute(asset.path)
      ? resolve(asset.path)
      : resolve(options.manifestDir, asset.path);
    if (!isContained(absolutePath, options.allowedRoots)) {
      reject('UNSAFE_PATH', `${absolutePath} is outside every allowed source root`);
      continue;
    }

    // --- existence ---------------------------------------------------------
    let sizeBytes: number;
    try {
      const stats = await stat(absolutePath);
      if (!stats.isFile()) {
        reject('FILE_MISSING', `${absolutePath} is not a file`);
        continue;
      }
      sizeBytes = stats.size;
    } catch {
      reject('FILE_MISSING', `${absolutePath} does not exist`);
      continue;
    }
    if (sizeBytes === 0) {
      reject('FILE_MISSING', `${absolutePath} is empty`);
      continue;
    }

    // --- checksum ----------------------------------------------------------
    const bytes = await readFile(absolutePath);
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    if (asset.checksumSha256 && asset.checksumSha256 !== checksumSha256) {
      reject(
        'CHECKSUM_MISMATCH',
        `declared ${asset.checksumSha256} but the file hashes to ${checksumSha256}`,
      );
      continue;
    }

    // --- decode ------------------------------------------------------------
    let probe;
    try {
      probe = await probeMedia(runner, absolutePath, { ffprobePath: options.binaries.ffprobe });
    } catch (error) {
      reject(
        'UNSUPPORTED_MEDIA',
        `ffprobe could not read it: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const detectedKind = probedKind(probe.mediaType);
    if (detectedKind !== asset.kind) {
      reject('KIND_MISMATCH', `declared ${asset.kind} but decodes as ${probe.mediaType}`);
      continue;
    }

    const discrepancies: string[] = [];
    const measuredDurationSeconds =
      probe.mediaType === 'VIDEO' || probe.mediaType === 'AUDIO'
        ? probe.durationSeconds
        : undefined;
    const measuredWidthPx =
      probe.mediaType === 'VIDEO' || probe.mediaType === 'IMAGE' ? probe.widthPx : undefined;
    const measuredHeightPx =
      probe.mediaType === 'VIDEO' || probe.mediaType === 'IMAGE' ? probe.heightPx : undefined;

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

    resolved.push({
      asset,
      absolutePath,
      sizeBytes,
      checksumSha256,
      ...(measuredDurationSeconds === undefined ? {} : { measuredDurationSeconds }),
      ...(measuredWidthPx === undefined ? {} : { measuredWidthPx }),
      ...(measuredHeightPx === undefined ? {} : { measuredHeightPx }),
      ...(probe.mediaType === 'VIDEO' ? { measuredCodec: probe.videoCodec } : {}),
      discrepancies,
    });
  }

  if (rejections.length > 0) {
    // All-or-nothing: a manifest that lists an unusable asset is a manifest
    // the operator needs to fix, and quietly proceeding with the survivors
    // would produce an ad missing material somebody deliberately supplied.
    throw new AssetResolutionError(rejections);
  }

  return resolved;
}

/** The per-asset rows the run's provenance report is built from. */
export function describeAssetProvenance(
  resolved: readonly ResolvedAsset[],
): readonly Record<string, unknown>[] {
  return resolved.map((entry) => ({
    assetId: entry.asset.id,
    role: entry.asset.role,
    kind: entry.asset.kind,
    path: entry.absolutePath,
    checksumSha256: entry.checksumSha256,
    sizeBytes: entry.sizeBytes,
    rightsClassification: entry.asset.rights.classification,
    owner: entry.asset.rights.owner,
    ...(entry.asset.rights.attribution ? { attribution: entry.asset.rights.attribution } : {}),
    ...(entry.asset.rights.expiresAt ? { licenceExpiresAt: entry.asset.rights.expiresAt } : {}),
    restrictions: entry.asset.rights.restrictions,
    ...(entry.measuredDurationSeconds === undefined
      ? {}
      : { measuredDurationSeconds: entry.measuredDurationSeconds }),
    ...(entry.measuredWidthPx === undefined ? {} : { measuredWidthPx: entry.measuredWidthPx }),
    ...(entry.measuredHeightPx === undefined ? {} : { measuredHeightPx: entry.measuredHeightPx }),
    ...(entry.measuredCodec ? { measuredCodec: entry.measuredCodec } : {}),
    discrepancies: entry.discrepancies,
  }));
}
