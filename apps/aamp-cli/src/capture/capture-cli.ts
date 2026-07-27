import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { resolveFfmpegBinaries, type CommandRunner } from '@combat/media';

import { findRepositoryRoot } from '../generate-cli';
import { parseProductionAssetManifest } from '../production-assets';
import {
  AppCaptureRightsError,
  AppCaptureSpecificationError,
  CAPTURE_EXIT_CODES,
  parseCaptureSpecification,
  parseRightsDeclaration,
  screenIsEnabled,
  type AppCaptureSpecification,
  type CaptureFailureKind,
  type CapturedAppAsset,
} from './capture-contracts';
import {
  CAPTURED_ASSETS_FILENAME,
  CAPTURE_CONTACT_SHEET_FILENAME,
  CAPTURE_REPORT_FILENAME,
  CAPTURE_SESSION_FILENAME,
  REDACTION_REPORT_FILENAME,
  ingestCaptures,
  writeCaptureArtefacts,
} from './capture-ingestion';
import { mergeCapturedAssets, CaptureMergeError } from './manifest-merge';
import { CaptureAbortedError, runCapture, type BrowserLauncher } from './playwright-capture';
import { evaluateRightsDeclaration } from './rights-declaration';

/**
 * `pnpm aamp:capture-app`.
 *
 * Two commands share one binary because they are two halves of one operation:
 * the capture produces `captured-assets.json`, and the merge turns it into a
 * production asset manifest the existing preview already knows how to render.
 * Keeping them together means the merge cannot drift away from the shape the
 * capture writes.
 *
 * Nothing here constructs a reasoning provider, a generation provider or a
 * database client. There is no paid call on this path and no code that could
 * make one.
 */

export interface CaptureCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
  /** Injected by tests so a run can be driven against a fixture site. */
  readonly launcher?: BrowserLauncher;
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
}

interface CaptureOptions {
  readonly specPath?: string;
  readonly rightsPath?: string;
  readonly outputDirectory?: string;
  readonly json: boolean;
  readonly help: boolean;
}

interface MergeOptions {
  readonly capturedPath?: string;
  readonly manifestPath?: string;
  readonly outputPath?: string;
  readonly json: boolean;
  readonly help: boolean;
}

const USAGE = [
  'Usage:',
  '  aamp:capture-app --spec <capture-spec.json> --rights <rights-declaration.json> --output-dir <dir>',
  '  aamp:capture-app --spec <capture-spec.json> --output-dir <dir>          (inspection only)',
  '  aamp:capture-app merge --captured <captured-assets.json> --manifest <assets.json> --output <merged.json>',
  '',
  'Capture options:',
  '  --spec <path>        the capture specification (required)',
  '  --rights <path>      a human-authored rights declaration. Without it every captured',
  '                       screenshot is REVIEW_REQUIRED and cannot enter a render.',
  '  --output-dir <path>  where screenshots and reports are written (required)',
  '  --json               machine-readable output',
  '',
  'Merge options:',
  '  --captured <path>    captured-assets.json from a declared capture',
  '  --manifest <path>    the production asset manifest to update',
  '  --output <path>      where to write the merged manifest',
  '',
  'Exit codes: 0 success, 2 invalid specification, 3 disallowed host, 4 mutation attempted,',
  '5 navigation failure, 6 readiness failure, 7 redaction failure, 8 screenshot failure,',
  '9 rights failure, 10 ingestion failure.',
].join('\n');

function parseCaptureArgs(argv: readonly string[]): CaptureOptions {
  let specPath: string | undefined;
  let rightsPath: string | undefined;
  let outputDirectory: string | undefined;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--spec':
        specPath = argv[++i];
        break;
      case '--rights':
        rightsPath = argv[++i];
        break;
      case '--output-dir':
        outputDirectory = argv[++i];
        break;
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        break;
    }
  }
  return {
    ...(specPath ? { specPath } : {}),
    ...(rightsPath ? { rightsPath } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    json,
    help,
  };
}

