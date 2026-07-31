import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { resolveFfmpegBinaries } from '@combat/media';
import { assertSupportedLtxModel, LtxModelSupportError, type LtxModel } from '@combat/providers';

import { V2_CAMPAIGN_DIRECTORY } from '../flagship/flagship2-cli';
import { describeStagedPlates } from './canonical-plate-staging';
import { STORYBOARD_VIDEO_EXIT_CODES, type StoryboardVideoExitCode } from './failures';
import { DEFAULT_MOTION_REVIEW_DIRECTORY } from './motion-review-store';
import { runStoryboardVideo } from './run-storyboard-video';

/**
 * `pnpm aamp:full-review` — the whole cut, for a person to judge.
 *
 * A separate command from `aamp:storyboard-video`, and the separation *is* the
 * safety property. The production command refuses to composite a moving scene
 * without a standing human approval of the exact bytes; that has not changed
 * and no flag on it changes it. This command produces the artefact those
 * decisions are made **from** — continuity, pacing and the nine transitions
 * between shots are not visible in ten isolated clips, and requiring the
 * approvals first would mean approving the parts before anyone had seen the
 * whole.
 *
 * What it still refuses is a clip that failed local technical inspection. The
 * two inspection tiers already draw that line: `BINDING_TECHNICAL` means the
 * file is unusable and a reviewer looking at it is being asked the wrong
 * question, while `NOT_REVIEWED` simply means nobody has decided yet.
 *
 * `FULL_LENGTH_REVIEW_CANDIDATE` is fixed here, in the source, with no flag,
 * argument or environment variable that reaches it. There is likewise no
 * option that approves a scene: every moving scene this command renders is
 * written into `pending-human-review-ledger.json` as `PENDING_HUMAN_REVIEW`
 * with a null reviewer and a null verdict.
 */

export interface FullReviewCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: Date;
  readonly workflowRunId?: string;
}

