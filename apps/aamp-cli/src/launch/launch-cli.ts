import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { CreativeMemoryModeSchema, type CreativeMemoryMode } from '@combat/domain';
import type { CommandRunner } from '@combat/media';

import { estimateMaximumCost } from '../benchmark/paid-providers';
import {
  CampaignRequestValidationError,
  loadCampaignRequest,
  type CampaignRequest,
} from '../campaign-request';
import {
  CreativeMemoryInjector,
  type CreativeMemoryDependencies,
} from '../creative-memory/injection';
import { findRepositoryRoot } from '../generate-cli';
import {
  executionModeFlagFor,
  parseExecutionModeFlag,
  type AampExecutionMode,
} from '../production/aamp-execution-mode';
import {
  AampDependencyError,
  createAampDependencies,
  requireReasoningProvider,
  type AampDependencies,
} from '../production/dependency-factory';
import { runDirectoryFor } from '../run-source-campaign';
import { LAUNCH_EXIT_CODES, type LaunchCostBasis } from './launch-contracts';
import { LaunchFixtureReasoningProvider } from './launch-fixture-reasoning';
import {
  inspectLaunchRun,
  LaunchGateError,
  readLaunchRunState,
  rejectAllConcepts,
  reviseConceptInRun,
  selectConcept,
} from './launch-gate';
import { runLaunchRender } from './launch-render';
import { runLaunchPlan, type LaunchRunLabel } from './run-launch-plan';

/**
 * `pnpm aamp:launch` — the product-launch creative workflow.
 *
 * Five subcommands, split along the line that matters: `plan`, `revise` and
 * `render` need a reasoning provider and the composition root; `inspect`,
 * `select` and `reject` construct **no provider at all**. A reviewer reading
 * concepts and approving one cannot spend money, and that is a property of the
 * object graph rather than a promise — those three paths never call
 * `createAampDependencies`.
 */

export const LAUNCH_USAGE = [
  'Usage: pnpm aamp:launch <command> [options]',
  '',
  'Commands:',
  '  plan     --request <campaign-request.json> --benchmark-profile <name>',
  '           [--assets <production-assets.json>] [--captures <capture-session.json>]',
  '           [--output-dir <dir>] [--creative-memory required|optional]',
  '           [--fixture-demo] [--execution-mode <tier>] [--json]',
  '           Runs the concept competition and writes a reviewable run directory.',
  '           --output-dir is the ROOT the run directory is created inside; the exact',
  '           run directory is printed, and it is what every other command takes as --run.',
  '',
  '  inspect  --run <run-directory> [--json]',
  '           Reads the run. Constructs no provider and cannot spend anything.',
  '',
  '  revise   --run <run-directory> --concept <concept-id> --feedback <file>',
  '           [--reviewer <user-id>] [--fixture-demo] [--json]',
  '           Sends the reviewer’s written feedback back through the Creative Director',
  '           and writes a new immutable version that supersedes the previous one.',
  '',
  '  select   --run <run-directory> --concept <concept-id> --reviewer <user-id>',
  '           [--version <n>] [--workspace <workspace-id>] [--json]',
  '           Records the human concept decision. Nothing renders until this exists.',
  '',
  '  reject   --run <run-directory> --reviewer <user-id> --feedback <file> [--json]',
  '           Rejects the whole set and closes the run; plan a new one.',
  '',
  '  render   --run <run-directory> [--fixture-demo] [--skip-render] [--json]',
  '           Hands the selected concept to the existing script, shot, source-selection,',
  '           FFmpeg and actual-media QA path.',
].join('\n');

export type LaunchCommand = 'plan' | 'inspect' | 'revise' | 'select' | 'reject' | 'render';

export interface LaunchCliOptions {
  readonly command: LaunchCommand;
  readonly requestPath?: string;
  readonly assetsPath?: string;
  readonly capturesPath?: string;
  readonly benchmarkProfile?: string;
  readonly outputDirectory?: string;
  readonly runDirectory?: string;
  readonly conceptId?: string;
  readonly conceptVersion?: number;
  readonly feedbackPath?: string;
  readonly reviewerId?: string;
  readonly workspaceId?: string;
  readonly creativeMemory: Exclude<CreativeMemoryMode, 'off'>;
  readonly executionMode?: AampExecutionMode;
  readonly fixtureDemo: boolean;
  readonly skipRender: boolean;
  readonly json: boolean;
}

