import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { resolveFfmpegBinaries } from '@combat/media';
import { assertSupportedLtxModel, LtxModelSupportError, type LtxModel } from '@combat/providers';

import { V2_CAMPAIGN_DIRECTORY } from '../flagship/flagship2-cli';
import { STORYBOARD_VIDEO_EXIT_CODES, type StoryboardVideoExitCode } from './failures';
import { DEFAULT_MOTION_REVIEW_DIRECTORY } from './motion-review-store';
import { DEFAULT_PRE_GENERATED_SUBDIRECTORY } from './pre-generated-clips';
import { runStoryboardVideo } from './run-storyboard-video';

/**
 * `pnpm aamp:storyboard-video` — storyboard package to finished MP4.
 *
 * A thin command. Every flag is either a path to something the operator owns
 * or a bound on what the run may do; there is no execution-mode flag and no
 * way to change what the result may be called, for the same reason the
 * flagship commands have none. An unrecognised option is refused by name
 * rather than ignored, because a mistyped `--max-cost-cents` that silently
 * fell back to a default would be the one typo in this repository that spends
 * money.
 */

export interface StoryboardVideoCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: Date;
  readonly workflowRunId?: string;
}

interface Options {
  storyboard?: string;
  framesDir?: string;
  footagePack?: string;
  preGeneratedClipsDir?: string;
  sceneManifest?: string;
  outputDir?: string;
  workPack?: string;
  campaignDirectory?: string;
  storyboard01?: string;
  provider?: string;
  model?: string;
  maxCostCents?: string;
  reviewDir?: string;
  regenerateScenes: number[];
  regenerateRejected: boolean;
  dryRun: boolean;
  json: boolean;
  reuseGenerated: boolean;
  generateAudio: boolean;
  help: boolean;
}

const USAGE = `aamp:storyboard-video — animate the locked storyboard into one 15-second master.

  --storyboard <dir>               the verified ten-panel storyboard package (required)
  --frames-dir <dir>               the ten approved production keyframes, FRAME-01…FRAME-10 (required)
  --output-dir <dir>               where the run writes (required)
  --provider ltx-hosted            the generation provider (required)
  --model ltx-2-3-fast|ltx-2-3-pro the LTX model (required)
  --max-cost-cents <integer>       hard ceiling, checked before any upload (required)

  --footage-pack <dir>             the footage acquisition pack; its verified originals outrank generation
  --pre-generated-clips-dir <dir>  hand-animated clips (defaults to <frames-dir>/${DEFAULT_PRE_GENERATED_SUBDIRECTORY})
  --scene-manifest <file>          the ordered scene manifest (defaults to the campaign's own)
  --work-pack <dir>                the pack holding asset-root/assets.json (defaults to --footage-pack)
  --campaign-dir <dir>             committed campaign source; defaults to the packaged one
  --storyboard-01 <dir>            Storyboard-01's package; proven absent from this run
  --regenerate-scene <n>           regenerate this scene even if a clip exists (repeatable)
  --regenerate-rejected            also regenerate every scene a reviewer rejected
  --review-dir <dir>               where human motion decisions live (defaults to <output-dir>/${DEFAULT_MOTION_REVIEW_DIRECTORY})
  --reuse-generated                prefer cached generations (default)
  --generate-audio                 ask LTX for an audio track (mixed only as optional ambience)
  --dry-run                        plan and price it; reads no API key, makes no request, spends nothing
  --json                           print the machine-readable result
  --help

Scenes that preserve exact product UI or exact typography never reach a
generation provider — they are animated deterministically from the approved
frame, because a model asked to redraw a rankings table invents its contents.

Every scene with moving footage must carry a standing human approval of the
exact clip before anything is composited. There is no flag that skips it: run
"pnpm aamp:motion-review inspect" to look at the footage, then approve or
reject each scene.
`;

