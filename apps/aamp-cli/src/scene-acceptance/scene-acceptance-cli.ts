import { join, resolve } from 'node:path';

import { resolveFfmpegBinaries } from '@combat/media';

import { STORYBOARD_VIDEO_EXIT_CODES } from '../storyboard-video/failures';
import { runSceneAcceptance, type SceneAcceptanceResult } from './run-scene-acceptance';

/**
 * `aamp:ltx-scene-01` — the Scene-1 acceptance command.
 *
 * Deliberately small. It parses flags, refuses an unrecognised one by name,
 * resolves the two paths a run needs and hands everything to
 * `runSceneAcceptance`. It holds no creative decision, no default prompt and
 * no default cost: `--max-cost-cents` is required, because a spending ceiling
 * that defaults is a ceiling nobody chose.
 *
 * `--dry-run` never reads the API key. That is a property of the code — the
 * key is only read on the branch past the dry-run return — rather than a
 * promise in this help text.
 */

const USAGE = `
aamp:ltx-scene-01 — prove one Scene-1 LTX generation from the authoritative plate

  --plates-dir <path>        Required. The authoritative high-quality plate directory.
  --brief <path>             The Scene-1 acceptance brief JSON.
                             Default: apps/aamp-cli/campaigns/combat-reviews-flagship-02/scene-01-ltx-acceptance.json
  --logo <path>              Required unless --dry-run. The owned Combat Reviews mark.
  --out <path>               Run directory. Default: .aamp-output/storyboard-02-ltx-scene-01-acceptance
  --max-cost-cents <n>       Required. The ceiling this run may not exceed.
  --review-dir <path>        Where a later human decision is recorded.
  --dry-run                  Resolve, price and report. No key is read, no request is made.
  --json                     Print the result as JSON.
  --help

Exactly one paid generation is ever submitted. There is no retry, no second
variation and no fallback provider. Scenes 2-10 are not generated and no
fifteen-second master is rendered.
`.trim();

export interface SceneAcceptanceCliOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now?: Date;
}

export const DEFAULT_OUTPUT_DIRECTORY = join(
  '.aamp-output',
  'storyboard-02-ltx-scene-01-acceptance',
);
export const DEFAULT_BRIEF_PATH = join(
  'apps',
  'aamp-cli',
  'campaigns',
  'combat-reviews-flagship-02',
  'scene-01-ltx-acceptance.json',
);

export async function runSceneAcceptanceCli(options: SceneAcceptanceCliOptions): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(options.argv);
  } catch (error) {
    options.stderr(error instanceof Error ? error.message : String(error));
    options.stderr('');
    options.stderr(USAGE);
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

  if (parsed.help) {
    options.stdout(USAGE);
    return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
  }

  const now = options.now ?? new Date();
  const binaries = resolveFfmpegBinaries(options.env);

  const result = await runSceneAcceptance({
    platesDirectory: resolve(options.cwd, parsed.platesDirectory),
    briefPath: resolve(options.cwd, parsed.briefPath ?? DEFAULT_BRIEF_PATH),
    outputDirectory: resolve(options.cwd, parsed.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY),
    logoPath: resolve(options.cwd, parsed.logoPath ?? ''),
    maxCostCents: parsed.maxCostCents,
    dryRun: parsed.dryRun,
    binaries,
    workflowRunId: `ltx-scene-01-${now.toISOString().replace(/[:.]/g, '-')}`,
    now,
    // Read only on the paid branch. A dry run never reaches this value.
    ...(parsed.dryRun ? {} : { apiKey: options.env.LTXV_API_KEY ?? '' }),
    ...(options.env.LTX_BASE_URL ? { baseUrl: options.env.LTX_BASE_URL } : {}),
    ...(parsed.reviewDirectory
      ? { reviewDirectory: resolve(options.cwd, parsed.reviewDirectory) }
      : {}),
    onProgress: (message) => options.stderr(message),
  });

  if (parsed.json) {
    options.stdout(JSON.stringify(result, null, 2));
  } else {
    printSummary(result, options.stdout);
  }
  if (result.failure) options.stderr(result.failure);
  return result.exitCode;
}

function printSummary(result: SceneAcceptanceResult, stdout: (line: string) => void): void {
  stdout('');
  stdout(`run directory        ${result.runDirectory}`);
  stdout(`model                ${result.model} @ ${result.requestedDurationSeconds}s`);
  stdout(`plate                ${result.plateFrameId} ${result.plateChecksumSha256 ?? '—'}`);
  stdout(`billable requests    ${result.ltxRequestCount} of ${1} authorised`);
  stdout(`network requests     ${result.networkRequestCount}`);
  stdout(
    `cost                 ${result.costChargedCents === null ? 'not reported' : `${result.costChargedCents}¢`} (max ${result.maximumCostCents}¢, ceiling ${result.ceilingCents}¢)`,
  );
  stdout(`cost basis           ${result.costBasis}`);
  if (result.rawClipPath) stdout(`raw clip             ${result.rawClipPath}`);
  if (result.compositedClipPath) stdout(`composited clip      ${result.compositedClipPath}`);
  if (result.galleryPath) stdout(`gallery              ${result.galleryPath}`);
  if (result.technicalVerdict) stdout(`technical verdict    ${result.technicalVerdict}`);
  if (result.reviewStatus) stdout(`review status        ${result.reviewStatus}`);
  if (result.technicalVerdict) {
    stdout(
      `production source    ${result.safeAsProductionSource ? 'yes' : 'no — not until a named reviewer records an approval of these exact bytes'}`,
    );
  }
  stdout('');
}

interface ParsedArguments {
  readonly platesDirectory: string;
  readonly briefPath?: string;
  readonly outputDirectory?: string;
  readonly logoPath?: string;
  readonly reviewDirectory?: string;
  readonly maxCostCents: number;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  let platesDirectory: string | undefined;
  let briefPath: string | undefined;
  let outputDirectory: string | undefined;
  let logoPath: string | undefined;
  let reviewDirectory: string | undefined;
  let maxCostCents: number | undefined;
  let dryRun = false;
  let json = false;
  let help = false;

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    switch (argument) {
      case '--plates-dir':
        platesDirectory = requireValue(argument, argv[++index]);
        break;
      case '--brief':
        briefPath = requireValue(argument, argv[++index]);
        break;
      case '--out':
        outputDirectory = requireValue(argument, argv[++index]);
        break;
      case '--logo':
        logoPath = requireValue(argument, argv[++index]);
        break;
      case '--review-dir':
        reviewDirectory = requireValue(argument, argv[++index]);
        break;
      case '--max-cost-cents': {
        const raw = requireValue(argument, argv[++index]);
        const value = Number(raw);
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(
            `--max-cost-cents must be a positive whole number of cents, got "${raw}"`,
          );
        }
        maxCostCents = value;
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`unrecognised option "${argument}"`);
    }
  }

  if (help) {
    return { platesDirectory: '', maxCostCents: 0, dryRun, json, help };
  }
  if (!platesDirectory) throw new Error('--plates-dir is required');
  if (maxCostCents === undefined) {
    throw new Error(
      '--max-cost-cents is required. A spending ceiling that defaults is a ceiling nobody chose.',
    );
  }
  if (!dryRun && !logoPath) {
    throw new Error(
      '--logo is required for a live run: the notification card is never drawn with a substitute mark',
    );
  }

  return {
    platesDirectory,
    ...(briefPath ? { briefPath } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    ...(logoPath ? { logoPath } : {}),
    ...(reviewDirectory ? { reviewDirectory } : {}),
    maxCostCents,
    dryRun,
    json,
    help,
  };
}
