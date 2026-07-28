import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { resolveFfmpegBinaries } from '@combat/media';

import { EXIT_CODES, type ExitCode } from '../run-source-campaign';
import {
  runFlagshipV2,
  V2_EXECUTION_MODE,
  V2_IS_PUBLIC_RELEASE_READY,
  V2_IS_REAL_CAMPAIGN_RUN,
  V2_OUTPUT_USE,
  V2_PAID_PROVIDER_CALLS,
} from './run-flagship-v2';

/**
 * `pnpm aamp:flagship2` — one command, one locked-storyboard motion proof.
 *
 * The flag surface is where the storyboard is, where the packs are and where
 * the output goes. There is no execution-mode flag, no output-use flag and no
 * paid-provider flag, and an unrecognised option is refused by name rather
 * than ignored: a locked-storyboard proof is a fixed kind of run, and what the
 * result may be called is not among the things a caller can change.
 */

export const V2_CAMPAIGN_DIRECTORY = resolve(
  __dirname,
  '..',
  '..',
  'campaigns',
  'combat-reviews-flagship-02',
);

export interface CliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: Date;
  readonly workflowRunId?: string;
}

interface Options {
  storyboard?: string;
  workPack?: string;
  storyboard01?: string;
  outputDir?: string;
  campaignDirectory?: string;
  json: boolean;
  help: boolean;
}

const USAGE = `aamp:flagship2 — render the locked ten-panel Combat Reviews storyboard.

  --storyboard <dir>       the verified ten-panel Storyboard-02 package (required)
  --work-pack <dir>        the pack holding asset-root/assets.json (required)
  --storyboard-01 <dir>    Storyboard-01's package; proven absent from this run
  --output-dir <dir>       where the run writes (required)
  --campaign-dir <dir>     committed campaign source; defaults to the packaged one
  --json                   print the machine-readable result
  --help

The storyboard package is the locked art direction and its panels are the
primary visual source. Every run declares ${V2_EXECUTION_MODE},
isRealCampaignRun: ${V2_IS_REAL_CAMPAIGN_RUN}, isPublicReleaseReady: ${V2_IS_PUBLIC_RELEASE_READY},
paidProviderCalls: ${V2_PAID_PROVIDER_CALLS}, outputUse: ${V2_OUTPUT_USE}; no flag changes any of those.
`;

export function parseFlagship2Args(argv: readonly string[]): Options {
  const options: Options = { json: false, help: false };
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
      case '--storyboard-01':
        options.storyboard01 = value;
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

export async function runFlagship2Cli(
  argv: readonly string[],
  context: CliContext,
): Promise<ExitCode> {
  let options: Options;
  try {
    options = parseFlagship2Args(argv);
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
        .map((key) =>
          key === 'workPack' ? '--work-pack' : key === 'outputDir' ? '--output-dir' : `--${key}`,
        )
        .join(', ')}\n\n${USAGE}`,
    );
    return EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

  context.stderr(
    [
      '',
      `execution mode:        ${V2_EXECUTION_MODE}`,
      `output use:            ${V2_OUTPUT_USE}`,
      `real campaign run:     ${V2_IS_REAL_CAMPAIGN_RUN}`,
      `public release ready:  ${V2_IS_PUBLIC_RELEASE_READY}`,
      `paid provider calls:   ${V2_PAID_PROVIDER_CALLS}`,
      `storyboard imagery:    INTERNAL_REVIEW only — not licensed public-production media`,
      '',
    ].join('\n'),
  );

  const result = await runFlagshipV2({
    storyboardRoot: resolve(context.cwd, options.storyboard as string),
    workPackRoot: resolve(context.cwd, options.workPack as string),
    ...(options.storyboard01
      ? { storyboard01Root: resolve(context.cwd, options.storyboard01) }
      : {}),
    campaignDirectory: resolve(context.cwd, options.campaignDirectory ?? V2_CAMPAIGN_DIRECTORY),
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
          isPublicReleaseReady: result.isPublicReleaseReady,
          paidProviderCalls: result.paidProviderCalls,
          outputPath: result.outputPath ?? null,
          qaVerdict: result.qaVerdict ?? null,
          fidelityVerdict: result.fidelity?.verdict ?? null,
          fidelityFailures: result.fidelity?.failures ?? [],
          measured: result.measured ?? null,
          scorecardStatus: result.scorecard?.status ?? null,
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
    const m = result.measured as Record<string, unknown> | undefined;
    context.stderr(
      [
        '',
        `QA verdict:            ${result.qaVerdict ?? 'UNKNOWN'}`,
        `storyboard fidelity:   ${result.fidelity?.verdict ?? 'NOT_BUILT'} over ${result.fidelity?.sceneCount ?? 0} scenes`,
        `measured:              ${String(m?.widthPx ?? '?')}x${String(m?.heightPx ?? '?')}, ${String(m?.durationSeconds ?? '?')}s, ` +
          `${String(m?.videoCodec ?? 'none')}/${String(m?.audioCodec ?? 'none')}, ${String(m?.pixelFormat ?? '?')}`,
        `scorecard:             ${result.scorecard?.status ?? 'NOT_BUILT'} (agency grade: ${result.scorecard?.agencyGradeClaim ?? 'NOT_ASSESSED'})`,
        `comparison gallery:    ${result.galleryPath ?? 'not written'}`,
        '',
      ].join('\n'),
    );
    context.stdout(`${result.outputPath}\n`);
  }

  return result.exitCode;
}