export function parseStoryboardVideoArgs(argv: readonly string[]): Options {
  const options: Options = {
    regenerateScenes: [],
    regenerateRejected: false,
    dryRun: false,
    json: false,
    reuseGenerated: true,
    generateAudio: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    switch (token) {
      case '--storyboard':
        options.storyboard = value;
        index += 1;
        break;
      case '--frames-dir':
        options.framesDir = value;
        index += 1;
        break;
      case '--footage-pack':
        options.footagePack = value;
        index += 1;
        break;
      case '--pre-generated-clips-dir':
        options.preGeneratedClipsDir = value;
        index += 1;
        break;
      case '--scene-manifest':
        options.sceneManifest = value;
        index += 1;
        break;
      case '--output-dir':
        options.outputDir = value;
        index += 1;
        break;
      case '--work-pack':
        options.workPack = value;
        index += 1;
        break;
      case '--campaign-dir':
        options.campaignDirectory = value;
        index += 1;
        break;
      case '--storyboard-01':
        options.storyboard01 = value;
        index += 1;
        break;
      case '--provider':
        options.provider = value;
        index += 1;
        break;
      case '--model':
        options.model = value;
        index += 1;
        break;
      case '--max-cost-cents':
        options.maxCostCents = value;
        index += 1;
        break;
      case '--regenerate-scene': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
          throw new Error(
            `--regenerate-scene takes a scene number between 1 and 10, got "${value ?? ''}"`,
          );
        }
        options.regenerateScenes.push(parsed);
        index += 1;
        break;
      }
      case '--regenerate-rejected':
        options.regenerateRejected = true;
        break;
      case '--review-dir':
        options.reviewDir = value;
        index += 1;
        break;
      case '--reuse-generated':
        options.reuseGenerated = true;
        break;
      case '--generate-audio':
        options.generateAudio = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option "${token ?? ''}" — run --help.`);
    }
  }
  return options;
}

export async function runStoryboardVideoCli(
  argv: readonly string[],
  context: StoryboardVideoCliContext,
): Promise<StoryboardVideoExitCode> {
  let options: Options;
  try {
    options = parseStoryboardVideoArgs(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }
  if (options.help) {
    context.stdout(USAGE);
    return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
  }

  const missing = (
    ['storyboard', 'framesDir', 'outputDir', 'provider', 'model', 'maxCostCents'] as const
  ).filter((key) => {
    const value = options[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  if (missing.length > 0) {
    context.stderr(`missing required option(s): ${missing.map(flagFor).join(', ')}\n\n${USAGE}`);
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

  if (options.provider !== 'ltx-hosted') {
    context.stderr(
      `--provider must be "ltx-hosted"; "${options.provider ?? ''}" is not a provider this command can use.\n`,
    );
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

  let model: LtxModel;
  try {
    model = assertSupportedLtxModel(options.model as string);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof LtxModelSupportError
      ? STORYBOARD_VIDEO_EXIT_CODES.UNSUPPORTED_MODEL_OR_DURATION
      : STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const maxCostCents = Number(options.maxCostCents);
  if (!Number.isInteger(maxCostCents) || maxCostCents < 0) {
    context.stderr(
      `--max-cost-cents takes a whole number of cents, got "${options.maxCostCents ?? ''}"\n`,
    );
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const framesDirectory = resolve(context.cwd, options.framesDir as string);
  const footagePackRoot = options.footagePack
    ? resolve(context.cwd, options.footagePack)
    : undefined;
  const workPackRoot = options.workPack ? resolve(context.cwd, options.workPack) : footagePackRoot;
  if (!workPackRoot) {
    context.stderr(
      'either --work-pack or --footage-pack is required: the run needs an asset library holding the logo and the audio bed.\n',
    );
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

  // The key is read once, here, and handed straight to the run. A dry run
  // never reads it at all — that is what makes "no key needed to plan" a
  // property of the code rather than a promise in the help text.
  const apiKey = options.dryRun ? undefined : context.env.LTXV_API_KEY;

  context.stderr(
    [
      '',
      `storyboard:            ${options.storyboard}`,
      `keyframes:             ${framesDirectory}`,
      `footage pack:          ${footagePackRoot ?? 'none supplied'}`,
      `model:                 ${model} @ 1080x1920, 24 fps`,
      `cost ceiling:          ${maxCostCents}¢`,
      `mode:                  ${options.dryRun ? 'DRY RUN — no key read, no request, no spend' : 'LIVE — paid generation is possible'}`,
      '',
    ].join('\n'),
  );

  const result = await runStoryboardVideo({
    storyboardRoot: resolve(context.cwd, options.storyboard as string),
    framesDirectory,
    outputDirectory: resolve(context.cwd, options.outputDir as string),
    workPackRoot,
    campaignDirectory: resolve(context.cwd, options.campaignDirectory ?? V2_CAMPAIGN_DIRECTORY),
    model,
    maxCostCents,
    ...(footagePackRoot ? { footagePackRoot } : {}),
    ...(options.preGeneratedClipsDir
      ? { preGeneratedClipsDirectory: resolve(context.cwd, options.preGeneratedClipsDir) }
      : {}),
    ...(options.sceneManifest
      ? { sceneManifestPath: resolve(context.cwd, options.sceneManifest) }
      : {}),
    ...(options.storyboard01
      ? { storyboard01Root: resolve(context.cwd, options.storyboard01) }
      : {}),
    dryRun: options.dryRun,
    generateAudio: options.generateAudio,
    reuseGenerated: options.reuseGenerated,
    regenerateScenes: new Set(options.regenerateScenes),
    regenerateRejected: options.regenerateRejected,
    ...(options.reviewDir ? { reviewDirectory: resolve(context.cwd, options.reviewDir) } : {}),
    binaries: resolveFfmpegBinaries(context.env),
    workflowRunId: context.workflowRunId ?? randomUUID(),
    now: context.now ?? new Date(),
    ...(apiKey ? { apiKey } : {}),
    ...(context.env.LTX_BASE_URL ? { baseUrl: context.env.LTX_BASE_URL } : {}),
    onProgress: (message) => context.stderr(`  … ${message}\n`),
  });

  if (options.json) {
    context.stdout(
      `${JSON.stringify(
        {
          exitCode: result.exitCode,
          dryRun: result.dryRun,
          maximumEstimatedCostCents: result.costEstimate?.maximumTotalCostCents ?? null,
          actualCostCents: result.actualCostCents,
          ltxCallCount: result.ltxCallCount,
          generatedSceneCount: result.generatedSceneCount,
          nextRequiredGenerationScene: result.nextRequiredGenerationScene ?? null,
          outputPath: result.outputPath ?? null,
          qaVerdict: result.qaVerdict ?? null,
          measured: result.measured ?? null,
          galleryPath: result.galleryPath ?? null,
          motionReviewGalleryPath: result.motionReviewGalleryPath ?? null,
          motionGate: result.motionGate ?? null,
          regeneratedRejectedScenes: result.regeneratedRejectedScenes ?? [],
          artefacts: result.artefacts,
          failureKind: result.failureKind ?? null,
          failure: result.failure ?? null,
          sources: (result.decisions ?? []).map((decision) => ({
            sceneNumber: decision.sceneNumber,
            sceneRole: decision.sceneRole,
            sourceType: decision.selectedSourceType,
            identifier: decision.selectedIdentifier,
            requiresGeneration: decision.requiresGeneration,
            generationProvenance: decision.generationProvenance ?? null,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }

  if (result.failure) {
    context.stderr(`\n${result.failureKind ?? 'FAILED'}: ${result.failure}\n`);
  }

  if (result.nextRequiredGenerationScene) {
    context.stderr(
      `\nnext scene still needing this pipeline to generate it: scene ${result.nextRequiredGenerationScene}\n` +
        `  a first live run should target it, so the paid test also produces footage the cut needs.\n`,
    );
  }

  if (result.outputPath) {
    const measured = result.measured as Record<string, unknown> | undefined;
    context.stderr(
      [
        '',
        `QA verdict:            ${result.qaVerdict ?? 'UNKNOWN'}`,
        `measured:              ${String(measured?.widthPx ?? '?')}x${String(measured?.heightPx ?? '?')}, ${String(measured?.durationSeconds ?? '?')}s`,
        `LTX calls:             ${result.ltxCallCount}`,
        `actual spend:          ${result.actualCostCents}¢`,
        `comparison gallery:    ${result.galleryPath ?? 'not written'}`,
        '',
      ].join('\n'),
    );
    context.stdout(`${result.outputPath}\n`);
  }

  return result.exitCode;
}

function flagFor(key: string): string {
  const map: Record<string, string> = {
    storyboard: '--storyboard',
    framesDir: '--frames-dir',
    outputDir: '--output-dir',
    provider: '--provider',
    model: '--model',
    maxCostCents: '--max-cost-cents',
  };
  return map[key] ?? `--${key}`;
}
