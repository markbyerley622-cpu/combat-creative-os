import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';
import {
  evaluateMediaRights,
  orientationOf,
  type LicenceFamily,
  type MediaCandidate,
  type MediaKind,
  type MediaQualityMeasurements,
  type MediaRightsFacts,
  type PermissionState,
  type ReleaseState,
  type RiskLevel,
  type RiskState,
} from '@combat/providers';

import { readCsvTable, requireColumns, type CsvRow, type CsvTable } from './csv';
import {
  evaluateSourceQuality,
  measureSourceMedia,
  sha256OfFile,
  SourceQualityError,
} from './source-quality';

/**
 * Reading an operator's externally-collected candidate library, without
 * touching it.
 *
 * The folder is **not** a repository, it is **not** version-controlled, and it
 * holds real downloaded media, licence evidence and screenshots. So the entire
 * contract of this module is: open, read, hash, measure, and write nothing.
 * Every path it produces is recorded and every byte it copies is zero.
 *
 * Its harder job is that the folder is *untrusted input that looks
 * trustworthy*. It was assembled by hand, its CSVs were edited in a
 * spreadsheet, and its `stored_path` column is a string that will be joined
 * onto a root. Treating it as authoritative is how a `..\..\Windows\System32`
 * or a symlink pointing outside the pack becomes a file this process reads. So:
 *
 * - Every path is resolved **and** `realpath`-ed, then re-checked for
 *   containment. A symlink inside the pack pointing outside it is refused, not
 *   followed — the same rule the preview's asset-root preflight settled on.
 * - Checksums are **recalculated**, never read. The CSV's `sha256` column is
 *   compared against the recalculation and a disagreement is reported as a
 *   discrepancy; the measured value is what travels onward.
 * - `references/` is refused as production media whatever any CSV says about
 *   it. That is the structural half of "analysis-only can never reach an
 *   output": the refusal does not depend on a rights column being filled in
 *   correctly.
 * - Nothing imported becomes output-eligible. Every candidate lands at
 *   `RIGHTS_REVIEW_REQUIRED` at best, and a human approval is the only way
 *   past it.
 */

export const PILOT_PACK_IMPORT_VERSION = 'EXTERNAL_PACK_IMPORT_V1';

/** Files the importer reads. A pack missing one is degraded, not refused. */
export const PACK_FILES = {
  sourceCandidates: 'source-candidates.csv',
  acquisitionLog: 'acquisition-log.csv',
  assetInventory: 'asset-inventory.csv',
  rightsInventory: 'rights-inventory.csv',
} as const;

export const LICENCE_EVIDENCE_DIRECTORY = 'candidates/licence-evidence';

/**
 * Directories whose contents are analysis-only, refused as production media
 * regardless of what any inventory row claims.
 *
 * Shared vocabulary with the preview preflight on purpose: an operator who
 * learns the rule in one place has learned it in both.
 */
export const ANALYSIS_ONLY_DIRECTORIES: readonly string[] = ['references'];

export const PACK_IMPORT_PROBLEM_KINDS = [
  'PACK_NOT_FOUND',
  'MISSING_FILE',
  'MISSING_COLUMN',
  'PATH_ESCAPE',
  'SYMLINK_ESCAPE',
  'MEDIA_MISSING',
  'CHECKSUM_MISMATCH',
  'DUPLICATE_CONTENT',
  'ANALYSIS_ONLY_IN_PRODUCTION',
  'UNKNOWN_CANDIDATE',
  'ORPHANED_ACQUISITION',
  'MEASUREMENT_FAILED',
  'UNREADABLE_ROW',
] as const;
export type PackImportProblemKind = (typeof PACK_IMPORT_PROBLEM_KINDS)[number];

export interface PackImportProblem {
  readonly kind: PackImportProblemKind;
  /** The record it concerns, where one can be named. */
  readonly candidateId: string | null;
  readonly detail: string;
}

export class PilotPackImportError extends Error {
  constructor(
    public readonly problems: readonly PackImportProblem[],
    packPath: string,
  ) {
    super(
      `The candidate pack at ${packPath} cannot be imported:\n  - ${problems
        .map((problem) => `[${problem.kind}] ${problem.candidateId ?? '<pack>'}: ${problem.detail}`)
        .join('\n  - ')}`,
    );
    this.name = 'PilotPackImportError';
  }
}

