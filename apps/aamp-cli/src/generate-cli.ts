#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { aampCliEnvSchema, type AampCliEnv } from '@combat/config';
import {
  CREATIVE_MEMORY_MODES,
  CreativeMemoryModeSchema,
  type CreativeMemoryMode,
} from '@combat/domain';
import {
  NodeCommandRunner,
  renderAdvertisement,
  resolveFfmpegBinaries,
  type CommandRunner,
} from '@combat/media';
import {
  ComfyUIVideoGenerationProvider,
  createClaudeReasoningProvider,
  createVideoGenerationProvider,
  type ReasoningProvider,
  type VideoGenerationProvider,
} from '@combat/providers';

import { buildRenderManifest } from './build-render-manifest';
import {
  CreativeMemoryInjectionError,
  CreativeMemoryInjector,
  type CreativeMemoryDependencies,
} from './creative-memory/injection';
import {
  CampaignRequestValidationError,
  loadCampaignRequest,
  type CampaignRequest,
} from './campaign-request';
import { planCampaign } from './plan-campaign';
import { parseProductionAssetManifest } from './production-assets';
import { buildHumanPlanTemplate } from './preview/human-plan';
import { runPreviewCampaign } from './preview/run-preview-campaign';
import {
  executionModeFlagFor,
  parseExecutionModeFlag,
  type AampExecutionMode,
} from './production/aamp-execution-mode';
import { buildRunProvenance } from './production/campaign-run-provenance';
import {
  AampDependencyError,
  createAampDependencies,
  requireReasoningProvider,
  type AampDependencies,
  type AampDependencyFailure,
} from './production/dependency-factory';
import { writeRunProvenance } from './production/run-provenance';
import {
  EXIT_CODES,
  runDirectoryFor,
  runSourceCampaign,
  type SourceCampaignResult,
} from './run-source-campaign';
import {
  describeExecutionMode,
  isFullyReal,
  resolveExecutionMode,
  usesFixtureGeneration,
  type ExecutionProvenance,
} from './execution-mode';
import { FixtureVideoGenerationProvider } from './fixture-generation';
import { createFixtureReasoningProvider } from './fixture-reasoning';
import { generateShots, type GeneratedShotResult } from './generate-shots';
import {
  GenerationManifestValidationError,
  parseGenerationManifest,
  type CampaignGenerationManifest,
  type ManifestAsset,
} from './generation-manifest';
import { runAgentPipeline } from './run-agents';

/**
 * `pnpm aamp:generate --manifest <campaign-generation-manifest.json>` — the
 * whole chain in one command: prompt → existing specialist agents → shot
 * specifications → real ComfyUI generation → generated clips → the existing
 * FFmpeg renderer → actual-media QA → a downloadable 1080×1920 MP4.
 *
 * It reuses, rather than re-implements, every stage that already exists:
 * `AGENT_REGISTRY` and `executeAgent` for the creative chain,
 * `VideoGenerationProvider` for generation, `@combat/media`'s
 * `renderAdvertisement` (which runs the real FFmpeg graph and the binding
 * actual-media QA) for the cut. There is no second agent framework and no
 * second renderer here — only composition.
 *
 * Like `runRenderCli`, the whole run is a function taking its environment as
 * arguments, so tests execute the real entry point.
 */

const DEFAULT_OUTPUT_DIRECTORY = '.aamp-output';

export interface GenerateCliOptions {
  /** Canonical input: a campaign request describing what to advertise and why. */
  readonly requestPath?: string;
  /** Overrides the request's own `sourceAssetManifest`. */
  readonly assetsPath?: string;
  /** Overrides the request's own `outputDirectory`. */
  readonly outputDirectory?: string;
  /** Legacy input from the ComfyUI gateway milestone. Still supported. */
  readonly manifestPath?: string;
  readonly outputRoot?: string;
  readonly json: boolean;
  /** Stops after the agents have produced shot briefs. */
  readonly planOnly: boolean;
  /**
   * Opt in to replayed fixture creative. Without it, a run that has no real
   * reasoning provider fails rather than quietly producing generic output.
   */
  readonly fixtureDemo: boolean;
  /**
   * Whether approved benchmark intelligence may influence this campaign.
   * Defaults to `off`, so an existing command line behaves exactly as it did
   * before this milestone.
   */
  readonly creativeMemory: CreativeMemoryMode;
  /**
   * A validated, human-authored creative plan.
   *
   * Its presence selects `HUMAN_ASSISTED_PREVIEW`: no reasoning provider and no
   * generation provider is constructed, so neither can be called.
   */
  readonly planFile?: string;
  /** The external directory every production asset must canonicalise inside. */
  readonly assetRoot?: string;
  /** Writes a deterministic plan skeleton for the request and exits. */
  readonly emitPlanTemplate: boolean;
  /**
   * The **required minimum** infrastructure tier.
   *
   * Absent means "require nothing" — the attained tier is still derived from
   * the dependencies that were actually built and reported everywhere. Present,
   * it can only cause a refusal: it never promotes a run's label, which is what
   * stops a local demonstration being filed as a production result.
   */
  readonly executionMode?: AampExecutionMode;
  /**
   * Set internally when `--creative-memory optional` could not reach retrieval
   * and the run continued without it. Recorded as the run's `fallbackReason`;
   * it is never a way to substitute anything.
   */
  readonly creativeMemoryDegraded?: boolean;
}

