import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  assessLaunchConceptDistinctness,
  evaluateOriginality,
  LAUNCH_MIN_CONCEPT_CANDIDATES,
  type CreativeMemoryMode,
  type LaunchConceptVersion,
  type LaunchGoverningProfile,
  type ProductLaunchBrief,
} from '@combat/domain';
import type { ReasoningProvider } from '@combat/providers';

import type { CampaignRequest } from '../campaign-request';
import { AppCaptureSessionSchema, type CapturedAppAsset } from '../capture/capture-contracts';
import { CaptureMergeError, mergeCapturedAssets } from '../capture/manifest-merge';
import {
  CreativeMemoryInjectionError,
  type CreativeMemoryInjector,
} from '../creative-memory/injection';
import { parseProductionAssetManifest, ProductionAssetManifestError } from '../production-assets';
import {
  assessLaunchConcept,
  conceptOriginalityEntries,
  type LaunchInventory,
} from './concept-assessment';
import { ConceptCompetitionError, runConceptCompetition } from './concept-competition';
import {
  writeConceptSet,
  writeConceptVersion,
  writeRunArtefact,
  writeRunManifest,
} from './concept-store';
import {
  checksumOf,
  LAUNCH_EXIT_CODES,
  LAUNCH_REFERENCE_NOTICE,
  LAUNCH_RUN_NOTICE,
  type LaunchCaptureVerification,
  type LaunchCostBasis,
  type LaunchExitCode,
} from './launch-contracts';

/**
 * `aamp:launch plan` — from a launch brief to a set of competing, assessed,
 * reviewable concepts.
 *
 * Ordered so that everything cheap and refusable happens before anything that
 * calls a model: the request, the rights on the asset library, the product
 * captures and the merged manifest are all settled first, and the run manifest
 * is on disk before the first agent runs. A run that fails at candidate three
 * still leaves behind what it was working from.
 */

export interface LaunchRunLabel {
  readonly executionMode: string;
  readonly isRealCampaignRun: boolean;
  readonly demonstrationOnly: boolean;
  readonly caveat: string;
  readonly runMode: string;
  readonly reasoningProvider: string;
  readonly reasoningModel: string;
}

export interface LaunchPlanOptions {
  readonly request: CampaignRequest;
  readonly launchBrief: ProductLaunchBrief;
  readonly benchmarkProfileName: string;
  readonly captureSessionPath: string;
  readonly reasoningProvider: ReasoningProvider;
  readonly injector?: CreativeMemoryInjector;
  readonly creativeMemoryMode: CreativeMemoryMode;
  readonly runDirectory: string;
  readonly launchRunId: string;
  readonly workflowRunId: string;
  readonly label: LaunchRunLabel;
  readonly costBasis: LaunchCostBasis;
  readonly now: Date;
  readonly newConceptId: () => string;
  readonly onProgress?: (message: string) => void;
}

export interface LaunchPlanResult {
  readonly exitCode: LaunchExitCode;
  readonly runDirectory: string;
  readonly launchRunId: string;
  readonly conceptIds?: readonly string[];
  readonly selectableConceptIds?: readonly string[];
  readonly rejectedCandidateCount?: number;
  readonly distinctnessVerdict?: string;
  readonly failure?: string;
}

/** Which captures may be used, and which were refused, stated rather than filtered silently. */
export function verifyCaptures(options: {
  readonly assets: readonly CapturedAppAsset[];
  readonly requiredCaptureIds: readonly string[];
  readonly captureSessionPath: string;
  readonly sessionRightsMode: 'DECLARED' | 'INSPECTION_ONLY';
}): LaunchCaptureVerification {
  const outputEligible = options.assets.filter(
    (asset) => asset.eligibility === 'OUTPUT_ELIGIBLE' && asset.rightsClassification !== null,
  );
  const reviewRequired = options.assets.filter(
    (asset) => asset.eligibility !== 'OUTPUT_ELIGIBLE' || asset.rightsClassification === null,
  );
  const eligibleIds = new Set(outputEligible.map((asset) => asset.assetId));

  return {
    captureSessionPath: options.captureSessionPath,
    sessionRightsMode: options.sessionRightsMode,
    outputEligibleCaptureIds: outputEligible.map((asset) => asset.assetId),
    reviewRequiredCaptureIds: reviewRequired.map((asset) => asset.assetId),
    requiredCaptureIds: [...options.requiredCaptureIds],
    missingRequiredCaptureIds: options.requiredCaptureIds.filter((id) => !eligibleIds.has(id)),
    mergedAssetIds: [],
  };
}

