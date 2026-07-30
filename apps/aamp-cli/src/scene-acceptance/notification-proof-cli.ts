import { join, resolve } from 'node:path';

import { resolveFfmpegBinaries } from '@combat/media';

import { STORYBOARD_VIDEO_EXIT_CODES } from '../storyboard-video/failures';
import { runNotificationProof, type NotificationProofResult } from './notification-proof';
import { DEFAULT_BRIEF_PATH } from './scene-acceptance-cli';

/**
 * `aamp:notification-proof` — the zero-cost notification treatment proof.
 *
 * Deliberately small, and deliberately unable to spend. It takes no API key, no
 * base URL and no cost ceiling, because there is nothing on this path that
 * could charge anything: a ceiling here would imply there was something to
 * cap. It parses flags, refuses an unrecognised one by name, resolves paths and
 * hands everything to `runNotificationProof`.
 *
 * It holds no creative decision. Every word, colour, distance and timing comes
 * from the brief.
 */

const USAGE = `
aamp:notification-proof — prove the Scene-1 notification treatment at zero cost

  --source <path>            Required. The Scene-1 picture to composite over.
  --logo <path>              Required. The owned Combat Reviews mark.
  --brief <path>             The Scene-1 acceptance brief JSON.
                             Default: apps/aamp-cli/campaigns/combat-reviews-flagship-02/scene-01-ltx-acceptance.json
  --out <path>               Run directory. Default: .aamp-output/storyboard-02-notification-proof
  --previous <path>          The previous treatment's cut, for the side-by-side.
  --no-determinism-check     Render once instead of twice. The re-render comparison
                             is then reported as NOT_MEASURED rather than as a pass.
  --json                     Print the result as JSON.
  --help

No provider is constructed, no credential is read and no request is made. This
command cannot spend money. It renders one scene's opening second as a treatment
proof; scenes 2-10 and the fifteen-second master are not rendered.
`.trim();

export const DEFAULT_PROOF_OUTPUT_DIRECTORY = join(
  '.aamp-output',
  'storyboard-02-notification-proof',
);

export interface NotificationProofCliOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now?: Date;
}

export async function runNotificationProofCli(
  options: NotificationProofCliOptions,
): Promise<number> {
  let parsed: ParsedProofArguments;
  try {
    parsed = parseProofArguments(options.argv);
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

  const result = await runNotificationProof({
    briefPath: resolve(options.cwd, parsed.briefPath ?? DEFAULT_BRIEF_PATH),
    sourceClipPath: resolve(options.cwd, parsed.sourcePath),
    logoPath: resolve(options.cwd, parsed.logoPath),
    outputDirectory: resolve(options.cwd, parsed.outputDirectory ?? DEFAULT_PROOF_OUTPUT_DIRECTORY),
    ...(parsed.previousPath
      ? { previousCompositePath: resolve(options.cwd, parsed.previousPath) }
      : {}),
    binaries: resolveFfmpegBinaries(options.env),
    now: options.now ?? new Date(),
    verifyDeterminism: parsed.verifyDeterminism,
    onProgress: (message) => options.stderr(message),
  });

  if (parsed.json) {
    options.stdout(JSON.stringify(result, null, 2));
  } else {
    printProofSummary(result, options.stdout);
  }
  if (result.failure) options.stderr(result.failure);
  return result.exitCode;
}

function printProofSummary(result: NotificationProofResult, stdout: (line: string) => void): void {
  stdout('');
  stdout(`run directory        ${result.runDirectory}`);
  if (result.proofPath) stdout(`proof                ${result.proofPath}`);
  if (result.proofChecksumSha256) stdout(`proof sha256         ${result.proofChecksumSha256}`);
  if (result.surfaceAssetPath) stdout(`surface asset        ${result.surfaceAssetPath}`);
  if (result.galleryPath) stdout(`gallery              ${result.galleryPath}`);
  if (result.measuredWidthPx && result.measuredHeightPx) {
    stdout(
      `measured             ${result.measuredWidthPx}x${result.measuredHeightPx} @ ${result.measuredDurationSeconds?.toFixed(6) ?? '—'}s`,
    );
  }
  for (const path of result.framePaths) stdout(`frame                ${path}`);
  if (result.placementClears !== undefined) {
    stdout(
      `placement            ${result.placementClears ? 'clears all subject content on every frame' : 'DOES NOT CLEAR — see placement-report.json'}`,
    );
  }
  if (result.measuredDefectCount !== undefined) {
    stdout(`measured defects     ${result.measuredDefectCount}`);
    stdout(`unmeasurable rows    ${result.notMeasuredCount ?? 0}`);
    stdout(`open for a person    ${result.openHumanJudgementCount ?? 0}`);
  }
  stdout(`paid provider calls  ${result.paidProviderCalls}`);
  stdout(`cost                 ${result.costCents}¢`);
  stdout('');
}

interface ParsedProofArguments {
  readonly sourcePath: string;
  readonly logoPath: string;
  readonly briefPath?: string;
  readonly outputDirectory?: string;
  readonly previousPath?: string;
  readonly verifyDeterminism: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

export function parseProofArguments(argv: readonly string[]): ParsedProofArguments {
  let sourcePath: string | undefined;
  let logoPath: string | undefined;
  let briefPath: string | undefined;
  let outputDirectory: string | undefined;
  let previousPath: string | undefined;
  let verifyDeterminism = true;
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
      case '--source':
        sourcePath = requireValue(argument, argv[++index]);
        break;
      case '--logo':
        logoPath = requireValue(argument, argv[++index]);
        break;
      case '--brief':
        briefPath = requireValue(argument, argv[++index]);
        break;
      case '--out':
        outputDirectory = requireValue(argument, argv[++index]);
        break;
      case '--previous':
        previousPath = requireValue(argument, argv[++index]);
        break;
      case '--no-determinism-check':
        verifyDeterminism = false;
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
    return { sourcePath: '', logoPath: '', verifyDeterminism, json, help };
  }
  if (!sourcePath) {
    throw new Error(
      '--source is required: this command composites over existing Scene-1 bytes and never generates a substitute',
    );
  }
  if (!logoPath) {
    throw new Error(
      '--logo is required: the notification card is never drawn with a substitute mark',
    );
  }

  return {
    sourcePath,
    logoPath,
    ...(briefPath ? { briefPath } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    ...(previousPath ? { previousPath } : {}),
    verifyDeterminism,
    json,
    help,
  };
}