/**
 * Where a candidate's bytes actually live, kept out of shared artefacts.
 *
 * An absolute path on somebody's Desktop is private provenance: it names a
 * machine, frequently a person, and it is meaningless to anybody else. It is
 * recorded once, in the run's own private provenance file, and never in a
 * gallery, a credits file, a rights report or a production manifest.
 */
export interface PrivateSourceLocation {
  readonly candidateId: string;
  readonly absolutePath: string;
  readonly checksumSha256: string;
  readonly licenceEvidencePath: string | null;
}

export interface PilotPackImportResult {
  readonly packPath: string;
  readonly canonicalPackPath: string;
  readonly candidates: readonly MediaCandidate[];
  /** Never written to a shared artefact. */
  readonly privateLocations: readonly PrivateSourceLocation[];
  readonly problems: readonly PackImportProblem[];
  readonly counts: {
    readonly candidateRows: number;
    readonly acquisitionRows: number;
    readonly mediaFound: number;
    readonly mediaMissing: number;
    readonly checksumVerified: number;
    readonly checksumMismatched: number;
    readonly duplicates: number;
    readonly analysisOnlyRefused: number;
    readonly licenceEvidenceFiles: number;
  };
}

export interface ImportPilotPackOptions {
  readonly packPath: string;
  readonly runner: CommandRunner;
  readonly binaries?: FfmpegBinaries;
  readonly signal?: AbortSignal;
  /** Supplied by the caller; this module reads no clock. */
  readonly now: Date;
  /**
   * Measure every located file. Off by default for a large library, because
   * two whole-clip decode passes per item is minutes of work — and when it is
   * off, every measurement-derived field is `null` and says why.
   */
  readonly measureMedia?: boolean;
  readonly onProgress?: (message: string) => void;
}

/* ------------------------------------------------------------------------- */
/* Path safety                                                                */
/* ------------------------------------------------------------------------- */

async function canonicalise(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // A path that does not exist yet cannot be `realpath`-ed; `resolve` is the
    // best available answer and the existence check that follows is what
    // actually decides.
    return resolve(path);
  }
}

/** True when `candidate` is the root itself or sits beneath it. */
export function containedWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Resolves a pack-relative path, refusing anything that leaves the pack.
 *
 * Two checks, not one. The lexical check catches `../../secrets`; the
 * `realpath` check catches a symlink that looks contained and is not. Either
 * alone is bypassable, which is why both are here.
 */
export async function resolveInsidePack(
  canonicalRoot: string,
  declared: string,
): Promise<{ readonly path: string; readonly problem: PackImportProblem | null }> {
  // Pack CSVs are Windows-authored, so backslashes are the normal separator.
  const normalized = declared.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (normalized.length === 0) {
    return {
      path: '',
      problem: { kind: 'MEDIA_MISSING', candidateId: null, detail: 'the row declares no path' },
    };
  }
  if (isAbsolute(normalized)) {
    return {
      path: '',
      problem: {
        kind: 'PATH_ESCAPE',
        candidateId: null,
        detail: `"${declared}" is an absolute path; pack rows must be relative to the pack root`,
      },
    };
  }

  const joined = resolve(canonicalRoot, normalized);
  if (!containedWithin(canonicalRoot, joined)) {
    return {
      path: '',
      problem: {
        kind: 'PATH_ESCAPE',
        candidateId: null,
        detail: `"${declared}" resolves outside the pack root`,
      },
    };
  }

  const canonical = await canonicalise(joined);
  if (!containedWithin(canonicalRoot, canonical)) {
    return {
      path: '',
      problem: {
        kind: 'SYMLINK_ESCAPE',
        candidateId: null,
        detail: `"${declared}" is a link that points outside the pack root (${canonical})`,
      },
    };
  }
  return { path: canonical, problem: null };
}