export function parseGenerateCliArguments(argv: readonly string[]): GenerateCliOptions {
  let requestPath: string | undefined;
  let assetsPath: string | undefined;
  let outputDirectory: string | undefined;
  let manifestPath: string | undefined;
  let outputRoot: string | undefined;
  let json = false;
  let planOnly = false;
  let fixtureDemo = false;
  let creativeMemory: CreativeMemoryMode = 'off';
  let executionMode: AampExecutionMode | undefined;
  let planFile: string | undefined;
  let assetRoot: string | undefined;
  let emitPlanTemplate = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--execution-mode': {
        const value = argv[++i];
        const parsed = parseExecutionModeFlag(value);
        if (!parsed) {
          throw new Error(
            `--execution-mode must be one of fixture|human-assisted-preview|local-production|production (got "${value ?? ''}")`,
          );
        }
        executionMode = parsed;
        break;
      }
      case '--creative-memory': {
        const value = argv[++i];
        const parsed = CreativeMemoryModeSchema.safeParse(value);
        if (!parsed.success) {
          throw new Error(
            `--creative-memory must be one of ${CREATIVE_MEMORY_MODES.join('|')} (got "${value ?? ''}")`,
          );
        }
        creativeMemory = parsed.data;
        break;
      }
      case '--request':
        requestPath = argv[++i];
        break;
      case '--assets':
        assetsPath = argv[++i];
        break;
      case '--plan-file':
        planFile = argv[++i];
        break;
      case '--asset-root':
        assetRoot = argv[++i];
        break;
      case '--emit-plan-template':
        emitPlanTemplate = true;
        break;
      case '--output-dir':
        outputDirectory = argv[++i];
        break;
      case '--manifest':
        manifestPath = argv[++i];
        break;
      case '--output-root':
        outputRoot = argv[++i];
        break;
      case '--json':
        json = true;
        break;
      case '--plan-only':
        planOnly = true;
        break;
      case '--fixture-demo':
        fixtureDemo = true;
        break;
      default:
        if (arg && arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    }
  }

  if (!requestPath && !manifestPath) {
    throw new Error(
      [
        'Usage: aamp:generate --request <campaign-request.json> [--assets <production-assets.json>] [--output-dir <dir>]',
        '',
        'Zero-cost footage-first preview:',
        '  --plan-file <validated-plan.json>',
        '                   execute a human-authored creative plan. Selects HUMAN_ASSISTED_PREVIEW:',
        '                   no reasoning provider and no generation provider is constructed, so',
        '                   neither can be called and no paid work is possible.',
        '  --asset-root <dir>',
        '                   the external directory every production asset must canonicalise inside.',
        '  --emit-plan-template',
        '                   write a deterministic plan skeleton for this request to stdout and exit.',
        '',
        '  --execution-mode fixture|human-assisted-preview|local-production|production',
        '                   the minimum infrastructure tier this run must reach (default: require nothing,',
        '                   report whatever was attained). Never promotes a label; only refuses.',
        '  --creative-memory required|optional|off',
        '                   whether approved benchmark intelligence may influence this campaign (default: off)',
        '  --fixture-demo   replay committed fixture creative instead of calling a real reasoning model',
        '  --plan-only      stop after planning, before any render',
        '  --json           machine-readable output',
        '',
        'The legacy --manifest <generation-manifest.json> form from the ComfyUI gateway milestone is still accepted.',
      ].join('\n'),
    );
  }
  return {
    ...(requestPath ? { requestPath } : {}),
    ...(assetsPath ? { assetsPath } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    ...(outputRoot ? { outputRoot } : {}),
    json,
    planOnly,
    fixtureDemo,
    creativeMemory,
    emitPlanTemplate,
    ...(planFile ? { planFile } : {}),
    ...(assetRoot ? { assetRoot } : {}),
    ...(executionMode ? { executionMode } : {}),
  };
}

export async function findRepositoryRoot(startDir: string): Promise<string> {
  let current = resolve(startDir);
  for (;;) {
    try {
      await stat(resolve(current, 'pnpm-workspace.yaml'));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(startDir);
      current = parent;
    }
  }
}

export interface GenerateCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly runner?: CommandRunner;
  readonly now?: () => Date;
  /** Overridable so an integration test can drive a fake endpoint. */
  readonly providerOverride?: VideoGenerationProvider;
  readonly workflowRunId?: string;
  /**
   * Creative Memory collaborators, injected so tests run against the in-memory
   * reference store and an in-process Qdrant. Production builds them from env,
   * and there is no environment variable that can select a fake here.
   */
  readonly creativeMemoryDependencies?: CreativeMemoryDependencies;
}

/**
 * `MockReasoningProvider` is deliberately not used here: it returns an empty
 * echo shape, so every agent would fail schema validation and the command
 * could not run at all without a paid key. The fixture provider replays
 * committed golden results instead — and the caller announces that the
 * creative is canned, because it is.
 */
async function resolveReasoning(env: AampCliEnv, shotCount: number): Promise<ReasoningProvider> {
  if (env.REASONING_PROVIDER === 'claude') {
    return createClaudeReasoningProvider(env.ANTHROPIC_API_KEY!);
  }
  return createFixtureReasoningProvider(shotCount);
}

/**
 * Resolves a manifest-relative asset path and refuses anything outside the
 * allowed roots — the same containment discipline `@combat/media`'s source
 * resolution applies, enforced here too because this is where operator-
 * supplied paths first enter the system.
 */
function resolveAssetPath(
  asset: ManifestAsset,
  manifestDir: string,
  allowedRoots: readonly string[],
): string {
  const absolute = isAbsolute(asset.path) ? resolve(asset.path) : resolve(manifestDir, asset.path);
  const contained = allowedRoots.some((root) => {
    const normalisedRoot = resolve(root);
    return (
      absolute === normalisedRoot ||
      absolute.startsWith(`${normalisedRoot}\\`) ||
      absolute.startsWith(`${normalisedRoot}/`)
    );
  });
  if (!contained) {
    throw new Error(
      `Asset "${asset.id}" resolves to ${absolute}, which is outside every allowed source root`,
    );
  }
  return absolute;
}

