import { join, resolve } from 'node:path';

import { resolveFfmpegBinaries } from '@combat/media';

import { STORYBOARD_VIDEO_EXIT_CODES } from '../storyboard-video/failures';
import { recordSceneAcceptanceDecision } from './record-decision';
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

  decide --verdict APPROVED|REJECTED --reviewer "<name>" --feedback "<why>"
                             Record a named person's judgement about the clip the
                             run produced. Reads no key and makes no request:
                             recording a rejection can never spend money.
  --acknowledge <FINDING>    A fidelity finding accepted despite. Repeatable.

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

  if (parsed.decide) {
    try {
      const recorded = await recordSceneAcceptanceDecision({
        runDirectory: resolve(options.cwd, parsed.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY),
        reviewer: parsed.reviewer as string,
        verdict: parsed.verdict as 'APPROVED' | 'REJECTED',
        feedback: parsed.feedback as string,
        acknowledgedFindings: parsed.acknowledged,
        ...(parsed.reviewDirectory
          ? { reviewDirectory: resolve(options.cwd, parsed.reviewDirectory) }
          : {}),
        now,
      });
      options.stdout('');
      options.stdout(`recorded             ${recorded.verdict} for scene ${recorded.sceneNumber}`);
      options.stdout(`reviewer             ${recorded.reviewer}`);
      options.stdout(`at                   ${recorded.recordedAt}`);
      options.stdout(`decision id          ${recorded.decisionId}`);
      options.stdout(`ledger               ${recorded.ledgerPath}`);
      if (recorded.supersedesDecisionId) {
        options.stdout(`supersedes           ${recorded.supersedesDecisionId}`);
      }
      options.stdout('');
      return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
    } catch (error) {
      options.stderr(error instanceof Error ? error.message : String(error));
      return STORYBOARD_VIDEO_EXIT_CODES.MOTION_REVIEW_BLOCKED;
    }
  }

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
  readonly decide: boolean;
  readonly reviewer?: string;
  readonly verdict?: 'APPROVED' | 'REJECTED';
  readonly feedback?: string;
  readonly acknowledged: readonly string[];
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
  let decide = false;
  let reviewer: string | undefined;
  let verdict: 'APPROVED' | 'REJECTED' | undefined;
  let feedback: string | undefined;
  const acknowledged: string[] = [];
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
      case 'decide':
        decide = true;
        break;
      case '--reviewer':
        reviewer = requireValue(argument, argv[++index]);
        break;
      case '--feedback':
        feedback = requireValue(argument, argv[++index]);
        break;
      case '--acknowledge':
        acknowledged.push(requireValue(argument, argv[++index]));
        break;
      case '--verdict': {
        const value = requireValue(argument, argv[++index]);
        if (value !== 'APPROVED' && value !== 'REJECTED') {
          throw new Error(`--verdict must be APPROVED or REJECTED, got "${value}"`);
        }
        verdict = value;
        break;
      }
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
    return { decide, acknowledged, platesDirectory: '', maxCostCents: 0, dryRun, json, help };
  }

  if (decide) {
    // A decision is attributable or it does not happen, and a reason a person
    // cannot act on is not a reason. Both are refused here rather than defaulted.
    if (!reviewer) {
      throw new Error(
        'decide requires --reviewer: a judgement without a named person is not attributable, and this record exists to be attributable.',
      );
    }
    if (!verdict) throw new Error('decide requires --verdict APPROVED or REJECTED');
    if (!feedback) throw new Error('decide requires --feedback: say why, in your own words.');
    return {
      decide,
      reviewer,
      verdict,
      feedback,
      acknowledged,
      platesDirectory: '',
      ...(outputDirectory ? { outputDirectory } : {}),
      ...(reviewDirectory ? { reviewDirectory } : {}),
      maxCostCents: 0,
      dryRun: false,
      json,
      help,
    };
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
    decide,
    acknowledged,
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
