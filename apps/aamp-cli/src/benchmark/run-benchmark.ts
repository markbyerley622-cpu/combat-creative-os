import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { CreativeMemoryMode } from '@combat/domain';
import type { ReasoningProvider } from '@combat/providers';

import type { CampaignRequest } from '../campaign-request';
import { ContextAwareFixtureReasoningProvider } from '../creative-memory/context-aware-fixture-reasoning';
import { CreativeMemoryInjector } from '../creative-memory/injection';
import { buildRunProvenance } from '../production/campaign-run-provenance';
import { requireReasoningProvider, type AampDependencies } from '../production/dependency-factory';
import { writeRunProvenance } from '../production/run-provenance';
import { EXIT_CODES, runSourceCampaign } from '../run-source-campaign';
import { buildComparisonReport, collectArmFacts, type ComparisonReport } from './comparison';
import {
  assertArmsWereControlled,
  CREATIVE_BENCHMARK_EXPERIMENT_VERSION,
  EXPERIMENT_INTERPRETATION,
  ExperimentControlViolation,
  freezeDeep,
  hashExperimentRequest,
  sealExperiment,
  sha256Of,
  type BenchmarkArm,
  type BenchmarkArmKey,
  type ComparisonStatus,
  type ControlledSettings,
  type CreativeBenchmarkExperiment,
  type ExperimentStatus,
  type ImmutableExperimentInputs,
} from './experiment';
import { createBlankScorecard } from './human-scorecard';
import type { PaidProviderDecision } from './paid-providers';
import { renderComparisonMarkdown } from './report-markdown';

/**
 * Runs the same campaign twice — Creative Memory off, then required — and
 * compares what came out.
 *
 * Three properties make this an experiment rather than two runs:
 *
 * - **The inputs are frozen and hashed once.** Both arms receive the same
 *   object, each records the hash it actually got, and `assertArmsWereControlled`
 *   refuses to compare arms that disagree. A comparison of two different briefs
 *   is worse than no comparison, because it looks like evidence.
 * - **No mutable state crosses between arms.** Each arm gets its own run
 *   directory, its own workflow run id, its own injector (so audits do not
 *   accumulate) and its own reasoning provider instance. The database and
 *   Qdrant handles are shared, which is correct: they are read-only here.
 * - **The comparison is computed from the artefacts on disk**, so it can be
 *   re-derived from a finished run and cannot quietly depend on something that
 *   was never written down.
 *
 * It reuses `runSourceCampaign` rather than reimplementing a pipeline. There is
 * no second orchestrator here, and no second renderer.
 */

export const BENCHMARK_EXIT_CODES = {
  SUCCESS: 0,
  INVALID_ARGUMENTS: 2,
  DEPENDENCIES_UNAVAILABLE: 3,
  ARM_FAILED: 4,
  CONTROL_VIOLATION: 5,
  ORIGINALITY_BLOCKED: 6,
} as const;

export interface RunBenchmarkOptions {
  readonly experimentId?: string;
  readonly request: CampaignRequest;
  readonly dependencies: AampDependencies;
  readonly repositoryRoot: string;
  readonly outputDirectory: string;
  readonly benchmarkProfileName: string | null;
  readonly paidProviders: PaidProviderDecision;
  readonly planOnly: boolean;
  readonly skipRender: boolean;
  readonly now: Date;
  /**
   * Substitutes the reasoning provider, in process only.
   *
   * A test seam, and a deliberately narrow one: it can replace a provider but
   * can never *cause* a paid call, so it does not weaken the authorisation
   * gate. `benchmark-cli.ts` never sets it, so no command line and no
   * environment variable can reach it.
   */
  readonly reasoningProviderFactory?: () => ReasoningProvider;
  readonly onProgress?: (message: string) => void;
}

export interface BenchmarkResult {
  readonly exitCode: number;
  readonly experiment: CreativeBenchmarkExperiment;
  readonly comparison: ComparisonReport | null;
  readonly experimentPath: string;
  readonly comparisonJsonPath: string | null;
  readonly comparisonMarkdownPath: string | null;
  readonly scorecardTemplatePaths: readonly string[];
  readonly failure: string | null;
}

