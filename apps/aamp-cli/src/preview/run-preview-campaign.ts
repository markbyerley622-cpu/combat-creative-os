import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { evaluateOriginality, type OriginalityAssessment } from '@combat/domain';
import {
  analyseClip,
  NodeCommandRunner,
  renderAdvertisement,
  type ClipAnalysis,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';

import {
  AssetResolutionError,
  describeAssetProvenance,
  resolveProductionAssets,
  type ResolvedAsset,
} from '../asset-resolution';
import type { CampaignRequest } from '../campaign-request';
import { buildCreativeScorecard } from '../creative-scorecard';
import { buildOriginalityEntries } from '../creative-memory/originality-inputs';
import { parseProductionAssetManifest, ProductionAssetManifestError } from '../production-assets';
import { EXIT_CODES, type ExitCode } from '../run-source-campaign';
import { describeAudioPlan } from './audio-plan';
import {
  AssetRootPreflightError,
  runAssetRootPreflight,
  type AssetRootPreflightReport,
} from './asset-root-preflight';
import { buildPreviewEdit, PreviewEditError } from './build-preview-edit';
import { HumanPlanValidationError, loadHumanPlan, type HumanCreativePlan } from './human-plan';
import { projectHumanPlan } from './plan-to-campaign-plan';
import {
  selectSegments,
  SegmentSelectionError,
  describeSegmentSelections,
  type SelectedSegment,
  type SegmentRequest,
} from './segment-selection';
import {
  AUDIO_PLAN_FILENAME,
  extractPreviewFrames,
  RENDER_SUMMARY_FILENAME,
  SOURCE_SELECTION_REPORT_FILENAME,
  writeStoryboardArtefacts,
} from './storyboard';

/**
 * The whole zero-cost, footage-first preview: a validated human plan and an
 * external library of owned material, to a measured MP4.
 *
 * The stage order is the point. Preflight and plan validation come first, so a
 * bad library or an incomplete plan costs nothing. Clip analysis and segment
 * selection come next, so the cut is decided before a frame is encoded. The
 * storyboard is written *before* the render, so a reviewer can see what is
 * about to be made and so QA has something independent to compare the finished
 * file against. Only then does FFmpeg run.
 *
 * Nothing here constructs a reasoning provider or a video-generation provider,
 * and nothing imports one. That is what makes "zero paid provider calls" a
 * structural property of this module rather than a promise in a comment.
 */

export interface PreviewCampaignOptions {
  readonly request: CampaignRequest;
  readonly planPath: string;
  readonly assetRoot: string;
  readonly runDirectory: string;
  readonly repositoryRoot: string;
  readonly binaries: FfmpegBinaries;
  readonly workflowRunId: string;
  readonly now: Date;
  readonly runner?: CommandRunner;
  readonly onProgress?: (message: string) => void;
}

export interface PreviewCampaignResult {
  readonly exitCode: ExitCode;
  readonly runDirectory: string;
  readonly outputPath?: string;
  readonly qaVerdict?: string;
  readonly measuredDurationSeconds?: number | null;
  readonly measuredResolution?: string;
  readonly measuredCodecs?: string;
  readonly measuredLoudnessLufs?: number | null;
  readonly measuredPeakDbtp?: number | null;
  readonly outputChecksumSha256?: string;
  readonly qaFailedChecks?: readonly string[];
  readonly heuristicAverage?: number;
  readonly originality?: OriginalityAssessment;
  readonly preflight?: AssetRootPreflightReport;
  readonly plan?: HumanCreativePlan;
  readonly nonZeroInPointCount?: number;
  readonly artefacts?: readonly string[];
  readonly failure?: string;
  /** Always zero here, and written rather than inferred. */
  readonly paidProviderCalls: 0;
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

export async function runPreviewCampaign(
  options: PreviewCampaignOptions,
): Promise<PreviewCampaignResult> {
  const { request, runDirectory, onProgress } = options;
  const runner = options.runner ?? new NodeCommandRunner();
  await mkdir(runDirectory, { recursive: true });

  const fail = (exitCode: ExitCode, failure: string): PreviewCampaignResult => ({
    exitCode,
    runDirectory,
    failure,
    paidProviderCalls: 0,
  });

  await writeArtefact(runDirectory, 'campaign-request.json', request);

  // --- the human plan --------------------------------------------------------
  let plan: HumanCreativePlan;
  try {
    onProgress?.('validating the human-authored plan');
    plan = await loadHumanPlan(options.planPath, request);
  } catch (error) {
    return fail(
      EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
      error instanceof HumanPlanValidationError
        ? error.message
        : `Could not read the creative plan at ${options.planPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await writeArtefact(runDirectory, 'creative-plan.json', plan);

  const shortestBeatSeconds = Math.min(...plan.beats.map((beat) => beat.durationSeconds));

  // --- the external asset root ----------------------------------------------
  let preflight: AssetRootPreflightReport;
  let assets: readonly ResolvedAsset[];
  try {
    onProgress?.('preflighting the external asset root');
    const manifest = parseProductionAssetManifest(
      JSON.parse(await readFile(request.sourceAssetManifestPath, 'utf8')),
      request.sourceAssetManifestPath,
    );
    preflight = await runAssetRootPreflight({
      manifest,
      manifestDir: dirname(request.sourceAssetManifestPath),
      assetRoot: options.assetRoot,
      binaries: options.binaries,
      now: options.now,
      runner,
      shortestBeatSeconds,
    });
    // The existing resolver still runs: it is the single gate that proves
    // rights, containment, checksums and media kind for the renderer, and
    // preflight adds to it rather than replacing it.
    assets = await resolveProductionAssets({
      manifest,
      manifestDir: dirname(request.sourceAssetManifestPath),
      allowedRoots: [preflight.canonicalAssetRoot],
      binaries: options.binaries,
      now: options.now,
      runner,
    });
  } catch (error) {
    if (error instanceof AssetRootPreflightError) {
      await writeArtefact(runDirectory, 'asset-preflight.json', {
        status: 'REJECTED',
        problems: error.problems,
      });
      const rightsProblem = error.problems.some(
        (problem) =>
          problem.kind === 'RIGHTS_NOT_PERMITTED' ||
          problem.kind === 'REFERENCE_MATERIAL_IN_PRODUCTION_MANIFEST',
      );
      return fail(
        rightsProblem ? EXIT_CODES.INVALID_ASSET_RIGHTS : EXIT_CODES.MISSING_PRODUCTION_ASSETS,
        error.message,
      );
    }
    if (error instanceof ProductionAssetManifestError) {
      const rightsProblem = error.issues.some((issue) => issue.path.includes('rights'));
      return fail(
        rightsProblem ? EXIT_CODES.INVALID_ASSET_RIGHTS : EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
        error.message,
      );
    }
    if (error instanceof AssetResolutionError) {
      return fail(EXIT_CODES.INVALID_ASSET_RIGHTS, error.message);
    }
    return fail(
      EXIT_CODES.MISSING_PRODUCTION_ASSETS,
      error instanceof Error ? error.message : String(error),
    );
  }

  await writeArtefact(runDirectory, 'asset-preflight.json', { status: 'ACCEPTED', ...preflight });
  await writeArtefact(runDirectory, 'asset-provenance.json', {
    status: 'ACCEPTED',
    library: preflight.canonicalAssetRoot,
    assets: describeAssetProvenance(assets),
  });

  // --- originality, before anything is selected or rendered -----------------
  const projected = projectHumanPlan(plan);
  await writeArtefact(runDirectory, 'agent-outputs.json', {
    planningSource: 'HUMAN_SUPPLIED_STRUCTURED_PLAN',
    reasoningProviderCalls: 0,
    strategy: projected.strategy,
    concept: projected.concept,
    script: projected.script,
    shotBriefs: projected.shotBriefs,
    agentVersions: projected.agentVersions,
  });

  const originality = evaluateOriginality(buildOriginalityEntries(projected));
  await writeArtefact(runDirectory, 'originality-report.json', originality);
  if (originality.blocked) {
    return fail(
      EXIT_CODES.ORIGINALITY_RISK_BLOCKED,
      `originality risk is HIGH — the preview stopped before any source was selected. Signals: ${originality.signals
        .filter((signal) => signal.severity === 'HIGH')
        .map((signal) => `${signal.agentRole}/${signal.code}`)
        .join(', ')}`,
    );
  }

  // --- bind each beat to an asset -------------------------------------------
  const assetsById = new Map(assets.map((asset) => [asset.asset.id, asset]));
  const assetByBeatId = new Map<string, ResolvedAsset>();
  for (const beat of plan.beats) {
    const chosen = chooseAssetForBeat(beat, assets, assetsById);
    if (!chosen) {
      return fail(
        EXIT_CODES.MISSING_PRODUCTION_ASSETS,
        `beat "${beat.id}" (${beat.role}) has no usable source: ${describeSelector(beat)}`,
      );
    }
    assetByBeatId.set(beat.id, chosen);
  }

  // --- analyse every video clip a beat draws on -----------------------------
  const analyses = new Map<string, ClipAnalysis>();
  try {
    for (const asset of new Set(assetByBeatId.values())) {
      if (asset.asset.kind !== 'VIDEO') continue;
      onProgress?.(`analysing ${asset.asset.id} for scene, black and freeze regions`);
      // eslint-disable-next-line no-await-in-loop -- analysed in a fixed order for a stable report
      analyses.set(
        asset.asset.id,
        await analyseClip(runner, asset.absolutePath, {
          ffmpegPath: options.binaries.ffmpeg,
          ffprobePath: options.binaries.ffprobe,
        }),
      );
    }
  } catch (error) {
    return fail(
      EXIT_CODES.MISSING_PRODUCTION_ASSETS,
      `clip analysis failed, so no in-point can be shown to be legal: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // --- deterministic segment selection --------------------------------------
  let segments: readonly SelectedSegment[];
  try {
    onProgress?.('selecting source segments');
    const requests: (SegmentRequest & { asset: ResolvedAsset })[] = [];
    plan.beats.forEach((beat, index) => {
      const asset = assetByBeatId.get(beat.id);
      if (!asset || asset.asset.kind !== 'VIDEO') return;
      requests.push({
        beatId: beat.id,
        beatIndex: beat.index,
        storyBeat: beat.role,
        durationSeconds: beat.durationSeconds,
        hasTransitionIn: Boolean(beat.transitionIn),
        hasTransitionOut: Boolean(plan.beats[index + 1]?.transitionIn),
        ...(beat.source.inSeconds === undefined ? {} : { pinnedInSeconds: beat.source.inSeconds }),
        needsAudio: beat.useSourceAudio,
        asset,
      });
    });
    segments = selectSegments({ requests, analyses });
  } catch (error) {
    if (error instanceof SegmentSelectionError) {
      return fail(EXIT_CODES.MISSING_PRODUCTION_ASSETS, error.message);
    }
    return fail(
      EXIT_CODES.PLANNING_FAILURE,
      error instanceof Error ? error.message : String(error),
    );
  }

  const segmentByBeatId = new Map(segments.map((segment) => [segment.beatId, segment]));
  const nonZeroInPointCount = segments.filter((segment) => segment.inSeconds > 0).length;

  await writeArtefact(runDirectory, SOURCE_SELECTION_REPORT_FILENAME, {
    deterministic: true,
    requiresNoModelOrNetwork: true,
    nonZeroInPointCount,
    totalVideoSegments: segments.length,
    clipAnalysis: [...analyses.entries()].map(([assetId, analysis]) => ({
      assetId,
      durationSeconds: analysis.durationSeconds,
      sceneBoundaries: analysis.sceneBoundaries,
      blackRegions: analysis.blackRegions,
      freezeRegions: analysis.freezeRegions,
      unavailable: analysis.unavailable,
    })),
    selections: describeSegmentSelections(segments),
  });

  // --- the edit -------------------------------------------------------------
  let edit;
  try {
    onProgress?.('building the edit');
    edit = buildPreviewEdit({ request, plan, assets, assetByBeatId, segmentByBeatId });
  } catch (error) {
    return fail(
      EXIT_CODES.PLANNING_FAILURE,
      error instanceof PreviewEditError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  await writeArtefact(runDirectory, 'render-manifest.json', edit.manifest);
  await writeArtefact(
    runDirectory,
    AUDIO_PLAN_FILENAME,
    describeAudioPlan(edit.audioPlan, edit.manifest),
  );

  // --- storyboard, before the render ----------------------------------------
  onProgress?.('extracting storyboard frames and the contact sheet');
  const relativePathByAssetId = new Map(
    preflight.assets.map((asset) => [asset.assetId, asset.relativePath]),
  );
  const frames = await extractPreviewFrames({
    runner,
    binaries: options.binaries,
    runDirectory,
    plan,
    assetByBeatId,
    segmentByBeatId,
  });
  if (frames.problem) {
    onProgress?.(`WARNING: no contact sheet could be built (${frames.problem})`);
  }

  const { storyboard } = await writeStoryboardArtefacts({
    runDirectory,
    plan,
    campaignName: request.name,
    manifest: edit.manifest,
    assetByBeatId,
    segmentByBeatId,
    relativePathByAssetId,
    audioPlan: edit.audioPlan,
    executionMode: 'HUMAN_ASSISTED_PREVIEW',
    frames: frames.frames,
    contactSheetFileName: frames.contactSheetFileName,
  });

  // --- render ---------------------------------------------------------------
  let rendered;
  try {
    onProgress?.('rendering with FFmpeg');
    rendered = await renderAdvertisement(runner, {
      manifest: edit.manifest,
      manifestDir: runDirectory,
      allowedSourceRoots: [preflight.canonicalAssetRoot, runDirectory],
      outputRoot: runDirectory,
      binaries: options.binaries,
      now: options.now,
      // Everything the expanded QA needs to hold this run to the promises it
      // already made on disk.
      qa: {
        storyboard: {
          beatCount: storyboard.beats.length,
          totalDurationSeconds: storyboard.totalDurationSeconds,
          sourceChecksums: storyboard.beats.map((beat) => beat.sourceChecksumSha256),
          rightsClassifications: storyboard.beats.map((beat) => beat.rightsClassification),
        },
        expectedSourceChecksums: edit.manifest.sources.map(
          (source) => source.expectedChecksum as string,
        ),
      },
    });
  } catch (error) {
    return fail(
      EXIT_CODES.RENDERING_FAILURE,
      error instanceof Error ? error.message : String(error),
    );
  }

  // --- reports --------------------------------------------------------------
  const { summary } = rendered.qaReport;
  const scorecard = buildCreativeScorecard({
    request,
    manifest: edit.manifest,
    selections: [],
    measuredDurationSeconds: summary.durationSeconds,
    qaVerdict: rendered.qaReport.verdict,
    hasAudio: summary.audioCodec !== null && summary.audioCodec !== undefined,
  });
  await writeArtefact(runDirectory, 'creative-scorecard.json', scorecard);

  const qaFailedChecks = rendered.qaReport.measurements
    .filter((measurement) => measurement.verdict === 'FAIL')
    .map(
      (measurement) =>
        `${measurement.check}: measured ${String(measurement.measured)}, expected ${measurement.expected}${
          measurement.notMeasuredReason ? ` (${measurement.notMeasuredReason})` : ''
        }`,
    );

  const artefacts = [
    'campaign-request.json',
    'creative-plan.json',
    'asset-preflight.json',
    'asset-provenance.json',
    'agent-outputs.json',
    'originality-report.json',
    SOURCE_SELECTION_REPORT_FILENAME,
    'render-manifest.json',
    AUDIO_PLAN_FILENAME,
    'storyboard.json',
    'storyboard.html',
    ...(frames.contactSheetFileName ? [frames.contactSheetFileName] : []),
    'creative-scorecard.json',
    RENDER_SUMMARY_FILENAME,
  ];

  await writeArtefact(runDirectory, RENDER_SUMMARY_FILENAME, {
    campaignId: request.campaignId,
    workspaceId: request.workspaceId,
    workflowRunId: options.workflowRunId,
    executionMode: 'HUMAN_ASSISTED_PREVIEW',
    isRealCampaignRun: false,
    paidProviderCalls: 0,
    planningSource: 'HUMAN_SUPPLIED_STRUCTURED_PLAN',
    reasoningProviderCalls: 0,
    videoGenerationProviderCalls: 0,
    promptSha256: request.promptSha256,
    planAuthoredBy: plan.authoredBy,
    outputPath: rendered.outputPath,
    qaVerdict: rendered.qaReport.verdict,
    status:
      rendered.qaReport.verdict === 'PASS' ? 'RENDERED_PENDING_HUMAN_APPROVAL' : 'REJECTED_BY_QA',
    requiresHumanApproval: true,
    measured: {
      durationSeconds: summary.durationSeconds,
      widthPx: summary.widthPx,
      heightPx: summary.heightPx,
      frameRate: summary.frameRate,
      videoCodec: summary.videoCodec,
      audioCodec: summary.audioCodec,
      pixelFormat: summary.pixelFormat,
      faststart: summary.faststart,
      checksumSha256: summary.checksumSha256,
      audio: summary.audio,
    },
    sourceSegments: {
      total: segments.length,
      startingAtNonZeroInPoint: nonZeroInPointCount,
    },
    heuristicAverage: scorecard.heuristicAverage,
    originalityRiskLevel: originality.riskLevel,
    requiresOriginalityReview: originality.requiresHumanReview,
    anyReferenceOutputEligible: false,
    analysisOnlyReferenceCount: preflight.analysisOnlyReferenceCount,
    qaFailedChecks,
    artefacts,
    qaReportPath: rendered.qaReportPath,
    caveat:
      'HUMAN_ASSISTED_PREVIEW — the creative decisions were made by a person and executed deterministically. No reasoning model and no generation provider was called. This is not an autonomous campaign result, and human approval is still required before publication.',
  });

  const common = {
    runDirectory,
    outputPath: rendered.outputPath,
    qaVerdict: rendered.qaReport.verdict,
    measuredDurationSeconds: summary.durationSeconds,
    measuredResolution: `${summary.widthPx ?? '?'}x${summary.heightPx ?? '?'}`,
    measuredCodecs: `${summary.videoCodec ?? 'none'} / ${summary.audioCodec ?? 'none'}`,
    measuredLoudnessLufs: summary.audio?.integratedLufs ?? null,
    measuredPeakDbtp: summary.audio?.peakDbtp ?? null,
    outputChecksumSha256: summary.checksumSha256,
    qaFailedChecks,
    heuristicAverage: scorecard.heuristicAverage,
    originality,
    preflight,
    plan,
    nonZeroInPointCount,
    artefacts,
    paidProviderCalls: 0 as const,
  };

  if (rendered.qaReport.verdict !== 'PASS') {
    return { ...common, exitCode: EXIT_CODES.QA_FAILURE, failure: qaFailedChecks.join('; ') };
  }
  return { ...common, exitCode: EXIT_CODES.SUCCESS };
}

/**
 * Which asset fills a beat.
 *
 * An explicit `assetId` binds outright — the author decided. Otherwise the
 * preferred role and required tags narrow the field and the lowest asset id
 * wins, which is arbitrary but *stable*, and stability is what makes two runs
 * of the same plan produce the same advertisement.
 */
function chooseAssetForBeat(
  beat: HumanCreativePlan['beats'][number],
  assets: readonly ResolvedAsset[],
  assetsById: ReadonlyMap<string, ResolvedAsset>,
): ResolvedAsset | undefined {
  if (beat.source.assetId) return assetsById.get(beat.source.assetId);

  const tags = beat.source.requiredTags.map((tag) => tag.toLowerCase());
  return [...assets]
    .filter((asset) => {
      if (beat.source.preferredRole && asset.asset.role !== beat.source.preferredRole) return false;
      if (asset.asset.kind === 'AUDIO') return false;
      const haystack = `${asset.asset.description} ${asset.asset.tags.join(' ')}`.toLowerCase();
      return tags.every((tag) => haystack.includes(tag));
    })
    .sort((a, b) => a.asset.id.localeCompare(b.asset.id))[0];
}

function describeSelector(beat: HumanCreativePlan['beats'][number]): string {
  if (beat.source.assetId) return `no asset with id "${beat.source.assetId}"`;
  const parts: string[] = [];
  if (beat.source.preferredRole) parts.push(`role ${beat.source.preferredRole}`);
  if (beat.source.requiredTags.length > 0) {
    parts.push(`tags ${beat.source.requiredTags.join(', ')}`);
  }
  return `nothing matched ${parts.join(' and ') || 'the empty selector'}`;
}
