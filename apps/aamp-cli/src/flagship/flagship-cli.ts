import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { resolveFfmpegBinaries } from '@combat/media';

import { EXIT_CODES, type ExitCode } from '../run-source-campaign';
import {
  FLAGSHIP_EXECUTION_MODE,
  FLAGSHIP_IS_REAL_CAMPAIGN_RUN,
  FLAGSHIP_OUTPUT_USE,
  FLAGSHIP_PAID_PROVIDER_CALLS,
  runFlagshipCampaign,
} from './run-flagship';

/**
 * `pnpm aamp:flagship` — one command, one advertisement, no way to argue the
 * labels up.
 *
 * The flag surface is deliberately tiny: where the storyboard is, where the
 * packs are, where the output goes. There is no `--execution-mode`, no
 * `--allow-paid-providers`, no `--output-use` and no `--skip-*`. That is the
 * whole point of the command existing as its own entry rather than as options
 * on `aamp:generate`: a flagship run is a fixed kind of run, and the set of
 * things a caller can change does not include what the result is called.
 */

/**
 * The committed campaign source, resolved from this module rather than from
 * the caller's working directory.
 *
 * `dist/flagship/` and `src/flagship/` are both two levels below the package
 * root, so the same expression is correct whether the command is running from
 * compiled output or from a test.
 */
export const FLAGSHIP_CAMPAIGN_DIRECTORY = resolve(
  __dirname,
  '..',
  '..',
  'campaigns',
  'combat-reviews-flagship-01',
);

export interface CliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: Date;
  readonly workflowRunId?: string;
}

interface FlagshipCliOptions {
  storyboard?: string;
  premiumPack?: string;
  workPack?: string;
  pilotPack?: string;
  outputDir?: string;
  campaignDirectory?: string;
  json: boolean;
  help: boolean;
}

const USAGE = `aamp:flagship — render the storyboard-driven Combat Reviews flagship advertisement.

  --storyboard <dir>      the verified eight-panel storyboard package (required)
  --work-pack <dir>       the pack holding asset-root/assets.json (required)
  --premium-pack <dir>    craft documentation and rights evidence, reconciled read-only
  --pilot-pack <dir>      earlier candidate media, reconciled read-only
  --output-dir <dir>      where the run writes (required)
  --campaign-dir <dir>    committed campaign source; defaults to ${FLAGSHIP_CAMPAIGN_DIRECTORY}
  --json                  print the machine-readable result
  --help

Every declared pack is read only. The run always produces
${FLAGSHIP_EXECUTION_MODE}, isRealCampaignRun: ${FLAGSHIP_IS_REAL_CAMPAIGN_RUN},
paidProviderCalls: ${FLAGSHIP_PAID_PROVIDER_CALLS}, outputUse: ${FLAGSHIP_OUTPUT_USE};
no flag changes any of those.
`;

export function parseFlagshipArgs(argv: readonly string[]): FlagshipCliOptions {
  const options: FlagshipCliOptions = { json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    switch (token) {
      case '--storyboard':
        options.storyboard = value;
        index += 1;
        break;
      case '--work-pack':
        options.workPack = value;
        index += 1;
        break;
      case '--premium-pack':
        options.premiumPack = value;
        index += 1;
        break;
      case '--pilot-pack':
        options.pilotPack = value;
        index += 1;
        break;
      case '--output-dir':
        options.outputDir = value;
        index += 1;
        break;
      case '--campaign-dir':
        options.campaignDirectory = value;
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(
          `unknown option "${token ?? ''}". This command takes no execution-mode, provider or output-use flag — run --help.`,
        );
    }
  }
  return options;
}

