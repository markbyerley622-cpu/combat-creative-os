import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  parseProductionAssetManifest,
  type ProductionAsset,
  type ProductionAssetManifest,
  type StoryBeat,
} from '../production-assets';
import type { HumanCreativePlan } from '../preview/human-plan';
import type { VerifiedStoryboardPackage } from './storyboard-package';

/**
 * Beat-by-beat asset reconciliation across every external pack, and the
 * staging that turns the winners into one self-contained render root.
 *
 * The rule this module exists to serve is "do not declare an asset missing
 * until all existing packs and relevant run manifests have been checked". So
 * discovery is exhaustive and cheap — every media file in every declared root
 * is found, sized and hashed — and the reconciliation table records what was
 * *considered* as well as what won. A table of winners with no losers is not
 * an explanation, and "we had nothing for this beat" is a claim that has to be
 * demonstrated rather than asserted.
 *
 * Two hard boundaries:
 *
 * - **Every external root is read-only.** Nothing here writes, renames, moves
 *   or deletes inside one. Selected media is *copied* into a staging root the
 *   run owns, and the copy's checksum is recomputed and compared to the
 *   original's before it is allowed to stand. Staging rather than pointing at
 *   the packs in place is what lets the existing preflight keep its
 *   single-canonical-root contract untouched, and it gives the run a snapshot
 *   that can be re-rendered byte-for-byte later.
 * - **Anything under `references/` is refused by location**, before any rights
 *   column is consulted, and so is anything whose bytes match a storyboard
 *   frame. Location and content, not declaration.
 */

/** Media this milestone knows how to reconcile. Anything else is documentation. */
const MEDIA_EXTENSIONS: ReadonlyMap<string, 'VIDEO' | 'IMAGE' | 'AUDIO'> = new Map([
  ['.mp4', 'VIDEO'],
  ['.mov', 'VIDEO'],
  ['.m4v', 'VIDEO'],
  ['.webm', 'VIDEO'],
  ['.png', 'IMAGE'],
  ['.jpg', 'IMAGE'],
  ['.jpeg', 'IMAGE'],
  ['.webp', 'IMAGE'],
  ['.wav', 'AUDIO'],
  ['.mp3', 'AUDIO'],
  ['.m4a', 'AUDIO'],
  ['.aac', 'AUDIO'],
  ['.flac', 'AUDIO'],
]);

/** Directory names never descended into. Build output and caches, not media. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.turbo',
]);

/** Beyond this a file is recorded but not hashed; nothing this campaign uses is near it. */
const MAX_HASHED_BYTES = 1_024 * 1_024 * 1_024;

export interface DeclaredSourceRoot {
  readonly label: string;
  readonly path: string;
  /** What this root is expected to contribute, for the reconciliation report. */
  readonly expectation: string;
}

export interface DiscoveredCandidate {
  readonly rootLabel: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: 'VIDEO' | 'IMAGE' | 'AUDIO';
  readonly sizeBytes: number;
  readonly checksumSha256: string | null;
  /** Set when the file sits under a `references/` directory. */
  readonly referenceOnlyByLocation: boolean;
}

export interface SourceRootScan {
  readonly label: string;
  readonly path: string;
  readonly present: boolean;
  readonly expectation: string;
  readonly mediaFileCount: number;
  readonly referenceOnlyByLocationCount: number;
  readonly note: string;
}