export function parseLaunchCliArguments(argv: readonly string[]): LaunchCliOptions {
  const command = argv[0];
  if (
    command !== 'plan' &&
    command !== 'inspect' &&
    command !== 'revise' &&
    command !== 'select' &&
    command !== 'reject' &&
    command !== 'render'
  ) {
    throw new Error(`${LAUNCH_USAGE}\n\nUnknown command "${command ?? ''}".`);
  }

  let requestPath: string | undefined;
  let assetsPath: string | undefined;
  let capturesPath: string | undefined;
  let benchmarkProfile: string | undefined;
  let outputDirectory: string | undefined;
  let runDirectory: string | undefined;
  let conceptId: string | undefined;
  let conceptVersion: number | undefined;
  let feedbackPath: string | undefined;
  let reviewerId: string | undefined;
  let workspaceId: string | undefined;
  let creativeMemory: Exclude<CreativeMemoryMode, 'off'> = 'required';
  let executionMode: AampExecutionMode | undefined;
  let fixtureDemo = false;
  let skipRender = false;
  let json = false;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--request':
        requestPath = argv[++index];
        break;
      case '--assets':
        assetsPath = argv[++index];
        break;
      case '--captures':
        capturesPath = argv[++index];
        break;
      case '--benchmark-profile':
        benchmarkProfile = argv[++index];
        break;
      case '--output-dir':
        outputDirectory = argv[++index];
        break;
      case '--run':
        runDirectory = argv[++index];
        break;
      case '--concept':
        conceptId = argv[++index];
        break;
      case '--version': {
        const value = Number(argv[++index]);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error('--version must be a positive integer');
        }
        conceptVersion = value;
        break;
      }
      case '--feedback':
        feedbackPath = argv[++index];
        break;
      case '--reviewer':
        reviewerId = argv[++index];
        break;
      case '--workspace':
        workspaceId = argv[++index];
        break;
      case '--creative-memory': {
        const value = argv[++index];
        const parsed = CreativeMemoryModeSchema.safeParse(value);
        if (!parsed.success || parsed.data === 'off') {
          throw new Error(
            `--creative-memory must be required or optional (got "${value ?? ''}"). A product launch is governed by an approved benchmark profile, so "off" is not available here.`,
          );
        }
        creativeMemory = parsed.data;
        break;
      }
      case '--execution-mode': {
        const value = argv[++index];
        const parsed = parseExecutionModeFlag(value);
        if (!parsed) {
          throw new Error(
            `--execution-mode must be one of fixture|local-production|production (got "${value ?? ''}")`,
          );
        }
        executionMode = parsed;
        break;
      }
      case '--fixture-demo':
        fixtureDemo = true;
        break;
      case '--skip-render':
        skipRender = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        if (argument && argument.startsWith('--')) throw new Error(`Unknown option ${argument}`);
    }
  }

  const required = (value: string | undefined, flag: string): string => {
    if (!value) throw new Error(`${LAUNCH_USAGE}\n\n${command} requires ${flag}.`);
    return value;
  };

  if (command === 'plan') {
    required(requestPath, '--request');
    required(benchmarkProfile, '--benchmark-profile');
  } else {
    required(runDirectory, '--run');
  }
  if (command === 'revise') {
    required(conceptId, '--concept');
    required(feedbackPath, '--feedback');
  }
  if (command === 'select') {
    required(conceptId, '--concept');
    required(reviewerId, '--reviewer');
  }
  if (command === 'reject') {
    required(reviewerId, '--reviewer');
    required(feedbackPath, '--feedback');
  }

  return {
    command,
    ...(requestPath ? { requestPath } : {}),
    ...(assetsPath ? { assetsPath } : {}),
    ...(capturesPath ? { capturesPath } : {}),
    ...(benchmarkProfile ? { benchmarkProfile } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    ...(runDirectory ? { runDirectory } : {}),
    ...(conceptId ? { conceptId } : {}),
    ...(conceptVersion === undefined ? {} : { conceptVersion }),
    ...(feedbackPath ? { feedbackPath } : {}),
    ...(reviewerId ? { reviewerId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    creativeMemory,
    ...(executionMode ? { executionMode } : {}),
    fixtureDemo,
    skipRender,
    json,
  };
}

export interface LaunchCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly runner?: CommandRunner;
  readonly now?: () => Date;
  readonly workflowRunId?: string;
  readonly launchRunId?: string;
  readonly newConceptId?: () => string;
  /** Injected so tests run against the in-memory reference store and an in-process Qdrant. */
  readonly creativeMemoryDependencies?: CreativeMemoryDependencies;
}

function labelFrom(dependencies: AampDependencies): LaunchRunLabel {
  return {
    executionMode: dependencies.executionMode,
    isRealCampaignRun: dependencies.label.isRealCampaignRun,
    demonstrationOnly: dependencies.label.demonstrationOnly,
    caveat: dependencies.label.caveat,
    runMode: dependencies.reasoningPolicy.runMode,
    reasoningProvider: dependencies.reasoningPolicy.providerName,
    reasoningModel: dependencies.reasoningPolicy.reasoningModel,
  };
}

/**
 * The budget ceiling, enforced rather than recorded.
 *
 * A real run computes a **maximum** from operator-declared rates and refuses if
 * it exceeds the brief's ceiling. Without declared rates there is no ceiling to
 * check against, so a paid run is refused rather than authorised against an
 * unknown number — the same rule the controlled benchmark applies, for the same
 * reason. A fixture run makes no paid call at all, and says so.
 */
export function resolveCostBasis(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly budgetCeilingCents: number;
  readonly candidateCount: number;
  readonly paidProviderCallsPossible: boolean;
}): { readonly basis: LaunchCostBasis } | { readonly refusal: string } {
  // One strategist call plus one Creative Director call per candidate.
  const plannedAgentInvocations = options.candidateCount + 1;

  if (!options.paidProviderCallsPossible) {
    return {
      basis: {
        budgetCeilingCents: options.budgetCeilingCents,
        estimatedMaximumCostCents: 0,
        plannedAgentInvocations,
        paidProviderCallsPossible: false,
        note: 'No paid provider was constructed for this run, so the ceiling cannot be approached. The creative is a labelled demonstration.',
      },
    };
  }

  // A rate that is not a number is treated as no declared rate at all: an
  // unparseable price is not a ceiling, and coercing it would authorise paid
  // work against NaN.
  const rate = (value: string | undefined): number | undefined => {
    if (value === undefined || value.trim().length === 0) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };

  const estimate = estimateMaximumCost(
    {
      BENCHMARK_INPUT_COST_CENTS_PER_MTOK: rate(options.env.BENCHMARK_INPUT_COST_CENTS_PER_MTOK),
      BENCHMARK_OUTPUT_COST_CENTS_PER_MTOK: rate(options.env.BENCHMARK_OUTPUT_COST_CENTS_PER_MTOK),
    },
    {
      arms: 1,
      agentInvocationsPerArm: plannedAgentInvocations,
      maxTokensInPerInvocation: 24_000,
      maxTokensOutPerInvocation: 4_000,
    },
  );

  if (!estimate) {
    return {
      refusal: [
        `This launch brief declares a budget ceiling of ${options.budgetCeilingCents} cents, and this run would call a paid model.`,
        'No maximum cost can be computed, so the ceiling cannot be enforced and nothing is authorised.',
        'Set BENCHMARK_INPUT_COST_CENTS_PER_MTOK and BENCHMARK_OUTPUT_COST_CENTS_PER_MTOK to the rates you believe apply,',
        'or pass --fixture-demo to run an explicitly-labelled demonstration that makes no paid call.',
      ].join('\n'),
    };
  }
  if (estimate.estimatedMaximumCostCents > options.budgetCeilingCents) {
    return {
      refusal: [
        `Refusing: the estimated MAXIMUM cost of ${estimate.estimatedMaximumCostCents} cents exceeds this brief's ceiling of ${options.budgetCeilingCents} cents.`,
        `${estimate.totalInvocations} invocations at up to ${estimate.maxTokensIn} input and ${estimate.maxTokensOut} output tokens, at the declared rates.`,
        'Raise the ceiling in the brief, reduce conceptCandidateCount, or run with --fixture-demo.',
      ].join('\n'),
    };
  }

  return {
    basis: {
      budgetCeilingCents: options.budgetCeilingCents,
      estimatedMaximumCostCents: estimate.estimatedMaximumCostCents,
      plannedAgentInvocations,
      paidProviderCallsPossible: true,
      note: `Ceiling from declared rates, not a quote and not a measurement: ${estimate.totalInvocations} invocations at ${estimate.inputCentsPerMTok}/${estimate.outputCentsPerMTok} cents per million tokens.`,
    },
  };
}

