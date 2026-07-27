import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import { NodeCommandRunner, resolveFfmpegBinaries, type CommandRunner } from '@combat/media';
import {
  AcquiredProductionAssetSchema,
  createMediaAcquisitionProviders,
  evaluateMediaRights,
  MediaHttpError,
  MediaSearchRequestSchema,
  MEDIA_ACQUISITION_NOTICE,
  MEDIA_ADAPTER_DESCRIPTORS,
  refusedSourceReason,
  type AcquiredProductionAsset,
  type MediaAcquisitionProviderId,
  type MediaAcquisitionRun,
  type MediaCandidate,
  type MediaKind,
  type MediaSearchRequest,
} from '@combat/providers';

import { findRepositoryRoot } from '../generate-cli';
import { parseProductionAssetManifest } from '../production-assets';
import { acquireApprovedAssets } from './acquire';
import {
  applyApprovals,
  buildApprovalTemplate,
  MediaApprovalError,
  parseApprovalSubmission,
} from './approval';
import {
  buildProductionAssetManifest,
  ManifestBuildError,
  type AssetBinding,
} from './build-manifest';
import { renderGallery } from './gallery';
import { importPilotPack, PilotPackImportError } from './pilot-pack';
import {
  ACQUIRED_ASSETS_FILENAME,
  buildAcquisitionProvenance,
  buildCredits,
  buildCreditsMarkdown,
  buildRightsReport,
  buildSourceQualityReport,
  REPORT_FILENAMES,
} from './reports';
import {
  APPROVAL_TEMPLATE_FILENAME,
  APPROVED_SELECTION_FILENAME,
  GALLERY_FILENAME,
  deriveRunId,
  listRuns,
  MediaRunError,
  readPrivateProvenance,
  readRun,
  runDirectory,
  writeRun,
  writeRunArtefact,
} from './run-store';
import { evaluateSourceQuality, measureSourceMedia, rankBySourceQuality } from './source-quality';

/**
 * `pnpm aamp:media` — seven commands over one acquisition run.
 *
 * They are deliberately separate rather than one pipeline, because the thing
 * between `inspect` and `approve` is **a person reading a licence**, and a
 * single command that ran end to end would have to either stop and wait or
 * skip that. Stopping in the middle of a pipeline is how "just press enter"
 * becomes the approval step.
 *
 * Nothing here constructs a reasoning provider, a generation provider or a
 * database client. There is no paid call on this path and no code that could
 * make one — `paidProviderCalls: 0` is written into every run record as a fact
 * about the object graph, not an aspiration.
 */

export const MEDIA_EXIT_CODES = {
  SUCCESS: 0,
  INVALID_ARGUMENTS: 2,
  PROVIDER_FAILURE: 3,
  PACK_IMPORT_FAILURE: 4,
  APPROVAL_REFUSED: 5,
  ACQUISITION_FAILURE: 6,
  MANIFEST_FAILURE: 7,
  RUN_NOT_FOUND: 8,
} as const;

const USAGE = [
  'Usage:',
  '  aamp:media search --query <text> --kind video|image|audio [--orientation portrait|landscape|square]',
  '                    [--providers pexels,pixabay,dvids,wikimedia,openverse] [--min-width N] [--per-page N] [--page N]',
  '  aamp:media import-pack --path <folder> [--measure]',
  '  aamp:media inspect --run <run-id> [--candidate <id>]',
  '  aamp:media gallery --run <run-id>',
  '  aamp:media approve --run <run-id> --selection <approval-file>',
  '  aamp:media acquire --run <run-id> --selection <approval-file> [--output-dir <dir>] [--accept-below-profile]',
  '  aamp:media build-manifest --run <run-id> --output <path> [--base-manifest <path>] [--usage organic-social|paid-social|internal-evaluation]',
  '  aamp:media providers',
  '',
  'Nothing is approved by any of these commands except `approve`, and that one only',
  'reads an approval a person wrote. There is no flag that fabricates or bypasses one.',
  '',
  'Exit codes: 0 success, 2 invalid arguments, 3 provider failure, 4 pack import failure,',
  '5 approval refused, 6 acquisition failure, 7 manifest failure, 8 run not found.',
].join('\n');

export interface MediaCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
  /** Test seam: adapters pointed at a fixture server. Never set from the environment. */
  readonly providerOverrides?: Parameters<typeof acquireApprovedAssets>[0]['providers'];
}

interface ParsedArgs {
  readonly flags: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const valueless = new Set(['--json', '--help', '-h', '--measure', '--accept-below-profile']);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--') && token !== '-h') continue;
    if (valueless.has(token)) {
      booleans.add(token);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(token, next);
      index += 1;
    } else {
      booleans.add(token);
    }
  }
  return { flags, booleans };
}