export async function runFlagshipCli(
  argv: readonly string[],
  context: CliContext,
): Promise<ExitCode> {
  let options: FlagshipCliOptions;
  try {
    options = parseFlagshipArgs(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

  if (options.help) {
    context.stdout(USAGE);
    return EXIT_CODES.SUCCESS;
  }

  const missing = (['storyboard', 'workPack', 'outputDir'] as const).filter(
    (key) => !options[key] || options[key]?.trim().length === 0,
  );
  if (missing.length > 0) {
    context.stderr(
      `missing required option(s): ${missing
        .map(
          (key) =>
            `--${key === 'workPack' ? 'work-pack' : key === 'outputDir' ? 'output-dir' : key}`,
        )
        .join(', ')}\n\n${USAGE}`,
    );
    return EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

  const campaignDirectory = resolve(
    context.cwd,
    options.campaignDirectory ?? FLAGSHIP_CAMPAIGN_DIRECTORY,
  );

  context.stderr(
    [
      '',
      `execution mode:        ${FLAGSHIP_EXECUTION_MODE}`,
      `output use:            ${FLAGSHIP_OUTPUT_USE}`,
      `real campaign run:     ${FLAGSHIP_IS_REAL_CAMPAIGN_RUN}`,
      `paid provider calls:   ${FLAGSHIP_PAID_PROVIDER_CALLS}`,
      `storyboard:            REFERENCE_ONLY — no frame may reach the output`,
      '',
    ].join('\n'),
  );

  const result = await runFlagshipCampaign({
    storyboardRoot: resolve(context.cwd, options.storyboard as string),
    workPackRoot: resolve(context.cwd, options.workPack as string),
    ...(options.premiumPack ? { premiumPackRoot: resolve(context.cwd, options.premiumPack) } : {}),
    ...(options.pilotPack ? { pilotPackRoot: resolve(context.cwd, options.pilotPack) } : {}),
    campaignDirectory,
    outputDirectory: resolve(context.cwd, options.outputDir as string),
    binaries: resolveFfmpegBinaries(context.env),
    workflowRunId: context.workflowRunId ?? randomUUID(),
    now: context.now ?? new Date(),
    onProgress: (message) => context.stderr(`  … ${message}\n`),
  });

  if (options.json) {
    context.stdout(
      `${JSON.stringify(
        {
          exitCode: result.exitCode,
          executionMode: result.executionMode,
          outputUse: result.outputUse,
          isRealCampaignRun: result.isRealCampaignRun,
          paidProviderCalls: result.paidProviderCalls,
          outputPath: result.outputPath ?? null,
          qaVerdict: result.qaVerdict ?? null,
          measured: result.measured ?? null,
          scorecardStatus: result.scorecard?.status ?? null,
          agencyGradeClaim: result.scorecard?.agencyGradeClaim ?? null,
          blockingDefects: result.scorecard?.blockingDefects.map((defect) => defect.code) ?? [],
          galleryPath: result.galleryPath ?? null,
          failure: result.failure ?? null,
        },
        null,
        2,
      )}\n`,
    );
  }

  if (result.failure && result.exitCode !== EXIT_CODES.SUCCESS) {
    context.stderr(`\n${result.failure}\n`);
  }

  if (result.outputPath) {
    const measured = result.measured as Record<string, unknown> | undefined;
    context.stderr(
      [
        '',
        `QA verdict:            ${result.qaVerdict ?? 'UNKNOWN'}`,
        `measured:              ${String(measured?.widthPx ?? '?')}x${String(measured?.heightPx ?? '?')}, ` +
          `${String(measured?.durationSeconds ?? '?')}s, ${String(measured?.videoCodec ?? 'none')}/${String(measured?.audioCodec ?? 'none')}, ` +
          `${String(measured?.pixelFormat ?? '?')}`,
        `scorecard:             ${result.scorecard?.status ?? 'NOT_BUILT'} (agency grade: ${result.scorecard?.agencyGradeClaim ?? 'NOT_ASSESSED'})`,
        ...(result.scorecard && result.scorecard.blockingDefects.length > 0
          ? [
              'blocking defects:',
              ...result.scorecard.blockingDefects.map(
                (defect) => `  - ${defect.code}: ${defect.summary}`,
              ),
            ]
          : []),
        `gallery:               ${result.galleryPath ?? 'not written'}`,
        '',
      ].join('\n'),
    );
    // The one line a person is looking for, on stdout, last.
    context.stdout(`${result.outputPath}\n`);
  }

  return result.exitCode;
}