export async function runLaunchPlan(options: LaunchPlanOptions): Promise<LaunchPlanResult> {
  const { request, launchBrief, runDirectory, onProgress } = options;
  const fail = (exitCode: LaunchExitCode, failure: string): LaunchPlanResult => ({
    exitCode,
    runDirectory,
    launchRunId: options.launchRunId,
    failure,
  });

  await writeRunArtefact(runDirectory, 'campaign-request.json', request);

  // --- the approved production library --------------------------------------
  let manifest;
  try {
    onProgress?.('reading the approved production asset manifest');
    manifest = parseProductionAssetManifest(
      JSON.parse(await readFile(request.sourceAssetManifestPath, 'utf8')),
      request.sourceAssetManifestPath,
    );
  } catch (error) {
    if (error instanceof ProductionAssetManifestError) {
      const rightsProblem = error.issues.some((issue) => issue.path.includes('rights'));
      return fail(
        rightsProblem
          ? LAUNCH_EXIT_CODES.INVALID_ASSET_RIGHTS
          : LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
        error.message,
      );
    }
    return fail(
      LAUNCH_EXIT_CODES.MISSING_PRODUCTION_ASSETS,
      error instanceof Error ? error.message : String(error),
    );
  }

  // --- the approved product captures ----------------------------------------
  let verification: LaunchCaptureVerification;
  let mergedManifestPath: string;
  try {
    onProgress?.('verifying approved product captures');
    const session = AppCaptureSessionSchema.parse(
      JSON.parse(await readFile(options.captureSessionPath, 'utf8')),
    );
    verification = verifyCaptures({
      assets: session.assets,
      requiredCaptureIds: launchBrief.requiredCaptureIds,
      captureSessionPath: options.captureSessionPath,
      sessionRightsMode: session.rightsMode,
    });

    if (verification.missingRequiredCaptureIds.length > 0) {
      await writeRunArtefact(runDirectory, 'capture-verification.json', verification);
      return fail(
        LAUNCH_EXIT_CODES.MISSING_PRODUCTION_ASSETS,
        `required product capture(s) are missing or not output-eligible: ${verification.missingRequiredCaptureIds
          .map(
            (id) =>
              `${id}${verification.reviewRequiredCaptureIds.includes(id) ? ' (captured for inspection only — a capture without a rights declaration may never enter a production manifest)' : ' (absent from the capture session)'}`,
          )
          .join(', ')}`,
      );
    }

    // Only output-eligible captures are handed to the merge. `mergeCapturedAssets`
    // refuses a REVIEW_REQUIRED capture by name, and that refusal stays reachable
    // — what this selection avoids is failing the whole run because the session
    // *also* photographed screens no concept requires. Every refused capture is
    // named in `reviewRequiredCaptureIds` rather than silently dropped.
    const eligible = session.assets.filter(
      (asset) => asset.eligibility === 'OUTPUT_ELIGIBLE' && asset.rightsClassification !== null,
    );
    const merged = mergeCapturedAssets({
      manifest,
      manifestDirectory: dirname(request.sourceAssetManifestPath),
      captured: eligible,
      captureDirectory: dirname(options.captureSessionPath),
      outputManifestDirectory: runDirectory,
    });
    manifest = merged.manifest;
    verification = {
      ...verification,
      mergedAssetIds: merged.report.replaced.map((entry) => entry.assetId),
    };
    mergedManifestPath = await writeRunArtefact(
      runDirectory,
      'production-assets.merged.json',
      manifest,
    );
    await writeRunArtefact(runDirectory, 'capture-verification.json', {
      ...verification,
      mergeReport: merged.report,
    });
  } catch (error) {
    if (error instanceof CaptureMergeError) {
      return fail(LAUNCH_EXIT_CODES.INVALID_ASSET_RIGHTS, error.message);
    }
    return fail(
      LAUNCH_EXIT_CODES.MISSING_PRODUCTION_ASSETS,
      `the approved product capture session at ${options.captureSessionPath} could not be used: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // --- the run manifest, before any model runs ------------------------------
  await writeRunManifest(runDirectory, {
    manifestVersion: 1,
    launchRunId: options.launchRunId,
    campaignMode: 'PRODUCT_LAUNCH',
    workspaceId: request.workspaceId,
    campaignId: request.campaignId,
    campaignName: request.name,
    campaignPromptSha256: request.promptSha256,
    createdAt: options.now.toISOString(),
    executionMode: options.label.executionMode,
    isRealCampaignRun: options.label.isRealCampaignRun,
    demonstrationOnly: options.label.demonstrationOnly,
    runMode: options.label.runMode,
    reasoningProvider: options.label.reasoningProvider,
    reasoningModel: options.label.reasoningModel,
    caveat: options.label.caveat,
    creativeMemoryMode: options.creativeMemoryMode,
    benchmarkProfileName: options.benchmarkProfileName,
    conceptCandidateCount: launchBrief.conceptCandidateCount,
    approvedReviewerIds: [...launchBrief.approvedReviewerIds],
    costBasis: options.costBasis,
    requestPath: request.requestPath,
    productionAssetManifestPath: request.sourceAssetManifestPath,
    mergedAssetManifestPath: mergedManifestPath,
    captureVerification: verification,
    requiresHumanApproval: true,
    notice: LAUNCH_RUN_NOTICE,
    referenceNotice: LAUNCH_REFERENCE_NOTICE,
  });

  // --- the competition ------------------------------------------------------
  let competition;
  try {
    onProgress?.('running the concept competition');
    competition = await runConceptCompetition({
      request,
      launchBrief,
      reasoningProvider: options.reasoningProvider,
      workflowRunId: options.workflowRunId,
      ...(options.injector ? { injector: options.injector } : {}),
      newConceptId: options.newConceptId,
      ...(onProgress ? { onProgress } : {}),
    });
  } catch (error) {
    await writeCreativeMemoryProvenance(runDirectory, options, [], error);
    if (error instanceof CreativeMemoryInjectionError) {
      return fail(LAUNCH_EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE, error.message);
    }
    if (error instanceof ConceptCompetitionError) {
      return fail(LAUNCH_EXIT_CODES.PLANNING_FAILURE, error.message);
    }
    return fail(
      LAUNCH_EXIT_CODES.PLANNING_FAILURE,
      error instanceof Error ? error.message : String(error),
    );
  }

  await writeRunArtefact(runDirectory, 'strategy.json', {
    strategy: competition.strategy,
    agentVersions: competition.agentVersions,
  });

  // --- governance: the profile that actually governed -----------------------
  const audits = options.injector?.audits ?? [];
  const governingProfiles: LaunchGoverningProfile[] = [];
  for (const audit of audits) {
    if (!audit.benchmarkProfile) continue;
    if (governingProfiles.some((entry) => entry.profileId === audit.benchmarkProfile?.id)) continue;
    governingProfiles.push({
      agentRole: audit.agentRole,
      profileId: audit.benchmarkProfile.id,
      name: audit.benchmarkProfile.name,
      version: audit.benchmarkProfile.version,
      ...(audit.benchmarkProfile.reviewerId
        ? { reviewerId: audit.benchmarkProfile.reviewerId }
        : {}),
      ...(audit.benchmarkProfile.approvedAt
        ? { approvedAt: audit.benchmarkProfile.approvedAt }
        : {}),
      governingChecksumSha256: audit.benchmarkProfile.governingChecksumSha256,
    });
  }
  await writeCreativeMemoryProvenance(runDirectory, options, governingProfiles);

  const wrongProfile = governingProfiles.filter(
    (profile) => profile.name !== options.benchmarkProfileName,
  );
  if (wrongProfile.length > 0) {
    return fail(
      LAUNCH_EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE,
      `this run was told to be governed by benchmark profile "${options.benchmarkProfileName}", but ${wrongProfile
        .map((profile) => `${profile.agentRole} was governed by "${profile.name}"`)
        .join('; ')}. Refusing rather than filing the run under a profile that did not govern it.`,
    );
  }
  if (options.creativeMemoryMode !== 'off' && governingProfiles.length === 0) {
    return fail(
      LAUNCH_EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE,
      `no approved benchmark profile governed this run, but a product launch requires "${options.benchmarkProfileName}". Approve and activate it, then re-run.`,
    );
  }

  // --- enough candidates? ---------------------------------------------------
  if (competition.candidates.length < LAUNCH_MIN_CONCEPT_CANDIDATES) {
    await writeRunArtefact(runDirectory, 'rejected-candidates.json', competition.rejected);
    return fail(
      LAUNCH_EXIT_CODES.INSUFFICIENT_CONCEPTS,
      `only ${competition.candidates.length} valid concept(s) were produced; at least ${LAUNCH_MIN_CONCEPT_CANDIDATES} are required for a competition. Rejected candidates:\n${competition.rejected
        .map((entry) => `  - candidate ${entry.candidateIndex}: ${entry.reasons.join('; ')}`)
        .join('\n')}`,
    );
  }

  // --- distinctness ---------------------------------------------------------
  const distinctness = assessLaunchConceptDistinctness(
    competition.candidates.map((candidate) => ({
      conceptId: candidate.conceptId,
      concept: candidate.concept,
    })),
  );
  await writeRunArtefact(runDirectory, 'distinctness-report.json', distinctness);
  if (distinctness.verdict !== 'DISTINCT') {
    return fail(
      LAUNCH_EXIT_CODES.CONCEPTS_NOT_DISTINCT,
      `the concept set is not a competition:\n${distinctness.failures.map((line) => `  - ${line}`).join('\n')}`,
    );
  }

  // --- assessment and persistence -------------------------------------------
  const inventory: LaunchInventory = {
    assets: manifest.assets,
    outputEligibleCaptureIds: new Set(verification.outputEligibleCaptureIds),
    reviewRequiredCaptureIds: new Set(verification.reviewRequiredCaptureIds),
  };

  const selectable: string[] = [];
  for (const candidate of competition.candidates) {
    const originality = evaluateOriginality(
      conceptOriginalityEntries({
        candidate,
        strategy: competition.strategy,
        ...(competition.strategyContext ? { strategyContext: competition.strategyContext } : {}),
      }),
    );
    const assessment = assessLaunchConcept({
      candidate,
      conceptVersion: 1,
      inventory,
      request,
      launchBrief,
      originality,
      governingProfiles,
    });
    if (assessment.selectable) selectable.push(candidate.conceptId);

    const record: LaunchConceptVersion = {
      recordVersion: 1,
      conceptId: candidate.conceptId,
      version: 1,
      workspaceId: request.workspaceId,
      campaignId: request.campaignId,
      launchRunId: options.launchRunId,
      origin: 'INITIAL_COMPETITION',
      authoredByAgent: candidate.agentVersion,
      createdAt: options.now.toISOString(),
      conceptChecksumSha256: checksumOf(candidate.concept),
      campaignPromptSha256: request.promptSha256,
      concept: candidate.concept,
    };
    // eslint-disable-next-line no-await-in-loop -- written in candidate order so the ledger reads as the competition ran
    await writeConceptVersion(runDirectory, record, assessment);
    // eslint-disable-next-line no-await-in-loop -- the director result travels beside its concept
    await writeRunArtefact(
      runDirectory,
      `concepts/${candidate.conceptId}.v1.director.json`,
      candidate.director,
    );
  }

  await writeConceptSet(runDirectory, {
    setVersion: 1,
    launchRunId: options.launchRunId,
    generatedAt: options.now.toISOString(),
    conceptIds: competition.candidates.map((candidate) => candidate.conceptId),
    rejectedCandidates: competition.rejected.map((entry) => ({
      candidateIndex: entry.candidateIndex,
      reasons: [...entry.reasons],
    })),
    agentVersions: [...competition.agentVersions],
  });

  if (selectable.length === 0) {
    return fail(
      LAUNCH_EXIT_CODES.ORIGINALITY_RISK_BLOCKED,
      'every concept in this set is unselectable — see each assessment’s blockingReasons. Nothing was rendered and nothing can be selected.',
    );
  }

  return {
    exitCode: LAUNCH_EXIT_CODES.SUCCESS,
    runDirectory,
    launchRunId: options.launchRunId,
    conceptIds: competition.candidates.map((candidate) => candidate.conceptId),
    selectableConceptIds: selectable,
    rejectedCandidateCount: competition.rejected.length,
    distinctnessVerdict: distinctness.verdict,
  };
}

async function writeCreativeMemoryProvenance(
  runDirectory: string,
  options: LaunchPlanOptions,
  governingProfiles: readonly LaunchGoverningProfile[],
  error?: unknown,
): Promise<void> {
  await writeRunArtefact(runDirectory, 'creative-memory-provenance.json', {
    mode: options.creativeMemoryMode,
    status:
      error !== undefined
        ? 'FAILED'
        : options.creativeMemoryMode === 'off'
          ? 'NOT_USED'
          : 'COMPLETED',
    ...(error instanceof CreativeMemoryInjectionError
      ? { failureKind: error.kind, agentRole: error.agentRole, detail: error.message }
      : {}),
    requestedBenchmarkProfile: options.benchmarkProfileName,
    governingProfiles,
    retrievals: options.injector?.audits ?? [],
    anyReferenceOutputEligible: false,
    notice: LAUNCH_REFERENCE_NOTICE,
  });
}

/** Where a launch run's render sub-directory lives, so nothing collides with the gate artefacts. */
export function renderDirectoryFor(runDirectory: string): string {
  return join(runDirectory, 'render');
}