const PROVIDER_ALIASES: Readonly<Record<string, MediaAcquisitionProviderId>> = {
  pexels: 'PEXELS',
  pixabay: 'PIXABAY',
  dvids: 'DVIDS',
  wikimedia: 'WIKIMEDIA_COMMONS',
  'wikimedia-commons': 'WIKIMEDIA_COMMONS',
  commons: 'WIKIMEDIA_COMMONS',
  openverse: 'OPENVERSE',
};

/**
 * Resolves `--providers`, refusing the sources this system will not integrate
 * with by name and with the reason.
 *
 * An operator who types `--providers youtube` deserves the explanation, not an
 * "unknown provider" that reads like a typo.
 */
export function resolveProviderList(raw: string | undefined): {
  readonly providers: readonly MediaAcquisitionProviderId[];
  readonly refusals: readonly string[];
} {
  if (!raw) {
    return { providers: MEDIA_ADAPTER_DESCRIPTORS.map((entry) => entry.provider), refusals: [] };
  }
  const providers: MediaAcquisitionProviderId[] = [];
  const refusals: string[] = [];
  for (const token of raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)) {
    const known = PROVIDER_ALIASES[token];
    if (known) {
      if (!providers.includes(known)) providers.push(known);
      continue;
    }
    const refusal = refusedSourceReason(token);
    refusals.push(
      refusal
        ? `"${token}" is not integrated and will not be: ${refusal}`
        : `"${token}" is not a known provider. Available: ${Object.keys(PROVIDER_ALIASES).join(', ')}.`,
    );
  }
  return { providers, refusals };
}

function resolveFrom(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runMediaCli(
  argv: readonly string[],
  context: MediaCliContext,
): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === '--help' || command === '-h') {
    context.stderr(`${USAGE}\n`);
    return command ? MEDIA_EXIT_CODES.SUCCESS : MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }

  switch (command) {
    case 'search':
      return runSearch(rest, context);
    case 'import-pack':
      return runImportPack(rest, context);
    case 'inspect':
      return runInspect(rest, context);
    case 'gallery':
      return runGallery(rest, context);
    case 'approve':
      return runApprove(rest, context);
    case 'acquire':
      return runAcquire(rest, context);
    case 'build-manifest':
      return runBuildManifest(rest, context);
    case 'providers':
      return runProviders(context);
    default:
      context.stderr(`Unknown command "${command}".\n\n${USAGE}\n`);
      return MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }
}

function runProviders(context: MediaCliContext): number {
  const lines = MEDIA_ADAPTER_DESCRIPTORS.map((descriptor) =>
    [
      `${descriptor.provider}`,
      `  kinds:        ${descriptor.supportedKinds.join(', ')}`,
      `  key:          ${descriptor.apiKeyEnvVar ?? 'none required'}${
        descriptor.apiKeyEnvVar
          ? context.env[descriptor.apiKeyEnvVar]?.trim()
            ? ' (set)'
            : ' (NOT SET)'
          : ''
      }`,
      `  api hosts:    ${descriptor.apiHosts.join(', ')}`,
      `  download:     ${descriptor.downloadHosts.join(', ')}`,
      `  contract:     ${descriptor.responseContractStatus}`,
      `  licence:      ${descriptor.licenceTermsUrl}`,
    ].join('\n'),
  );
  context.stdout(`${lines.join('\n\n')}\n`);
  return MEDIA_EXIT_CODES.SUCCESS;
}

