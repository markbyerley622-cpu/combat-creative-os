import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  isInternalEvaluationOnly,
  type AcquiredProductionAsset,
  type ApprovedUsage,
  type LicenceFamily,
} from '@combat/providers';

import {
  parseProductionAssetManifest,
  type AssetKind,
  type AssetRole,
  type ProductionAsset,
  type ProductionAssetManifest,
  type RightsClassification,
  type StoryBeat,
} from '../production-assets';

/**
 * Turning acquired media into the manifest the existing generator already
 * accepts.
 *
 * There is no second manifest format and no second renderer. Whatever comes out
 * of here goes through `parseProductionAssetManifest` — the same
 * `.strict()` schema, the same cross-field rules, the same refusal of
 * `ANALYSIS_ONLY` and `UNKNOWN_RIGHTS`, the same "at least one LOGO"
 * requirement — as a hand-written manifest or a capture merge. That is the
 * point: a new acquisition route must not become a new way into the renderer.
 *
 * Two projections deserve stating plainly, because both are places where a
 * shortcut would break something load-bearing:
 *
 * - **Licence families project onto the existing rights vocabulary.** A CC0
 *   file becomes `LICENSED_FOR_OUTPUT`, not a new `PUBLIC_DOMAIN_ACQUISITION`
 *   class. Adding a class would mean every existing rights check had to learn
 *   about it, and the one that forgot would be the hole. The production
 *   manifest never learns that an acquisition was involved.
 * - **`INTERNAL_EVALUATION` never reaches a campaign manifest.** It is refused
 *   by name rather than filtered out, so an operator is told which asset they
 *   cannot use rather than quietly getting a shorter library. Internal material
 *   builds a separate, visibly labelled demonstration manifest instead.
 */

