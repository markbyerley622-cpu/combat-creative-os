import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CreativeDirectorResultSchema, type CreativeDirectorResult } from '@combat/agents';
import type { CreativeMemoryMode } from '@combat/domain';
import type { CommandRunner, FfmpegBinaries } from '@combat/media';
import type { ReasoningProvider } from '@combat/providers';

import { formatFactualConstraints } from '../campaign-request';
import type { CreativeMemoryInjector } from '../creative-memory/injection';
import { parseProductionAssetManifest } from '../production-assets';
import type { ReasoningPolicy } from '../reasoning-policy';
import { runSourceCampaign, type SourceCampaignResult } from '../run-source-campaign';
import { readConceptVersion, writeHandoff } from './concept-store';
import {
  LAUNCH_EXIT_CODES,
  LAUNCH_REFERENCE_NOTICE,
  type LaunchExitCode,
  type LaunchHandoff,
} from './launch-contracts';
import { LaunchGateError, readLaunchRunState, readStrategy, requireSelection } from './launch-gate';
import type { LaunchRunState } from './launch-gate';
import { renderDirectoryFor } from './run-launch-plan';

/**
 * The selected-concept production handoff.
 *
 * Nothing new is planned here and nothing is re-decided: the approved concept
 * is fed into the *existing* chain — Script & Timing Director, Shot Prompt
 * Engineer, deterministic source selection, the render-manifest builder, real
 * FFmpeg and actual-media QA — as `preplanned` strategy and concept. There is
 * no second renderer and no launch-specific timeline code.
 *
 * Everything that made the concept legitimate travels with it: the campaign
 * prompt hash, the concept version and its checksum, the reviewer, the
 * benchmark profile, the Creative Memory retrieval provenance, the approved
 * asset ids and the product-capture ids. The handoff record is written before
 * the render starts, so a failed render still says exactly what it was
 * rendering and on whose authority.
 *
 * The asset manifest handed downstream is the **merged** one — the approved
 * library with the output-eligible product captures substituted in. It was
 * re-parsed through `parseProductionAssetManifest` when it was written, so an
 * analysis-only, unknown-rights or inspection-only asset could not have reached
 * it, and it faces the same rights checks again at resolution time.
 */

export interface LaunchRenderOptions {
  readonly runDirectory: string;
  readonly reasoningProvider: ReasoningProvider;
  readonly reasoningPolicy: ReasoningPolicy;
  readonly injector?: CreativeMemoryInjector;
  readonly creativeMemoryMode: CreativeMemoryMode;
  readonly repositoryRoot: string;
  readonly binaries: FfmpegBinaries;
  readonly runner?: CommandRunner;
  readonly workflowRunId: string;
  readonly now: Date;
  readonly skipRender?: boolean;
  readonly onProgress?: (message: string) => void;
}

export interface LaunchRenderResult {
  readonly exitCode: LaunchExitCode;
  readonly runDirectory: string;
  readonly handoff?: LaunchHandoff;
  readonly campaign?: SourceCampaignResult;
  readonly failure?: string;
}

interface ProvenanceShape {
  readonly governingProfiles?: readonly {
    readonly agentRole?: string;
    readonly name?: string;
    readonly version?: number;
  }[];
  readonly retrievals?: readonly {
    readonly agentRole?: string;
    readonly contextHash?: string | null;
    readonly queryHash?: string | null;
  }[];
}

async function readProvenance(runDirectory: string): Promise<ProvenanceShape> {
  try {
    return JSON.parse(
      await readFile(join(runDirectory, 'creative-memory-provenance.json'), 'utf8'),
    ) as ProvenanceShape;
  } catch {
    return {};
  }
}