async function runSearch(argv: readonly string[], context: MediaCliContext): Promise<number> {
  const { flags, booleans } = parseArgs(argv);
  const json = booleans.has('--json');
  const query = flags.get('--query');
  const kindRaw = (flags.get('--kind') ?? 'video').toUpperCase();

  if (!query || !['VIDEO', 'IMAGE', 'AUDIO'].includes(kindRaw)) {
    context.stderr(`${USAGE}\n`);
    return MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const { providers, refusals } = resolveProviderList(flags.get('--providers'));
  for (const refusal of refusals) context.stderr(`  refused: ${refusal}\n`);
  if (providers.length === 0) {
    context.stderr('No usable providers were named.\n');
    return MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }

  let request: MediaSearchRequest;
  try {
    request = MediaSearchRequestSchema.parse({
      query,
      kind: kindRaw as MediaKind,
      ...(flags.get('--orientation')
        ? { orientation: flags.get('--orientation')?.toUpperCase() }
        : {}),
      ...(flags.get('--min-width') ? { minWidthPx: Number(flags.get('--min-width')) } : {}),
      ...(flags.get('--min-height') ? { minHeightPx: Number(flags.get('--min-height')) } : {}),
      ...(flags.get('--min-duration')
        ? { minDurationSeconds: Number(flags.get('--min-duration')) }
        : {}),
      ...(flags.get('--max-duration')
        ? { maxDurationSeconds: Number(flags.get('--max-duration')) }
        : {}),
      page: Number(flags.get('--page') ?? 1),
      perPage: Number(flags.get('--per-page') ?? 20),
    });
  } catch (error) {
    context.stderr(`The search request is invalid: ${describe(error)}\n`);
    return MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const now = context.now ? context.now() : new Date();
  const adapters =
    context.providerOverrides ??
    createMediaAcquisitionProviders(providers, {
      PEXELS_API_KEY: context.env.PEXELS_API_KEY,
      PIXABAY_API_KEY: context.env.PIXABAY_API_KEY,
      DVIDS_API_KEY: context.env.DVIDS_API_KEY,
      ...(context.env.MEDIA_ACQUISITION_TIMEOUT_MS
        ? { MEDIA_ACQUISITION_TIMEOUT_MS: Number(context.env.MEDIA_ACQUISITION_TIMEOUT_MS) }
        : {}),
      ...(context.env.MEDIA_ACQUISITION_USER_AGENT
        ? { MEDIA_ACQUISITION_USER_AGENT: context.env.MEDIA_ACQUISITION_USER_AGENT }
        : {}),
    });

  const candidates: MediaCandidate[] = [];
  const problems: MediaAcquisitionRun['providerProblems'] = [];

  for (const providerId of providers) {
    const adapter = adapters.get(providerId);
    if (!adapter) continue;
    try {
      const page = await adapter.search(request, {
        ...(context.signal ? { signal: context.signal } : {}),
      });
      for (const candidate of page.candidates) {
        // Rights are decided here, once, over every provider — not inside the
        // adapters, which would be five policies wearing one name.
        const rightsDecision = evaluateMediaRights({
          facts: candidate.rights,
          landingPageUrl: candidate.landingPageUrl,
          isGovernmentPublicAffairs: candidate.provider === 'DVIDS',
        });
        candidates.push({
          ...candidate,
          state:
            rightsDecision.outcome === 'REJECTED' ? 'METADATA_VERIFIED' : 'RIGHTS_REVIEW_REQUIRED',
          rightsDecision,
        });
      }
      if (!json) context.stderr(`  ${providerId}: ${page.candidates.length} candidates\n`);
    } catch (error) {
      const kind = error instanceof MediaHttpError ? error.kind : 'UNKNOWN';
      problems.push({ provider: providerId, kind, detail: describe(error).slice(0, 600) });
      if (!json) context.stderr(`  ${providerId}: ${kind} — ${describe(error)}\n`);
    }
  }

  const runId = deriveRunId({
    origin: 'PROVIDER_SEARCH',
    discriminator: `${request.query}|${request.kind}|${request.orientation ?? ''}|${providers.join(',')}|${request.page}`,
    now,
  });
  const run: MediaAcquisitionRun = {
    runVersion: 1,
    runId,
    workspaceId: context.env.AAMP_WORKSPACE_ID ?? 'combat-reviews',
    origin: 'PROVIDER_SEARCH',
    startedAt: now.toISOString(),
    request,
    providersQueried: [...providers],
    candidates: rankBySourceQuality(candidates),
    providerProblems: problems,
    paidProviderCalls: 0,
  };

  const written = await writeRun({ repositoryRoot, run });
  await writeRunArtefact(
    written.directory,
    GALLERY_FILENAME,
    renderGallery({ run, galleryDirectory: written.directory, now }),
  );
  await writeRunArtefact(
    written.directory,
    APPROVAL_TEMPLATE_FILENAME,
    buildApprovalTemplate(run, now),
  );

  if (json) {
    context.stdout(
      `${JSON.stringify({ runId, directory: written.directory, candidates: run.candidates.length, providerProblems: problems, paidProviderCalls: 0 }, null, 2)}\n`,
    );
  } else {
    context.stdout(
      `${[
        `run id:             ${runId}`,
        `candidates:         ${run.candidates.length}`,
        `policy-clear:       ${run.candidates.filter((c) => c.rightsDecision?.outcome === 'AUTOMATICALLY_ELIGIBLE').length}`,
        `need review:        ${run.candidates.filter((c) => c.rightsDecision?.outcome === 'REVIEW_REQUIRED').length}`,
        `refused:            ${run.candidates.filter((c) => c.rightsDecision?.outcome === 'REJECTED').length}`,
        `provider problems:  ${problems.map((p) => `${p.provider} (${p.kind})`).join(', ') || 'none'}`,
        `gallery:            ${resolve(written.directory, GALLERY_FILENAME)}`,
        `approval template:  ${resolve(written.directory, APPROVAL_TEMPLATE_FILENAME)}`,
        `paid calls:         0`,
        '',
        MEDIA_ACQUISITION_NOTICE,
      ].join('\n')}\n`,
    );
  }
  return problems.length > 0 && candidates.length === 0
    ? MEDIA_EXIT_CODES.PROVIDER_FAILURE
    : MEDIA_EXIT_CODES.SUCCESS;
}

async function runImportPack(argv: readonly string[], context: MediaCliContext): Promise<number> {
  const { flags, booleans } = parseArgs(argv);
  const json = booleans.has('--json');
  const packPath = flags.get('--path');
  if (!packPath) {
    context.stderr(`${USAGE}\n`);
    return MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const now = context.now ? context.now() : new Date();
  const runner = context.runner ?? new NodeCommandRunner();
  const binaries = resolveFfmpegBinaries(context.env);

  if (!json) {
    context.stderr(
      `\nREAD-ONLY IMPORT: the pack is opened, hashed and measured. Nothing in it is written, renamed, moved or deleted.\nPAID PROVIDER CALLS DISABLED — no reasoning or generation provider is constructed.\n\n`,
    );
  }

  let imported;
  try {
    imported = await importPilotPack({
      packPath,
      runner,
      binaries,
      now,
      ...(context.signal ? { signal: context.signal } : {}),
      measureMedia: booleans.has('--measure'),
      ...(json ? {} : { onProgress: (message) => context.stderr(`  ${message}\n`) }),
    });
  } catch (error) {
    if (error instanceof PilotPackImportError) {
      context.stderr(`${error.message}\n`);
      return MEDIA_EXIT_CODES.PACK_IMPORT_FAILURE;
    }
    context.stderr(`The pack could not be imported: ${describe(error)}\n`);
    return MEDIA_EXIT_CODES.PACK_IMPORT_FAILURE;
  }

  const runId = deriveRunId({
    origin: 'EXTERNAL_PACK_IMPORT',
    discriminator: imported.canonicalPackPath,
    now,
  });
  const run: MediaAcquisitionRun = {
    runVersion: 1,
    runId,
    workspaceId: context.env.AAMP_WORKSPACE_ID ?? 'combat-reviews',
    origin: 'EXTERNAL_PACK_IMPORT',
    startedAt: now.toISOString(),
    providersQueried: [],
    candidates: rankBySourceQuality(imported.candidates),
    providerProblems: [],
    paidProviderCalls: 0,
  };

  const written = await writeRun({
    repositoryRoot,
    run,
    privateLocations: imported.privateLocations,
    externalPackPath: imported.canonicalPackPath,
  });
  const localMedia = new Map(
    imported.privateLocations.map((entry) => [entry.candidateId, entry.absolutePath]),
  );
  await writeRunArtefact(
    written.directory,
    GALLERY_FILENAME,
    renderGallery({ run, galleryDirectory: written.directory, localMedia, now }),
  );
  await writeRunArtefact(
    written.directory,
    APPROVAL_TEMPLATE_FILENAME,
    buildApprovalTemplate(run, now),
  );

  if (json) {
    context.stdout(
      `${JSON.stringify({ runId, directory: written.directory, counts: imported.counts, problems: imported.problems, paidProviderCalls: 0 }, null, 2)}\n`,
    );
  } else {
    context.stdout(
      `${[
        `run id:               ${runId}`,
        `candidate rows:       ${imported.counts.candidateRows}`,
        `acquisition rows:     ${imported.counts.acquisitionRows}`,
        `media found:          ${imported.counts.mediaFound}`,
        `media missing:        ${imported.counts.mediaMissing}`,
        `checksums verified:   ${imported.counts.checksumVerified}`,
        `checksums mismatched: ${imported.counts.checksumMismatched}`,
        `duplicate content:    ${imported.counts.duplicates}`,
        `analysis-only refused:${imported.counts.analysisOnlyRefused}`,
        `licence evidence:     ${imported.counts.licenceEvidenceFiles} files (counted, never copied)`,
        `problems:             ${imported.problems.length}`,
        `gallery:              ${resolve(written.directory, GALLERY_FILENAME)}`,
        `paid calls:           0`,
        '',
        'Every imported candidate is at RIGHTS_REVIEW_REQUIRED at best. Importing is cataloguing, not approval.',
      ].join('\n')}\n`,
    );
    for (const problem of imported.problems.slice(0, 40)) {
      context.stderr(
        `  - [${problem.kind}] ${problem.candidateId ?? '<pack>'}: ${problem.detail}\n`,
      );
    }
    if (imported.problems.length > 40) {
      context.stderr(`  ... and ${imported.problems.length - 40} more (see the run record)\n`);
    }
  }
  return MEDIA_EXIT_CODES.SUCCESS;
}

async function runInspect(argv: readonly string[], context: MediaCliContext): Promise<number> {
  const { flags, booleans } = parseArgs(argv);
  const json = booleans.has('--json');
  const runId = flags.get('--run');
  if (!runId) {
    context.stderr(
      `${USAGE}\nKnown runs: ${(await listRuns(await findRepositoryRoot(context.cwd))).join(', ') || 'none'}\n`,
    );
    return MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  let run: MediaAcquisitionRun;
  try {
    run = await readRun(repositoryRoot, runId);
  } catch (error) {
    context.stderr(`${error instanceof MediaRunError ? error.message : describe(error)}\n`);
    return MEDIA_EXIT_CODES.RUN_NOT_FOUND;
  }

  const runner = context.runner ?? new NodeCommandRunner();
  const binaries = resolveFfmpegBinaries(context.env);
  const provenance = await readPrivateProvenance(repositoryRoot, runId);
  const locations = new Map(
    provenance.locations.map((entry) => [entry.candidateId, entry.absolutePath]),
  );
  const only = flags.get('--candidate');

  const measured: MediaCandidate[] = [];
  for (const candidate of run.candidates) {
    if (only && candidate.candidateId !== only) {
      measured.push(candidate);
      continue;
    }
    const path = locations.get(candidate.candidateId);
    if (!path) {
      measured.push(candidate);
      continue;
    }
    try {
      const measurements = await measureSourceMedia({
        filePath: path,
        mediaKind: candidate.mediaKind,
        runner,
        binaries,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const qualityDecision = evaluateSourceQuality({
        measurements,
        mediaKind: candidate.mediaKind,
        ...(candidate.rightsDecision ? { rightsDecision: candidate.rightsDecision } : {}),
      });
      measured.push({
        ...candidate,
        measurements,
        qualityDecision,
        widthPx: measurements.widthPx,
        heightPx: measurements.heightPx,
        durationSeconds: measurements.durationSeconds,
        frameRate: measurements.frameRate,
        fileSizeBytes: measurements.fileSizeBytes,
      });
      if (!json)
        context.stderr(
          `  ${candidate.candidateId}: ${qualityDecision.outcome} (overall ${qualityDecision.scores.overallSourceScore})\n`,
        );
    } catch (error) {
      measured.push(candidate);
      context.stderr(`  ${candidate.candidateId}: could not be measured — ${describe(error)}\n`);
    }
  }

  const updated: MediaAcquisitionRun = { ...run, candidates: rankBySourceQuality(measured) };
  const written = await writeRun({
    repositoryRoot,
    run: updated,
    privateLocations: provenance.locations,
    ...(provenance.externalPackPath ? { externalPackPath: provenance.externalPackPath } : {}),
  });
  const now = context.now ? context.now() : new Date();
  await writeRunArtefact(
    written.directory,
    GALLERY_FILENAME,
    renderGallery({
      run: updated,
      galleryDirectory: written.directory,
      localMedia: locations,
      now,
    }),
  );

  const summary = {
    runId,
    measured: measured.filter((c) => c.measurements).length,
    meetsProfile: measured.filter((c) => c.qualityDecision?.outcome === 'MEETS_PROFILE').length,
    reviewRequired: measured.filter((c) => c.qualityDecision?.outcome === 'REVIEW_REQUIRED').length,
    belowProfile: measured.filter((c) => c.qualityDecision?.outcome === 'BELOW_PROFILE').length,
    notMeasured: measured.filter((c) => !c.qualityDecision).length,
  };

  if (json) {
    context.stdout(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    context.stdout(
      `${[
        `run id:           ${runId}`,
        `measured:         ${summary.measured}`,
        `meets profile:    ${summary.meetsProfile}`,
        `review required:  ${summary.reviewRequired}`,
        `below profile:    ${summary.belowProfile}`,
        `not measured:     ${summary.notMeasured} (no local file — search candidates are metadata only until acquired)`,
        `gallery:          ${resolve(written.directory, GALLERY_FILENAME)}`,
      ].join('\n')}\n`,
    );
  }
  return MEDIA_EXIT_CODES.SUCCESS;
}

async function runGallery(argv: readonly string[], context: MediaCliContext): Promise<number> {
  const { flags } = parseArgs(argv);
  const runId = flags.get('--run');
  if (!runId) {
    context.stderr(`${USAGE}\n`);
    return MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }
  const repositoryRoot = await findRepositoryRoot(context.cwd);
  let run: MediaAcquisitionRun;
  try {
    run = await readRun(repositoryRoot, runId);
  } catch (error) {
    context.stderr(`${describe(error)}\n`);
    return MEDIA_EXIT_CODES.RUN_NOT_FOUND;
  }
  const provenance = await readPrivateProvenance(repositoryRoot, runId);
  const directory = runDirectory(repositoryRoot, runId);
  const path = await writeRunArtefact(
    directory,
    GALLERY_FILENAME,
    renderGallery({
      run,
      galleryDirectory: directory,
      localMedia: new Map(
        provenance.locations.map((entry) => [entry.candidateId, entry.absolutePath]),
      ),
      now: context.now ? context.now() : new Date(),
    }),
  );
  context.stdout(`${path}\n`);
  return MEDIA_EXIT_CODES.SUCCESS;
}

async function runApprove(argv: readonly string[], context: MediaCliContext): Promise<number> {
  const { flags, booleans } = parseArgs(argv);
  const json = booleans.has('--json');
  const runId = flags.get('--run');
  const selectionPath = flags.get('--selection');
  if (!runId || !selectionPath) {
    context.stderr(`${USAGE}\n`);
    return MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const now = context.now ? context.now() : new Date();
  let run: MediaAcquisitionRun;
  try {
    run = await readRun(repositoryRoot, runId);
  } catch (error) {
    context.stderr(`${describe(error)}\n`);
    return MEDIA_EXIT_CODES.RUN_NOT_FOUND;
  }

  let applied;
  try {
    const submission = parseApprovalSubmission(
      await readJson(resolveFrom(repositoryRoot, selectionPath)),
      selectionPath,
    );
    applied = applyApprovals({
      run,
      submission,
      now,
      maxDownloadBytes: Number(
        context.env.MEDIA_ACQUISITION_MAX_DOWNLOAD_BYTES ?? 512 * 1024 * 1024,
      ),
    });
  } catch (error) {
    context.stderr(
      `${error instanceof MediaApprovalError ? error.message : `The approval file could not be read: ${describe(error)}`}\n`,
    );
    return MEDIA_EXIT_CODES.APPROVAL_REFUSED;
  }

  const provenance = await readPrivateProvenance(repositoryRoot, runId);
  const written = await writeRun({
    repositoryRoot,
    run: applied.run,
    privateLocations: provenance.locations,
    ...(provenance.externalPackPath ? { externalPackPath: provenance.externalPackPath } : {}),
  });
  await writeRunArtefact(written.directory, APPROVED_SELECTION_FILENAME, {
    approvedSelectionVersion: 1,
    runId,
    recordedAt: now.toISOString(),
    notice:
      'Each entry records a decision a named person made. Nothing in this repository produces, suggests or defaults an approval.',
    selections: applied.approved.map((entry) => entry.selection),
  });

  if (json) {
    context.stdout(
      `${JSON.stringify({ runId, approved: applied.approved.map((e) => e.candidateId), refused: applied.refused }, null, 2)}\n`,
    );
  } else {
    context.stdout(
      `${[
        `run id:             ${runId}`,
        `approved:           ${applied.approved.length}`,
        `internal-only:      ${
          applied.approved
            .filter((e) => e.internalEvaluationOnly)
            .map((e) => e.candidateId)
            .join(', ') || 'none'
        }`,
        `refused:            ${applied.refused.length}`,
      ].join('\n')}\n`,
    );
    for (const refusal of applied.refused) {
      context.stderr(
        `  - ${refusal.candidateId}:\n${refusal.reasons.map((reason) => `      ${reason}`).join('\n')}\n`,
      );
    }
  }
  return applied.approved.length === 0
    ? MEDIA_EXIT_CODES.APPROVAL_REFUSED
    : MEDIA_EXIT_CODES.SUCCESS;
}

async function runAcquire(argv: readonly string[], context: MediaCliContext): Promise<number> {
  const { flags, booleans } = parseArgs(argv);
  const json = booleans.has('--json');
  const runId = flags.get('--run');
  const selectionPath = flags.get('--selection');
  if (!runId || !selectionPath) {
    context.stderr(`${USAGE}\n`);
    return MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const now = context.now ? context.now() : new Date();
  let run: MediaAcquisitionRun;
  try {
    run = await readRun(repositoryRoot, runId);
  } catch (error) {
    context.stderr(`${describe(error)}\n`);
    return MEDIA_EXIT_CODES.RUN_NOT_FOUND;
  }

  let applied;
  try {
    const submission = parseApprovalSubmission(
      await readJson(resolveFrom(repositoryRoot, selectionPath)),
      selectionPath,
    );
    // Re-applied rather than read from the run record. The gate has to run
    // against the approval file the operator is invoking *now*, so a run that
    // was approved and then edited cannot acquire on the strength of a stale
    // state field.
    applied = applyApprovals({
      run: {
        ...run,
        candidates: run.candidates.map((c) =>
          c.state === 'APPROVED_FOR_DOWNLOAD'
            ? { ...c, state: 'RIGHTS_REVIEW_REQUIRED' as const }
            : c,
        ),
      },
      submission,
      now,
      maxDownloadBytes: Number(
        context.env.MEDIA_ACQUISITION_MAX_DOWNLOAD_BYTES ?? 512 * 1024 * 1024,
      ),
    });
  } catch (error) {
    context.stderr(`${error instanceof MediaApprovalError ? error.message : describe(error)}\n`);
    return MEDIA_EXIT_CODES.APPROVAL_REFUSED;
  }

  if (applied.approved.length === 0) {
    context.stderr('Nothing is approved, so nothing was acquired.\n');
    for (const refusal of applied.refused) {
      context.stderr(`  - ${refusal.candidateId}: ${refusal.reasons.join('; ')}\n`);
    }
    return MEDIA_EXIT_CODES.APPROVAL_REFUSED;
  }

  const outputDirectory = resolveFrom(
    repositoryRoot,
    flags.get('--output-dir') ??
      context.env.MEDIA_ACQUISITION_OUTPUT_DIR ??
      '.aamp-output/acquired-assets',
  );
  const provenance = await readPrivateProvenance(repositoryRoot, runId);
  const adapters =
    context.providerOverrides ??
    createMediaAcquisitionProviders(
      [...new Set(applied.approved.map((entry) => entry.selection.provider))],
      {
        PEXELS_API_KEY: context.env.PEXELS_API_KEY,
        PIXABAY_API_KEY: context.env.PIXABAY_API_KEY,
        DVIDS_API_KEY: context.env.DVIDS_API_KEY,
        ...(context.env.MEDIA_ACQUISITION_MAX_DOWNLOAD_BYTES
          ? {
              MEDIA_ACQUISITION_MAX_DOWNLOAD_BYTES: Number(
                context.env.MEDIA_ACQUISITION_MAX_DOWNLOAD_BYTES,
              ),
            }
          : {}),
      },
    );

  const result = await acquireApprovedAssets({
    run: applied.run,
    approved: applied.approved,
    providers: adapters,
    privateLocations: provenance.locations,
    outputDirectory,
    runner: context.runner ?? new NodeCommandRunner(),
    binaries: resolveFfmpegBinaries(context.env),
    now,
    ...(context.signal ? { signal: context.signal } : {}),
    acceptBelowProfile: booleans.has('--accept-below-profile'),
    ...(json ? {} : { onProgress: (message) => context.stderr(`  ${message}\n`) }),
  });

  const written = await writeRun({
    repositoryRoot,
    run: result.run,
    privateLocations: provenance.locations,
    ...(provenance.externalPackPath ? { externalPackPath: provenance.externalPackPath } : {}),
  });

  const reportInput = { run: result.run, assets: result.assets, now };
  await writeRunArtefact(outputDirectory, ACQUIRED_ASSETS_FILENAME, {
    acquiredAssetsVersion: 1,
    runId,
    generatedAt: now.toISOString(),
    notice: MEDIA_ACQUISITION_NOTICE,
    assets: result.assets,
  });
  await writeRunArtefact(outputDirectory, REPORT_FILENAMES.credits, buildCredits(reportInput));
  await writeRunArtefact(
    outputDirectory,
    REPORT_FILENAMES.creditsMarkdown,
    buildCreditsMarkdown(reportInput),
  );
  await writeRunArtefact(outputDirectory, REPORT_FILENAMES.rights, buildRightsReport(reportInput));
  await writeRunArtefact(
    outputDirectory,
    REPORT_FILENAMES.provenance,
    buildAcquisitionProvenance(reportInput),
  );
  await writeRunArtefact(
    outputDirectory,
    REPORT_FILENAMES.sourceQuality,
    buildSourceQualityReport(reportInput),
  );

  if (json) {
    context.stdout(
      `${JSON.stringify(
        {
          runId,
          outputDirectory,
          acquired: result.assets.map((asset) => ({
            assetId: asset.assetId,
            checksumSha256: asset.checksumSha256,
            outcome: asset.qualityDecision.outcome,
          })),
          failures: result.failures,
          internalEvaluationOnly: result.internalEvaluationOnly,
          paidProviderCalls: 0,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    context.stdout(
      `${[
        `run id:             ${runId}`,
        `acquired:           ${result.assets.length}`,
        `failed:             ${result.failures.length}`,
        `internal-only:      ${result.internalEvaluationOnly.join(', ') || 'none'}`,
        `output directory:   ${outputDirectory}`,
        `reports:            ${Object.values(REPORT_FILENAMES).join(', ')}`,
        `run record:         ${written.runPath}`,
        `paid calls:         0`,
      ].join('\n')}\n`,
    );
    for (const failure of result.failures) {
      context.stderr(`  - ${failure.candidateId} [${failure.kind}]: ${failure.detail}\n`);
    }
  }
  return result.assets.length === 0
    ? MEDIA_EXIT_CODES.ACQUISITION_FAILURE
    : MEDIA_EXIT_CODES.SUCCESS;
}

async function runBuildManifest(
  argv: readonly string[],
  context: MediaCliContext,
): Promise<number> {
  const { flags, booleans } = parseArgs(argv);
  const json = booleans.has('--json');
  const runId = flags.get('--run');
  const outputPath = flags.get('--output');
  if (!runId || !outputPath) {
    context.stderr(`${USAGE}\n`);
    return MEDIA_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const now = context.now ? context.now() : new Date();
  let run: MediaAcquisitionRun;
  try {
    run = await readRun(repositoryRoot, runId);
  } catch (error) {
    context.stderr(`${describe(error)}\n`);
    return MEDIA_EXIT_CODES.RUN_NOT_FOUND;
  }

  const assetDirectory = resolveFrom(
    repositoryRoot,
    flags.get('--asset-dir') ??
      context.env.MEDIA_ACQUISITION_OUTPUT_DIR ??
      '.aamp-output/acquired-assets',
  );
  let assets: readonly AcquiredProductionAsset[];
  try {
    const document = (await readJson(resolve(assetDirectory, ACQUIRED_ASSETS_FILENAME))) as {
      assets?: unknown[];
    };
    // Re-parsed through the schema rather than cast. This file is read back
    // between two separate command invocations, so it is input by the time it
    // gets here — and a hand-edited entry must fail by name, not three frames
    // into the manifest builder.
    assets = z.array(AcquiredProductionAssetSchema).parse(document.assets ?? []);
  } catch (error) {
    context.stderr(
      `No usable ${ACQUIRED_ASSETS_FILENAME} in ${assetDirectory}. Run \`aamp:media acquire\` first (${describe(error)}).\n`,
    );
    return MEDIA_EXIT_CODES.MANIFEST_FAILURE;
  }
  if (assets.length === 0) {
    context.stderr(`${ACQUIRED_ASSETS_FILENAME} in ${assetDirectory} lists no asset.\n`);
    return MEDIA_EXIT_CODES.MANIFEST_FAILURE;
  }

  const usageFlag = (flags.get('--usage') ?? 'organic-social').toLowerCase();
  const usage =
    usageFlag === 'paid-social'
      ? ('PAID_SOCIAL' as const)
      : usageFlag === 'internal-evaluation'
        ? ('INTERNAL_EVALUATION' as const)
        : ('ORGANIC_SOCIAL' as const);

  let baseManifest;
  let baseManifestDirectory: string | undefined;
  const basePath = flags.get('--base-manifest');
  if (basePath) {
    const resolved = resolveFrom(repositoryRoot, basePath);
    try {
      baseManifest = parseProductionAssetManifest(await readJson(resolved), resolved);
      baseManifestDirectory = dirname(resolved);
    } catch (error) {
      context.stderr(`The base manifest could not be read: ${describe(error)}\n`);
      return MEDIA_EXIT_CODES.MANIFEST_FAILURE;
    }
  }

  let bindings: AssetBinding[] = [];
  const bindingsPath = flags.get('--bindings');
  if (bindingsPath) {
    try {
      bindings = (await readJson(resolveFrom(repositoryRoot, bindingsPath))) as AssetBinding[];
    } catch (error) {
      context.stderr(`The bindings file could not be read: ${describe(error)}\n`);
      return MEDIA_EXIT_CODES.MANIFEST_FAILURE;
    }
  }

  const target = resolveFrom(repositoryRoot, outputPath);
  let built;
  try {
    built = buildProductionAssetManifest({
      library: flags.get('--library') ?? 'Combat Reviews acquired library',
      assets,
      assetDirectory,
      outputManifestDirectory: dirname(target),
      bindings,
      usage,
      ...(baseManifest ? { baseManifest } : {}),
      ...(baseManifestDirectory ? { baseManifestDirectory } : {}),
      now,
    });
  } catch (error) {
    context.stderr(`${error instanceof ManifestBuildError ? error.message : describe(error)}\n`);
    return MEDIA_EXIT_CODES.MANIFEST_FAILURE;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(built.manifest, null, 2)}\n`, 'utf8');

  const reportInput = { run, assets, manifestPath: target, now };
  await writeRunArtefact(dirname(target), REPORT_FILENAMES.credits, buildCredits(reportInput));
  await writeRunArtefact(
    dirname(target),
    REPORT_FILENAMES.creditsMarkdown,
    buildCreditsMarkdown(reportInput),
  );

  if (json) {
    context.stdout(
      `${JSON.stringify({ output: target, added: built.added, replaced: built.replaced, preserved: built.preserved, refused: built.refused, isInternalEvaluationDemonstration: built.isInternalEvaluationDemonstration, acquiredAssets: assets.length }, null, 2)}\n`,
    );
  } else {
    context.stdout(
      `${[
        `manifest:           ${target}`,
        `usage:              ${usage}${built.isInternalEvaluationDemonstration ? ' — LABELLED DEMONSTRATION, never a published advertisement' : ''}`,
        `added:              ${built.added.join(', ') || 'none'}`,
        `replaced:           ${built.replaced.join(', ') || 'none'}`,
        `preserved:          ${built.preserved.length} assets from the base manifest`,
        `refused:            ${built.refused.length}`,
        '',
        'This manifest is accepted directly by the existing generation path — pass it to',
        '`pnpm aamp:generate --assets <path>`. No renderer, selector or QA step was duplicated.',
      ].join('\n')}\n`,
    );
    for (const refusal of built.refused) {
      context.stderr(`  - ${refusal.assetId}: ${refusal.reason}\n`);
    }
  }
  return MEDIA_EXIT_CODES.SUCCESS;
}