export class ManifestBuildError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`A production asset manifest could not be built:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'ManifestBuildError';
  }
}

/**
 * Every acquirable licence family, mapped onto the three output-permitting
 * classes the renderer understands.
 *
 * Total over the enum on purpose — a new family is a compile error here rather
 * than an asset that silently classifies as `UNKNOWN_RIGHTS` and gets refused
 * at parse time with no explanation of why.
 */
export function classifyForOutput(family: LicenceFamily): RightsClassification {
  switch (family) {
    case 'CC0':
    case 'PUBLIC_DOMAIN':
    case 'PUBLIC_DOMAIN_MARK':
    case 'US_GOVERNMENT_PUBLIC_DOMAIN':
    case 'CC_BY':
    case 'CC_BY_SA':
    case 'PEXELS_LICENCE':
    case 'PIXABAY_CONTENT_LICENCE':
      return 'LICENSED_FOR_OUTPUT';
    case 'CC_BY_NC':
    case 'CC_BY_ND':
    case 'CC_BY_NC_SA':
    case 'CC_BY_NC_ND':
    case 'EDITORIAL_ONLY':
    case 'PERSONAL_USE_ONLY':
    case 'STANDARD_YOUTUBE_LICENCE':
    case 'ALL_RIGHTS_RESERVED':
    case 'UNKNOWN':
      // Deliberately mapped rather than thrown: the manifest parser's own
      // refusal message for UNKNOWN_RIGHTS is the clearest place for this to
      // surface, and it names the asset.
      return 'UNKNOWN_RIGHTS';
    default: {
      const exhaustive: never = family;
      throw new ManifestBuildError([`unmapped licence family: ${String(exhaustive)}`]);
    }
  }
}

function kindFor(mediaKind: AcquiredProductionAsset['mediaKind']): AssetKind {
  return mediaKind;
}

/**
 * The campaign role an acquired asset takes.
 *
 * Audio becomes `MUSIC`, video becomes `SOURCE_CLIP`, and a still becomes a
 * `BRAND_CARD` unless the operator says otherwise — a photograph is usable as a
 * held card and is never a `LOGO` or an `APP_SCREENSHOT` by accident, because
 * both of those carry meanings the acquisition pipeline cannot establish.
 */
export function defaultRoleFor(asset: AcquiredProductionAsset): AssetRole {
  if (asset.mediaKind === 'AUDIO') return 'MUSIC';
  if (asset.mediaKind === 'VIDEO') return 'SOURCE_CLIP';
  return 'BRAND_CARD';
}

export interface AssetBinding {
  readonly candidateId: string;
  readonly role?: AssetRole;
  readonly beats?: readonly StoryBeat[];
  readonly tags?: readonly string[];
  readonly assetId?: string;
}

export interface BuildManifestOptions {
  readonly library: string;
  readonly assets: readonly AcquiredProductionAsset[];
  /** Directory the acquired files live in. */
  readonly assetDirectory: string;
  /** Directory the manifest will be written to; paths are expressed relative to it. */
  readonly outputManifestDirectory: string;
  /** Optional per-candidate plan bindings: which beat an asset may serve. */
  readonly bindings?: readonly AssetBinding[];
  /** The usage this manifest is for. `INTERNAL_EVALUATION` builds a demonstration. */
  readonly usage: Exclude<ApprovedUsage, 'INTERNAL_EVALUATION'> | 'INTERNAL_EVALUATION';
  /**
   * An existing manifest to merge over — a committed library of owned brand
   * assets, live UI captures and a logo. Acquired assets are added to it;
   * matching ids are replaced.
   */
  readonly baseManifest?: ProductionAssetManifest;
  readonly baseManifestDirectory?: string;
  /** Supplied by the caller. */
  readonly now: Date;
}

export interface BuildManifestResult {
  readonly manifest: ProductionAssetManifest;
  readonly added: readonly string[];
  readonly replaced: readonly string[];
  readonly preserved: readonly string[];
  /** Assets refused, each with the reason. Never silently dropped. */
  readonly refused: readonly { readonly assetId: string; readonly reason: string }[];
  readonly isInternalEvaluationDemonstration: boolean;
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

function manifestPathTo(fromDirectory: string, absoluteTarget: string): string {
  const rel = posix(relative(fromDirectory, absoluteTarget));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return rel;
  return `./${rel}`;
}

/**
 * Builds the manifest.
 *
 * Refusals are collected and reported; the manifest is built from what remains.
 * The exception is a manifest that would end up empty or without a logo, which
 * throws — an unusable manifest written to disk is worse than a refusal,
 * because the failure then surfaces three commands later inside the renderer.
 */
export function buildProductionAssetManifest(options: BuildManifestOptions): BuildManifestResult {
  const refused: { assetId: string; reason: string }[] = [];
  const bindingsById = new Map(
    (options.bindings ?? []).map((binding) => [binding.candidateId, binding]),
  );
  const isDemonstration = options.usage === 'INTERNAL_EVALUATION';

  const usable: AcquiredProductionAsset[] = [];
  for (const asset of options.assets) {
    const internalOnly = isInternalEvaluationOnly(asset.approval);

    if (internalOnly && !isDemonstration) {
      // Refused by name, never filtered. An operator who approved something for
      // evaluation only needs to be told it did not enter the campaign, rather
      // than discovering a shorter library.
      refused.push({
        assetId: asset.assetId,
        reason: `"${asset.candidateId}" is approved for INTERNAL_EVALUATION only. That is a different kind of permission, not a weaker production grade: it produces a labelled demonstration and can never become a campaign asset. Build it with --usage internal-evaluation, or obtain an approval covering ${options.usage}.`,
      });
      continue;
    }
    if (!internalOnly && isDemonstration) {
      // Not an error — a demonstration may legitimately include production
      // material — but recorded so the demonstration's own provenance is honest
      // about what it contains.
      usable.push(asset);
      continue;
    }
    if (asset.state !== 'OUTPUT_ELIGIBLE') {
      refused.push({
        assetId: asset.assetId,
        reason: `"${asset.candidateId}" is ${asset.state}, not OUTPUT_ELIGIBLE`,
      });
      continue;
    }
    if (asset.qualityDecision.outcome === 'BELOW_PROFILE') {
      refused.push({
        assetId: asset.assetId,
        reason: `"${asset.candidateId}" measures below ${asset.qualityDecision.profileVersion}: ${asset.qualityDecision.reasons.join('; ')}`,
      });
      continue;
    }
    usable.push(asset);
  }

  const acquiredEntries: ProductionAsset[] = usable.map((asset) => {
    const binding = bindingsById.get(asset.candidateId);
    const absolute = resolve(options.assetDirectory, asset.relativePath);
    const expiry = asset.approval.expiresAt;
    const restrictions = [
      ...asset.rights.sourceRestrictions,
      `Approved by ${asset.approval.approvedBy} for ${asset.approval.approvedUsages.join(', ')} on ${asset.approval.approvedPlatforms.join(', ')}.`,
      ...(isDemonstration && isInternalEvaluationOnly(asset.approval)
        ? ['INTERNAL EVALUATION ONLY — this asset may not appear in a published advertisement.']
        : []),
    ];

    return {
      id: binding?.assetId ?? asset.assetId,
      path: manifestPathTo(options.outputManifestDirectory, absolute),
      kind: kindFor(asset.mediaKind),
      role: binding?.role ?? defaultRoleFor(asset),
      description:
        `${asset.provider} ${asset.providerAssetId} — ${asset.rights.declaredLicence}`.slice(
          0,
          300,
        ),
      rights: {
        classification: classifyForOutput(asset.rights.licenceFamily),
        owner: asset.rights.creator.slice(0, 200),
        permittedOutputUse: true,
        ...(asset.rightsDecision.requiredAttribution
          ? { attribution: asset.rightsDecision.requiredAttribution.slice(0, 300) }
          : {}),
        ...(expiry ? { expiresAt: expiry } : {}),
        restrictions: restrictions.map((entry) => entry.slice(0, 500)),
      },
      beats: [...(binding?.beats ?? [])],
      tags: [
        ...(binding?.tags ?? []),
        asset.provider.toLowerCase(),
        asset.rights.licenceFamily.toLowerCase(),
      ],
      checksumSha256: asset.checksumSha256,
      ...(asset.measurements.durationSeconds
        ? { declaredDurationSeconds: asset.measurements.durationSeconds }
        : {}),
      ...(asset.measurements.widthPx ? { declaredWidthPx: asset.measurements.widthPx } : {}),
      ...(asset.measurements.heightPx ? { declaredHeightPx: asset.measurements.heightPx } : {}),
    };
  });

  const acquiredById = new Map(acquiredEntries.map((entry) => [entry.id, entry]));
  const replaced: string[] = [];
  const preserved: string[] = [];
  const merged: ProductionAsset[] = [];

  for (const existing of options.baseManifest?.assets ?? []) {
    const replacement = acquiredById.get(existing.id);
    if (replacement) {
      replaced.push(existing.id);
      // Plan bindings are preserved exactly as the capture merge preserves
      // them: role, beats and tags belong to the campaign, not to the source.
      merged.push({
        ...replacement,
        role: existing.role,
        beats: existing.beats,
        tags: existing.tags,
      });
      acquiredById.delete(existing.id);
      continue;
    }
    const baseDirectory = options.baseManifestDirectory ?? options.outputManifestDirectory;
    const absolute = isAbsolute(existing.path)
      ? existing.path
      : resolve(baseDirectory, existing.path);
    preserved.push(existing.id);
    merged.push({ ...existing, path: manifestPathTo(options.outputManifestDirectory, absolute) });
  }

  const added = [...acquiredById.keys()];
  merged.push(...acquiredById.values());

  if (merged.length === 0) {
    throw new ManifestBuildError([
      'nothing is usable, so there is no manifest to write',
      ...refused.map((entry) => entry.reason),
    ]);
  }
  if (!merged.some((entry) => entry.role === 'LOGO')) {
    throw new ManifestBuildError([
      'the manifest has no LOGO asset, which the existing production manifest schema requires. Merge these acquisitions over your committed brand manifest with --base-manifest, rather than building a standalone one.',
      ...refused.map((entry) => entry.reason),
    ]);
  }

  // Re-parsed rather than cast. The merged document faces exactly the same
  // rules as a hand-written one, including the ANALYSIS_ONLY and UNKNOWN_RIGHTS
  // refusals — so a licence family that mapped to UNKNOWN_RIGHTS is named here
  // rather than discovered at render time.
  const manifest = parseProductionAssetManifest({
    manifestVersion: 1,
    library: isDemonstration
      ? `${options.library} — INTERNAL EVALUATION DEMONSTRATION`
      : options.library,
    assets: merged,
  });

  return {
    manifest,
    added,
    replaced,
    preserved,
    refused,
    isInternalEvaluationDemonstration: isDemonstration,
  };
}