async function readDirectorResult(
  runDirectory: string,
  conceptId: string,
  version: number,
): Promise<CreativeDirectorResult> {
  const relative = `concepts/${conceptId}.v${version}.director.json`;
  const raw = JSON.parse(await readFile(join(runDirectory, relative), 'utf8')) as unknown;
  const parsed = CreativeDirectorResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.PROVENANCE_INCOMPLETE,
      `${relative} does not hold a valid Creative Director result, so the approved concept cannot be handed to the script stage: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** Builds the handoff, refusing when anything about the approval no longer holds. */
export async function buildLaunchHandoff(
  state: LaunchRunState,
): Promise<{ readonly handoff: LaunchHandoff; readonly director: CreativeDirectorResult }> {
  const selection = requireSelection(state);

  if (state.request.promptSha256 !== selection.campaignPromptSha256) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.CONCEPT_STALE_OR_SUPERSEDED,
      'the campaign brief changed after this concept was approved. The selection is stale: re-plan and have a reviewer select against the current brief.',
    );
  }

  const history = state.histories.find((entry) => entry.conceptId === selection.conceptId);
  if (!history) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.PROVENANCE_INCOMPLETE,
      `the selected concept "${selection.conceptId}" is not in this run's ledger`,
    );
  }
  if (history.latest.version !== selection.conceptVersion) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.CONCEPT_STALE_OR_SUPERSEDED,
      `version ${selection.conceptVersion} was selected but version ${history.latest.version} now exists; a superseded concept is never rendered`,
    );
  }

  const version = await readConceptVersion(
    state.runDirectory,
    selection.conceptId,
    selection.conceptVersion,
  );
  if (version.conceptChecksumSha256 !== selection.conceptChecksumSha256) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.PROVENANCE_INCOMPLETE,
      `the approved concept's bytes no longer match the checksum recorded at selection (${selection.conceptChecksumSha256})`,
    );
  }

  const director = await readDirectorResult(
    state.runDirectory,
    selection.conceptId,
    selection.conceptVersion,
  );

  const merged = parseProductionAssetManifest(
    JSON.parse(await readFile(state.manifest.mergedAssetManifestPath, 'utf8')),
    state.manifest.mergedAssetManifestPath,
  );
  const provenance = await readProvenance(state.runDirectory);

  const handoff: LaunchHandoff = {
    handoffVersion: 1,
    launchRunId: state.manifest.launchRunId,
    workspaceId: state.manifest.workspaceId,
    campaignId: state.manifest.campaignId,
    campaignPromptSha256: selection.campaignPromptSha256,
    conceptId: selection.conceptId,
    conceptVersion: selection.conceptVersion,
    conceptChecksumSha256: selection.conceptChecksumSha256,
    conceptTitle: version.concept.title,
    authoredByAgent: version.authoredByAgent,
    reviewerId: selection.reviewerId,
    selectedAt: selection.selectedAt,
    benchmarkProfileName: selection.benchmarkProfileName,
    benchmarkProfileVersions: (provenance.governingProfiles ?? []).map(
      (profile) =>
        `${profile.name ?? 'unknown'}@v${profile.version ?? 0} (${profile.agentRole ?? 'unknown'})`,
    ),
    creativeMemoryRetrievalIds: (provenance.retrievals ?? []).map(
      (audit) =>
        `${audit.agentRole ?? 'unknown'}:${audit.contextHash ?? audit.queryHash ?? 'none'}`,
    ),
    approvedAssetIds: merged.assets.map((asset) => asset.id),
    productCaptureIds: [...state.manifest.captureVerification.mergedAssetIds],
    factualConstraints: formatFactualConstraints(state.request),
    prohibitedClaims: [...state.launchBrief.prohibitedClaims],
    anyReferenceOutputEligible: false,
    requiresHumanApproval: true,
    notice: LAUNCH_REFERENCE_NOTICE,
  };

  return { handoff, director };
}

export async function runLaunchRender(options: LaunchRenderOptions): Promise<LaunchRenderResult> {
  let state: LaunchRunState;
  try {
    state = await readLaunchRunState(options.runDirectory);
  } catch (error) {
    return {
      exitCode:
        error instanceof LaunchGateError ? error.exitCode : LAUNCH_EXIT_CODES.PROVENANCE_INCOMPLETE,
      runDirectory: options.runDirectory,
      failure: error instanceof Error ? error.message : String(error),
    };
  }

  let handoff: LaunchHandoff;
  let director: CreativeDirectorResult;
  try {
    const built = await buildLaunchHandoff(state);
    handoff = built.handoff;
    director = built.director;
  } catch (error) {
    return {
      exitCode:
        error instanceof LaunchGateError ? error.exitCode : LAUNCH_EXIT_CODES.PROVENANCE_INCOMPLETE,
      runDirectory: options.runDirectory,
      failure: error instanceof Error ? error.message : String(error),
    };
  }

  await writeHandoff(options.runDirectory, handoff);
  options.onProgress?.(
    `handing "${handoff.conceptTitle}" (v${handoff.conceptVersion}, approved by ${handoff.reviewerId}) to the existing script, shot and render path`,
  );

  const strategy = await readStrategy(options.runDirectory);
  const campaign = await runSourceCampaign({
    // The merged manifest is what the render sees: the approved library with
    // the output-eligible captures substituted in, and nothing else.
    request: { ...state.request, sourceAssetManifestPath: state.manifest.mergedAssetManifestPath },
    reasoningProvider: options.reasoningProvider,
    reasoningPolicy: options.reasoningPolicy,
    runDirectory: renderDirectoryFor(options.runDirectory),
    repositoryRoot: options.repositoryRoot,
    binaries: options.binaries,
    workflowRunId: options.workflowRunId,
    now: options.now,
    creativeMemoryMode: options.creativeMemoryMode,
    // The merged manifest lives in the run directory while the files it names
    // still live beside the original library and the capture output, so both
    // are named as permitted roots rather than left to be inferred.
    additionalSourceRoots: [
      dirname(state.manifest.productionAssetManifestPath),
      dirname(state.manifest.captureVerification.captureSessionPath),
    ],
    preplanned: { strategy, concept: director },
    ...(options.injector ? { injector: options.injector } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.skipRender === undefined ? {} : { skipRender: options.skipRender }),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  return {
    exitCode: campaign.exitCode as LaunchExitCode,
    runDirectory: options.runDirectory,
    handoff,
    campaign,
    // Surfaced rather than left inside the campaign result: a failed QA verdict
    // an operator has to go looking for is one they will not read.
    ...(campaign.failure ? { failure: campaign.failure } : {}),
  };
}