const ARMS: readonly { key: BenchmarkArmKey; mode: 'off' | 'required' }[] = [
  { key: 'OFF', mode: 'off' },
  { key: 'REQUIRED', mode: 'required' },
];

async function sha256OfFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function writeJson(path: string, value: unknown): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * The reasoning provider for one arm.
 *
 * When paid providers are authorised the arms call the real model. Otherwise
 * they use the **context-aware** deterministic fixture, not the golden-replay
 * one: the replay provider ignores its input entirely, so an ON/OFF comparison
 * driven by it would show two identical plans and prove nothing. The
 * context-aware fixture derives from the retrieved *measurements*, which
 * demonstrates the mechanism — and is labelled as a demonstration everywhere it
 * appears, because it says nothing about how a real model would use the
 * context.
 *
 * A fresh instance per arm: the fixture records its calls, and a shared
 * instance would be mutable state crossing the arm boundary.
 */
async function reasoningFor(
  dependencies: AampDependencies,
  paidProviders: PaidProviderDecision,
  override?: () => ReasoningProvider,
): Promise<{ provider: ReasoningProvider; profile: string; deterministic: boolean }> {
  if (override) {
    return { provider: override(), profile: 'injected-test-provider', deterministic: true };
  }
  if (paidProviders.authorised) {
    return {
      provider: requireReasoningProvider(dependencies),
      profile: `${paidProviders.providerName}/${paidProviders.model}`,
      deterministic: false,
    };
  }
  return {
    provider: new ContextAwareFixtureReasoningProvider(),
    profile: 'deterministic-context-aware-fixture',
    deterministic: true,
  };
}

