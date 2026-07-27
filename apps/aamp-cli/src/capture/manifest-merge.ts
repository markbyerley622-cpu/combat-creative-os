import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  parseProductionAssetManifest,
  type ProductionAsset,
  type ProductionAssetManifest,
} from '../production-assets';
import type { CapturedAppAsset } from './capture-contracts';

/**
 * Substituting captured screens for synthetic ones, deterministically.
 *
 * The merge is keyed by **asset id**, and it replaces rather than appends.
 * That is what keeps the committed creative plan working untouched: the plan
 * binds beats to `screen-predictions` and `screen-scorecards` by id, so
 * swapping what those ids point at swaps the footage without touching a single
 * creative decision. An append-based merge would leave the plan pointing at
 * the synthetic stills it was supposed to replace.
 *
 * What is preserved from the original entry, and why:
 *
 * - `role`, `beats` and `tags` — these are *plan bindings*. The selector reads
 *   them to decide which beat an asset can serve, and a capture has no opinion
 *   about the campaign it is being merged into.
 * - `id` — obviously, or nothing would be replaced.
 *
 * What comes from the capture: `path`, `checksumSha256`, the measured
 * dimensions, the description, and the rights block. The checksum matters most
 * — it pins the merged manifest to the exact bytes that were photographed, so
 * a later edit of the PNG is refused by the existing preflight.
 */

export class CaptureMergeError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`The captured assets cannot be merged:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'CaptureMergeError';
  }
}

export interface MergeCapturedAssetsOptions {
  /** The manifest being updated, already parsed. */
  readonly manifest: ProductionAssetManifest;
  /** Directory the existing manifest's relative paths resolve against. */
  readonly manifestDirectory: string;
  readonly captured: readonly CapturedAppAsset[];
  /** Directory the captured assets' relative paths resolve against. */
  readonly captureDirectory: string;
  /** Directory the *merged* manifest will be written to; paths are relative to it. */
  readonly outputManifestDirectory: string;
}

export interface CaptureMergeReport {
  readonly replaced: readonly {
    readonly assetId: string;
    readonly fromPath: string;
    readonly toPath: string;
    readonly checksumSha256: string;
    readonly widthPx: number;
    readonly heightPx: number;
  }[];
  /** Captured assets whose id matches nothing in the manifest. Reported, never appended. */
  readonly notMerged: readonly { readonly assetId: string; readonly reason: string }[];
  /** Manifest assets left exactly as they were. */
  readonly preserved: readonly string[];
}

export interface MergeCapturedAssetsResult {
  readonly manifest: ProductionAssetManifest;
  readonly report: CaptureMergeReport;
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * A path from the merged manifest's directory to a file, as the manifest
 * spells paths: relative where possible, forward-slashed, and explicitly
 * `./`-prefixed so it never reads as a bare filename.
 */
function manifestPathTo(fromDirectory: string, absoluteTarget: string): string {
  const rel = posix(relative(fromDirectory, absoluteTarget));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return rel;
  return `./${rel}`;
}

/**
 * Replaces manifest entries with captured screens.
 *
 * Refuses, rather than filtering, when a capture is not output-eligible. An
 * inspection-only capture reaching a production manifest is the exact failure
 * the rights boundary exists to prevent, and a merge that silently skipped it
 * would leave an operator believing the substitution happened.
 */
export function mergeCapturedAssets(
  options: MergeCapturedAssetsOptions,
): MergeCapturedAssetsResult {
  const reasons: string[] = [];

  for (const asset of options.captured) {
    if (asset.eligibility !== 'OUTPUT_ELIGIBLE') {
      reasons.push(
        `"${asset.assetId}" is ${asset.eligibility}. It was captured without a rights declaration, so it may not enter a production asset manifest.`,
      );
    } else if (asset.rightsClassification === null) {
      reasons.push(
        `"${asset.assetId}" is marked output-eligible but carries no rights classification, which cannot be true at the same time`,
      );
    }
  }
  if (reasons.length > 0) throw new CaptureMergeError(reasons);

  const capturedById = new Map(options.captured.map((asset) => [asset.assetId, asset]));
  const matched = new Set<string>();
  const replaced: CaptureMergeReport['replaced'][number][] = [];
  const preserved: string[] = [];

  const assets: ProductionAsset[] = options.manifest.assets.map((existing) => {
    const capture = capturedById.get(existing.id);
    if (!capture) {
      // Preserved entries keep their original path, re-expressed relative to
      // wherever the merged manifest is being written.
      const absolute = isAbsolute(existing.path)
        ? existing.path
        : resolve(options.manifestDirectory, existing.path);
      preserved.push(existing.id);
      return { ...existing, path: manifestPathTo(options.outputManifestDirectory, absolute) };
    }
    matched.add(existing.id);

    const absoluteCapture = resolve(options.captureDirectory, capture.relativePath);
    const toPath = manifestPathTo(options.outputManifestDirectory, absoluteCapture);
    replaced.push({
      assetId: existing.id,
      fromPath: existing.path,
      toPath,
      checksumSha256: capture.checksumSha256,
      widthPx: capture.widthPx,
      heightPx: capture.heightPx,
    });

    return {
      ...existing,
      // Plan bindings — role, beats, tags — are deliberately untouched.
      path: toPath,
      description:
        `${capture.role} captured from ${capture.provenance.sourceHost}${capture.provenance.sourcePath}`.slice(
          0,
          300,
        ),
      rights: {
        classification: capture.rightsClassification as 'OWNED' | 'LICENSED_FOR_OUTPUT',
        owner: existing.rights.owner,
        permittedOutputUse: true,
        restrictions: existing.rights.restrictions,
        ...(existing.rights.attribution ? { attribution: existing.rights.attribution } : {}),
        ...(existing.rights.expiresAt ? { expiresAt: existing.rights.expiresAt } : {}),
      },
      checksumSha256: capture.checksumSha256,
      declaredWidthPx: capture.widthPx,
      declaredHeightPx: capture.heightPx,
    };
  });

  const notMerged = options.captured
    .filter((asset) => !matched.has(asset.assetId))
    .map((asset) => ({
      assetId: asset.assetId,
      reason:
        'no asset with this id exists in the manifest. Captured screens replace existing entries; they are never appended, because an id no beat references would change the library without changing the advertisement.',
    }));

  // Re-parsed rather than cast: the merged document has to satisfy exactly the
  // same schema and cross-field rules as a hand-written one, including "at
  // least one LOGO" and every role/kind agreement.
  const merged = parseProductionAssetManifest({
    ...options.manifest,
    assets,
  });

  return {
    manifest: merged,
    report: { replaced, notMerged, preserved },
  };
}