export class AssetReconciliationError extends Error {
  constructor(
    public readonly problems: readonly string[],
    message: string,
  ) {
    super(`${message}\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'AssetReconciliationError';
  }
}

function containedIn(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

async function sha256OfFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Walks one root, read-only, collecting every media file it can see.
 *
 * A root that is absent is not an error: the flagship command declares more
 * packs than any one machine is guaranteed to hold, and "this pack was not
 * present" is a finding worth recording rather than a reason to stop.
 */
export async function scanSourceRoot(
  root: DeclaredSourceRoot,
): Promise<{ scan: SourceRootScan; candidates: readonly DiscoveredCandidate[] }> {
  const rootPath = resolve(root.path);
  let present = true;
  try {
    if (!(await stat(rootPath)).isDirectory()) present = false;
  } catch {
    present = false;
  }

  if (!present) {
    return {
      scan: {
        label: root.label,
        path: rootPath,
        present: false,
        expectation: root.expectation,
        mediaFileCount: 0,
        referenceOnlyByLocationCount: 0,
        note: 'not present on this machine; nothing was declared missing on its account without checking the packs that are',
      },
      candidates: [],
    };
  }

  const candidates: DiscoveredCandidate[] = [];
  const queue: string[] = [rootPath];
  while (queue.length > 0) {
    const directory = queue.shift() as string;
    // eslint-disable-next-line no-await-in-loop -- a breadth-first walk is inherently sequential
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = MEDIA_EXTENSIONS.get(extname(entry.name).toLowerCase());
      if (!kind) continue;

      const relativePath = posix(relative(rootPath, absolutePath));
      // eslint-disable-next-line no-await-in-loop -- one file at a time keeps memory flat over ~1 GB of packs
      const sizeBytes = (await stat(absolutePath)).size;
      const checksumSha256 =
        sizeBytes <= MAX_HASHED_BYTES
          ? // eslint-disable-next-line no-await-in-loop -- as above
            await sha256OfFile(absolutePath)
          : null;

      candidates.push({
        rootLabel: root.label,
        absolutePath,
        relativePath,
        kind,
        sizeBytes,
        checksumSha256,
        referenceOnlyByLocation: relativePath.split('/').includes('references'),
      });
    }
  }

  const referenceCount = candidates.filter((c) => c.referenceOnlyByLocation).length;
  return {
    scan: {
      label: root.label,
      path: rootPath,
      present: true,
      expectation: root.expectation,
      mediaFileCount: candidates.length,
      referenceOnlyByLocationCount: referenceCount,
      note:
        referenceCount > 0
          ? `${referenceCount} file(s) sit under references/ and are refused as production media by location, before any rights column is read`
          : 'no reference-located media in this root',
    },
    candidates,
  };
}

/** One row of the beat-by-beat reconciliation table. */
export interface BeatReconciliationRow {
  readonly beatId: string;
  readonly beatIndex: number;
  readonly storyboardFrameId: string;
  readonly slotStartSeconds: number;
  readonly slotEndSeconds: number;
  readonly productionRole: string;
  readonly requiredAsset: string;
  readonly discoveredCandidateIds: readonly string[];
  readonly selectedAssetId: string;
  readonly selectedRelativePath: string;
  readonly sourceRootLabel: string;
  readonly checksumSha256: string;
  readonly outputEligible: boolean;
  readonly rightsState: string;
  readonly provenanceState: string;
  readonly factualLimitations: readonly string[];
  readonly substitutionReason: string | null;
  readonly unresolvedGap: string | null;
}

/**
 * What each beat could not have, and why the thing it got is honest instead.
 *
 * Authored, not inferred. The storyboard asks for talent, arena footage,
 * reaction plates and a live discussion feed, and none of those exist in any
 * pack — the substitution is a creative decision a person made, and it is
 * recorded here in that person's own words rather than generated from a
 * template.
 */
export interface BeatSubstitution {
  readonly beatId: string;
  readonly requiredAsset: string;
  readonly substitutionReason: string | null;
  readonly factualLimitations: readonly string[];
  readonly unresolvedGap: string | null;
}

export interface ReconciliationInput {
  readonly roots: readonly DeclaredSourceRoot[];
  readonly plan: HumanCreativePlan;
  readonly storyboard: VerifiedStoryboardPackage;
  readonly libraryManifest: ProductionAssetManifest;
  readonly libraryManifestDir: string;
  readonly substitutions: readonly BeatSubstitution[];
  /**
   * Assets this run built rather than found. They are reconciled exactly like
   * discovered ones — hashed, checked against the reference set, recorded with
   * their provenance — but they resolve from their own absolute path rather
   * than relative to the pack's manifest.
   */
  readonly generatedAssets?: readonly {
    readonly asset: ProductionAsset;
    readonly absolutePath: string;
    readonly sourceRootLabel: string;
  }[];
}

export interface ReconciliationReport {
  readonly roots: readonly SourceRootScan[];
  readonly totalMediaFilesDiscovered: number;
  readonly rows: readonly BeatReconciliationRow[];
  readonly unresolvedGaps: readonly string[];
  /** Every candidate the scan saw, so "nothing else fitted" is checkable. */
  readonly candidates: readonly DiscoveredCandidate[];
}

/**
 * Builds the reconciliation table and proves each beat's chosen asset is real.
 *
 * The plan binds every beat by explicit `assetId` — this milestone does not
 * let a tag selector decide which footage carries a flagship beat — so this is
 * a verification pass, not a search: the named asset must exist in the
 * library, must be on disk where the library says, and must hash to what the
 * library declared if the library declared anything.
 */
export async function reconcileAssets(input: ReconciliationInput): Promise<ReconciliationReport> {
  const scans: SourceRootScan[] = [];
  const candidates: DiscoveredCandidate[] = [];
  for (const root of input.roots) {
    // eslint-disable-next-line no-await-in-loop -- roots are scanned in declared order for a stable report
    const result = await scanSourceRoot(root);
    scans.push(result.scan);
    candidates.push(...result.candidates);
  }

  const storyboardChecksums = new Set(input.storyboard.excludedChecksums);
  const assetsById = new Map(
    input.libraryManifest.assets.map((asset) => [
      asset.id,
      {
        asset,
        absolutePath: resolve(input.libraryManifestDir, asset.path),
        sourceRootLabel: null as string | null,
      },
    ]),
  );
  for (const generated of input.generatedAssets ?? []) {
    assetsById.set(generated.asset.id, {
      asset: generated.asset,
      absolutePath: generated.absolutePath,
      sourceRootLabel: generated.sourceRootLabel,
    });
  }
  const substitutionsByBeat = new Map(input.substitutions.map((s) => [s.beatId, s]));
  const framesBySequence = new Map(input.storyboard.frames.map((frame) => [frame.sequence, frame]));

  const problems: string[] = [];
  const rows: BeatReconciliationRow[] = [];

  for (const [index, beat] of input.plan.beats.entries()) {
    const frame = framesBySequence.get(index + 1);
    const substitution = substitutionsByBeat.get(beat.id);
    const assetId = beat.source.assetId;
    if (!assetId) {
      problems.push(
        `beat "${beat.id}" has no explicit source.assetId; a flagship beat names the asset it carries rather than leaving it to a tag match`,
      );
      continue;
    }
    const entry = assetsById.get(assetId);
    if (!entry) {
      problems.push(`beat "${beat.id}" names asset "${assetId}", which the library does not hold`);
      continue;
    }
    const { asset, absolutePath } = entry;

    let checksumSha256: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- ordered for a stable report
      checksumSha256 = await sha256OfFile(absolutePath);
    } catch {
      problems.push(`asset "${assetId}" is declared at ${asset.path} but is not readable on disk`);
      continue;
    }
    if (asset.checksumSha256 && asset.checksumSha256 !== checksumSha256) {
      problems.push(
        `asset "${assetId}" hashes to ${checksumSha256.slice(0, 16)}… but the library declared ${asset.checksumSha256.slice(0, 16)}…`,
      );
      continue;
    }
    if (storyboardChecksums.has(checksumSha256)) {
      problems.push(
        `asset "${assetId}" is byte-identical to a storyboard frame; storyboard pixels can never be production media`,
      );
      continue;
    }

    const discovered = candidates.filter(
      (candidate) =>
        candidate.kind === asset.kind &&
        !candidate.referenceOnlyByLocation &&
        servesBeat(asset, beat.role, candidate),
    );

    rows.push({
      beatId: beat.id,
      beatIndex: beat.index,
      storyboardFrameId: frame?.frameId ?? `FRAME-0${index + 1}`,
      slotStartSeconds: frame?.startSeconds ?? 0,
      slotEndSeconds: frame?.endSeconds ?? 0,
      productionRole: frame?.requiredProductionRole ?? beat.role,
      requiredAsset: substitution?.requiredAsset ?? frame?.requiredAssetTypes.join('; ') ?? '',
      discoveredCandidateIds: discovered.slice(0, 12).map((candidate) => candidate.relativePath),
      selectedAssetId: assetId,
      selectedRelativePath: posix(asset.path),
      sourceRootLabel:
        entry.sourceRootLabel ??
        scans.find((scan) => scan.present && containedIn(scan.path, absolutePath))?.label ??
        'library manifest directory',
      checksumSha256,
      outputEligible: asset.rights.permittedOutputUse,
      rightsState: `${asset.rights.classification} — ${asset.rights.owner}`,
      provenanceState: asset.description,
      factualLimitations: substitution?.factualLimitations ?? [],
      substitutionReason: substitution?.substitutionReason ?? null,
      unresolvedGap: substitution?.unresolvedGap ?? null,
    });
  }

  if (problems.length > 0) {
    throw new AssetReconciliationError(problems, 'Asset reconciliation failed');
  }

  return {
    roots: scans,
    totalMediaFilesDiscovered: candidates.length,
    rows,
    unresolvedGaps: rows
      .map((row) => (row.unresolvedGap ? `${row.beatId}: ${row.unresolvedGap}` : null))
      .filter((gap): gap is string => gap !== null),
    candidates,
  };
}

/** A candidate is a plausible alternative for a beat when it could carry the same role. */
function servesBeat(
  asset: ProductionAsset,
  role: StoryBeat,
  candidate: DiscoveredCandidate,
): boolean {
  if (asset.kind !== candidate.kind) return false;
  // Everything of the right kind is a candidate; the library's declared beats
  // narrow it where they exist. Being generous here is deliberate — the table
  // is meant to show what was passed over, not to pre-justify the winner.
  return asset.beats.length === 0 || asset.beats.includes(role);
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface StagedAsset {
  readonly assetId: string;
  readonly stagedRelativePath: string;
  readonly checksumSha256: string;
  readonly sourceAbsolutePath: string;
  readonly copied: boolean;
}

export interface StagingResult {
  readonly stagingRoot: string;
  readonly manifestPath: string;
  readonly assets: readonly StagedAsset[];
  readonly generatedAssetIds: readonly string[];
}

export interface StageAssetsInput {
  readonly libraryManifest: ProductionAssetManifest;
  readonly libraryManifestDir: string;
  readonly stagingRoot: string;
  /** Only these ids are staged — an unused 80 MB clip is not copied. */
  readonly requiredAssetIds: readonly string[];
  /** Assets this run generated itself, already written under `stagingRoot`. */
  readonly generatedAssets: readonly ProductionAsset[];
  readonly libraryLabel: string;
  readonly forbiddenChecksums: ReadonlySet<string>;
}

/**
 * Copies the assets this cut actually uses into a root the run owns.
 *
 * Idempotent by content: a staged file that already hashes correctly is left
 * alone, so a second run of the same campaign costs no copying. The copy is
 * re-hashed rather than trusted, because a truncated copy that renders is far
 * worse than one that fails here.
 */
export async function stageAssets(input: StageAssetsInput): Promise<StagingResult> {
  const stagingRoot = resolve(input.stagingRoot);
  const mediaDirectory = join(stagingRoot, 'media');
  await mkdir(mediaDirectory, { recursive: true });

  const assetsById = new Map(input.libraryManifest.assets.map((asset) => [asset.id, asset]));
  const staged: StagedAsset[] = [];
  const stagedAssets: ProductionAsset[] = [];
  const problems: string[] = [];

  for (const assetId of [...new Set(input.requiredAssetIds)].sort()) {
    const asset = assetsById.get(assetId);
    if (!asset) {
      problems.push(`asset "${assetId}" is required by the plan but absent from the library`);
      continue;
    }
    const sourceAbsolutePath = resolve(input.libraryManifestDir, asset.path);
    let checksumSha256: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- deterministic order
      checksumSha256 = await sha256OfFile(sourceAbsolutePath);
    } catch {
      problems.push(`asset "${assetId}" could not be read at ${asset.path}`);
      continue;
    }
    if (input.forbiddenChecksums.has(checksumSha256)) {
      problems.push(
        `asset "${assetId}" is byte-identical to reference material and cannot be staged`,
      );
      continue;
    }

    const stagedName = `${assetId}-${checksumSha256.slice(0, 16)}${extname(asset.path).toLowerCase()}`;
    const stagedAbsolutePath = join(mediaDirectory, stagedName);

    let copied = false;
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    const existing = await checksumIfPresent(stagedAbsolutePath);
    if (existing !== checksumSha256) {
      // eslint-disable-next-line no-await-in-loop -- deterministic order
      await copyFile(sourceAbsolutePath, stagedAbsolutePath);
      copied = true;
      // eslint-disable-next-line no-await-in-loop -- the copy is verified, never assumed
      const written = await sha256OfFile(stagedAbsolutePath);
      if (written !== checksumSha256) {
        problems.push(
          `the staged copy of "${assetId}" hashes to ${written.slice(0, 16)}… but the original hashes to ${checksumSha256.slice(0, 16)}…`,
        );
        continue;
      }
    }

    staged.push({
      assetId,
      stagedRelativePath: `./media/${stagedName}`,
      checksumSha256,
      sourceAbsolutePath,
      copied,
    });
    stagedAssets.push({
      ...asset,
      path: `./media/${stagedName}`,
      checksumSha256,
    });
  }

  if (problems.length > 0) {
    throw new AssetReconciliationError(problems, 'Staging failed');
  }

  // Generated assets are already inside the staging root; they are hashed the
  // same way and enter the manifest through the same parse as everything else.
  for (const generated of input.generatedAssets) {
    const absolutePath = resolve(stagingRoot, generated.path);
    if (!containedIn(stagingRoot, absolutePath)) {
      throw new AssetReconciliationError(
        [`generated asset "${generated.id}" resolves outside the staging root`],
        'Staging failed',
      );
    }
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    const checksumSha256 = await sha256OfFile(absolutePath);
    staged.push({
      assetId: generated.id,
      stagedRelativePath: generated.path,
      checksumSha256,
      sourceAbsolutePath: absolutePath,
      copied: false,
    });
    stagedAssets.push({ ...generated, checksumSha256 });
  }

  // Re-parsed rather than cast: the staged manifest faces exactly the same
  // rules a hand-written one does, so an analysis-only or unknown-rights asset
  // cannot enter production through the staging door.
  const manifest = parseProductionAssetManifest(
    {
      manifestVersion: 1,
      library: input.libraryLabel,
      assets: stagedAssets.sort((a, b) => a.id.localeCompare(b.id)),
    },
    join(stagingRoot, 'assets.json'),
  );

  const manifestPath = join(stagingRoot, 'assets.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    stagingRoot,
    manifestPath,
    assets: staged.sort((a, b) => a.assetId.localeCompare(b.assetId)),
    generatedAssetIds: input.generatedAssets.map((asset) => asset.id).sort(),
  };
}

async function checksumIfPresent(path: string): Promise<string | null> {
  try {
    return await sha256OfFile(path);
  } catch {
    return null;
  }
}