interface Options {
  storyboard?: string;
  platesDir?: string;
  framesDir?: string;
  footagePack?: string;
  workPack?: string;
  campaignDirectory?: string;
  storyboard01?: string;
  sceneManifest?: string;
  outputDir?: string;
  reviewDir?: string;
  audioBenchmark?: string;
  notificationBrief?: string;
  provider?: string;
  model?: string;
  maxCostCents?: string;
  maxGenerations?: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

/**
 * The number of billable submissions this command may ever authorise.
 *
 * A second ceiling beside the money one, because they fail differently: a
 * routing mistake that turns four deterministic scenes into generations stays
 * under a generous cost ceiling while quietly quadrupling the number of paid
 * requests. Checked before the first upload, like the cost.
 */
export const DEFAULT_MAX_GENERATIONS = 5;

const USAGE = `aamp:full-review — assemble the whole 15-second cut so a person can judge it.

  --storyboard <dir>               the verified ten-panel storyboard package (required)
  --output-dir <dir>               where the run writes (required)
  --provider ltx-hosted            the generation provider (required)
  --model ltx-2-3-fast|ltx-2-3-pro the LTX model (required)
  --max-cost-cents <integer>       hard ceiling, checked before any upload (required)

  --plates-dir <dir>               the authoritative FRAME1PLATE…FRAME10PLATE folder; staged
                                   read-only into run-owned FRAME-01…FRAME-10 copies
  --frames-dir <dir>               an already-canonical FRAME-01…FRAME-10 folder, when no
                                   staging is wanted. One of --plates-dir or --frames-dir.
  --max-generations <integer>      hard ceiling on billable submissions (default ${DEFAULT_MAX_GENERATIONS})
  --footage-pack <dir>             the footage acquisition pack; its verified originals outrank generation
  --work-pack <dir>                the pack holding asset-root/assets.json (defaults to --footage-pack)
  --scene-manifest <file>          the ordered scene manifest (defaults to the campaign's own)
  --campaign-dir <dir>             committed campaign source; defaults to the packaged one
  --storyboard-01 <dir>            Storyboard-01's package; proven absent from this run
  --review-dir <dir>               where human motion decisions live (defaults to <output-dir>/${DEFAULT_MOTION_REVIEW_DIRECTORY})
  --audio-benchmark <dir>          a completed audio benchmark; used only if its final report says
                                   the chain finished and it holds selected mixes, otherwise the cut
                                   is marked AUDIO_TEMPORARY
  --notification-brief <file>      the authored brief carrying the locked notification treatment;
                                   composited after the motion onto the scene the brief names
  --dry-run                        plan and price it; reads no API key, makes no request, spends nothing
  --json                           print the machine-readable result
  --help

This command produces a FULL_LENGTH_REVIEW_CANDIDATE. It is not a production
master, it approves nothing, and every moving scene in it is recorded as
PENDING_HUMAN_REVIEW. To produce a master, review each scene with
"pnpm aamp:motion-review" and then run "pnpm aamp:storyboard-video", which
refuses to composite an unapproved moving scene.
`;

export function parseFullReviewArgs(argv: readonly string[]): Options {
  const options: Options = { dryRun: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    switch (token) {
      case '--storyboard':
        options.storyboard = value;
        index += 1;
        break;
      case '--plates-dir':
        options.platesDir = value;
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
      case '--work-pack':
        options.workPack = value;
        index += 1;
        break;
      case '--scene-manifest':
        options.sceneManifest = value;
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
      case '--output-dir':
        options.outputDir = value;
        index += 1;
        break;
      case '--review-dir':
        options.reviewDir = value;
        index += 1;
        break;
      case '--audio-benchmark':
        options.audioBenchmark = value;
        index += 1;
        break;
      case '--notification-brief':
        options.notificationBrief = value;
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
      case '--max-generations':
        options.maxGenerations = value;
        index += 1;
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
        // Refused by name rather than ignored: a mistyped --max-cost-cents that
        // silently fell back to a default would be the one typo here that
        // spends money.
        throw new Error(`unknown option "${token ?? ''}" — run --help.`);
    }
  }
  return options;
}

export async function runFullReviewCli(
  argv: readonly string[],
  context: FullReviewCliContext,
): Promise<StoryboardVideoExitCode> {
  let options: Options;
  try {
    options = parseFullReviewArgs(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }
  if (options.help) {
    context.stdout(USAGE);
    return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
  }

  const missing = (
    ['storyboard', 'outputDir', 'provider', 'model', 'maxCostCents'] as const
  ).filter((key) => {
    const value = options[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  if (missing.length > 0) {
    context.stderr(`missing required option(s): ${missing.map(flagFor).join(', ')}\n\n${USAGE}`);
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }
  if (!options.platesDir && !options.framesDir) {
    context.stderr(
      'one of --plates-dir or --frames-dir is required: the run needs ten authoritative keyframes.\n',
    );
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
  const maxGenerations =
    options.maxGenerations === undefined ? DEFAULT_MAX_GENERATIONS : Number(options.maxGenerations);
  if (!Number.isInteger(maxGenerations) || maxGenerations < 0) {
    context.stderr(
      `--max-generations takes a whole number of billable submissions, got "${options.maxGenerations ?? ''}"\n`,
    );
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

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

  // Read once, here, and handed straight to the run. A dry run never reads it
  // at all, which is a property of the code rather than a promise in the help
  // text.
  const apiKey = options.dryRun ? undefined : context.env.LTXV_API_KEY;

  context.stderr(
    [
      '',
      'output intent:         FULL_LENGTH_REVIEW_CANDIDATE — not a production master, approves nothing',
      `storyboard:            ${options.storyboard}`,
      `plates:                ${options.platesDir ?? '(none — using --frames-dir)'}`,
      `frames:                ${options.framesDir ?? '(staged from --plates-dir)'}`,
      `footage pack:          ${footagePackRoot ?? 'none supplied'}`,
      `model:                 ${model} @ 1080x1920, 24 fps, generate_audio false`,
      `cost ceiling:          ${maxCostCents}¢`,
      `generation ceiling:    ${maxGenerations} billable submission(s)`,
      `credential:            ${
        options.dryRun
          ? 'not read — this is a dry run'
          : apiKey && apiKey.trim().length > 0
            ? `LTXV_API_KEY present (${apiKey.trim().length} characters); never printed, logged or written`
            : 'LTXV_API_KEY absent'
      }`,
      `mode:                  ${options.dryRun ? 'DRY RUN — no key read, no request, no spend' : 'LIVE — paid generation is possible'}`,
      '',
    ].join('\n'),
  );

  const result = await runStoryboardVideo({
    outputIntent: 'FULL_LENGTH_REVIEW_CANDIDATE',
    storyboardRoot: resolve(context.cwd, options.storyboard as string),
    // `framesDirectory` is superseded by `platesDirectory` when one is given;
    // the empty string is never read in that case.
    framesDirectory: options.framesDir ? resolve(context.cwd, options.framesDir) : '',
    ...(options.platesDir ? { platesDirectory: resolve(context.cwd, options.platesDir) } : {}),
    outputDirectory: resolve(context.cwd, options.outputDir as string),
    workPackRoot,
    campaignDirectory: resolve(context.cwd, options.campaignDirectory ?? V2_CAMPAIGN_DIRECTORY),
    model,
    maxCostCents,
    maxGenerations,
    ...(footagePackRoot ? { footagePackRoot } : {}),
    ...(options.sceneManifest
      ? { sceneManifestPath: resolve(context.cwd, options.sceneManifest) }
      : {}),
    ...(options.storyboard01
      ? { storyboard01Root: resolve(context.cwd, options.storyboard01) }
      : {}),
    dryRun: options.dryRun,
    // Never asked for. The audio design is a separate decision, and a model
    // that also produced sound would put ungoverned audio into a cut whose
    // mix is deterministic.
    generateAudio: false,
    reuseGenerated: true,
    regenerateScenes: new Set<number>(),
    regenerateRejected: false,
    ...(options.reviewDir ? { reviewDirectory: resolve(context.cwd, options.reviewDir) } : {}),
    ...(options.audioBenchmark
      ? { audioBenchmarkDirectory: resolve(context.cwd, options.audioBenchmark) }
      : {}),
    ...(options.notificationBrief
      ? { notificationBriefPath: resolve(context.cwd, options.notificationBrief) }
      : {}),
    binaries: resolveFfmpegBinaries(context.env),
    workflowRunId: context.workflowRunId ?? randomUUID(),
    now: context.now ?? new Date(),
    ...(apiKey ? { apiKey } : {}),
    ...(context.env.LTX_BASE_URL ? { baseUrl: context.env.LTX_BASE_URL } : {}),
    onProgress: (message) => context.stderr(`  … ${message}\n`),
  });

  if (result.stagedPlates) {
    context.stderr(
      [
        '',
        `resolved plates (${result.stagedPlates.plates.length} of 10, read-only from ${result.stagedPlates.sourceDirectory}):`,
        describeStagedPlates(result.stagedPlates),
        '',
      ].join('\n'),
    );
  }

  if (result.decisions) {
    const generating = result.decisions.filter((decision) => decision.requiresGeneration);
    context.stderr(
      [
        'scene routing:',
        ...result.decisions.map((decision) => {
          const line = result.costEstimate?.lines.find(
            (candidate) => candidate.sceneNumber === decision.sceneNumber,
          );
          const price = line?.willGenerate ? `${String(line.costCents).padStart(3)}¢` : '   —';
          // Read from the estimate, not from `requiresGeneration`. A scene the
          // cache already covers requires generation *in principle* and buys
          // nothing in fact, and a table that called it "PAID GENERATION" at 0¢
          // told an operator the opposite of what was about to happen.
          const disposition = !decision.requiresGeneration
            ? 'no paid generation'
            : line?.willGenerate
              ? 'PAID GENERATION'
              : 'cached — no request, no charge';
          return `  scene ${String(decision.sceneNumber).padStart(2)}  ${decision.sceneRole.padEnd(26)} ${decision.selectedSourceType.padEnd(30)} ${price}  ${disposition}`;
        }),
        '',
        `generation count:      ${result.costEstimate?.generatedSceneCount ?? generating.length} scene(s) will be bought — ${
          result.costEstimate?.lines
            .filter((line) => line.willGenerate)
            .map((line) => line.sceneNumber)
            .join(', ') || 'none'
        }`,
        `scenes needing motion: ${generating.length} — ${generating.map((decision) => decision.sceneNumber).join(', ') || 'none'}`,
        `generation ceiling:    ${maxGenerations}`,
        `total maximum price:   ${result.costEstimate?.maximumTotalCostCents ?? 0}¢ of a ${maxCostCents}¢ ceiling`,
        `output routing:        ${resolve(context.cwd, options.outputDir as string)}`,
        `human-review status:   ${
          result.motionGate
            ? `${result.motionGate.rows.filter((row) => row.status !== 'APPROVED').length} of ${result.motionGate.rows.length} moving scene(s) PENDING_HUMAN_REVIEW`
            : 'not evaluated on a dry run — no clip exists to review yet'
        }`,
        '',
      ].join('\n'),
    );
  }

  if (options.json) {
    context.stdout(
      `${JSON.stringify(
        {
          outputIntent: result.outputIntent,
          exitCode: result.exitCode,
          dryRun: result.dryRun,
          maximumEstimatedCostCents: result.costEstimate?.maximumTotalCostCents ?? null,
          actualCostCents: result.actualCostCents,
          ltxCallCount: result.ltxCallCount,
          generatedSceneCount: result.generatedSceneCount,
          outputPath: result.outputPath ?? null,
          qaVerdict: result.qaVerdict ?? null,
          measured: result.measured ?? null,
          galleryPath: result.galleryPath ?? null,
          motionReviewGalleryPath: result.motionReviewGalleryPath ?? null,
          motionGate: result.motionGate ?? null,
          postMotion: (result.postMotion ?? []).map((applied) => ({
            sceneNumber: applied.sceneNumber,
            treatment: applied.compiled.treatment,
            magnitudePercent: applied.compiled.magnitudePercent,
            direction: applied.compiled.direction,
            outputChecksumSha256: applied.outputChecksumSha256,
          })),
          stagedPlates: (result.stagedPlates?.plates ?? []).map((plate) => ({
            frameId: plate.frameId,
            sourceFileName: plate.sourceFileName,
            checksumSha256: plate.checksumSha256,
            widthPx: plate.widthPx,
            heightPx: plate.heightPx,
          })),
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
        'This is a FULL_LENGTH_REVIEW_CANDIDATE. Nothing in it is approved, its',
        'creative quality is not assessed, and it is not a production master.',
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
    outputDir: '--output-dir',
    provider: '--provider',
    model: '--model',
    maxCostCents: '--max-cost-cents',
  };
  return map[key] ?? `--${key}`;
}
