import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { CommandRunner } from '@combat/media';

import {
  CampaignRequestValidationError,
  loadCampaignRequest,
  type CampaignRequest,
} from '../campaign-request';
import type { CreativeMemoryDependencies } from '../creative-memory/injection';
import { createFixtureReasoningProvider } from '../fixture-reasoning';
import { findRepositoryRoot } from '../generate-cli';
import { parseExecutionModeFlag, type AampExecutionMode } from '../production/aamp-execution-mode';
import {
  AampDependencyError,
  createAampDependencies,
  parseAampCliEnv,
} from '../production/dependency-factory';
import {
  HumanScorecardValidationError,
  parseHumanScorecard,
  summariseScorecard,
} from './human-scorecard';
import { authorisePaidProviders, describeCostCeiling } from './paid-providers';
import { BENCHMARK_EXIT_CODES, runCreativeBenchmark } from './run-benchmark';

/**
 * `pnpm aamp:benchmark` — the operator surface for the controlled experiment,
 * plus the `score` subcommand a human uses to submit a judgement.
 *
 * Two things are deliberately awkward here, and both are load-bearing:
 *
 * - **Paid work needs three separate yeses**: a configured provider, an
 *   explicit `--allow-paid-providers`, and declared token prices so a ceiling
 *   can be printed *before* the first call. Without all three the benchmark
 *   still runs — with the deterministic context-aware fixture, labelled as a
 *   demonstration — and spends nothing.
 * - **`score` is the only way a number reaches a scorecard.** It reads a file a
 *   named person wrote and validates it; there is no code path that generates
 *   one.
 */

export interface BenchmarkCliOptions {
  readonly command: 'run' | 'score';
  readonly requestPath?: string;
  readonly assetsPath?: string;
  readonly workspaceId?: string;
  readonly benchmarkProfileName?: string;
  readonly executionMode?: AampExecutionMode;
  readonly outputDirectory: string;
  readonly allowPaidProviders: boolean;
  readonly maximumCostCents?: number;
  readonly json: boolean;
  readonly planOnly: boolean;
  readonly skipRender: boolean;
  // `score` only
  readonly scorecardPath?: string;
  readonly experimentDirectory?: string;
}

const DEFAULT_OUTPUT_DIRECTORY = '.aamp-output/benchmarks';

export function usage(): string {
  return [
    'Usage: pnpm aamp:benchmark [run] --request <campaign-request.json> [options]',
    '',
    'Required for `run`:',
    '  --request <path>            the campaign request both arms receive',
    '  --workspace <uuid>          workspace whose approved references and profiles govern the REQUIRED arm',
    '  --benchmark-profile <name>  the approved profile expected to govern this campaign',
    '',
    'Optional:',
    '  --assets <path>             override the request’s production asset manifest',
    '  --execution-mode fixture|local-production|production',
    '  --output-dir <dir>          default .aamp-output/benchmarks',
    '  --allow-paid-providers      permit real model calls (see below)',
    '  --max-cost-cents <n>        refuse if the estimated maximum exceeds this',
    '  --plan-only                 stop after planning both arms',
    '  --skip-render               build both render manifests but invoke no FFmpeg',
    '  --json                      machine-readable result',
    '',
    'Submitting a human judgement:',
    '  pnpm aamp:benchmark score --scorecard <filled-scorecard.json> --experiment-dir <dir>',
    '',
    'No paid provider call is made unless --allow-paid-providers is supplied, a real',
    'provider is configured, and BENCHMARK_INPUT_COST_CENTS_PER_MTOK and',
    'BENCHMARK_OUTPUT_COST_CENTS_PER_MTOK are set so a maximum cost can be printed first.',
  ].join('\n');
}

