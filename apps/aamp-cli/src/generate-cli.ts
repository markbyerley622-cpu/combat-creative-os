#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { aampCliEnvSchema, type AampCliEnv } from '@combat/config';
import { createPrismaClient } from '@combat/database';
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
  resolveEmbedder,
  resolveQdrant,
  resolveReranker,
  type RetrievalCliEnv,
} from './creative-memory/retrieval-commands';
import {
  CampaignRequestValidationError,
  loadCampaignRequest,
  type CampaignRequest,
} from './campaign-request';
import { planCampaign } from './plan-campaign';
import { resolveReasoningPolicy, type ReasoningPolicy } from './reasoning-policy';
import { EXIT_CODES, runDirectoryFor, runSourceCampaign } from './run-source-campaign';
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

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
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
    return runCampaignRequestCli(options, context);
  }
  return runLegacyManifestCli(options, context);
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

interface ResolvedCreativeMemory {
  readonly injector?: CreativeMemoryInjector;
  readonly dispose: () => Promise<void>;
  /** Why no injector could be built. Fatal under `required`, a warning under `optional`. */
  readonly problem?: string;
}

/**
 * Builds the Creative Memory injector, or explains why it cannot.
 *
 * The composition root is the only place a real `PrismaClient` and a real
 * `QdrantClient` are constructed for this command, and `--creative-memory off`
 * constructs neither — a source-only run must not acquire a database
 * dependency it does not use. Tests inject their collaborators through
 * `context.creativeMemoryDependencies`; no environment variable can select a
 * fake, which is the same discipline `@combat/auth/testing` follows.
 */
async function resolveCreativeMemory(
  mode: CreativeMemoryMode,
  env: AampCliEnv,
  context: GenerateCliContext,
  request: CampaignRequest,
  now: Date,
  onProgress: (message: string) => void,
): Promise<ResolvedCreativeMemory> {
  const noop = async (): Promise<void> => undefined;
  if (mode === 'off') return { dispose: noop };

  const build = (
    dependencies: CreativeMemoryDependencies,
    dispose: () => Promise<void>,
  ): ResolvedCreativeMemory => ({
    injector: new CreativeMemoryInjector({
      mode,
      dependencies,
      workspaceId: request.workspaceId,
      campaignId: request.campaignId,
      platform: request.platform,
      now,
      onProgress,
    }),
    dispose,
  });

  if (context.creativeMemoryDependencies) {
    return build(context.creativeMemoryDependencies, noop);
  }

  if (!env.DATABASE_URL) {
    return {
      dispose: noop,
      problem:
        'DATABASE_URL is not set, so the reference library, its approved annotations and its benchmark governance profiles cannot be read.',
    };
  }

  // The retrieval commands take the raw environment shape; this command's
  // schema has already coerced the numeric fields, so they are put back as
  // strings here rather than duplicating the resolver for one type difference.
  const retrievalEnv: RetrievalCliEnv = {
    CREATIVE_MEMORY_EMBEDDING_PROFILE: env.CREATIVE_MEMORY_EMBEDDING_PROFILE,
    ...(env.CREATIVE_MEMORY_EMBEDDING_ENDPOINT
      ? { CREATIVE_MEMORY_EMBEDDING_ENDPOINT: env.CREATIVE_MEMORY_EMBEDDING_ENDPOINT }
      : {}),
    ...(env.CREATIVE_MEMORY_RERANKER_ENDPOINT
      ? { CREATIVE_MEMORY_RERANKER_ENDPOINT: env.CREATIVE_MEMORY_RERANKER_ENDPOINT }
      : {}),
    ...(env.CREATIVE_MEMORY_EMBEDDING_API_KEY
      ? { CREATIVE_MEMORY_EMBEDDING_API_KEY: env.CREATIVE_MEMORY_EMBEDDING_API_KEY }
      : {}),
    CREATIVE_MEMORY_TIMEOUT_MS: String(env.CREATIVE_MEMORY_TIMEOUT_MS),
    QDRANT_URL: env.QDRANT_URL,
    ...(env.QDRANT_API_KEY ? { QDRANT_API_KEY: env.QDRANT_API_KEY } : {}),
  };

  let embedder;
  try {
    embedder = resolveEmbedder(retrievalEnv);
  } catch (error) {
    return { dispose: noop, problem: error instanceof Error ? error.message : String(error) };
  }

  const qdrant = resolveQdrant(retrievalEnv);
  if (!(await qdrant.isHealthy())) {
    return {
      dispose: noop,
      problem: `Qdrant is not reachable at ${env.QDRANT_URL}. Start it with: docker compose -f infrastructure/docker-compose.yml up -d qdrant`,
    };
  }

  const prisma = createPrismaClient();
  return build(
    {
      db: prisma as unknown as CreativeMemoryDependencies['db'],
      qdrant,
      embedder,
      reranker: resolveReranker(retrievalEnv),
    },
    async () => {
      await prisma.$disconnect();
    },
  );
}

/**
 * The canonical flow: a campaign request, real reasoning, real owned assets, a
 * deterministic render, and a run directory that records every decision.
 */