/**
 * Dispatches on which input form was given.
 *
 * `--request` is the canonical interface introduced by the prompt-driven
 * source milestone. `--manifest` is the ComfyUI gateway milestone's generation
 * manifest, kept working so that flow and its acceptance test remain usable —
 * the two describe genuinely different things (a campaign versus a cut), so
 * they get different code paths rather than one contorted union.
 */
export async function runGenerateCli(
  argv: readonly string[],
  context: GenerateCliContext,
): Promise<number> {
  let options: GenerateCliOptions;
  try {
    options = parseGenerateCliArguments(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (options.requestPath) {
    if (options.emitPlanTemplate) return emitPlanTemplateCli(options, context);
    if (options.planFile) return runHumanAssistedPreviewCli(options, context);
    return runCampaignRequestCli(options, context);
  }
  return runLegacyManifestCli(options, context);
}

/** Loads the request the two preview entry points share. */
async function loadRequestFor(
  options: GenerateCliOptions,
  repositoryRoot: string,
): Promise<CampaignRequest> {
  const requestPath = isAbsolute(options.requestPath!)
    ? options.requestPath!
    : resolve(repositoryRoot, options.requestPath!);
  const request = await loadCampaignRequest(requestPath);
  if (!options.assetsPath) return request;
  return {
    ...request,
    sourceAssetManifestPath: isAbsolute(options.assetsPath)
      ? options.assetsPath
      : resolve(repositoryRoot, options.assetsPath),
  };
}

async function emitPlanTemplateCli(
  options: GenerateCliOptions,
  context: GenerateCliContext,
): Promise<number> {
  const repositoryRoot = await findRepositoryRoot(context.cwd);
  try {
    const request = await loadRequestFor(options, repositoryRoot);
    const authoredAt = (context.now ? context.now() : new Date()).toISOString();
    context.stdout(`${JSON.stringify(buildHumanPlanTemplate(request, authoredAt), null, 2)}\n`);
    context.stderr(
      "This is a skeleton, not a plan. Every TODO is a decision only a person can make; a template that rendered as-is would make this mode's claim untrue on first use.\n",
    );
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    context.stderr(
      `${
        error instanceof CampaignRequestValidationError
          ? error.message
          : `Could not read the campaign request: ${error instanceof Error ? error.message : String(error)}`
      }\n`,
    );
    return EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }
}

/**
 * The zero-cost, footage-first preview.
 *
 * Deliberately does *not* go through `createAampDependencies`: that factory's
 * job is to build reasoning, generation, persistence and retrieval
 * collaborators, and this mode's entire claim is that none of the first two
 * exist. Asking the composition root for a run with no reasoning provider and
 * then not using it would leave the call path in place; not asking removes it.
 * The FFmpeg toolchain — the one collaborator a preview genuinely needs — is
 * verified here explicitly, before anything is read.
 */
async function runHumanAssistedPreviewCli(
  options: GenerateCliOptions,
  context: GenerateCliContext,
): Promise<number> {
  const repositoryRoot = await findRepositoryRoot(context.cwd);

  let request: CampaignRequest;
  try {
    request = await loadRequestFor(options, repositoryRoot);
  } catch (error) {
    context.stderr(
      `${
        error instanceof CampaignRequestValidationError
          ? error.message
          : `Could not read the campaign request: ${error instanceof Error ? error.message : String(error)}`
      }\n`,
    );
    return EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

  if (options.executionMode && options.executionMode !== 'HUMAN_ASSISTED_PREVIEW') {
    context.stderr(
      `--plan-file selects HUMAN_ASSISTED_PREVIEW, but --execution-mode ${executionModeFlagFor(options.executionMode)} was required. A human-authored plan cannot attain that mode: the creative did not come from a model.\n`,
    );
    return EXIT_CODES.EXECUTION_MODE_NOT_ATTAINED;
  }

  const planPath = isAbsolute(options.planFile!)
    ? options.planFile!
    : resolve(repositoryRoot, options.planFile!);
  const assetRoot = options.assetRoot
    ? isAbsolute(options.assetRoot)
      ? options.assetRoot
      : resolve(repositoryRoot, options.assetRoot)
    : dirname(request.sourceAssetManifestPath);

  const workflowRunId = context.workflowRunId ?? `aamp-cli-${randomUUID()}`;
  const outputRoot = options.outputDirectory
    ? resolve(repositoryRoot, options.outputDirectory)
    : resolve(repositoryRoot, request.outputDirectory);
  const runDirectory = runDirectoryFor(outputRoot, request.name, workflowRunId);
  const runner = context.runner ?? new NodeCommandRunner();
  const binaries = resolveFfmpegBinaries(context.env);

  // The banner, before any work. Everything an operator needs to know that
  // this run cannot spend money is stated up front rather than inferred from
  // the absence of a warning.
  const banner = [
    '',
    'PAID PROVIDER CALLS DISABLED',
    'AUTONOMOUS REASONING NOT USED',
    'OUTPUT IS A HUMAN-ASSISTED PREVIEW',
    '',
    `execution mode:        HUMAN_ASSISTED_PREVIEW`,
    `paid calls possible:   NO — no reasoning provider and no generation provider is constructed`,
    `plan file:             ${planPath}`,
    `asset root:            ${assetRoot}`,
    `output directory:      ${runDirectory}`,
  ];

  // The asset counts need the manifest, which is cheap to read and is the
  // first thing that can be wrong. Reading it here means the banner reports
  // real numbers rather than promising to find some later.
  let outputEligibleCount = 0;
  let analysisOnlyReferenceCount = 0;
  try {
    const manifest = parseProductionAssetManifest(
      JSON.parse(await readFile(request.sourceAssetManifestPath, 'utf8')),
      request.sourceAssetManifestPath,
    );
    outputEligibleCount = manifest.assets.length;
    analysisOnlyReferenceCount = await countAnalysisOnlyReferences(assetRoot);
  } catch {
    // A manifest that cannot be read is reported properly by the run itself,
    // with the full validation detail. The banner simply says it is unknown.
  }

  banner.push(
    `output-eligible assets: ${outputEligibleCount || 'unknown until preflight'}`,
    `analysis-only refs:     ${analysisOnlyReferenceCount} (counted, never resolved, never eligible for output)`,
    'expected artefacts:     storyboard.json, storyboard.html, contact-sheet.png,',
    '                        source-selection-report.json, audio-plan.json, render-summary.json,',
    '                        render-manifest.json, asset-preflight.json, creative-plan.json,',
    '                        originality-report.json, creative-scorecard.json and the measured MP4',
    '',
  );
  if (!options.json) context.stderr(`${banner.join('\n')}\n`);

  const progress = (message: string): void => {
    if (!options.json) context.stderr(`  ${message}\n`);
  };

  const result = await runPreviewCampaign({
    request,
    planPath,
    assetRoot,
    runDirectory,
    repositoryRoot,
    binaries,
    workflowRunId,
    now: context.now ? context.now() : new Date(),
    runner,
    onProgress: progress,
  });

  if (options.json) {
    context.stdout(
      `${JSON.stringify(
        {
          executionMode: 'HUMAN_ASSISTED_PREVIEW',
          isRealCampaignRun: false,
          paidProviderCalls: 0,
          planningSource: 'HUMAN_SUPPLIED_STRUCTURED_PLAN',
          promptSha256: request.promptSha256,
          exitCode: result.exitCode,
          runDirectory: result.runDirectory,
          outputPath: result.outputPath ?? null,
          qaVerdict: result.qaVerdict ?? null,
          measuredDurationSeconds: result.measuredDurationSeconds ?? null,
          measuredResolution: result.measuredResolution ?? null,
          measuredCodecs: result.measuredCodecs ?? null,
          measuredLoudnessLufs: result.measuredLoudnessLufs ?? null,
          measuredPeakDbtp: result.measuredPeakDbtp ?? null,
          outputChecksumSha256: result.outputChecksumSha256 ?? null,
          nonZeroInPointCount: result.nonZeroInPointCount ?? 0,
          qaFailedChecks: result.qaFailedChecks ?? [],
          artefacts: result.artefacts ?? [],
          failure: result.failure ?? null,
        },
        null,
        2,
      )}\n`,
    );
  } else if (result.exitCode === EXIT_CODES.SUCCESS || result.exitCode === EXIT_CODES.QA_FAILURE) {
    context.stdout(
      `${[
        `execution mode:    HUMAN_ASSISTED_PREVIEW`,
        `real campaign run: NO`,
        `paid calls:        0`,
        `planning source:   HUMAN_SUPPLIED_STRUCTURED_PLAN (${result.plan?.authoredBy ?? 'unknown'})`,
        `campaign ID:       ${request.campaignId}`,
        `prompt sha256:     ${request.promptSha256}`,
        `run directory:     ${result.runDirectory}`,
        `final MP4:         ${result.outputPath ?? 'none'}`,
        `duration:          ${
          result.measuredDurationSeconds === null || result.measuredDurationSeconds === undefined
            ? 'unknown'
            : `${result.measuredDurationSeconds.toFixed(3)}s`
        }`,
        `resolution:        ${result.measuredResolution ?? '?'}`,
        `codecs:            ${result.measuredCodecs ?? '?'}`,
        `loudness:          ${result.measuredLoudnessLufs ?? 'not measured'} LUFS (measured from the file)`,
        `true peak:         ${result.measuredPeakDbtp ?? 'not measured'} dB (measured from the file)`,
        `non-zero in-points:${' '}${result.nonZeroInPointCount ?? 0} of ${result.preflight?.assets.filter((a) => a.kind === 'VIDEO').length ?? 0} video segments`,
        `QA status:         ${result.qaVerdict ?? 'unknown'}`,
        `output sha256:     ${result.outputChecksumSha256 ?? 'none'}`,
        `status:            ${result.exitCode === EXIT_CODES.SUCCESS ? 'RENDERED — REQUIRES HUMAN APPROVAL' : 'REJECTED BY QA'}`,
      ].join('\n')}\n`,
    );
  }

  if (result.failure) context.stderr(`\n${result.failure}\n`);
  if (result.exitCode === EXIT_CODES.SUCCESS) {
    context.stderr(
      '\nWARNING: HUMAN_ASSISTED_PREVIEW — the creative decisions were made by a person and executed deterministically. No reasoning model and no generation provider was called. This is not an autonomous campaign result, and human approval is still required before publication.\n',
    );
  }
  return result.exitCode;
}

/** Counts reference files without resolving, reading or measuring any of them. */
async function countAnalysisOnlyReferences(assetRoot: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(resolve(assetRoot, 'references'), {
      withFileTypes: true,
      recursive: true,
    });
    return entries.filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

async function runLegacyManifestCli(
  options: GenerateCliOptions,
  context: GenerateCliContext,
): Promise<number> {
  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const legacyManifest = options.manifestPath as string;
  const manifestPath = isAbsolute(legacyManifest)
    ? legacyManifest
    : resolve(repositoryRoot, legacyManifest);
  const manifestDir = dirname(manifestPath);
  const outputRoot = options.outputRoot
    ? resolve(repositoryRoot, options.outputRoot)
    : resolve(repositoryRoot, DEFAULT_OUTPUT_DIRECTORY);

  let env: AampCliEnv;
  try {
    env = aampCliEnvSchema.parse(context.env);
  } catch (error) {
    context.stderr(
      `Configuration is invalid:\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  let manifest: CampaignGenerationManifest;
  try {
    manifest = parseGenerationManifest(
      JSON.parse(await readFile(manifestPath, 'utf8')),
      manifestPath,
    );
  } catch (error) {
    context.stderr(
      `${error instanceof GenerationManifestValidationError ? error.message : `Could not read manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`}\n`,
    );
    return 2;
  }

  const progress = (message: string): void => {
    if (!options.json) context.stderr(`  ${message}\n`);
  };

  const workflowRunId = context.workflowRunId ?? `aamp-cli-${randomUUID()}`;

  // Announced before any work starts, and repeated on the result. A reader who
  // sees only the first line or only the last must still know what they have.
  const executionMode = resolveExecutionMode({
    reasoningProvider: env.REASONING_PROVIDER,
    videoGenerationProvider: env.VIDEO_GENERATION_PROVIDER,
  });
  context.stderr(
    `${isFullyReal(executionMode) ? '' : 'WARNING: '}${describeExecutionMode(executionMode)}\n`,
  );

  let resolvedAssets: { asset: ManifestAsset; absolutePath: string }[];
  try {
    resolvedAssets = manifest.assets.map((asset) => ({
      asset,
      absolutePath: resolveAssetPath(asset, manifestDir, [repositoryRoot, manifestDir]),
    }));
    for (const entry of resolvedAssets) {
      // eslint-disable-next-line no-await-in-loop -- a missing asset should be reported in manifest order
      await stat(entry.absolutePath);
    }
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // --- 1-3: agents produce structured shot specifications -------------------
  let pipeline;
  try {
    pipeline = await runAgentPipeline({
      manifest,
      reasoningProvider: await resolveReasoning(env, manifest.generation.shotCount),
      workflowRunId,
      onProgress: progress,
    });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (options.planOnly) {
    context.stdout(
      `${JSON.stringify(
        { executionMode, campaignId: manifest.campaignId, shotBriefs: pipeline.shotBriefs },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const binaries = resolveFfmpegBinaries(context.env);

  // --- 4-6: generation, retrieved and measured ------------------------------
  let provider: VideoGenerationProvider;
  try {
    if (context.providerOverride) {
      provider = context.providerOverride;
    } else if (env.VIDEO_GENERATION_PROVIDER === 'comfyui') {
      const comfyui = createVideoGenerationProvider({
        kind: 'comfyui',
        nodeEnv: env.NODE_ENV,
        comfyui: {
          baseUrl: env.COMFYUI_BASE_URL!,
          workflowProfile: manifest.generation.profile,
          clientId: env.COMFYUI_CLIENT_ID,
          outputTimeoutMs: env.COMFYUI_OUTPUT_TIMEOUT_MS,
          outputDirectory: resolve(repositoryRoot, env.COMFYUI_OUTPUT_DIR),
          ...(env.COMFYUI_API_KEY ? { apiKey: env.COMFYUI_API_KEY } : {}),
        },
      });

      // Real generation was explicitly requested, so an endpoint that cannot
      // actually run this profile is a hard failure here — before any budget,
      // any GPU time, and above all before anything downstream could present a
      // substituted result as genuine. There is no fallback path.
      if (comfyui instanceof ComfyUIVideoGenerationProvider) {
        progress(`verifying ComfyUI endpoint for profile ${manifest.generation.profile}`);
        const environment = await comfyui.verifyEnvironment();
        if (!environment.compatible) {
          context.stderr(
            `Real generation was requested (VIDEO_GENERATION_PROVIDER=comfyui) but the endpoint cannot run profile ${manifest.generation.profile}:\n${environment.problems
              .map((problem) => `  - ${problem}`)
              .join(
                '\n',
              )}\nRefusing to continue. This command will not substitute fixture footage for real generation.\n`,
          );
          return 3;
        }
      }
      provider = comfyui;
    } else {
      // Demo path. `MockVideoGenerationProvider` produces no file at all, so
      // the render and QA stages would be unreachable; a synthetic test
      // pattern keeps them exercisable. Everything downstream labels it.
      provider = new FixtureVideoGenerationProvider({
        runner: context.runner ?? new NodeCommandRunner(),
        binaries,
        outputDirectory: resolve(repositoryRoot, env.COMFYUI_OUTPUT_DIR),
      });
    }
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let generatedShots: readonly GeneratedShotResult[];
  try {
    generatedShots = await generateShots({
      manifest,
      briefs: pipeline.shotBriefs,
      provider,
      binaries,
      workflowRunId,
      referenceAssets: resolvedAssets.filter((entry) => entry.asset.role === 'REFERENCE_IMAGE'),
      onProgress: progress,
    });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // --- 7-11: build the render manifest, render for real, QA the result ------
  let renderManifest;
  try {
    renderManifest = buildRenderManifest({
      manifest,
      generatedShots,
      resolvedAssets: resolvedAssets.filter((entry) => entry.asset.role !== 'REFERENCE_IMAGE'),
    });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Written out so a failed render can be re-run through `pnpm aamp:render`
  // against exactly the same timeline, without re-paying for generation.
  const builtManifestPath = resolve(outputRoot, `${manifest.name}.render-manifest.json`);
  await mkdir(dirname(builtManifestPath), { recursive: true });
  await writeFile(builtManifestPath, `${JSON.stringify(renderManifest, null, 2)}\n`, 'utf8');

  let result;
  try {
    result = await renderAdvertisement(context.runner ?? new NodeCommandRunner(), {
      manifest: renderManifest,
      manifestDir: outputRoot,
      allowedSourceRoots: [repositoryRoot, manifestDir, outputRoot],
      outputRoot,
      binaries,
      now: context.now ? context.now() : new Date(),
    });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Provenance travels with the deliverable, not just with the terminal that
  // produced it. An MP4 that outlives this shell must still be able to say
  // whether a model made it.
  const provenance: ExecutionProvenance = {
    executionMode,
    reasoningProvider: env.REASONING_PROVIDER,
    videoGenerationProvider: env.VIDEO_GENERATION_PROVIDER,
    workflowProfile: usesFixtureGeneration(executionMode) ? 'FIXTURE' : manifest.generation.profile,
    campaignId: manifest.campaignId,
    workflowRunId,
    isRealAdvertisement: isFullyReal(executionMode),
    caveat: describeExecutionMode(executionMode),
    generatedShots: generatedShots.map((shot) => ({
      shotId: shot.brief.shotId,
      localPath: shot.localPath,
      checksumSha256: shot.checksumSha256,
      measuredDurationSeconds: shot.measuredDurationSeconds,
      measuredWidthPx: shot.measuredWidthPx,
      measuredHeightPx: shot.measuredHeightPx,
      measuredVideoCodec: shot.measuredVideoCodec,
      synthetic: usesFixtureGeneration(executionMode),
    })),
  };
  const provenancePath = `${result.outputPath}.generation-provenance.json`;
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

  const { summary } = result.qaReport;
  if (options.json) {
    context.stdout(
      `${JSON.stringify(
        {
          executionMode,
          isRealAdvertisement: provenance.isRealAdvertisement,
          caveat: provenance.caveat,
          campaignId: manifest.campaignId,
          generationProfile: provenance.workflowProfile,
          generatedShotPaths: generatedShots.map((shot) => shot.localPath),
          outputPath: result.outputPath,
          qaReport: result.qaReport,
          qaReportPath: result.qaReportPath,
          provenancePath,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    context.stdout(
      `${[
        `execution mode:    ${executionMode}`,
        `campaign ID:       ${manifest.campaignId}`,
        `generation profile:${' '}${provenance.workflowProfile}`,
        `generated shots:   ${generatedShots.map((shot) => shot.localPath).join('\n                   ')}`,
        `final MP4:         ${result.outputPath}`,
        `duration:          ${summary.durationSeconds === null ? 'unknown' : `${summary.durationSeconds.toFixed(3)}s`}`,
        `resolution:        ${summary.widthPx ?? '?'}x${summary.heightPx ?? '?'}`,
        `codecs:            ${summary.videoCodec ?? 'none'} / ${summary.audioCodec ?? 'none'}`,
        `QA status:         ${result.qaReport.verdict}`,
        `QA report:         ${result.qaReportPath}`,
        `provenance:        ${provenancePath}`,
      ].join('\n')}\n`,
    );
    // Repeated after the result, not only before it: a PASS verdict beside a
    // 1080x1920 path reads as a finished advertisement, and for three of the
    // four modes it is not one.
    if (!isFullyReal(executionMode)) {
      context.stderr(`\nWARNING: ${describeExecutionMode(executionMode)}\n`);
    }
  }

  if (result.qaReport.verdict !== 'PASS') {
    const failures = result.qaReport.measurements.filter((m) => m.verdict === 'FAIL');
    context.stderr(
      `\nfailed checks:\n${failures
        .map((m) => `  - ${m.check}: measured ${String(m.measured)}, expected ${m.expected}`)
        .join('\n')}\n`,
    );
    return 1;
  }
  return 0;
}

/**
 * The canonical flow: a campaign request, real reasoning, real owned assets, a
 * deterministic render, and a run directory that records every decision.
 *
 * Every collaborator now comes from `createAampDependencies` — the one AAMP
 * composition root. This function no longer constructs a PrismaClient, a Qdrant
 * client, an embedder or a reasoning provider of its own; it decides *what the
 * run needs*, asks for it, and is refused with a typed error when it cannot be
 * had. That is what makes `--execution-mode production` enforceable rather than
 * advisory.
 */
async function runCampaignRequestCli(
  options: GenerateCliOptions,
  context: GenerateCliContext,
): Promise<number> {
  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const requestPath = isAbsolute(options.requestPath!)
    ? options.requestPath!
    : resolve(repositoryRoot, options.requestPath!);
  const startedAt = context.now ? context.now() : new Date();

  let request: CampaignRequest;
  try {
    request = await loadCampaignRequest(requestPath);
  } catch (error) {
    context.stderr(
      `${
        error instanceof CampaignRequestValidationError
          ? error.message
          : `Could not read campaign request at ${requestPath}: ${error instanceof Error ? error.message : String(error)}`
      }\n`,
    );
    return EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

  // CLI flags override the request's own paths, so one request file can be
  // pointed at a different asset library or output root without editing it.
  if (options.assetsPath) {
    request = {
      ...request,
      sourceAssetManifestPath: isAbsolute(options.assetsPath)
        ? options.assetsPath
        : resolve(repositoryRoot, options.assetsPath),
    };
  }

  const workflowRunId = context.workflowRunId ?? `aamp-cli-${randomUUID()}`;
  const outputRoot = options.outputDirectory
    ? resolve(repositoryRoot, options.outputDirectory)
    : resolve(repositoryRoot, request.outputDirectory);
  const runDirectory = runDirectoryFor(outputRoot, request.name, workflowRunId);
  const now = context.now ? context.now() : new Date();
  const progress = (message: string): void => {
    if (!options.json) context.stderr(`  ${message}\n`);
  };

  // --- the composition root -------------------------------------------------
  let dependencies: AampDependencies;
  try {
    dependencies = await createAampDependencies({
      env: context.env,
      creativeMemoryMode: options.creativeMemory,
      runMode: options.fixtureDemo ? 'FIXTURE_DEMO' : 'REAL',
      repositoryRoot,
      requiresRendering: !options.planOnly,
      generation: request.generation.source === 'COMFYUI' ? 'COMFYUI' : 'NONE',
      comfyuiProfile: request.generation.comfyuiProfile,
      ...(options.executionMode ? { requestedExecutionMode: options.executionMode } : {}),
      fixtures: {
        // Supplied by the caller, not imported by the factory, so a production
        // run refuses them structurally rather than by remembering to check.
        reasoning: () => createFixtureReasoningProvider(12),
        videoGeneration: () =>
          new FixtureVideoGenerationProvider({
            runner: context.runner ?? new NodeCommandRunner(),
            binaries: resolveFfmpegBinaries(context.env),
            outputDirectory: resolve(repositoryRoot, '.aamp-output/generated'),
          }),
      },
      overrides: {
        ...(context.creativeMemoryDependencies
          ? { creativeMemoryDependencies: context.creativeMemoryDependencies }
          : {}),
        ...(context.runner ? { runner: context.runner } : {}),
        ...(context.providerOverride ? { videoGenerationProvider: context.providerOverride } : {}),
      },
      onProgress: progress,
    });
  } catch (error) {
    if (error instanceof AampDependencyError) {
      context.stderr(`${error.message}\n`);
      const retrievalFailure =
        error.kind === 'VECTOR_STORE_UNAVAILABLE' ||
        error.kind === 'DATABASE_UNAVAILABLE' ||
        error.kind === 'EMBEDDING_PROVIDER_UNAVAILABLE';

      if (options.creativeMemory === 'required' && retrievalFailure) {
        context.stderr(
          'Refusing to continue. This command will not plan a campaign without the governed benchmark context it was told to use.\n',
        );
        return EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE;
      }
      // `optional` Creative Memory is the one dependency failure that is
      // allowed to degrade — and only when the *absence of retrieval* is what
      // failed, never when the composition itself did.
      if (options.creativeMemory === 'optional' && retrievalFailure) {
        context.stderr(
          'WARNING: Creative Memory is unavailable and the mode is "optional"; planning will proceed without benchmark context. No fixture creative or generic benchmark text is substituted.\n',
        );
        return runCampaignRequestCli(
          { ...options, creativeMemory: 'off', creativeMemoryDegraded: true },
          context,
        );
      }
      return DEPENDENCY_EXIT_CODES[error.kind];
    }
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.DEPENDENCY_UNAVAILABLE;
  }

  const { label, reasoningPolicy: policy } = dependencies;
  context.stderr(
    `${label.isRealCampaignRun ? '' : 'WARNING: '}execution mode ${dependencies.executionMode}: ${label.caveat}\n`,
  );
  context.stderr(
    policy.runMode === 'REAL'
      ? `run mode: REAL — reasoning via ${policy.providerName} (${policy.reasoningModel}); prompt sha256 ${request.promptSha256.slice(0, 16)}…\n`
      : `WARNING: run mode: FIXTURE_DEMO — creative is replayed from committed fixtures and ignores this campaign prompt. Not a campaign result.\n`,
  );
  context.stderr(`creative memory: ${options.creativeMemory}\n`);

  // Guarded on the mode as well as on the dependency: `off` must perform no
  // retrieval, not a retrieval that happens to return nothing.
  const injector =
    options.creativeMemory !== 'off' && dependencies.creativeMemory
      ? new CreativeMemoryInjector({
          mode: options.creativeMemory,
          dependencies: dependencies.creativeMemory,
          workspaceId: request.workspaceId,
          campaignId: request.campaignId,
          platform: request.platform,
          now,
          onProgress: progress,
        })
      : undefined;

  const writeProvenance = async (
    result: SourceCampaignResult | undefined,
    failureReason: string | null,
  ): Promise<string | undefined> => {
    try {
      return await writeRunProvenance(
        runDirectory,
        buildRunProvenance({
          request,
          dependencies,
          creativeMemoryMode: options.creativeMemory,
          audits: injector?.audits ?? [],
          workflowRunId,
          startedAt,
          completedAt: context.now ? context.now() : new Date(),
          ...(result ? { result } : {}),
          failureReason,
          fallbackReason: options.creativeMemoryDegraded
            ? 'Creative Memory was optional and unavailable; the run proceeded with no benchmark context.'
            : null,
        }),
      );
    } catch (error) {
      context.stderr(
        `WARNING: could not write run provenance: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    }
  };

  try {
    if (options.planOnly) {
      try {
        const plan = await planCampaign({
          request,
          reasoningProvider: requireReasoningProvider(dependencies),
          workflowRunId,
          ...(injector ? { injector } : {}),
          onProgress: progress,
        });
        const provenancePath = await writeProvenance(undefined, null);
        context.stdout(
          `${JSON.stringify(
            {
              executionMode: dependencies.executionMode,
              isRealCampaignRun: label.isRealCampaignRun,
              caveat: label.caveat,
              runMode: policy.runMode,
              creativeMemoryMode: options.creativeMemory,
              promptSha256: request.promptSha256,
              agentVersions: plan.agentVersions,
              shots: plan.shots,
              captionLines: plan.captionLines,
              creativeMemoryRetrievals: injector?.audits ?? [],
              providers: dependencies.providers,
              provenancePath: provenancePath ?? null,
            },
            null,
            2,
          )}\n`,
        );
        return EXIT_CODES.SUCCESS;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        context.stderr(`${detail}\n`);
        await writeProvenance(undefined, detail);
        return error instanceof CreativeMemoryInjectionError
          ? EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE
          : EXIT_CODES.PLANNING_FAILURE;
      }
    }

    const result = await runSourceCampaign({
      request,
      reasoningProvider: requireReasoningProvider(dependencies),
      reasoningPolicy: policy,
      runDirectory,
      repositoryRoot,
      binaries: dependencies.binaries,
      workflowRunId,
      now,
      creativeMemoryMode: options.creativeMemory,
      ...(injector ? { injector } : {}),
      runner: dependencies.runner,
      onProgress: progress,
    });
    const provenancePath = await writeProvenance(result, result.failure ?? null);
    return reportCampaignResult(result, request, dependencies, options, context, provenancePath);
  } finally {
    await dependencies.close();
  }
}

/**
 * Each construction failure gets the exit code that names the *response*, not
 * merely the fact that something went wrong: an operator who sees 9 approves a
 * profile, one who sees 11 changes a flag, and one who sees 12 starts a
 * service.
 */
const DEPENDENCY_EXIT_CODES: Readonly<Record<AampDependencyFailure, number>> = {
  INVALID_CONFIGURATION: EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
  DATABASE_UNAVAILABLE: EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE,
  VECTOR_STORE_UNAVAILABLE: EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE,
  EMBEDDING_PROVIDER_UNAVAILABLE: EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE,
  REASONING_UNAVAILABLE: EXIT_CODES.REAL_REASONING_UNAVAILABLE,
  RENDERER_UNAVAILABLE: EXIT_CODES.DEPENDENCY_UNAVAILABLE,
  GENERATION_UNAVAILABLE: EXIT_CODES.REAL_REASONING_UNAVAILABLE,
  FIXTURE_PROVIDER_PROHIBITED: EXIT_CODES.EXECUTION_MODE_NOT_ATTAINED,
  IN_MEMORY_PERSISTENCE_PROHIBITED: EXIT_CODES.EXECUTION_MODE_NOT_ATTAINED,
  EXECUTION_MODE_NOT_ATTAINED: EXIT_CODES.EXECUTION_MODE_NOT_ATTAINED,
};

/** Formats the run's outcome. Split out so the run body stays one readable flow. */
function reportCampaignResult(
  result: SourceCampaignResult,
  request: CampaignRequest,
  dependencies: AampDependencies,
  options: GenerateCliOptions,
  context: GenerateCliContext,
  provenancePath: string | undefined,
): number {
  const { label, reasoningPolicy: policy } = dependencies;
  if (options.json) {
    context.stdout(
      `${JSON.stringify(
        {
          ...result,
          executionMode: dependencies.executionMode,
          requestedExecutionMode: dependencies.requestedExecutionMode ?? null,
          isRealCampaignRun: label.isRealCampaignRun,
          demonstrationOnly: label.demonstrationOnly,
          partiallySimulated: label.partiallySimulated,
          caveat: label.caveat,
          providers: dependencies.providers,
          provenancePath: provenancePath ?? null,
        },
        null,
        2,
      )}\n`,
    );
  } else if (result.exitCode === EXIT_CODES.SUCCESS || result.exitCode === EXIT_CODES.QA_FAILURE) {
    context.stdout(
      `${[
        `execution mode:    ${dependencies.executionMode}`,
        `real campaign run: ${label.isRealCampaignRun ? 'yes' : 'NO'}`,
        `run mode:          ${policy.runMode}`,
        `campaign ID:       ${request.campaignId}`,
        `prompt sha256:     ${request.promptSha256}`,
        `run directory:     ${result.runDirectory}`,
        `final MP4:         ${result.outputPath ?? 'none'}`,
        `duration:          ${
          result.measuredDurationSeconds === null || result.measuredDurationSeconds === undefined
            ? 'unknown'
            : `${result.measuredDurationSeconds.toFixed(3)}s`
        }`,
        `resolution:        ${result.measuredResolution ?? '?'}`,
        `codecs:            ${result.measuredCodecs ?? '?'}`,
        `QA status:         ${result.qaVerdict ?? 'unknown'}`,
        `heuristic score:   ${result.heuristicAverage ?? '?'} / 5 (structural only, not a quality verdict)`,
        `creative memory:   ${result.creativeMemoryMode ?? 'off'}`,
        `originality risk:  ${result.originality?.riskLevel ?? 'not evaluated'}${
          result.originality?.requiresHumanReview ? ' — requires human review' : ''
        }`,
        `output sha256:     ${result.outputChecksumSha256 ?? 'none'}`,
        `provenance:        ${provenancePath ?? 'not written'}`,
        `status:            ${result.exitCode === EXIT_CODES.SUCCESS ? 'RENDERED — REQUIRES HUMAN APPROVAL' : 'REJECTED BY QA'}`,
      ].join('\n')}\n`,
    );
  }

  if (result.exitCode === EXIT_CODES.ORIGINALITY_RISK_BLOCKED) {
    context.stderr(
      '\nBLOCKED: originality risk is HIGH. Nothing was rendered. See originality-report.json in the run directory.\n',
    );
  }
  if (result.failure) context.stderr(`\n${result.failure}\n`);
  // Repeated after the result, not only before it: a PASS verdict beside a
  // 1080x1920 path reads as a finished advertisement, and outside PRODUCTION it
  // is not one.
  if (!label.isRealCampaignRun && result.exitCode === EXIT_CODES.SUCCESS) {
    context.stderr(`\nWARNING: ${label.caveat}\n`);
  }
  if (policy.runMode !== 'REAL' && result.exitCode === EXIT_CODES.SUCCESS) {
    context.stderr(
      '\nWARNING: FIXTURE_DEMO run — the creative ignores this campaign prompt. Do not present this as a campaign result.\n',
    );
  }
  return result.exitCode;
}

if (require.main === module) {
  runGenerateCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