async function loadRequest(
  options: LaunchCliOptions,
  repositoryRoot: string,
): Promise<CampaignRequest> {
  const requestPath = isAbsolute(options.requestPath as string)
    ? (options.requestPath as string)
    : resolve(repositoryRoot, options.requestPath as string);
  const request = await loadCampaignRequest(requestPath);
  if (!options.assetsPath) return request;
  return {
    ...request,
    sourceAssetManifestPath: isAbsolute(options.assetsPath)
      ? options.assetsPath
      : resolve(repositoryRoot, options.assetsPath),
  };
}

export async function runLaunchCli(
  argv: readonly string[],
  context: LaunchCliContext,
): Promise<number> {
  let options: LaunchCliOptions;
  try {
    options = parseLaunchCliArguments(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

  switch (options.command) {
    case 'plan':
      return runPlanCommand(options, context);
    case 'inspect':
      return runInspectCommand(options, context);
    case 'revise':
      return runReviseCommand(options, context);
    case 'select':
      return runSelectCommand(options, context);
    case 'reject':
      return runRejectCommand(options, context);
    case 'render':
      return runRenderCommand(options, context);
    default: {
      const unreachable: never = options.command;
      throw new Error(`unhandled launch command ${String(unreachable)}`);
    }
  }
}

async function runPlanCommand(
  options: LaunchCliOptions,
  context: LaunchCliContext,
): Promise<number> {
  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const now = context.now ? context.now() : new Date();

  let request: CampaignRequest;
  try {
    request = await loadRequest(options, repositoryRoot);
  } catch (error) {
    context.stderr(
      `${
        error instanceof CampaignRequestValidationError
          ? error.message
          : `Could not read the campaign request: ${error instanceof Error ? error.message : String(error)}`
      }\n`,
    );
    return LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

  const launchBrief = request.productLaunch;
  if (!launchBrief) {
    context.stderr(
      [
        `${request.requestPath} declares no productLaunch brief, so it is not a PRODUCT_LAUNCH campaign.`,
        'aamp:launch runs only for product launches. Add a productLaunch block — positioning, desired audience',
        'perception, prohibited claims, brand identity, approved reviewers and a budget ceiling — or use',
        'pnpm aamp:generate for an ordinary campaign.',
      ].join('\n') + '\n',
    );
    return LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

  if (
    launchBrief.benchmarkProfileName &&
    launchBrief.benchmarkProfileName !== options.benchmarkProfile
  ) {
    context.stderr(
      `The brief names benchmark profile "${launchBrief.benchmarkProfileName}" but --benchmark-profile said "${options.benchmarkProfile}". Two different answers to "which governance applies" is worse than none; make them agree.\n`,
    );
    return LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

  const capturesPath = options.capturesPath
    ? isAbsolute(options.capturesPath)
      ? options.capturesPath
      : resolve(repositoryRoot, options.capturesPath)
    : request.captureManifestPath;
  if (!capturesPath) {
    context.stderr(
      'No approved product-capture session was supplied. Pass --captures <capture-session.json>, or set captureManifest in the request. A product launch shows the real product.\n',
    );
    return LAUNCH_EXIT_CODES.MISSING_PRODUCTION_ASSETS;
  }

  const costDecision = resolveCostBasis({
    env: context.env,
    budgetCeilingCents: launchBrief.budgetCeilingCents,
    candidateCount: launchBrief.conceptCandidateCount,
    paidProviderCallsPossible: !options.fixtureDemo && context.env.REASONING_PROVIDER === 'claude',
  });
  if ('refusal' in costDecision) {
    context.stderr(`${costDecision.refusal}\n`);
    return LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }
  if (costDecision.basis.paidProviderCallsPossible && !options.json) {
    // Printed before the first call, never after the last.
    context.stderr(
      `ESTIMATED MAXIMUM COST FOR THIS LAUNCH PLAN: ${costDecision.basis.estimatedMaximumCostCents} cents across ${costDecision.basis.plannedAgentInvocations} agent invocations (ceiling ${launchBrief.budgetCeilingCents}).\n`,
    );
  }

  const launchRunId = context.launchRunId ?? `launch-${randomUUID()}`;
  const workflowRunId = context.workflowRunId ?? `aamp-cli-${randomUUID()}`;
  const outputRoot = options.outputDirectory
    ? resolve(repositoryRoot, options.outputDirectory)
    : resolve(repositoryRoot, request.outputDirectory);
  const runDirectory = runDirectoryFor(outputRoot, `${request.name}-launch`, launchRunId);
  const progress = (message: string): void => {
    if (!options.json) context.stderr(`  ${message}\n`);
  };

  let dependencies: AampDependencies;
  try {
    dependencies = await createAampDependencies({
      env: context.env,
      creativeMemoryMode: options.creativeMemory,
      runMode: options.fixtureDemo ? 'FIXTURE_DEMO' : 'REAL',
      repositoryRoot,
      // Planning renders nothing: the toolchain is required by `render`, and
      // demanding it here would refuse a perfectly good concept competition on
      // a machine that only has to review concepts.
      requiresRendering: false,
      generation: 'NONE',
      ...(options.executionMode ? { requestedExecutionMode: options.executionMode } : {}),
      fixtures: { reasoning: () => new LaunchFixtureReasoningProvider() },
      overrides: {
        ...(context.creativeMemoryDependencies
          ? { creativeMemoryDependencies: context.creativeMemoryDependencies }
          : {}),
        ...(context.runner ? { runner: context.runner } : {}),
      },
      onProgress: progress,
    });
  } catch (error) {
    return reportDependencyFailure(error, options, context);
  }

  try {
    context.stderr(
      `${dependencies.label.isRealCampaignRun ? '' : 'WARNING: '}execution mode ${dependencies.executionMode}: ${dependencies.label.caveat}\n`,
    );
    if (!dependencies.creativeMemory) {
      context.stderr(
        `Creative Memory is unavailable, but a product launch is governed by benchmark profile "${options.benchmarkProfile}". Refusing rather than planning an ungoverned launch.\n`,
      );
      return LAUNCH_EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE;
    }

    const injector = new CreativeMemoryInjector({
      mode: options.creativeMemory,
      dependencies: dependencies.creativeMemory,
      workspaceId: request.workspaceId,
      campaignId: request.campaignId,
      platform: request.platform,
      now,
      onProgress: progress,
    });

    const result = await runLaunchPlan({
      request,
      launchBrief,
      benchmarkProfileName: options.benchmarkProfile as string,
      captureSessionPath: capturesPath,
      reasoningProvider: requireReasoningProvider(dependencies),
      injector,
      creativeMemoryMode: options.creativeMemory,
      runDirectory,
      launchRunId,
      workflowRunId,
      label: labelFrom(dependencies),
      costBasis: costDecision.basis,
      now,
      newConceptId: context.newConceptId ?? (() => randomUUID()),
      onProgress: progress,
    });

    if (options.json) {
      context.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.exitCode === LAUNCH_EXIT_CODES.SUCCESS) {
      context.stdout(
        `${[
          `execution mode:     ${dependencies.executionMode}`,
          `real campaign run:  ${dependencies.label.isRealCampaignRun ? 'yes' : 'NO'}`,
          `run directory:      ${result.runDirectory}`,
          `launch run id:      ${result.launchRunId}`,
          `concepts:           ${result.conceptIds?.length ?? 0} (${result.selectableConceptIds?.length ?? 0} selectable)`,
          `rejected candidates:${' '}${result.rejectedCandidateCount ?? 0}`,
          `distinctness:       ${result.distinctnessVerdict ?? 'unknown'}`,
          `benchmark profile:  ${options.benchmarkProfile}`,
          '',
          'Next: pnpm aamp:launch inspect --run <run directory>',
          '      pnpm aamp:launch select --run <run directory> --concept <id> --reviewer <user-id>',
          '',
          'No advertisement exists yet. Nothing renders until a named reviewer selects one concept.',
        ].join('\n')}\n`,
      );
    }
    if (result.failure) context.stderr(`\n${result.failure}\n`);
    return result.exitCode;
  } finally {
    await dependencies.close();
  }
}

function reportDependencyFailure(
  error: unknown,
  options: LaunchCliOptions,
  context: LaunchCliContext,
): number {
  if (error instanceof AampDependencyError) {
    context.stderr(`${error.message}\n`);
    if (
      error.kind === 'VECTOR_STORE_UNAVAILABLE' ||
      error.kind === 'DATABASE_UNAVAILABLE' ||
      error.kind === 'EMBEDDING_PROVIDER_UNAVAILABLE'
    ) {
      context.stderr(
        'Refusing to continue. A product launch is planned against an approved benchmark profile; there is no ungoverned fallback.\n',
      );
      return LAUNCH_EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE;
    }
    if (error.kind === 'REASONING_UNAVAILABLE') return LAUNCH_EXIT_CODES.REAL_REASONING_UNAVAILABLE;
    if (
      error.kind === 'EXECUTION_MODE_NOT_ATTAINED' ||
      error.kind === 'FIXTURE_PROVIDER_PROHIBITED' ||
      error.kind === 'IN_MEMORY_PERSISTENCE_PROHIBITED'
    ) {
      context.stderr(
        `The run could not reach ${options.executionMode ? executionModeFlagFor(options.executionMode) : 'the required tier'}.\n`,
      );
      return LAUNCH_EXIT_CODES.EXECUTION_MODE_NOT_ATTAINED;
    }
    if (error.kind === 'INVALID_CONFIGURATION') return LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
    return LAUNCH_EXIT_CODES.DEPENDENCY_UNAVAILABLE;
  }
  context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  return LAUNCH_EXIT_CODES.DEPENDENCY_UNAVAILABLE;
}

function resolveRunDirectory(options: LaunchCliOptions, cwd: string): string {
  const value = options.runDirectory as string;
  return isAbsolute(value) ? value : resolve(cwd, value);
}

async function runInspectCommand(
  options: LaunchCliOptions,
  context: LaunchCliContext,
): Promise<number> {
  const runDirectory = resolveRunDirectory(options, context.cwd);
  try {
    const state = await readLaunchRunState(runDirectory);
    const inspection = inspectLaunchRun(state);
    if (options.json) {
      context.stdout(`${JSON.stringify(inspection, null, 2)}\n`);
      return LAUNCH_EXIT_CODES.SUCCESS;
    }

    const lines: string[] = [
      `launch run:        ${inspection.launchRunId}`,
      `execution mode:    ${inspection.executionMode} (real campaign run: ${inspection.isRealCampaignRun ? 'yes' : 'NO'})`,
      `benchmark profile: ${inspection.benchmarkProfileName}`,
      `brief unchanged:   ${inspection.campaignPromptUnchanged ? 'yes' : 'NO — the campaign brief changed since planning'}`,
      `reviewers:         ${inspection.approvedReviewerIds.join(', ')}`,
      '',
    ];
    for (const concept of inspection.concepts) {
      lines.push(
        `${concept.conceptId}  v${concept.latestVersion}${concept.supersededVersions.length > 0 ? ` (supersedes v${concept.supersededVersions.join(', v')})` : ''}`,
        `  title:            ${concept.title}`,
        `  central idea:     ${concept.centralIdea}`,
        `  structure:        ${Object.entries(concept.structure)
          .map(([axis, value]) => `${axis}=${value}`)
          .join(' ')}`,
        `  asset feasibility:${' '}${concept.assetFeasibility}${concept.missingCaptureIds.length > 0 ? ` (missing captures: ${concept.missingCaptureIds.join(', ')})` : ''}`,
        `  originality risk: ${concept.originalityRiskLevel}`,
        `  selectable:       ${concept.selectable ? 'yes' : `NO — ${concept.blockingReasons.join('; ')}`}`,
      );
      for (const dimension of concept.dimensions) {
        lines.push(
          `    ${dimension.dimension.padEnd(22)} ${dimension.verdict.padEnd(15)} ${dimension.basis}`,
        );
        lines.push(`      ${dimension.finding}`);
      }
      lines.push('');
    }
    lines.push(
      `decisions:         ${inspection.decisions.length}`,
      ...inspection.decisions.map(
        (decision) =>
          `  ${decision.decidedAt} ${decision.decision} by ${decision.reviewerId}${decision.conceptId ? ` on ${decision.conceptId} v${decision.conceptVersion}` : ''}`,
      ),
      `selection:         ${
        inspection.selection
          ? `${inspection.selection.conceptId} v${inspection.selection.conceptVersion} by ${inspection.selection.reviewerId}`
          : 'NONE — rendering is blocked until a reviewer selects a concept'
      }`,
      `render permitted:  ${inspection.renderPermitted ? 'yes' : 'NO'}`,
      '',
      inspection.caveat,
    );
    context.stdout(`${lines.join('\n')}\n`);
    return LAUNCH_EXIT_CODES.SUCCESS;
  } catch (error) {
    return reportGateFailure(error, context);
  }
}

function reportGateFailure(error: unknown, context: LaunchCliContext): number {
  if (error instanceof LaunchGateError) {
    context.stderr(`${error.message}\n`);
    return error.exitCode;
  }
  context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  return LAUNCH_EXIT_CODES.PROVENANCE_INCOMPLETE;
}

async function readFeedback(path: string, cwd: string): Promise<string> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const feedback = (await readFile(absolute, 'utf8')).trim();
  if (feedback.length === 0) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
      `${absolute} is empty. A revision request or a rejection without written feedback is not reviewable.`,
    );
  }
  return feedback;
}

/**
 * Attributes a decision that carries no explicit reviewer.
 *
 * With exactly one approved reviewer there is no ambiguity about who asked, so
 * the record names them. With more than one, the flag is required — a decision
 * attributed to a guess is worse than one that refuses to be recorded.
 */
function resolveReviewer(
  explicit: string | undefined,
  approved: readonly string[],
  action: string,
): string {
  if (explicit) return explicit;
  if (approved.length === 1) return approved[0] as string;
  throw new LaunchGateError(
    LAUNCH_EXIT_CODES.SELECTION_REFUSED,
    `${action} must name the reviewer: this campaign has ${approved.length} approved reviewers (${approved.join(', ')}). Pass --reviewer <user-id>.`,
  );
}

async function runReviseCommand(
  options: LaunchCliOptions,
  context: LaunchCliContext,
): Promise<number> {
  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const runDirectory = resolveRunDirectory(options, context.cwd);
  const now = context.now ? context.now() : new Date();
  const progress = (message: string): void => {
    if (!options.json) context.stderr(`  ${message}\n`);
  };

  let state;
  let feedback: string;
  let reviewerId: string;
  try {
    state = await readLaunchRunState(runDirectory);
    feedback = await readFeedback(options.feedbackPath as string, context.cwd);
    reviewerId = resolveReviewer(
      options.reviewerId,
      state.launchBrief.approvedReviewerIds,
      'a revision request',
    );
  } catch (error) {
    return reportGateFailure(error, context);
  }

  let dependencies: AampDependencies;
  try {
    dependencies = await createAampDependencies({
      env: context.env,
      creativeMemoryMode: options.creativeMemory,
      runMode: options.fixtureDemo ? 'FIXTURE_DEMO' : 'REAL',
      repositoryRoot,
      requiresRendering: false,
      generation: 'NONE',
      fixtures: { reasoning: () => new LaunchFixtureReasoningProvider() },
      overrides: {
        ...(context.creativeMemoryDependencies
          ? { creativeMemoryDependencies: context.creativeMemoryDependencies }
          : {}),
        ...(context.runner ? { runner: context.runner } : {}),
      },
      onProgress: progress,
    });
  } catch (error) {
    return reportDependencyFailure(error, options, context);
  }

  try {
    const injector = dependencies.creativeMemory
      ? new CreativeMemoryInjector({
          mode: options.creativeMemory,
          dependencies: dependencies.creativeMemory,
          workspaceId: state.manifest.workspaceId,
          campaignId: state.manifest.campaignId,
          platform: state.request.platform,
          now,
          onProgress: progress,
        })
      : undefined;

    const result = await reviseConceptInRun({
      state,
      conceptId: options.conceptId as string,
      feedback,
      reviewerId,
      reasoningProvider: requireReasoningProvider(dependencies),
      ...(injector ? { injector } : {}),
      workflowRunId: context.workflowRunId ?? `aamp-cli-${randomUUID()}`,
      now,
      onProgress: progress,
    });

    if (options.json) {
      context.stdout(
        `${JSON.stringify(
          {
            conceptId: result.version.conceptId,
            version: result.version.version,
            supersedesVersion: result.version.supersedesVersion,
            authoredByAgent: result.version.authoredByAgent,
            decisionId: result.decision.decisionId,
            reviewerId: result.decision.reviewerId,
            selectable: result.selectable,
            blockingReasons: result.blockingReasons,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      context.stdout(
        `${[
          `revision recorded: ${result.decision.decisionId} by ${result.decision.reviewerId}`,
          `new version:       ${result.version.conceptId} v${result.version.version} (supersedes v${result.version.supersedesVersion})`,
          `authored by:       ${result.version.authoredByAgent}`,
          `selectable:        ${result.selectable ? 'yes' : `NO — ${result.blockingReasons.join('; ')}`}`,
          '',
          `Version ${result.version.supersedesVersion} is still on disk exactly as it was reviewed, and can no longer be selected.`,
        ].join('\n')}\n`,
      );
    }
    return LAUNCH_EXIT_CODES.SUCCESS;
  } catch (error) {
    return reportGateFailure(error, context);
  } finally {
    await dependencies.close();
  }
}

async function runSelectCommand(
  options: LaunchCliOptions,
  context: LaunchCliContext,
): Promise<number> {
  const runDirectory = resolveRunDirectory(options, context.cwd);
  const now = context.now ? context.now() : new Date();
  try {
    const state = await readLaunchRunState(runDirectory);
    const { selection } = await selectConcept({
      state,
      conceptId: options.conceptId as string,
      ...(options.conceptVersion === undefined ? {} : { conceptVersion: options.conceptVersion }),
      reviewerId: options.reviewerId as string,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      now,
    });

    if (options.json) {
      context.stdout(`${JSON.stringify(selection, null, 2)}\n`);
    } else {
      context.stdout(
        `${[
          `selected:      ${selection.conceptId} v${selection.conceptVersion}`,
          `reviewer:      ${selection.reviewerId}`,
          `at:            ${selection.selectedAt}`,
          `concept sha256:${' '}${selection.conceptChecksumSha256}`,
          '',
          selection.notice,
          '',
          `Next: pnpm aamp:launch render --run ${runDirectory}`,
        ].join('\n')}\n`,
      );
    }
    return LAUNCH_EXIT_CODES.SUCCESS;
  } catch (error) {
    return reportGateFailure(error, context);
  }
}

async function runRejectCommand(
  options: LaunchCliOptions,
  context: LaunchCliContext,
): Promise<number> {
  const runDirectory = resolveRunDirectory(options, context.cwd);
  const now = context.now ? context.now() : new Date();
  try {
    const state = await readLaunchRunState(runDirectory);
    const feedback = await readFeedback(options.feedbackPath as string, context.cwd);
    const decision = await rejectAllConcepts({
      state,
      reviewerId: options.reviewerId as string,
      feedback,
      now,
    });
    if (options.json) {
      context.stdout(`${JSON.stringify(decision, null, 2)}\n`);
    } else {
      context.stdout(
        `whole set rejected by ${decision.reviewerId} at ${decision.decidedAt}. Plan a new set: pnpm aamp:launch plan …\n`,
      );
    }
    return LAUNCH_EXIT_CODES.SUCCESS;
  } catch (error) {
    return reportGateFailure(error, context);
  }
}

async function runRenderCommand(
  options: LaunchCliOptions,
  context: LaunchCliContext,
): Promise<number> {
  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const runDirectory = resolveRunDirectory(options, context.cwd);
  const now = context.now ? context.now() : new Date();
  const progress = (message: string): void => {
    if (!options.json) context.stderr(`  ${message}\n`);
  };

  let state;
  try {
    state = await readLaunchRunState(runDirectory);
  } catch (error) {
    return reportGateFailure(error, context);
  }

  let dependencies: AampDependencies;
  try {
    dependencies = await createAampDependencies({
      env: context.env,
      creativeMemoryMode: options.creativeMemory,
      runMode: options.fixtureDemo ? 'FIXTURE_DEMO' : 'REAL',
      repositoryRoot,
      requiresRendering: !options.skipRender,
      generation: 'NONE',
      ...(options.executionMode ? { requestedExecutionMode: options.executionMode } : {}),
      fixtures: { reasoning: () => new LaunchFixtureReasoningProvider() },
      overrides: {
        ...(context.creativeMemoryDependencies
          ? { creativeMemoryDependencies: context.creativeMemoryDependencies }
          : {}),
        ...(context.runner ? { runner: context.runner } : {}),
      },
      onProgress: progress,
    });
  } catch (error) {
    return reportDependencyFailure(error, options, context);
  }

  try {
    const injector = dependencies.creativeMemory
      ? new CreativeMemoryInjector({
          mode: options.creativeMemory,
          dependencies: dependencies.creativeMemory,
          workspaceId: state.manifest.workspaceId,
          campaignId: state.manifest.campaignId,
          platform: state.request.platform,
          now,
          onProgress: progress,
        })
      : undefined;

    const result = await runLaunchRender({
      runDirectory,
      reasoningProvider: requireReasoningProvider(dependencies),
      reasoningPolicy: dependencies.reasoningPolicy,
      ...(injector ? { injector } : {}),
      creativeMemoryMode: options.creativeMemory,
      repositoryRoot,
      // Both come from the composition root, which owns them for this run.
      binaries: dependencies.binaries,
      runner: dependencies.runner,
      workflowRunId: context.workflowRunId ?? `aamp-cli-${randomUUID()}`,
      now,
      ...(options.skipRender ? { skipRender: true } : {}),
      onProgress: progress,
    });

    if (options.json) {
      context.stdout(
        `${JSON.stringify(
          {
            exitCode: result.exitCode,
            runDirectory: result.runDirectory,
            executionMode: dependencies.executionMode,
            isRealCampaignRun: dependencies.label.isRealCampaignRun,
            caveat: dependencies.label.caveat,
            handoff: result.handoff ?? null,
            campaign: result.campaign ?? null,
            failure: result.failure ?? null,
          },
          null,
          2,
        )}\n`,
      );
    } else if (result.handoff) {
      context.stdout(
        `${[
          `execution mode:    ${dependencies.executionMode}`,
          `real campaign run: ${dependencies.label.isRealCampaignRun ? 'yes' : 'NO'}`,
          `concept:           ${result.handoff.conceptTitle} (${result.handoff.conceptId} v${result.handoff.conceptVersion})`,
          `approved by:       ${result.handoff.reviewerId} at ${result.handoff.selectedAt}`,
          `final MP4:         ${result.campaign?.outputPath ?? 'none'}`,
          `QA status:         ${result.campaign?.qaVerdict ?? 'not run'}`,
          `duration:          ${
            result.campaign?.measuredDurationSeconds === null ||
            result.campaign?.measuredDurationSeconds === undefined
              ? 'unknown'
              : `${result.campaign.measuredDurationSeconds.toFixed(3)}s`
          }`,
          `resolution:        ${result.campaign?.measuredResolution ?? '?'}`,
          `status:            ${result.exitCode === LAUNCH_EXIT_CODES.SUCCESS ? 'RENDERED — REQUIRES HUMAN APPROVAL' : 'NOT DELIVERED'}`,
        ].join('\n')}\n`,
      );
    }

    if (result.failure) context.stderr(`\n${result.failure}\n`);
    if (!dependencies.label.isRealCampaignRun && result.exitCode === LAUNCH_EXIT_CODES.SUCCESS) {
      context.stderr(`\nWARNING: ${dependencies.label.caveat}\n`);
    }
    return result.exitCode;
  } catch (error) {
    return reportGateFailure(error, context);
  } finally {
    await dependencies.close();
  }
}