/** True when a pack-relative path sits under an analysis-only directory. */
export function isAnalysisOnlyPath(canonicalRoot: string, canonicalPath: string): boolean {
  const rel = relative(canonicalRoot, canonicalPath).replace(/\\/g, '/');
  const first = rel.split('/')[0]?.toLowerCase() ?? '';
  // Matched as a whole path segment. A substring rule would refuse
  // `combat-clips/references-to-review.mp4`, and a rule that fires on ordinary
  // content is one operators learn to work around.
  return ANALYSIS_ONLY_DIRECTORIES.includes(first);
}

/* ------------------------------------------------------------------------- */
/* Column readings                                                            */
/* ------------------------------------------------------------------------- */

function permission(value: string): PermissionState {
  const normalized = value.trim().toUpperCase();
  if (normalized.startsWith('YES') || normalized === 'TRUE' || normalized === 'PERMITTED')
    return 'PERMITTED';
  if (normalized.startsWith('NO') || normalized === 'FALSE' || normalized === 'PROHIBITED')
    return 'PROHIBITED';
  return 'UNKNOWN';
}

function risk(value: string): RiskState {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'NONE_APPARENT' || normalized === 'NONE' || normalized === 'NO')
    return 'NONE_APPARENT';
  if (normalized === 'YES' || normalized === 'PRESENT' || normalized === 'TRUE') return 'PRESENT';
  return 'UNKNOWN';
}

function riskLevel(value: string): RiskLevel {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'LOW' || normalized === 'MEDIUM' || normalized === 'HIGH') return normalized;
  return 'UNKNOWN';
}

function release(value: string): ReleaseState {
  const normalized = value.trim().toUpperCase();
  if (normalized.includes('ON_FILE') || normalized === 'YES') return 'ON_FILE';
  if (normalized.includes('NOT_APPLICABLE') || normalized === 'N/A') return 'NOT_APPLICABLE';
  if (
    normalized.includes('UNVERIFIED') ||
    normalized.includes('NOT_PROVIDED') ||
    normalized === 'NO'
  ) {
    return 'NOT_PROVIDED';
  }
  return 'UNKNOWN';
}

/**
 * Maps a pack's free-text licence name onto a normalized family.
 *
 * Ordered most-restrictive-first for the same reason the Commons classifier is:
 * `CC BY-NC-SA` contains `CC BY`, and reading a NonCommercial licence as plain
 * attribution is the single most consequential mistake this table could make.
 */
export function classifyPackLicence(declared: string): LicenceFamily {
  const value = declared.toLowerCase().replace(/[\s_]+/g, '-');
  const table: readonly { readonly needle: string; readonly family: LicenceFamily }[] = [
    { needle: 'by-nc-nd', family: 'CC_BY_NC_ND' },
    { needle: 'by-nc-sa', family: 'CC_BY_NC_SA' },
    { needle: 'by-nc', family: 'CC_BY_NC' },
    { needle: 'noncommercial', family: 'CC_BY_NC' },
    { needle: 'non-commercial', family: 'CC_BY_NC' },
    { needle: 'by-nd', family: 'CC_BY_ND' },
    { needle: 'noderiv', family: 'CC_BY_ND' },
    { needle: 'by-sa', family: 'CC_BY_SA' },
    { needle: 'share-alike', family: 'CC_BY_SA' },
    { needle: 'cc0', family: 'CC0' },
    { needle: 'pexels', family: 'PEXELS_LICENCE' },
    { needle: 'pixabay', family: 'PIXABAY_CONTENT_LICENCE' },
    { needle: 'pd-usgov', family: 'US_GOVERNMENT_PUBLIC_DOMAIN' },
    { needle: 'u.s. government', family: 'US_GOVERNMENT_PUBLIC_DOMAIN' },
    { needle: 'us government', family: 'US_GOVERNMENT_PUBLIC_DOMAIN' },
    { needle: 'public-domain-mark', family: 'PUBLIC_DOMAIN_MARK' },
    { needle: 'public-domain', family: 'PUBLIC_DOMAIN' },
    { needle: 'public domain', family: 'PUBLIC_DOMAIN' },
    { needle: 'cc-by', family: 'CC_BY' },
    { needle: 'editorial', family: 'EDITORIAL_ONLY' },
    { needle: 'personal-use', family: 'PERSONAL_USE_ONLY' },
    { needle: 'standard-youtube', family: 'STANDARD_YOUTUBE_LICENCE' },
    { needle: 'all-rights-reserved', family: 'ALL_RIGHTS_RESERVED' },
  ];
  for (const entry of table) {
    if (value.includes(entry.needle)) return entry.family;
  }
  return 'UNKNOWN';
}