async function runCampaignRequestCli(
  options: GenerateCliOptions,
  context: GenerateCliContext,
): Promise<number> {
  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const requestPath = isAbsolute(options.requestPath!)
    ? options.requestPath!
    : resolve(repositoryRoot, options.requestPath!);

  let env: AampCliEnv;
  try {
    env = aampCliEnvSchema.parse(context.env);
  } catch (error) {
    context.stderr(
      `Configuration is invalid:\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

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

  // --- reasoning policy: the refusal that makes this milestone mean anything
  let policy: ReasoningPolicy;
  try {
    policy = resolveReasoningPolicy({
      runMode: options.fixtureDemo ? 'FIXTURE_DEMO' : 'REAL',
      reasoningProvider: env.REASONING_PROVIDER,
      reasoningModel: env.REASONING_MODEL,
      ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
    });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.REAL_REASONING_UNAVAILABLE;
  }

  context.stderr(
    policy.runMode === 'REAL'
      ? `run mode: REAL — reasoning via ${policy.providerName} (${policy.reasoningModel}); prompt sha256 ${request.promptSha256.slice(0, 16)}…\n`
      : `WARNING: run mode: FIXTURE_DEMO — creative is replayed from committed fixtures and ignores this campaign prompt. Not a campaign result.\n`,
  );

  const reasoningProvider = policy.useFixtureReasoning
    ? createFixtureReasoningProvider(12)
    : await createClaudeReasoningProvider(env.ANTHROPIC_API_KEY!);

  const workflowRunId = context.workflowRunId ?? `aamp-cli-${randomUUID()}`;
  const outputRoot = options.outputDirectory
    ? resolve(repositoryRoot, options.outputDirectory)
    : resolve(repositoryRoot, request.outputDirectory);
  const runDirectory = runDirectoryFor(outputRoot, request.name, workflowRunId);
  const now = context.now ? context.now() : new Date();
  const progress = (message: string): void => {
    if (!options.json) context.stderr(`  ${message}\n`);
  };

  // --- Creative Memory: resolved before any agent runs ----------------------
  const creativeMemory = await resolveCreativeMemory(
    options.creativeMemory,
    env,
    context,
    request,
    now,
    progress,
  );
  if (creativeMemory.problem) {
    // `required` stops here, with its own exit code, having produced nothing.
    // `optional` says so loudly and continues — but it never substitutes
    // fixture creative or generic benchmark text for the missing context.
    if (options.creativeMemory === 'required') {
      context.stderr(
        `Creative Memory is required for this run but is unavailable:\n  ${creativeMemory.problem}\nRefusing to continue. This command will not plan a campaign without the governed benchmark context it was told to use.\n`,
      );
      return EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE;
    }
    context.stderr(
      `WARNING: Creative Memory is unavailable and the mode is "optional"; planning will proceed without benchmark context.\n  ${creativeMemory.problem}\n`,
    );
  }
  context.stderr(`creative memory: ${options.creativeMemory}\n`);

  try {
    if (options.planOnly) {
      try {
        const plan = await planCampaign({
          request,
          reasoningProvider,
          workflowRunId,
          ...(creativeMemory.injector ? { injector: creativeMemory.injector } : {}),
          onProgress: progress,
        });
        context.stdout(
          `${JSON.stringify(
            {
              runMode: policy.runMode,
              creativeMemoryMode: options.creativeMemory,
              promptSha256: request.promptSha256,
              agentVersions: plan.agentVersions,
              shots: plan.shots,
              captionLines: plan.captionLines,
              creativeMemoryRetrievals: creativeMemory.injector?.audits ?? [],
            },
            null,
            2,
          )}\n`,
        );
        return EXIT_CODES.SUCCESS;
      } catch (error) {
        context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        return error instanceof CreativeMemoryInjectionError
          ? EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE
          : EXIT_CODES.PLANNING_FAILURE;
      }
    }

    const result = await runSourceCampaign({
      request,
      reasoningProvider,
      reasoningPolicy: policy,
      runDirectory,
      repositoryRoot,
      binaries: resolveFfmpegBinaries(context.env),
      workflowRunId,
      now,
      creativeMemoryMode: options.creativeMemory,
      ...(creativeMemory.injector ? { injector: creativeMemory.injector } : {}),
      ...(context.runner ? { runner: context.runner } : {}),
      onProgress: progress,
    });
    return reportCampaignResult(result, request, policy, options, context);
  } finally {
    await creativeMemory.dispose();
  }
}

/** Formats the run's outcome. Split out so the run body stays one readable flow. */
function reportCampaignResult(
  result: Awaited<ReturnType<typeof runSourceCampaign>>,
  request: CampaignRequest,
  policy: ReasoningPolicy,
  options: GenerateCliOptions,
  context: GenerateCliContext,
): number {
  if (options.json) {
    context.stdout(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.exitCode === EXIT_CODES.SUCCESS || result.exitCode === EXIT_CODES.QA_FAILURE) {
    context.stdout(
      `${[
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