export function parseBenchmarkArguments(argv: readonly string[]): BenchmarkCliOptions {
  const [maybeCommand, ...rest] = argv;
  const command = maybeCommand === 'score' ? 'score' : 'run';
  const tokens = maybeCommand === 'score' || maybeCommand === 'run' ? rest : argv;

  let requestPath: string | undefined;
  let assetsPath: string | undefined;
  let workspaceId: string | undefined;
  let benchmarkProfileName: string | undefined;
  let executionMode: AampExecutionMode | undefined;
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  let allowPaidProviders = false;
  let maximumCostCents: number | undefined;
  let json = false;
  let planOnly = false;
  let skipRender = false;
  let scorecardPath: string | undefined;
  let experimentDirectory: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    switch (token) {
      case '--request':
        requestPath = tokens[++index];
        break;
      case '--assets':
        assetsPath = tokens[++index];
        break;
      case '--workspace':
        workspaceId = tokens[++index];
        break;
      case '--benchmark-profile':
        benchmarkProfileName = tokens[++index];
        break;
      case '--execution-mode': {
        const value = tokens[++index];
        const parsed = parseExecutionModeFlag(value);
        if (!parsed) {
          throw new Error(
            `--execution-mode must be one of fixture|local-production|production (got "${value ?? ''}")`,
          );
        }
        executionMode = parsed;
        break;
      }
      case '--output-dir':
        outputDirectory = tokens[++index] ?? DEFAULT_OUTPUT_DIRECTORY;
        break;
      case '--allow-paid-providers':
        allowPaidProviders = true;
        break;
      case '--max-cost-cents': {
        const value = Number(tokens[++index]);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error('--max-cost-cents must be a non-negative number');
        }
        maximumCostCents = value;
        break;
      }
      case '--scorecard':
        scorecardPath = tokens[++index];
        break;
      case '--experiment-dir':
        experimentDirectory = tokens[++index];
        break;
      case '--json':
        json = true;
        break;
      case '--plan-only':
        planOnly = true;
        break;
      case '--skip-render':
        skipRender = true;
        break;
      case '--help':
      case '-h':
        throw new Error(usage());
      default:
        if (token?.startsWith('--')) throw new Error(`Unknown option ${token}\n\n${usage()}`);
    }
  }

  if (command === 'run' && !requestPath) throw new Error(usage());
  if (command === 'score' && (!scorecardPath || !experimentDirectory)) {
    throw new Error('score requires --scorecard <path> --experiment-dir <dir>');
  }

  return {
    command,
    ...(requestPath ? { requestPath } : {}),
    ...(assetsPath ? { assetsPath } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(benchmarkProfileName ? { benchmarkProfileName } : {}),
    ...(executionMode ? { executionMode } : {}),
    outputDirectory,
    allowPaidProviders,
    ...(maximumCostCents === undefined ? {} : { maximumCostCents }),
    json,
    planOnly,
    skipRender,
    ...(scorecardPath ? { scorecardPath } : {}),
    ...(experimentDirectory ? { experimentDirectory } : {}),
  };
}

export interface BenchmarkCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
  readonly experimentId?: string;
  /** Injected by tests; production builds them from env through the composition root. */
  readonly creativeMemoryDependencies?: CreativeMemoryDependencies;
  readonly runner?: CommandRunner;
  readonly operator?: string;
}

