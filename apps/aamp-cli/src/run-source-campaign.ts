import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  NodeCommandRunner,
  renderAdvertisement,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';
import {
  evaluateOriginality,
  type CreativeMemoryMode,
  type OriginalityAssessment,
} from '@combat/domain';
import type { ReasoningProvider } from '@combat/providers';

import {
  AssetResolutionError,
  describeAssetProvenance,
  resolveProductionAssets,
  type ResolvedAsset,
} from './asset-resolution';
import { buildSourceEdit, EditConstructionError } from './build-source-edit';
import type { CampaignRequest } from './campaign-request';
import { buildCreativeScorecard } from './creative-scorecard';
import {
  CreativeMemoryInjectionError,
  type CreativeMemoryInjector,
} from './creative-memory/injection';
import { buildOriginalityEntries } from './creative-memory/originality-inputs';
import { CampaignPlanningError, planCampaign } from './plan-campaign';
import { parseProductionAssetManifest, ProductionAssetManifestError } from './production-assets';
import type { ReasoningPolicy } from './reasoning-policy';
import {
  describeSelections,
  MissingShotSourceError,
  selectSources,
  type ShotSelection,
} from './source-selection';

/**
 * The whole source-based flow, from a validated request to a reviewed run
 * directory.
 *
 * Every stage writes its own artefact before the next begins, so a run that
 * fails halfway still leaves behind enough to see why: the plan that was made,
 * the assets that were accepted, the timeline that was built. A failed render
 * with no record of what it tried to render is the least useful possible
 * outcome, and it is what the previous CLI produced.
 */

/**
 * Exit codes. Distinct per failure class so a script can branch on *what* went
 * wrong without parsing prose — a missing file and an expired licence need very
 * different responses from whoever is on the other end.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  INVALID_CAMPAIGN_REQUEST: 2,
  REAL_REASONING_UNAVAILABLE: 3,
  INVALID_ASSET_RIGHTS: 4,
  MISSING_PRODUCTION_ASSETS: 5,
  PLANNING_FAILURE: 6,
  RENDERING_FAILURE: 7,
  QA_FAILURE: 8,
  /**
   * `--creative-memory required` could not obtain governed, eligible,
   * role-specific context. Distinct from a planning failure on purpose: the
   * agents never ran, and the response is an operator action (approve a
   * profile, start Qdrant, index the library), not a re-prompt.
   */
  CREATIVE_MEMORY_UNAVAILABLE: 9,
  /** A HIGH originality risk stopped the run before any source was selected. */
  ORIGINALITY_RISK_BLOCKED: 10,
  /**
   * `--execution-mode` named a tier the actual dependencies could not reach.
   * Distinct from a dependency failure: every collaborator may be present and
   * working, and the run still refused because one of them was a substitute.
   */
  EXECUTION_MODE_NOT_ATTAINED: 11,
  /** A collaborator could not be constructed at all. Nothing ran. */
  DEPENDENCY_UNAVAILABLE: 12,
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Rejections that mean "the rights are wrong" rather than "the file is missing". */
const RIGHTS_REJECTIONS = new Set(['RIGHTS_NOT_PERMITTED', 'LICENCE_EXPIRED']);

/**
 * Written on every Creative Memory provenance artefact. The audit record is
 * the place a later reader decides whether the run was legitimate, so it states
 * the rights position rather than leaving it to be inferred from an absence.
 */
const CREATIVE_MEMORY_PROVENANCE_NOTICE =
  'Reference material is analysis-only. Retrieval, injection and benchmark-profile approval grant no output rights, and no reference contributed a byte to the rendered advertisement.' as const;

export interface SourceCampaignOptions {
  readonly request: CampaignRequest;
  readonly reasoningProvider: ReasoningProvider;
  readonly reasoningPolicy: ReasoningPolicy;
  readonly runDirectory: string;
  readonly repositoryRoot: string;
  readonly binaries: FfmpegBinaries;
  readonly workflowRunId: string;
  readonly now: Date;
  readonly runner?: CommandRunner;
  /** Absent when `--creative-memory off`, which is the pre-injection baseline. */
  readonly injector?: CreativeMemoryInjector;
  readonly creativeMemoryMode: CreativeMemoryMode;
  readonly onProgress?: (message: string) => void;
}