function parseMergeArgs(argv: readonly string[]): MergeOptions {
  let capturedPath: string | undefined;
  let manifestPath: string | undefined;
  let outputPath: string | undefined;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--captured':
        capturedPath = argv[++i];
        break;
      case '--manifest':
        manifestPath = argv[++i];
        break;
      case '--output':
        outputPath = argv[++i];
        break;
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        break;
    }
  }
  return {
    ...(capturedPath ? { capturedPath } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    ...(outputPath ? { outputPath } : {}),
    json,
    help,
  };
}

function resolveFrom(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function runCaptureCli(
  argv: readonly string[],
  context: CaptureCliContext,
): Promise<number> {
  if (argv[0] === 'merge') return runMergeCommand(argv.slice(1), context);
  return runCaptureCommand(argv, context);
}

async function runCaptureCommand(
  argv: readonly string[],
  context: CaptureCliContext,
): Promise<number> {
  const options = parseCaptureArgs(argv);
  if (options.help || !options.specPath || !options.outputDirectory) {
    context.stderr(`${USAGE}\n`);
    return options.help ? CAPTURE_EXIT_CODES.SUCCESS : CAPTURE_EXIT_CODES.INVALID_SPECIFICATION;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const specPath = resolveFrom(repositoryRoot, options.specPath);
  const outputDirectory = resolveFrom(repositoryRoot, options.outputDirectory);

  let specification: AppCaptureSpecification;
  try {
    specification = parseCaptureSpecification(await readJson(specPath), specPath);
  } catch (error) {
    context.stderr(
      `${error instanceof AppCaptureSpecificationError ? error.message : `Could not read the capture specification: ${describe(error)}`}\n`,
    );
    return CAPTURE_EXIT_CODES.INVALID_SPECIFICATION;
  }

  const now = context.now ? context.now() : new Date();

  let rights;
  try {
    const declaration = options.rightsPath
      ? parseRightsDeclaration(
          await readJson(resolveFrom(repositoryRoot, options.rightsPath)),
          resolveFrom(repositoryRoot, options.rightsPath),
        )
      : undefined;
    rights = evaluateRightsDeclaration({
      ...(declaration ? { declaration } : {}),
      specification,
      host: new URL(specification.baseUrl).hostname,
      now,
    });
  } catch (error) {
    if (error instanceof AppCaptureRightsError) {
      context.stderr(`${error.message}\n`);
      return CAPTURE_EXIT_CODES.RIGHTS_FAILURE;
    }
    if (error instanceof AppCaptureSpecificationError) {
      context.stderr(`${error.message}\n`);
      return CAPTURE_EXIT_CODES.RIGHTS_FAILURE;
    }
    context.stderr(`Could not read the rights declaration: ${describe(error)}\n`);
    return CAPTURE_EXIT_CODES.RIGHTS_FAILURE;
  }

  const host = new URL(specification.baseUrl).hostname;
  const enabledScreens = specification.screens.filter((screen) => screenIsEnabled(screen));

  if (!options.json) {
    const banner = [
      '',
      ...(rights.mode === 'INSPECTION_ONLY'
        ? ['NOT OUTPUT ELIGIBLE', 'RIGHTS REVIEW REQUIRED', '']
        : ['RIGHTS DECLARED — OUTPUT ELIGIBLE SUBJECT TO PREFLIGHT', '']),
      'READ-ONLY CAPTURE: GET and HEAD only; every other method is aborted',
      'PAID PROVIDER CALLS DISABLED — no reasoning or generation provider is constructed',
      '',
      `specification:      ${specification.name} v${specification.specificationVersion}`,
      `host:               ${host}`,
      `rights mode:        ${rights.mode}`,
      `rights basis:       ${rights.basis ?? 'none — inspection only'}`,
      `declared by:        ${rights.declaredBy ?? 'nobody'}`,
      `licence expires:    ${rights.expiresAt ?? 'not stated'}`,
      `screens enabled:    ${enabledScreens.length} of ${specification.screens.length}`,
      `screens disabled:   ${
        specification.screens
          .filter((screen) => !screenIsEnabled(screen))
          .map((screen) => `${screen.assetId} (${screen.role})`)
          .join(', ') || 'none'
      }`,
      `output directory:   ${outputDirectory}`,
      '',
      rights.notice,
      '',
    ];
    context.stderr(`${banner.join('\n')}\n`);
  }

  await mkdir(outputDirectory, { recursive: true });
  const startedAt = now;
  const binaries = resolveFfmpegBinaries(context.env);

  let run;
  try {
    run = await runCapture({
      specification,
      ...(context.launcher ? { launcher: context.launcher } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
      onProgress: (text) => {
        if (!options.json) context.stderr(`  ${text}\n`);
      },
    });
  } catch (error) {
    if (error instanceof CaptureAbortedError) {
      context.stderr('The capture was cancelled; the browser was closed and nothing was kept.\n');
      return CAPTURE_EXIT_CODES.NAVIGATION_FAILURE;
    }
    context.stderr(`The browser could not be started: ${describe(error)}\n`);
    return CAPTURE_EXIT_CODES.NAVIGATION_FAILURE;
  }

  const ingestion = await ingestCaptures({
    specification,
    run,
    rights,
    outputDirectory,
    capturedAt: now,
    binaries,
    ...(context.runner ? { runner: context.runner } : {}),
  });

  const artefacts = await writeCaptureArtefacts({
    specification,
    run,
    rights,
    assets: ingestion.assets,
    problems: ingestion.problems,
    outputDirectory,
    startedAt,
    completedAt: context.now ? context.now() : new Date(),
    binaries,
    ...(context.runner ? { runner: context.runner } : {}),
  });

  const allFailures = [...run.failures, ...ingestion.problems];
  const exitCode = worstExitCode(allFailures.map((entry) => entry.kind));

  if (options.json) {
    context.stdout(
      `${JSON.stringify(
        {
          specification: specification.name,
          host,
          rightsMode: rights.mode,
          eligibility: rights.eligibility,
          paidProviderCalls: 0,
          outputDirectory,
          screensEnabled: run.screensEnabled,
          screensCaptured: ingestion.assets.length,
          screensSkippedDisabled: run.skippedDisabled,
          assets: ingestion.assets.map((asset) => ({
            assetId: asset.assetId,
            role: asset.role,
            relativePath: asset.relativePath,
            checksumSha256: asset.checksumSha256,
            widthPx: asset.widthPx,
            heightPx: asset.heightPx,
            eligibility: asset.eligibility,
            rightsClassification: asset.rightsClassification,
            redactedElementCount: asset.provenance.redactedElementCount,
          })),
          blockedRequests: run.blockedRequests,
          totalElementsRedacted: artefacts.session.totalElementsRedacted,
          failures: allFailures,
          artefacts: artefacts.artefacts,
          contactSheet: artefacts.contactSheetPath === null ? null : CAPTURE_CONTACT_SHEET_FILENAME,
          exitCode,
          notice: rights.notice,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (artefacts.contactSheetProblem) {
      context.stderr(`  WARNING: no contact sheet (${artefacts.contactSheetProblem})\n`);
    }
    context.stdout(
      `${[
        `rights mode:        ${rights.mode}`,
        `eligibility:        ${rights.eligibility}`,
        `paid calls:         0`,
        `screens captured:   ${ingestion.assets.length} of ${run.screensEnabled} enabled`,
        `screens disabled:   ${run.skippedDisabled.join(', ') || 'none'}`,
        `elements redacted:  ${artefacts.session.totalElementsRedacted}`,
        `requests blocked:   ${run.blockedRequests.reduce((total, entry) => total + entry.count, 0)} (${
          run.blockedRequests.map((entry) => `${entry.method} ${entry.path}`).join(', ') || 'none'
        })`,
        `artefacts:          ${[CAPTURE_SESSION_FILENAME, CAPTURE_REPORT_FILENAME, REDACTION_REPORT_FILENAME, CAPTURED_ASSETS_FILENAME].join(', ')}`,
        `contact sheet:      ${artefacts.contactSheetPath ?? 'not built'}`,
        `failures:           ${allFailures.length === 0 ? 'none' : allFailures.map((entry) => `${entry.assetId} [${entry.kind}]`).join(', ')}`,
        `status:             ${
          exitCode === CAPTURE_EXIT_CODES.SUCCESS
            ? rights.mode === 'DECLARED'
              ? 'CAPTURED — REQUIRES HUMAN APPROVAL'
              : 'CAPTURED — NOT OUTPUT ELIGIBLE, RIGHTS REVIEW REQUIRED'
            : 'FAILED'
        }`,
      ].join('\n')}\n`,
    );
    for (const entry of allFailures) {
      context.stderr(`  - ${entry.assetId} [${entry.kind}]: ${entry.detail}\n`);
    }
  }

  return exitCode;
}

/**
 * The exit code for a session with several failures.
 *
 * Rights and ingestion outrank the browser-side kinds because they are the
 * ones an operator can act on without re-running the capture.
 */
function worstExitCode(kinds: readonly CaptureFailureKind[]): number {
  if (kinds.length === 0) return CAPTURE_EXIT_CODES.SUCCESS;
  const priority: readonly CaptureFailureKind[] = [
    'RIGHTS_FAILURE',
    'MUTATION_ATTEMPTED',
    'DISALLOWED_HOST',
    'REDACTION_FAILURE',
    'INGESTION_FAILURE',
    'READINESS_FAILURE',
    'NAVIGATION_FAILURE',
    'SCREENSHOT_FAILURE',
    'INVALID_SPECIFICATION',
  ];
  for (const kind of priority) {
    if (kinds.includes(kind)) return CAPTURE_EXIT_CODES[kind];
  }
  return CAPTURE_EXIT_CODES.SCREENSHOT_FAILURE;
}

interface CapturedAssetsDocument {
  readonly assets: readonly CapturedAppAsset[];
}

async function runMergeCommand(
  argv: readonly string[],
  context: CaptureCliContext,
): Promise<number> {
  const options = parseMergeArgs(argv);
  if (options.help || !options.capturedPath || !options.manifestPath || !options.outputPath) {
    context.stderr(`${USAGE}\n`);
    return options.help ? CAPTURE_EXIT_CODES.SUCCESS : CAPTURE_EXIT_CODES.INVALID_SPECIFICATION;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const capturedPath = resolveFrom(repositoryRoot, options.capturedPath);
  const manifestPath = resolveFrom(repositoryRoot, options.manifestPath);
  const outputPath = resolveFrom(repositoryRoot, options.outputPath);

  let captured: CapturedAssetsDocument;
  let manifest;
  try {
    captured = (await readJson(capturedPath)) as CapturedAssetsDocument;
    manifest = parseProductionAssetManifest(await readJson(manifestPath), manifestPath);
  } catch (error) {
    context.stderr(`Could not read the inputs: ${describe(error)}\n`);
    return CAPTURE_EXIT_CODES.INVALID_SPECIFICATION;
  }

  let merged;
  try {
    merged = mergeCapturedAssets({
      manifest,
      manifestDirectory: dirname(manifestPath),
      captured: captured.assets ?? [],
      captureDirectory: dirname(capturedPath),
      outputManifestDirectory: dirname(outputPath),
    });
  } catch (error) {
    if (error instanceof CaptureMergeError) {
      context.stderr(`${error.message}\n`);
      return CAPTURE_EXIT_CODES.RIGHTS_FAILURE;
    }
    context.stderr(`The merge failed: ${describe(error)}\n`);
    return CAPTURE_EXIT_CODES.INGESTION_FAILURE;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(merged.manifest, null, 2)}\n`, 'utf8');

  if (options.json) {
    context.stdout(
      `${JSON.stringify({ outputPath, ...merged.report, paidProviderCalls: 0 }, null, 2)}\n`,
    );
  } else {
    context.stdout(
      `${[
        `merged manifest:    ${outputPath}`,
        `replaced:           ${merged.report.replaced.map((entry) => entry.assetId).join(', ') || 'none'}`,
        `preserved:          ${merged.report.preserved.length} assets`,
        `not merged:         ${merged.report.notMerged.map((entry) => entry.assetId).join(', ') || 'none'}`,
      ].join('\n')}\n`,
    );
    for (const entry of merged.report.notMerged) {
      context.stderr(`  - ${entry.assetId}: ${entry.reason}\n`);
    }
  }

  return CAPTURE_EXIT_CODES.SUCCESS;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