export async function runBenchmarkCli(
  argv: readonly string[],
  context: BenchmarkCliContext,
): Promise<number> {
  let options: BenchmarkCliOptions;
  try {
    options = parseBenchmarkArguments(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return BENCHMARK_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const absolute = (candidate: string): string =>
    isAbsolute(candidate) ? candidate : resolve(repositoryRoot, candidate);
  const now = context.now ? context.now() : new Date();

  if (options.command === 'score') {
    return runScoreCommand(options, context, absolute);
  }

  // --- the campaign request, loaded once for both arms ----------------------
  let request: CampaignRequest;
  try {
    request = await loadCampaignRequest(absolute(options.requestPath as string));
    if (options.assetsPath) {
      request = { ...request, sourceAssetManifestPath: absolute(options.assetsPath) };
    }
  } catch (error) {
    context.stderr(
      `${
        error instanceof CampaignRequestValidationError
          ? error.message
          : `Could not read campaign request: ${error instanceof Error ? error.message : String(error)}`
      }\n`,
    );
    return BENCHMARK_EXIT_CODES.INVALID_ARGUMENTS;
  }

  // --- the paid-provider gate, decided before anything is constructed -------
  let env;
  try {
    env = parseAampCliEnv(context.env);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return BENCHMARK_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const paidProviders = authorisePaidProviders({
    env,
    allowPaidProviders: options.allowPaidProviders,
    at: now,
    operator: context.operator ?? env.REASONING_PROVIDER,
    ...(options.maximumCostCents === undefined
      ? {}
      : { maximumCostCents: options.maximumCostCents }),
  });

  if (paidProviders.authorised) {
    // Printed before the first call, never after the last.
    context.stderr(`${describeCostCeiling(paidProviders.estimate)}\n`);
    context.stderr(`${paidProviders.statement}\n`);
  } else if (options.allowPaidProviders) {
    context.stderr(
      `Paid providers were requested but NOT authorised (${paidProviders.refusal}):\n  ${paidProviders.explanation}\n`,
    );
    if (paidProviders.refusal !== 'NOT_REQUESTED') {
      return BENCHMARK_EXIT_CODES.INVALID_ARGUMENTS;
    }
  } else {
    context.stderr(`DEMONSTRATION: ${paidProviders.explanation}\n`);
  }

  const progress = (message: string): void => {
    if (!options.json) context.stderr(`  ${message}\n`);
  };

  // --- the composition root, built once and shared read-only ---------------
  let dependencies;
  try {
    dependencies = await createAampDependencies({
      env: context.env,
      // The REQUIRED arm needs retrieval, so the experiment as a whole does.
      creativeMemoryMode: 'required',
      // Both arms use a deterministic fixture unless paid providers were
      // authorised; the reasoning policy still records FIXTURE_DEMO so every
      // artefact keeps its demonstration stamp.
      runMode: paidProviders.authorised ? 'REAL' : 'FIXTURE_DEMO',
      repositoryRoot,
      requiresRendering: !options.planOnly && !options.skipRender,
      generation: request.generation.source === 'COMFYUI' ? 'COMFYUI' : 'NONE',
      comfyuiProfile: request.generation.comfyuiProfile,
      ...(options.executionMode ? { requestedExecutionMode: options.executionMode } : {}),
      fixtures: { reasoning: () => createFixtureReasoningProvider(12) },
      overrides: {
        ...(context.creativeMemoryDependencies
          ? { creativeMemoryDependencies: context.creativeMemoryDependencies }
          : {}),
        ...(context.runner ? { runner: context.runner } : {}),
      },
      onProgress: progress,
    });
  } catch (error) {
    context.stderr(
      `${error instanceof AampDependencyError ? error.message : error instanceof Error ? error.message : String(error)}\n`,
    );
    return BENCHMARK_EXIT_CODES.DEPENDENCIES_UNAVAILABLE;
  }

  context.stderr(
    `${dependencies.label.isRealCampaignRun ? '' : 'WARNING: '}execution mode ${dependencies.executionMode}: ${dependencies.label.caveat}\n`,
  );

  try {
    const result = await runCreativeBenchmark({
      request,
      dependencies,
      repositoryRoot,
      outputDirectory: absolute(options.outputDirectory),
      benchmarkProfileName: options.benchmarkProfileName ?? null,
      paidProviders,
      planOnly: options.planOnly,
      skipRender: options.skipRender,
      now,
      ...(context.experimentId ? { experimentId: context.experimentId } : {}),
      onProgress: progress,
    });

    if (options.json) {
      context.stdout(
        `${JSON.stringify(
          {
            exitCode: result.exitCode,
            experimentId: result.experiment.experimentId,
            status: result.experiment.status,
            comparisonStatus: result.experiment.comparisonStatus,
            humanReviewStatus: result.experiment.humanReviewStatus,
            executionMode: result.experiment.executionMode,
            paidProvidersAuthorised: result.experiment.paidProvidersAuthorised,
            estimatedMaximumCostCents: result.experiment.estimatedMaximumCostCents,
            arms: result.experiment.arms,
            changedDimensions: result.comparison?.changedDimensions ?? [],
            offPerformedNoRetrieval: result.comparison?.offPerformedNoRetrieval ?? null,
            experimentPath: result.experimentPath,
            comparisonJsonPath: result.comparisonJsonPath,
            comparisonMarkdownPath: result.comparisonMarkdownPath,
            scorecardTemplatePaths: result.scorecardTemplatePaths,
            interpretation: result.experiment.interpretation,
            failure: result.failure,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      context.stdout(`${formatBenchmarkResult(result)}\n`);
    }

    if (result.failure) context.stderr(`\n${result.failure}\n`);
    return result.exitCode;
  } finally {
    await dependencies.close();
  }
}

function formatBenchmarkResult(result: Awaited<ReturnType<typeof runCreativeBenchmark>>): string {
  const { experiment, comparison } = result;
  const lines = [
    `experiment:        ${experiment.experimentId}`,
    `status:            ${experiment.status}`,
    `execution mode:    ${experiment.executionMode}`,
    `reasoning:         ${experiment.controlled.reasoningProfile}`,
    `paid providers:    ${experiment.paidProvidersAuthorised ? 'AUTHORISED' : 'not authorised — nothing was spent'}`,
    `request hash:      ${experiment.inputs.requestHashSha256}`,
    `assets hash:       ${experiment.inputs.productionAssetsSha256}`,
  ];
  for (const arm of experiment.arms) {
    lines.push(
      `arm ${arm.key.padEnd(9)}      exit ${arm.exitCode}, QA ${arm.qaVerdict ?? (arm.renderSkipped ? 'render skipped' : 'none')}, ${arm.retrievalCount} retrieval(s)`,
      `                   ${arm.outputPath ?? arm.runDirectory}`,
    );
  }
  if (comparison) {
    lines.push(
      `changed:           ${comparison.changedDimensions.length}/${comparison.dimensions.length} dimensions — ${comparison.changedDimensions.join(', ') || 'none'}`,
      `OFF retrievals:    ${comparison.off.retrievalCount} (must be 0)`,
      `comparison (json): ${result.comparisonJsonPath}`,
      `comparison (md):   ${result.comparisonMarkdownPath}`,
      `scorecards:        ${result.scorecardTemplatePaths.join('\n                   ')}`,
    );
  }
  lines.push('', experiment.interpretation);
  return lines.join('\n');
}

/**
 * Records a human judgement.
 *
 * Validates only. There is no branch here that supplies a score, a reviewer or
 * a note — a scorecard arrives complete from a person or it is refused.
 */
async function runScoreCommand(
  options: BenchmarkCliOptions,
  context: BenchmarkCliContext,
  absolute: (candidate: string) => string,
): Promise<number> {
  try {
    const scorecard = parseHumanScorecard(
      JSON.parse(await readFile(absolute(options.scorecardPath as string), 'utf8')),
    );
    const summary = summariseScorecard(scorecard);
    const target = join(
      absolute(options.experimentDirectory as string),
      `human-scorecard.${scorecard.arm.toLowerCase()}.json`,
    );
    await writeFile(target, `${JSON.stringify(scorecard, null, 2)}\n`, 'utf8');
    context.stdout(`${JSON.stringify({ recordedAt: target, summary }, null, 2)}\n`);
    return BENCHMARK_EXIT_CODES.SUCCESS;
  } catch (error) {
    context.stderr(
      `${
        error instanceof HumanScorecardValidationError
          ? error.message
          : `Could not record the scorecard: ${error instanceof Error ? error.message : String(error)}`
      }\n`,
    );
    return BENCHMARK_EXIT_CODES.INVALID_ARGUMENTS;
  }
}