export async function runCreativeBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkResult> {
  const { request, dependencies, now } = options;
  const progress = options.onProgress ?? ((): void => undefined);
  const experimentId = options.experimentId ?? `bench-${randomUUID()}`;
  const experimentDirectory = resolve(options.outputDirectory, experimentId);

  // --- immutable inputs, hashed once ---------------------------------------
  const frozenRequest = freezeDeep({ ...request });
  const inputs: ImmutableExperimentInputs = {
    campaignRequest: frozenRequest,
    requestHashSha256: hashExperimentRequest(frozenRequest),
    promptSha256: frozenRequest.promptSha256,
    productionAssetsPath: frozenRequest.sourceAssetManifestPath,
    productionAssetsSha256: await sha256OfFile(frozenRequest.sourceAssetManifestPath),
    platform: frozenRequest.platform,
    targetDurationSeconds: frozenRequest.targetDurationSeconds,
  };

  const arms: BenchmarkArm[] = [];
  const profileVersions = new Map<
    string,
    { agentRole: string; profileId: string; version: number; governingChecksumSha256: string }
  >();
  let agentPromptVersions: readonly string[] = [];
  let status: ExperimentStatus = 'RUNNING';
  let failure: string | null = null;

  for (const arm of ARMS) {
    progress(`arm ${arm.key}: creative memory ${arm.mode}`);
    const runDirectory = join(experimentDirectory, `arm-${arm.key.toLowerCase()}`);
    const workflowRunId = `${experimentId}-${arm.key.toLowerCase()}`;

    // A fresh injector per arm, so audits never accumulate across arms.
    const injector =
      arm.mode === 'required' && dependencies.creativeMemory
        ? new CreativeMemoryInjector({
            mode: 'required',
            dependencies: dependencies.creativeMemory,
            workspaceId: frozenRequest.workspaceId,
            campaignId: frozenRequest.campaignId,
            platform: frozenRequest.platform,
            now,
            onProgress: progress,
          })
        : undefined;

    // A fresh provider per arm: the deterministic fixture records its calls, so
    // a shared instance would be mutable state crossing the arm boundary.
    // eslint-disable-next-line no-await-in-loop -- the arms run in declared order, and OFF must not see REQUIRED's state
    const { provider } = await reasoningFor(
      dependencies,
      options.paidProviders,
      options.reasoningProviderFactory,
    );

    // eslint-disable-next-line no-await-in-loop -- same ordering rationale
    const result = await runSourceCampaign({
      request: frozenRequest,
      reasoningProvider: provider,
      reasoningPolicy: dependencies.reasoningPolicy,
      runDirectory,
      repositoryRoot: options.repositoryRoot,
      binaries: dependencies.binaries,
      workflowRunId,
      now,
      creativeMemoryMode: arm.mode as CreativeMemoryMode,
      ...(injector ? { injector } : {}),
      runner: dependencies.runner,
      ...(options.planOnly || options.skipRender ? { skipRender: true } : {}),
      onProgress: progress,
    });

    if (result.agentVersions && result.agentVersions.length > 0) {
      agentPromptVersions = result.agentVersions;
    }
    for (const audit of injector?.audits ?? []) {
      if (audit.benchmarkProfile) {
        profileVersions.set(audit.agentRole, {
          agentRole: audit.agentRole,
          profileId: audit.benchmarkProfile.id,
          version: audit.benchmarkProfile.version,
          governingChecksumSha256: audit.benchmarkProfile.governingChecksumSha256,
        });
      }
    }

    // eslint-disable-next-line no-await-in-loop -- provenance is written per arm, in order
    await writeRunProvenance(
      runDirectory,
      buildRunProvenance({
        request: frozenRequest,
        dependencies,
        creativeMemoryMode: arm.mode,
        audits: injector?.audits ?? [],
        workflowRunId,
        startedAt: now,
        completedAt: now,
        result,
        failureReason: result.failure ?? null,
        fallbackReason: null,
      }),
    ).catch(() => undefined);

    arms.push({
      key: arm.key,
      creativeMemoryMode: arm.mode,
      runDirectory,
      workflowRunId,
      // Recomputed from what this arm was actually handed, not copied from the
      // experiment — otherwise the control check would be comparing a value
      // with itself.
      receivedRequestHashSha256: hashExperimentRequest(frozenRequest),
      receivedAssetsSha256: await sha256OfFile(frozenRequest.sourceAssetManifestPath),
      exitCode: result.exitCode,
      outputPath: result.outputPath ?? null,
      outputChecksumSha256: result.outputChecksumSha256 ?? null,
      qaVerdict: result.qaVerdict ?? null,
      renderSkipped: result.renderSkipped === true,
      originalityRiskLevel: result.originality?.riskLevel ?? null,
      originalityBlocked: result.originality?.blocked === true,
      retrievalCount: injector?.audits.length ?? 0,
      failure: result.failure ?? null,
    });

    if (result.exitCode === EXIT_CODES.ORIGINALITY_RISK_BLOCKED) {
      status = 'BLOCKED_BY_ORIGINALITY';
      failure = `arm ${arm.key} was blocked by a HIGH originality result; nothing was rendered`;
      break;
    }
    if (result.exitCode !== EXIT_CODES.SUCCESS && result.exitCode !== EXIT_CODES.QA_FAILURE) {
      status = 'FAILED';
      failure = `arm ${arm.key} failed (exit ${result.exitCode}): ${result.failure ?? 'no detail'}`;
      break;
    }
  }

  // --- the control check ----------------------------------------------------
  let controlViolation: string | null = null;
  if (status === 'RUNNING') {
    try {
      assertArmsWereControlled(inputs, arms);
      status = 'COMPLETED';
    } catch (error) {
      status = 'FAILED';
      controlViolation = error instanceof Error ? error.message : String(error);
      failure = controlViolation;
    }
  }

  // --- comparison -----------------------------------------------------------
  let comparison: ComparisonReport | null = null;
  let comparisonStatus: ComparisonStatus = 'NOT_PRODUCED';
  if (status === 'COMPLETED') {
    progress('comparing the two arms');
    const off = await collectArmFacts('OFF', 'off', join(experimentDirectory, 'arm-off'));
    const required = await collectArmFacts(
      'REQUIRED',
      'required',
      join(experimentDirectory, 'arm-required'),
    );
    comparison = buildComparisonReport({
      experimentId,
      campaignName: frozenRequest.name,
      comparedAt: now,
      off,
      required,
    });
    comparisonStatus =
      off.qaVerdict !== null && required.qaVerdict !== null
        ? 'STRUCTURAL_AND_MEDIA'
        : 'STRUCTURAL_ONLY';
  }

  const controlled: ControlledSettings = {
    reasoningProfile: options.paidProviders.authorised
      ? `${options.paidProviders.providerName}/${options.paidProviders.model}`
      : 'deterministic-context-aware-fixture',
    reasoningModel: options.paidProviders.authorised
      ? options.paidProviders.model
      : 'NONE-DETERMINISTIC-FIXTURE',
    reasoningDeterministic: !options.paidProviders.authorised,
    agentPromptVersions,
    generationProfile:
      dependencies.providers.find((provider) => provider.role === 'video-generation')?.version ??
      null,
    renderProvider:
      dependencies.providers.find((provider) => provider.role === 'motion-graphics')?.identity ??
      'none',
    renderSettings: {
      widthPx: 1080,
      heightPx: 1920,
      frameRate: 30,
      targetDurationSeconds: frozenRequest.targetDurationSeconds,
    },
    qaConfiguration:
      'actual-media QA: container, codecs, geometry, duration, blankness, CTA, captions',
    // The context-aware fixture is a pure function of its input, so it needs no
    // seed; a real model exposes none through this path. Reporting `0` would
    // imply a reproducibility guarantee neither provider offers.
    deterministicSeed: null,
  };

  const experiment = sealExperiment({
    experimentVersion: CREATIVE_BENCHMARK_EXPERIMENT_VERSION,
    experimentId,
    workspaceId: frozenRequest.workspaceId,
    campaignId: frozenRequest.campaignId,
    campaignName: frozenRequest.name,
    inputs,
    benchmarkProfileName: options.benchmarkProfileName,
    benchmarkProfileVersions: [...profileVersions.values()].sort((left, right) =>
      left.agentRole.localeCompare(right.agentRole),
    ),
    requestedExecutionMode: dependencies.requestedExecutionMode ?? null,
    executionMode: dependencies.executionMode,
    evidence: dependencies.evidence,
    providers: dependencies.providers,
    controlled,
    arms,
    status,
    comparisonStatus,
    humanReviewStatus: 'AWAITING_HUMAN_REVIEW',
    paidProvidersAuthorised: options.paidProviders.authorised,
    paidProviderAuthorisation: options.paidProviders.authorised
      ? options.paidProviders.statement
      : null,
    estimatedMaximumCostCents: options.paidProviders.estimate?.estimatedMaximumCostCents ?? null,
    actualCostCents: null,
    costBasis:
      'NOT_METERED_BY_CLI — this command reserves no budget and writes no BudgetLedger row. The estimate is a declared-rate ceiling, not a measurement.',
    comparisonReportSha256: comparison?.reportChecksumSha256 ?? null,
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    interpretation: EXPERIMENT_INTERPRETATION,
  });

  // --- artefacts ------------------------------------------------------------
  await mkdir(experimentDirectory, { recursive: true });
  const experimentPath = await writeJson(join(experimentDirectory, 'experiment.json'), experiment);

  let comparisonJsonPath: string | null = null;
  let comparisonMarkdownPath: string | null = null;
  const scorecardTemplatePaths: string[] = [];

  if (comparison) {
    comparisonJsonPath = await writeJson(
      join(experimentDirectory, 'comparison-report.json'),
      comparison,
    );
    comparisonMarkdownPath = join(experimentDirectory, 'comparison-report.md');
    await writeFile(
      comparisonMarkdownPath,
      renderComparisonMarkdown(experiment, comparison),
      'utf8',
    );

    for (const arm of ARMS) {
      // A template, never a score. Nothing in this repository fills it in.
      // eslint-disable-next-line no-await-in-loop -- written in arm order
      scorecardTemplatePaths.push(
        await writeJson(
          join(experimentDirectory, `human-scorecard.${arm.key.toLowerCase()}.template.json`),
          createBlankScorecard(experimentId, arm.key),
        ),
      );
    }
  }

  const exitCode =
    status === 'COMPLETED'
      ? BENCHMARK_EXIT_CODES.SUCCESS
      : status === 'BLOCKED_BY_ORIGINALITY'
        ? BENCHMARK_EXIT_CODES.ORIGINALITY_BLOCKED
        : controlViolation
          ? BENCHMARK_EXIT_CODES.CONTROL_VIOLATION
          : BENCHMARK_EXIT_CODES.ARM_FAILED;

  return {
    exitCode,
    experiment,
    comparison,
    experimentPath,
    comparisonJsonPath,
    comparisonMarkdownPath,
    scorecardTemplatePaths,
    failure,
  };
}

export { ExperimentControlViolation, sha256Of };