export interface SourceCampaignResult {
  readonly exitCode: ExitCode;
  readonly runDirectory: string;
  readonly outputPath?: string;
  readonly qaVerdict?: string;
  readonly measuredDurationSeconds?: number | null;
  readonly measuredResolution?: string;
  readonly measuredCodecs?: string;
  readonly heuristicAverage?: number;
  readonly creativeMemoryMode?: CreativeMemoryMode;
  readonly originality?: OriginalityAssessment;
  readonly failure?: string;
  /**
   * Facts the run provenance record needs and that nothing else can supply
   * afterwards. The checksum in particular is *measured from the produced file*
   * by actual-media QA — never a value the manifest declared.
   */
  readonly outputChecksumSha256?: string;
  readonly qaFailedChecks?: readonly string[];
  readonly agentVersions?: readonly string[];
}

async function writeArtefact(
  runDirectory: string,
  filename: string,
  value: unknown,
): Promise<string> {
  const target = join(runDirectory, filename);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

export async function runSourceCampaign(
  options: SourceCampaignOptions,
): Promise<SourceCampaignResult> {
  const { request, runDirectory, onProgress } = options;
  await mkdir(runDirectory, { recursive: true });

  const fail = (exitCode: ExitCode, failure: string): SourceCampaignResult => ({
    exitCode,
    runDirectory,
    failure,
  });

  // The canonical request, recorded verbatim. Nothing secret is in it — the
  // prompt is content, not credentials — and it is what makes a run
  // reproducible months later.
  await writeArtefact(runDirectory, 'campaign-request.json', request);

  // --- production assets -------------------------------------------------
  let assets: readonly ResolvedAsset[];
  try {
    onProgress?.('resolving production assets');
    const manifest = parseProductionAssetManifest(
      JSON.parse(await readFile(request.sourceAssetManifestPath, 'utf8')),
      request.sourceAssetManifestPath,
    );
    assets = await resolveProductionAssets({
      manifest,
      manifestDir: dirname(request.sourceAssetManifestPath),
      allowedRoots: [options.repositoryRoot, dirname(request.sourceAssetManifestPath)],
      binaries: options.binaries,
      now: options.now,
      ...(options.runner ? { runner: options.runner } : {}),
    });
  } catch (error) {
    if (error instanceof ProductionAssetManifestError) {
      // A manifest that declares ANALYSIS_ONLY or UNKNOWN_RIGHTS fails here.
      const rightsProblem = error.issues.some((issue) => issue.path.includes('rights'));
      return fail(
        rightsProblem ? EXIT_CODES.INVALID_ASSET_RIGHTS : EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
        error.message,
      );
    }
    if (error instanceof AssetResolutionError) {
      const rightsProblem = error.rejections.some((rejection) =>
        RIGHTS_REJECTIONS.has(rejection.reason),
      );
      await writeArtefact(runDirectory, 'asset-provenance.json', {
        status: 'REJECTED',
        rejections: error.rejections,
      });
      return fail(
        rightsProblem ? EXIT_CODES.INVALID_ASSET_RIGHTS : EXIT_CODES.MISSING_PRODUCTION_ASSETS,
        error.message,
      );
    }
    return fail(
      EXIT_CODES.MISSING_PRODUCTION_ASSETS,
      error instanceof Error ? error.message : String(error),
    );
  }

  await writeArtefact(runDirectory, 'asset-provenance.json', {
    status: 'ACCEPTED',
    library: request.sourceAssetManifestPath,
    assets: describeAssetProvenance(assets),
  });

  // --- planning ----------------------------------------------------------
  let plan;
  try {
    onProgress?.('planning campaign');
    plan = await planCampaign({
      request,
      reasoningProvider: options.reasoningProvider,
      workflowRunId: options.workflowRunId,
      ...(options.injector ? { injector: options.injector } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
  } catch (error) {
    // A governance failure is reported as itself. Folding it into
    // PLANNING_FAILURE would tell an operator to look at the brief when the
    // actual problem is that nobody approved a benchmark profile.
    if (error instanceof CreativeMemoryInjectionError) {
      await writeArtefact(runDirectory, 'creative-memory-provenance.json', {
        mode: options.creativeMemoryMode,
        status: 'FAILED',
        failureKind: error.kind,
        agentRole: error.agentRole,
        detail: error.message,
        retrievals: options.injector?.audits ?? [],
        anyReferenceOutputEligible: false,
        notice: CREATIVE_MEMORY_PROVENANCE_NOTICE,
      });
      return fail(EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE, error.message);
    }
    return fail(
      EXIT_CODES.PLANNING_FAILURE,
      error instanceof CampaignPlanningError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  await writeArtefact(runDirectory, 'agent-outputs.json', {
    strategy: plan.strategy,
    concept: plan.concept,
    script: plan.script,
    shotBriefs: plan.shotBriefs,
    agentVersions: plan.agentVersions,
  });

  // --- Creative Memory provenance and originality --------------------------
  const originality = evaluateOriginality(buildOriginalityEntries(plan));
  await writeArtefact(runDirectory, 'originality-report.json', originality);
  await writeArtefact(runDirectory, 'creative-memory-provenance.json', {
    mode: options.creativeMemoryMode,
    status: options.creativeMemoryMode === 'off' ? 'NOT_USED' : 'COMPLETED',
    retrievals: options.injector?.audits ?? [],
    divergence: plan.roleContexts.map((record) => ({
      agentRole: record.agentRole,
      ...(record.shotIndex === undefined ? {} : { shotIndex: record.shotIndex }),
      contextInjected: record.context !== undefined,
      contextItems: record.context?.items.length ?? 0,
      ...(record.divergence ? { divergence: record.divergence } : {}),
    })),
    originality: {
      riskLevel: originality.riskLevel,
      blocked: originality.blocked,
      requiresHumanReview: originality.requiresHumanReview,
      signals: originality.signals,
    },
    anyReferenceOutputEligible: false,
    notice: CREATIVE_MEMORY_PROVENANCE_NOTICE,
  });

  if (originality.blocked) {
    // Stopped here, before any source is selected or any frame is rendered:
    // the cheapest place to catch it, and the only one where nothing has been
    // produced that could later be mistaken for an approved deliverable.
    return fail(
      EXIT_CODES.ORIGINALITY_RISK_BLOCKED,
      `originality risk is HIGH — production planning stopped. Signals: ${originality.signals
        .filter((signal) => signal.severity === 'HIGH')
        .map((signal) => `${signal.agentRole}/${signal.code}`)
        .join(', ')}`,
    );
  }

  // --- source selection ---------------------------------------------------
  let selections: readonly ShotSelection[];
  try {
    onProgress?.('selecting sources');
    selections = selectSources({ request, shots: plan.shots, assets });
  } catch (error) {
    if (error instanceof MissingShotSourceError) {
      return fail(EXIT_CODES.MISSING_PRODUCTION_ASSETS, error.message);
    }
    return fail(
      EXIT_CODES.PLANNING_FAILURE,
      error instanceof Error ? error.message : String(error),
    );
  }

  await writeArtefact(runDirectory, 'source-selection.json', {
    deterministic: true,
    selections: describeSelections(selections),
  });

  // --- edit construction ---------------------------------------------------
  let renderManifest;
  try {
    onProgress?.('building the edit');
    renderManifest = buildSourceEdit({
      request,
      selections,
      assets,
      captionLines: plan.captionLines,
    });
  } catch (error) {
    return fail(
      error instanceof EditConstructionError
        ? EXIT_CODES.PLANNING_FAILURE
        : EXIT_CODES.PLANNING_FAILURE,
      error instanceof Error ? error.message : String(error),
    );
  }

  await writeArtefact(runDirectory, 'render-manifest.json', renderManifest);

  // --- render --------------------------------------------------------------
  let rendered;
  try {
    onProgress?.('rendering with FFmpeg');
    rendered = await renderAdvertisement(options.runner ?? new NodeCommandRunner(), {
      manifest: renderManifest,
      manifestDir: runDirectory,
      allowedSourceRoots: [
        options.repositoryRoot,
        runDirectory,
        dirname(request.sourceAssetManifestPath),
      ],
      outputRoot: runDirectory,
      binaries: options.binaries,
      now: options.now,
    });
  } catch (error) {
    return fail(
      EXIT_CODES.RENDERING_FAILURE,
      error instanceof Error ? error.message : String(error),
    );
  }

  const { summary } = rendered.qaReport;
  const scorecard = buildCreativeScorecard({
    request,
    manifest: renderManifest,
    selections,
    measuredDurationSeconds: summary.durationSeconds,
    qaVerdict: rendered.qaReport.verdict,
    hasAudio: summary.audioCodec !== null && summary.audioCodec !== undefined,
  });
  await writeArtefact(runDirectory, 'creative-scorecard.json', scorecard);

  const executionModeReport = {
    runMode: options.reasoningPolicy.runMode,
    isRealCampaignRun: options.reasoningPolicy.runMode === 'REAL',
    reasoningProvider: options.reasoningPolicy.providerName,
    reasoningModel: options.reasoningPolicy.reasoningModel,
    fixtureReasoning: options.reasoningPolicy.useFixtureReasoning,
    generationProvider: request.generation.source === 'COMFYUI' ? 'comfyui' : 'source-library',
    renderingProvider: 'ffmpeg-deterministic',
    promptSha256: request.promptSha256,
    agentVersions: plan.agentVersions,
    caveat:
      options.reasoningPolicy.runMode === 'REAL'
        ? 'Creative was generated by a real reasoning model from the supplied campaign prompt. Human approval is still required.'
        : 'DEMONSTRATION ONLY — creative was replayed from committed fixtures and ignores the campaign prompt. This is not a campaign result.',
  };
  await writeArtefact(runDirectory, 'execution-mode.json', executionModeReport);

  const runSummary = {
    campaignId: request.campaignId,
    workspaceId: request.workspaceId,
    workflowRunId: options.workflowRunId,
    runMode: options.reasoningPolicy.runMode,
    promptSha256: request.promptSha256,
    outputPath: rendered.outputPath,
    qaVerdict: rendered.qaReport.verdict,
    // READY is gated on technical QA, never on the heuristic score.
    status: rendered.qaReport.verdict === 'PASS' ? 'RENDERED_PENDING_HUMAN_APPROVAL' : 'REJECTED',
    requiresHumanApproval: true,
    measured: {
      durationSeconds: summary.durationSeconds,
      widthPx: summary.widthPx,
      heightPx: summary.heightPx,
      videoCodec: summary.videoCodec,
      audioCodec: summary.audioCodec,
    },
    heuristicAverage: scorecard.heuristicAverage,
    creativeMemory: {
      mode: options.creativeMemoryMode,
      rolesWithContext: originality.rolesWithContext,
      originalityRiskLevel: originality.riskLevel,
      // MEDIUM never blocks, but it must not disappear either: the run summary
      // is what a reviewer reads first.
      requiresOriginalityReview: originality.requiresHumanReview,
      anyReferenceOutputEligible: false,
    },
    artefacts: [
      'campaign-request.json',
      'agent-outputs.json',
      'render-manifest.json',
      'source-selection.json',
      'asset-provenance.json',
      'creative-scorecard.json',
      'creative-memory-provenance.json',
      'originality-report.json',
      'execution-mode.json',
      'run-summary.json',
    ],
    qaReportPath: rendered.qaReportPath,
  };
  await writeArtefact(runDirectory, 'run-summary.json', runSummary);

  const measuredResolution = `${summary.widthPx ?? '?'}x${summary.heightPx ?? '?'}`;
  const measuredCodecs = `${summary.videoCodec ?? 'none'} / ${summary.audioCodec ?? 'none'}`;

  const qaFailedChecks = rendered.qaReport.measurements
    .filter((measurement) => measurement.verdict === 'FAIL')
    .map((measurement) => `${measurement.check}: expected ${measurement.expected}`);

  const common = {
    runDirectory,
    outputPath: rendered.outputPath,
    qaVerdict: rendered.qaReport.verdict,
    measuredDurationSeconds: summary.durationSeconds,
    measuredResolution,
    measuredCodecs,
    heuristicAverage: scorecard.heuristicAverage,
    creativeMemoryMode: options.creativeMemoryMode,
    originality,
    outputChecksumSha256: summary.checksumSha256,
    qaFailedChecks,
    agentVersions: plan.agentVersions,
  };

  if (rendered.qaReport.verdict !== 'PASS') {
    return { ...common, exitCode: EXIT_CODES.QA_FAILURE, failure: qaFailedChecks.join('; ') };
  }
  return { ...common, exitCode: EXIT_CODES.SUCCESS };
}

/** Re-exported for the CLI's own resolution of the run directory. */
export function runDirectoryFor(root: string, requestName: string, workflowRunId: string): string {
  return resolve(root, `${requestName}-${workflowRunId.slice(-12)}`);
}