function mediaKindOf(value: string): MediaKind {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'VIDEO' || normalized === 'IMAGE' || normalized === 'AUDIO') return normalized;
  return 'IMAGE';
}

function numberOrNull(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function rightsFromRow(row: CsvRow): MediaRightsFacts {
  const declared = row.get('declared_licence') || 'NOT_STATED';
  const restrictions = row.get('provider_restrictions');
  return {
    declaredLicence: declared.slice(0, 200),
    licenceFamily: classifyPackLicence(declared),
    ...(row.get('licence_url') ? { licenceUrl: row.get('licence_url').slice(0, 2000) } : {}),
    creator: (row.get('creator') || 'NOT_STATED').slice(0, 300),
    ...(row.get('attribution_text')
      ? { attributionText: row.get('attribution_text').slice(0, 600) }
      : {}),
    commercialUse: permission(row.get('commercial_use_permitted')),
    derivativeUse: permission(row.get('derivative_use_permitted')),
    paidAdvertisingUse: permission(row.get('paid_ads_permitted')),
    recognizablePersonRisk: risk(row.get('recognizable_people')),
    trademarkOrLogoRisk: risk(row.get('trademark_or_logo')),
    endorsementRisk: riskLevel(row.get('endorsement_risk')),
    // The pack records a release *status* only through the paid-ads column's
    // "RELEASE_UNVERIFIED" convention; anything less explicit is UNKNOWN.
    modelReleaseStatus: release(row.get('paid_ads_permitted')),
    propertyReleaseStatus: 'UNKNOWN',
    sourceRestrictions: restrictions ? [restrictions.slice(0, 600)] : [],
  };
}

function providerOf(row: CsvRow): MediaCandidate['provider'] {
  const declared = row.get('provider').toLowerCase();
  if (declared.includes('pexels')) return 'PEXELS';
  if (declared.includes('pixabay')) return 'PIXABAY';
  if (declared.includes('dvids')) return 'DVIDS';
  if (declared.includes('wikimedia') || declared.includes('commons')) return 'WIKIMEDIA_COMMONS';
  if (declared.includes('openverse')) return 'OPENVERSE';
  return 'EXTERNAL_PILOT_PACK';
}

/* ------------------------------------------------------------------------- */
/* The import                                                                 */
/* ------------------------------------------------------------------------- */

async function readTable(
  canonicalRoot: string,
  filename: string,
  problems: PackImportProblem[],
): Promise<CsvTable | null> {
  const resolved = await resolveInsidePack(canonicalRoot, filename);
  if (resolved.problem || !resolved.path) {
    problems.push({
      kind: 'MISSING_FILE',
      candidateId: null,
      detail: `${filename} could not be resolved inside the pack`,
    });
    return null;
  }
  try {
    return readCsvTable(await readFile(resolved.path, 'utf8'), filename);
  } catch (error) {
    problems.push({
      kind: 'MISSING_FILE',
      candidateId: null,
      detail: `${filename} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

/**
 * Imports the pack.
 *
 * Never throws for a per-record problem — a library of several hundred rows
 * with three broken paths should produce three named problems and the rest of
 * the library, not a refusal. It throws only when the pack itself is unusable:
 * absent, or with no candidate list at all.
 */
export async function importPilotPack(
  options: ImportPilotPackOptions,
): Promise<PilotPackImportResult> {
  const problems: PackImportProblem[] = [];
  const declaredRoot = resolve(options.packPath);

  const rootStat = await stat(declaredRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new PilotPackImportError(
      [
        {
          kind: 'PACK_NOT_FOUND',
          candidateId: null,
          detail: 'the path is not a readable directory',
        },
      ],
      options.packPath,
    );
  }
  const canonicalRoot = await canonicalise(declaredRoot);

  const candidateTable = await readTable(canonicalRoot, PACK_FILES.sourceCandidates, problems);
  if (!candidateTable) {
    throw new PilotPackImportError(problems, options.packPath);
  }
  const missingColumns = requireColumns(candidateTable, ['candidate_id', 'provider', 'media_kind']);
  if (missingColumns.length > 0) {
    throw new PilotPackImportError(
      [
        {
          kind: 'MISSING_COLUMN',
          candidateId: null,
          detail: `${PACK_FILES.sourceCandidates} has no ${missingColumns.join(', ')} column`,
        },
      ],
      options.packPath,
    );
  }

  const acquisitionTable = await readTable(canonicalRoot, PACK_FILES.acquisitionLog, problems);
  const assetInventory = await readTable(canonicalRoot, PACK_FILES.assetInventory, problems);
  const rightsInventory = await readTable(canonicalRoot, PACK_FILES.rightsInventory, problems);

  // Acquisition rows keyed by candidate — this is where the bytes are, and
  // where the checksum to check against lives.
  const acquisitionByCandidate = new Map<string, CsvRow>();
  for (const row of acquisitionTable?.rows ?? []) {
    const candidateId = row.get('candidate_id');
    if (!candidateId) continue;
    const existing = acquisitionByCandidate.get(candidateId);
    if (existing) {
      // Reported rather than silently overwritten. A candidate with two
      // download rows is either a repeat acquisition or two different files
      // filed under one id, and which one the importer picked is exactly the
      // thing an operator would otherwise have no way to find out.
      problems.push({
        kind: 'ORPHANED_ACQUISITION',
        candidateId,
        detail: `${PACK_FILES.acquisitionLog} has more than one download row for this candidate (lines ${existing.line} and ${row.line}); the last one is what the import used`,
      });
    }
    acquisitionByCandidate.set(candidateId, row);
  }

  const declaredCandidateIds = new Set(
    candidateTable.rows.map((row) => row.get('candidate_id')).filter((id) => id.length > 0),
  );
  for (const [candidateId] of acquisitionByCandidate) {
    if (!declaredCandidateIds.has(candidateId)) {
      problems.push({
        kind: 'ORPHANED_ACQUISITION',
        candidateId,
        detail: `${PACK_FILES.acquisitionLog} records a download for a candidate that ${PACK_FILES.sourceCandidates} does not list`,
      });
    }
  }

  // The two inventories describe the *intended* library rather than the
  // candidate pool, and they are cross-checked against each other: a rights row
  // for an asset the inventory does not list is a record nobody will ever act
  // on, and an inventory row with no rights row is an asset with no licence
  // position. Both are reported and neither blocks the import.
  const inventoryIds = new Set(
    (assetInventory?.rows ?? []).map((row) => row.get('asset_id')).filter((id) => id.length > 0),
  );
  for (const row of rightsInventory?.rows ?? []) {
    const assetId = row.get('asset_id');
    if (assetId && !inventoryIds.has(assetId)) {
      problems.push({
        kind: 'UNKNOWN_CANDIDATE',
        candidateId: assetId,
        detail: `${PACK_FILES.rightsInventory} records rights for an asset ${PACK_FILES.assetInventory} does not list`,
      });
    }
  }
  const rightsIds = new Set(
    (rightsInventory?.rows ?? []).map((row) => row.get('asset_id')).filter((id) => id.length > 0),
  );
  for (const assetId of inventoryIds) {
    if (!rightsIds.has(assetId)) {
      problems.push({
        kind: 'UNKNOWN_CANDIDATE',
        candidateId: assetId,
        detail: `${PACK_FILES.assetInventory} lists an asset with no row in ${PACK_FILES.rightsInventory}, so it has no recorded licence position`,
      });
    }
  }

  const licenceEvidenceFiles = await countLicenceEvidence(canonicalRoot);

  const candidates: MediaCandidate[] = [];
  const privateLocations: PrivateSourceLocation[] = [];
  const checksumToCandidate = new Map<string, string>();
  let mediaFound = 0;
  let mediaMissing = 0;
  let checksumVerified = 0;
  let checksumMismatched = 0;
  let duplicates = 0;
  let analysisOnlyRefused = 0;

  for (const row of candidateTable.rows) {
    const candidateId = row.get('candidate_id');
    if (!candidateId) {
      problems.push({
        kind: 'UNREADABLE_ROW',
        candidateId: null,
        detail: `line ${row.line} has no candidate_id`,
      });
      continue;
    }

    const mediaKind = mediaKindOf(row.get('media_kind'));
    const rights = rightsFromRow(row);
    const landingPageUrl = row.get('landing_page_url') || `pack://${candidateId}`;
    const rightsDecision = evaluateMediaRights({
      facts: rights,
      landingPageUrl,
      isGovernmentPublicAffairs: providerOf(row) === 'DVIDS',
    });

    const acquisition = acquisitionByCandidate.get(candidateId);
    let measurements: MediaQualityMeasurements | undefined;
    let licenceEvidencePath: string | null = null;
    let absolutePath: string | null = null;
    let fileChecksum = '';

    if (acquisition) {
      const storedPath = acquisition.get('stored_path');
      const resolved = await resolveInsidePack(canonicalRoot, storedPath);
      if (resolved.problem) {
        problems.push({ ...resolved.problem, candidateId });
      } else if (isAnalysisOnlyPath(canonicalRoot, resolved.path)) {
        // Refused by *location*, before any rights column is consulted. A row
        // that claimed OWNED for a file under references/ would still land
        // here, which is the whole point of the structural rule.
        analysisOnlyRefused += 1;
        problems.push({
          kind: 'ANALYSIS_ONLY_IN_PRODUCTION',
          candidateId,
          detail: `"${storedPath}" is under an analysis-only directory (${ANALYSIS_ONLY_DIRECTORIES.join(', ')}). Reference material may be studied for structure and pacing and may never enter a production selection, whatever its rights column says.`,
        });
      } else {
        const fileStat = await stat(resolved.path).catch(() => null);
        if (!fileStat?.isFile()) {
          mediaMissing += 1;
          problems.push({
            kind: 'MEDIA_MISSING',
            candidateId,
            detail: `${PACK_FILES.acquisitionLog} records "${storedPath}" but no file is there`,
          });
        } else {
          mediaFound += 1;
          absolutePath = resolved.path;

          if (options.measureMedia) {
            try {
              measurements = await measureSourceMedia({
                filePath: resolved.path,
                mediaKind,
                runner: options.runner,
                ...(options.binaries ? { binaries: options.binaries } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
              });
            } catch (error) {
              problems.push({
                kind: 'MEASUREMENT_FAILED',
                candidateId,
                detail:
                  error instanceof SourceQualityError
                    ? error.message
                    : `could not measure the file: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }

          // Recalculated either way. Even without a full decode this is the
          // half that proves the CSV is describing the file that is actually
          // there — and the declared value is never trusted in its place.
          const checksum = measurements?.checksumSha256 ?? (await sha256OfFile(resolved.path));
          fileChecksum = checksum;

          const declaredChecksum = acquisition.get('sha256').toLowerCase();
          if (declaredChecksum.length === 64) {
            if (declaredChecksum === checksum) {
              checksumVerified += 1;
            } else {
              checksumMismatched += 1;
              problems.push({
                kind: 'CHECKSUM_MISMATCH',
                candidateId,
                detail: `${PACK_FILES.acquisitionLog} records ${declaredChecksum.slice(0, 16)}… but the file hashes to ${checksum.slice(0, 16)}…. The recalculated value is what travels onward; either the file changed after it was logged, or the log was edited.`,
              });
            }
          }

          const existingOwner = checksumToCandidate.get(checksum);
          if (existingOwner && existingOwner !== candidateId) {
            duplicates += 1;
            problems.push({
              kind: 'DUPLICATE_CONTENT',
              candidateId,
              detail: `identical bytes to "${existingOwner}" — two catalogue entries for one file`,
            });
          } else {
            checksumToCandidate.set(checksum, candidateId);
          }

          const licenceEvidenceDeclared = acquisition.get('licence_evidence_file');
          if (licenceEvidenceDeclared) {
            const evidence = await resolveInsidePack(canonicalRoot, licenceEvidenceDeclared);
            if (!evidence.problem && evidence.path) {
              const evidenceStat = await stat(evidence.path).catch(() => null);
              licenceEvidencePath = evidenceStat?.isFile() ? evidence.path : null;
            }
          }
        }
      }
    }

    const qualityDecision = measurements
      ? evaluateSourceQuality({ measurements, mediaKind, rightsDecision })
      : undefined;

    const widthPx = measurements?.widthPx ?? numberOrNull(row.get('width'));
    const heightPx = measurements?.heightPx ?? numberOrNull(row.get('height'));

    candidates.push({
      candidateId,
      provider: providerOf(row),
      providerAssetId: row.get('provider_asset_id') || candidateId,
      mediaKind,
      title: (row.get('title') || candidateId).slice(0, 300),
      description: '',
      landingPageUrl,
      renditions: [],
      durationSeconds: measurements?.durationSeconds ?? numberOrNull(row.get('duration_seconds')),
      widthPx,
      heightPx,
      frameRate: measurements?.frameRate ?? null,
      orientation: orientationOf(widthPx ?? undefined, heightPx ?? undefined),
      fileSizeBytes: measurements?.fileSizeBytes ?? numberOrNull(row.get('file_size_bytes')),
      rights,
      retrievedAt: options.now.toISOString(),
      // Never higher. An imported candidate has been catalogued, and cataloguing
      // is not approval — `RIGHTS_REVIEW_REQUIRED` is the ceiling for anything
      // that arrives this way, and only a named human moves it on.
      state: rightsDecision.outcome === 'REJECTED' ? 'METADATA_VERIFIED' : 'RIGHTS_REVIEW_REQUIRED',
      rightsDecision,
      ...(qualityDecision ? { qualityDecision } : {}),
      ...(measurements ? { measurements } : {}),
      ...(row.get('suggested_asset_slot')
        ? { suggestedRole: row.get('suggested_asset_slot').slice(0, 120) }
        : {}),
      notes: (row.get('notes') || '').slice(0, 2000),
    });

    if (absolutePath) {
      privateLocations.push({
        candidateId,
        absolutePath,
        checksumSha256: fileChecksum,
        licenceEvidencePath,
      });
    }

    options.onProgress?.(`${candidateId}: ${rightsDecision.outcome}`);
  }

  return {
    packPath: options.packPath,
    canonicalPackPath: canonicalRoot,
    candidates,
    privateLocations,
    problems,
    counts: {
      candidateRows: candidateTable.rows.length,
      acquisitionRows: acquisitionTable?.rows.length ?? 0,
      mediaFound,
      mediaMissing,
      checksumVerified,
      checksumMismatched,
      duplicates,
      analysisOnlyRefused,
      licenceEvidenceFiles,
    },
  };

  async function countLicenceEvidence(root: string): Promise<number> {
    const resolved = await resolveInsidePack(root, LICENCE_EVIDENCE_DIRECTORY);
    if (resolved.problem || !resolved.path) return 0;
    try {
      const entries = await readdir(resolved.path, { withFileTypes: true });
      // Counted, never copied. Licence evidence is the operator's own record
      // and stays exactly where it is.
      return entries.filter((entry) => entry.isFile()).length;
    } catch {
      return 0;
    }
  }
}

/**
 * The last check before a pack-derived candidate enters a production selection.
 *
 * Independent of the import, and deliberately so: the import refuses
 * analysis-only material by location, and this refuses it again by rights
 * classification at the point of use. Two checks in two places, because the
 * consequence of missing it is publishing somebody else's advertisement.
 */
export function assertNoAnalysisOnlyInSelection(
  candidates: readonly {
    readonly candidateId: string;
    readonly rights: MediaRightsFacts;
    readonly notes?: string;
  }[],
): void {
  const offenders = candidates.filter(
    (candidate) =>
      candidate.rights.commercialUse === 'PROHIBITED' ||
      candidate.rights.derivativeUse === 'PROHIBITED' ||
      /analysis[_ -]?only/i.test(candidate.notes ?? '') ||
      /analysis[_ -]?only/i.test(candidate.rights.declaredLicence),
  );
  if (offenders.length === 0) return;
  throw new PilotPackImportError(
    offenders.map((candidate) => ({
      kind: 'ANALYSIS_ONLY_IN_PRODUCTION' as const,
      candidateId: candidate.candidateId,
      detail:
        'this candidate is analysis-only or its licence prohibits commercial or derivative use; it may be studied and may never enter a production selection',
    })),
    '<selection>',
  );
}
