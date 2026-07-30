import { resolve } from 'node:path';

import { NodeCommandRunner, resolveFfmpegBinaries, type CommandRunner } from '@combat/media';

import {
  PRODUCT_MOTION_LABEL,
  ProductMotionError,
  type ProductMotionErrorCode,
} from './product-motion-contracts';
import { runProductMotionProof } from './run-product-motion';

/**
 * `pnpm aamp:product-motion` — render the proof, measure it, and write the
 * artefacts a reviewer needs to reject it.
 *
 * The exit codes are per failure kind rather than a single 1, because the two
 * failures an operator will actually hit — an unmappable screen and a QA
 * failure — need different responses, and a shared code means reading the log
 * to tell them apart.
 */

const EXIT_CODES: Record<ProductMotionErrorCode, number> = {
  INVALID_PLAN: 2,
  ASSET_NOT_FOUND: 3,
  SCREEN_NOT_MAPPABLE: 4,
  TIMELINE_INCOHERENT: 5,
  RENDER_FAILED: 6,
  QA_FAILED: 7,
  FFMPEG_UNAVAILABLE: 8,
};

export interface ProductMotionCliOptions {
  readonly planPath: string;
  readonly platesRoot: string;
  readonly assetsRoot: string;
  readonly outputRoot: string;
  readonly json: boolean;
}

const USAGE = `Usage: aamp:product-motion --plan <plan.json> --plates-root <dir> --assets-root <dir> [--output-root <dir>] [--json]

Renders one Product Motion Proof: a short continuous product demonstration with
real captured interface pixels composited onto a photographed handset.

  --plan          Committed plan describing the states, accents, shots and cuts.
  --plates-root   Directory holding the photographic plates the plan names.
  --assets-root   Directory holding the captured screens, brand and audio assets.
  --output-root   Where the run directory is written. Default: .aamp-output
  --json          Print the machine-readable result instead of the summary.

Makes no paid provider call, constructs no reasoning or generation provider,
reads no credential and contacts no external service.`;

export function parseProductMotionArguments(argv: readonly string[]): ProductMotionCliOptions {
  let planPath: string | undefined;
  let platesRoot: string | undefined;
  let assetsRoot: string | undefined;
  let outputRoot = '.aamp-output';
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--plan':
        planPath = argv[++index];
        break;
      case '--plates-root':
        platesRoot = argv[++index];
        break;
      case '--assets-root':
        assetsRoot = argv[++index];
        break;
      case '--output-root':
        outputRoot = argv[++index] ?? outputRoot;
        break;
      case '--json':
        json = true;
        break;
      case '--help':
        throw new ProductMotionError('INVALID_PLAN', USAGE);
      default:
        // An unrecognised flag is refused by name. Silently ignoring one is how
        // an operator believes they passed an option that never took effect.
        throw new ProductMotionError('INVALID_PLAN', `unrecognised option ${argument}\n\n${USAGE}`);
    }
  }

  const missing = [
    planPath ? null : '--plan',
    platesRoot ? null : '--plates-root',
    assetsRoot ? null : '--assets-root',
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) {
    throw new ProductMotionError(
      'INVALID_PLAN',
      `missing required ${missing.join(', ')}\n\n${USAGE}`,
    );
  }

  return {
    planPath: planPath as string,
    platesRoot: platesRoot as string,
    assetsRoot: assetsRoot as string,
    outputRoot,
    json,
  };
}

export interface ProductMotionCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly runner?: CommandRunner;
  readonly now?: () => Date;
}

export async function runProductMotionCli(
  argv: readonly string[],
  context: ProductMotionCliContext,
): Promise<number> {
  let options: ProductMotionCliOptions;
  try {
    options = parseProductMotionArguments(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof ProductMotionError ? EXIT_CODES[error.code] : 2;
  }

  try {
    const result = await runProductMotionProof({
      planPath: resolve(context.cwd, options.planPath),
      platesRoot: resolve(context.cwd, options.platesRoot),
      assetsRoot: resolve(context.cwd, options.assetsRoot),
      outputRoot: resolve(context.cwd, options.outputRoot),
      binaries: resolveFfmpegBinaries(context.env),
      runner: context.runner ?? new NodeCommandRunner(),
      measuredAt: context.now ? context.now() : new Date(),
    });

    const summary = result.qaReport.summary;
    if (options.json) {
      context.stdout(
        `${JSON.stringify(
          {
            label: PRODUCT_MOTION_LABEL,
            outputPath: result.outputPath,
            qaVerdict: result.qaReport.verdict,
            durationSeconds: summary.durationSeconds,
            widthPx: summary.widthPx,
            heightPx: summary.heightPx,
            frameRate: summary.frameRate,
            videoCodec: summary.videoCodec,
            audioCodec: summary.audioCodec,
            faststart: summary.faststart,
            checksumSha256: summary.checksumSha256,
            galleryPath: result.galleryPath,
            paidProviderCalls: 0,
            isRealCampaignRun: false,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      context.stdout(
        `${[
          `label:        ${PRODUCT_MOTION_LABEL}`,
          `output path:  ${result.outputPath}`,
          `duration:     ${summary.durationSeconds === null ? 'unknown' : `${summary.durationSeconds.toFixed(3)}s`}`,
          `resolution:   ${summary.widthPx ?? '?'}x${summary.heightPx ?? '?'} @ ${summary.frameRate ?? '?'}fps`,
          `codecs:       ${summary.videoCodec ?? 'none'} / ${summary.audioCodec ?? 'none'}`,
          `QA status:    ${result.qaReport.verdict}`,
          `gallery:      ${result.galleryPath}`,
          `paid calls:   0`,
          '',
          'This is a proof, not an approved master. Look at the gallery before believing it.',
        ].join('\n')}\n`,
      );
    }

    if (result.qaReport.verdict !== 'PASS') {
      const failures = result.qaReport.measurements.filter(
        (measurement) => measurement.verdict === 'FAIL',
      );
      context.stderr(
        `\nfailed checks:\n${failures
          .map(
            (measurement) =>
              `  - ${measurement.check}: measured ${String(measurement.measured)}, expected ${measurement.expected}`,
          )
          .join('\n')}\n`,
      );
      return EXIT_CODES.QA_FAILED;
    }
    return 0;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof ProductMotionError ? EXIT_CODES[error.code] : 1;
  }
}
