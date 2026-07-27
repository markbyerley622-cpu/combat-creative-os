import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CampaignStrategistResultSchema, type CampaignStrategistResult } from '@combat/agents';
import {
  evaluateConceptSelection,
  LAUNCH_SELECTION_NOTICE,
  structuralPositionsOf,
  type LaunchConceptSelection,
  type LaunchConceptVersion,
  type LaunchGateDecision,
  type LaunchSelectionCandidateState,
  type LaunchSelectionRefusal,
  type ProductLaunchBrief,
} from '@combat/domain';
import type { ReasoningProvider } from '@combat/providers';

import { loadCampaignRequest, type CampaignRequest } from '../campaign-request';
import type { CreativeMemoryInjector } from '../creative-memory/injection';
import { parseProductionAssetManifest } from '../production-assets';
import { assessLaunchConcept, type LaunchInventory } from './concept-assessment';
import { reviseConcept, type ConceptCandidate } from './concept-competition';
import {
  appendDecision,
  readConceptHistories,
  readRunManifest,
  readSelection,
  listDecisions,
  writeConceptVersion,
  writeRunArtefact,
  writeSelection,
  type ConceptHistory,
} from './concept-store';
import {
  checksumOf,
  LAUNCH_EXIT_CODES,
  LaunchArtefactError,
  type LaunchExitCode,
  type LaunchRunManifest,
} from './launch-contracts';

/**
 * The human concept gate: inspect, revise, select, reject.
 *
 * Two rules do the work here.
 *
 * **Nothing downstream runs without a selection.** `readLaunchRunState` is what
 * every later command goes through, and `requireSelection` is the only way to
 * obtain one. There is no flag, no default and no "latest concept" fallback —
 * an absent selection is exit 15, and the render command has no other path.
 *
 * **A revision goes back through the agent.** `reviseConcept` invokes the
 * Creative Director again with the reviewer's feedback in the field its prompt
 * has treated as binding since v1. No function in this file edits concept JSON,
 * and the new version is validated exactly as a first-round candidate is.
 */

export interface LaunchRunState {
  readonly runDirectory: string;
  readonly manifest: LaunchRunManifest;
  /** Reloaded from the original request file, so a changed brief is detectable. */
  readonly request: CampaignRequest;
  readonly launchBrief: ProductLaunchBrief;
  readonly histories: readonly ConceptHistory[];
  readonly decisions: readonly LaunchGateDecision[];
  readonly selection?: LaunchConceptSelection;
  /** True when a reviewer rejected the whole set; the run is closed. */
  readonly allRejected: boolean;
}

export class LaunchGateError extends Error {
  constructor(
    public readonly exitCode: LaunchExitCode,
    detail: string,
  ) {
    super(detail);
    this.name = 'LaunchGateError';
  }
}

export async function readLaunchRunState(runDirectory: string): Promise<LaunchRunState> {
  const manifest = await readRunManifest(runDirectory);
  const request = await loadCampaignRequest(manifest.requestPath);
  if (!request.productLaunch) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
      `${manifest.requestPath} no longer declares a productLaunch brief, so this run's concepts answer a question that is no longer being asked`,
    );
  }

  const histories = await readConceptHistories(runDirectory);
  const decisions = await listDecisions(runDirectory);
  const selection = await readSelection(runDirectory);

  return {
    runDirectory,
    manifest,
    request,
    launchBrief: request.productLaunch,
    histories,
    decisions,
    ...(selection ? { selection } : {}),
    allRejected: decisions.some((decision) => decision.decision === 'ALL_REJECTED'),
  };
}

/** The only way to obtain a selection. Every downstream command goes through it. */
export function requireSelection(state: LaunchRunState): LaunchConceptSelection {
  if (!state.selection) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.HUMAN_SELECTION_REQUIRED,
      [
        'No concept has been selected for this run, so there is nothing to plan, shoot or render.',
        '',
        'A named reviewer must select one:',
        '  pnpm aamp:launch select --run <run-directory> --concept <concept-id> --reviewer <user-id>',
      ].join('\n'),
    );
  }
  return state.selection;
}

function candidateStates(state: LaunchRunState): readonly LaunchSelectionCandidateState[] {
  return state.histories.map((history) => ({
    conceptId: history.conceptId,
    versions: history.versions.map((version) => version.version),
    latestVersion: history.latest.version,
    workspaceId: history.latest.workspaceId,
    campaignId: history.latest.campaignId,
    campaignPromptSha256: history.latest.campaignPromptSha256,
    selectable: history.latestAssessment.selectable,
    blockingReasons: history.latestAssessment.blockingReasons,
  }));
}

/** Each refusal maps to the exit code that names the response, not merely the failure. */
const SELECTION_EXIT_CODES: Readonly<Record<LaunchSelectionRefusal, LaunchExitCode>> = {
  UNKNOWN_CONCEPT: LAUNCH_EXIT_CODES.SELECTION_REFUSED,
  UNKNOWN_VERSION: LAUNCH_EXIT_CODES.SELECTION_REFUSED,
  SUPERSEDED_VERSION: LAUNCH_EXIT_CODES.CONCEPT_STALE_OR_SUPERSEDED,
  STALE_CAMPAIGN_PROMPT: LAUNCH_EXIT_CODES.CONCEPT_STALE_OR_SUPERSEDED,
  CROSS_WORKSPACE: LAUNCH_EXIT_CODES.SELECTION_REFUSED,
  WRONG_CAMPAIGN: LAUNCH_EXIT_CODES.SELECTION_REFUSED,
  NOT_SELECTABLE: LAUNCH_EXIT_CODES.SELECTION_REFUSED,
  REVIEWER_NOT_APPROVED: LAUNCH_EXIT_CODES.SELECTION_REFUSED,
  ALREADY_SELECTED: LAUNCH_EXIT_CODES.SELECTION_REFUSED,
};

export interface SelectConceptOptions {
  readonly state: LaunchRunState;
  readonly conceptId: string;
  readonly conceptVersion?: number;
  readonly reviewerId: string;
  /** Overrides the run's own workspace, so a cross-workspace attempt is expressible and refusable. */
  readonly workspaceId?: string;
  readonly now: Date;
}

export interface SelectConceptResult {
  readonly selection: LaunchConceptSelection;
  readonly decision: LaunchGateDecision;
}

export async function selectConcept(options: SelectConceptOptions): Promise<SelectConceptResult> {
  const { state } = options;
  if (state.allRejected) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.SELECTION_REFUSED,
      'a reviewer rejected this whole concept set; plan a new set rather than selecting from a rejected one',
    );
  }

  const outcome = evaluateConceptSelection(
    {
      conceptId: options.conceptId,
      ...(options.conceptVersion === undefined ? {} : { conceptVersion: options.conceptVersion }),
      reviewerId: options.reviewerId,
      workspaceId: options.workspaceId ?? state.manifest.workspaceId,
      campaignId: state.manifest.campaignId,
      // From the request as it stands now, not from the run manifest: a brief
      // edited after planning must invalidate the concepts, and comparing the
      // manifest against itself could never detect that.
      campaignPromptSha256: state.request.promptSha256,
      approvedReviewerIds: state.launchBrief.approvedReviewerIds,
      alreadySelected: state.selection !== undefined,
    },
    candidateStates(state),
  );

  if (!outcome.ok) {
    throw new LaunchGateError(
      SELECTION_EXIT_CODES[outcome.refusal],
      `selection refused (${outcome.refusal}): ${outcome.detail}`,
    );
  }

  const history = state.histories.find(
    (entry) => entry.conceptId === outcome.conceptId,
  ) as ConceptHistory;
  const version = history.versions.find(
    (entry) => entry.version === outcome.conceptVersion,
  ) as LaunchConceptVersion;

  const decision: LaunchGateDecision = {
    recordVersion: 1,
    decisionId: randomUUID(),
    launchRunId: state.manifest.launchRunId,
    workspaceId: state.manifest.workspaceId,
    campaignId: state.manifest.campaignId,
    gate: 'CONCEPT',
    decision: 'SELECTED',
    reviewerId: options.reviewerId,
    decidedAt: options.now.toISOString(),
    conceptId: version.conceptId,
    conceptVersion: version.version,
  };
  await appendDecision(state.runDirectory, decision);

  const selection: LaunchConceptSelection = {
    selectionVersion: 1,
    launchRunId: state.manifest.launchRunId,
    workspaceId: state.manifest.workspaceId,
    campaignId: state.manifest.campaignId,
    conceptId: version.conceptId,
    conceptVersion: version.version,
    conceptChecksumSha256: version.conceptChecksumSha256,
    campaignPromptSha256: version.campaignPromptSha256,
    benchmarkProfileName: state.manifest.benchmarkProfileName,
    reviewerId: options.reviewerId,
    selectedAt: options.now.toISOString(),
    decisionId: decision.decisionId,
    requiresHumanApproval: true,
    notice: LAUNCH_SELECTION_NOTICE,
  };
  await writeSelection(state.runDirectory, selection);

  return { selection, decision };
}

export interface RejectAllOptions {
  readonly state: LaunchRunState;
  readonly reviewerId: string;
  readonly feedback: string;
  readonly now: Date;
}

export async function rejectAllConcepts(options: RejectAllOptions): Promise<LaunchGateDecision> {
  const { state } = options;
  if (state.selection) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.SELECTION_REFUSED,
      'this run already has a recorded selection; rejecting afterwards would rewrite an approval that has already been acted on',
    );
  }
  if (!state.launchBrief.approvedReviewerIds.includes(options.reviewerId)) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.SELECTION_REFUSED,
      `"${options.reviewerId}" is not one of this campaign's approved reviewers`,
    );
  }

  const decision: LaunchGateDecision = {
    recordVersion: 1,
    decisionId: randomUUID(),
    launchRunId: state.manifest.launchRunId,
    workspaceId: state.manifest.workspaceId,
    campaignId: state.manifest.campaignId,
    gate: 'CONCEPT',
    decision: 'ALL_REJECTED',
    reviewerId: options.reviewerId,
    decidedAt: options.now.toISOString(),
    feedback: options.feedback,
  };
  await appendDecision(state.runDirectory, decision);
  return decision;
}

export interface ReviseInRunOptions {
  readonly state: LaunchRunState;
  readonly conceptId: string;
  readonly feedback: string;
  readonly reviewerId: string;
  readonly reasoningProvider: ReasoningProvider;
  readonly injector?: CreativeMemoryInjector;
  readonly workflowRunId: string;
  readonly now: Date;
  readonly onProgress?: (message: string) => void;
}

export interface ReviseInRunResult {
  readonly decision: LaunchGateDecision;
  readonly version: LaunchConceptVersion;
  readonly selectable: boolean;
  readonly blockingReasons: readonly string[];
}

/**
 * Records the reviewer's request, then produces the next version through the
 * agent.
 *
 * The decision is written first and unconditionally: the fact that a reviewer
 * asked for a change is part of the record whether or not the agent then
 * succeeded in making one.
 */
export async function reviseConceptInRun(options: ReviseInRunOptions): Promise<ReviseInRunResult> {
  const { state } = options;
  if (state.selection) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.SELECTION_REFUSED,
      'this run already has a recorded selection; revise before selecting, or plan a new run',
    );
  }
  if (state.allRejected) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.SELECTION_REFUSED,
      'a reviewer rejected this whole concept set; plan a new set rather than revising a rejected one',
    );
  }
  const history = state.histories.find((entry) => entry.conceptId === options.conceptId);
  if (!history) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.SELECTION_REFUSED,
      `no concept "${options.conceptId}" exists in this run`,
    );
  }
  if (!state.launchBrief.approvedReviewerIds.includes(options.reviewerId)) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.SELECTION_REFUSED,
      `"${options.reviewerId}" is not one of this campaign's approved reviewers`,
    );
  }

  const decision: LaunchGateDecision = {
    recordVersion: 1,
    decisionId: randomUUID(),
    launchRunId: state.manifest.launchRunId,
    workspaceId: state.manifest.workspaceId,
    campaignId: state.manifest.campaignId,
    gate: 'CONCEPT',
    decision: 'REVISION_REQUESTED',
    reviewerId: options.reviewerId,
    decidedAt: options.now.toISOString(),
    conceptId: history.conceptId,
    conceptVersion: history.latest.version,
    feedback: options.feedback,
  };
  await appendDecision(state.runDirectory, decision);

  const strategy = await readStrategy(state.runDirectory);
  // The concept being revised is excluded from the occupied positions: the
  // agent is being asked to reconsider it, not to avoid it. The others still
  // constrain, so a revision cannot converge onto a sibling.
  const others = state.histories.filter((entry) => entry.conceptId !== history.conceptId);
  const revision = await reviseConcept({
    request: state.request,
    launchBrief: state.launchBrief,
    reasoningProvider: options.reasoningProvider,
    workflowRunId: options.workflowRunId,
    ...(options.injector ? { injector: options.injector } : {}),
    newConceptId: () => history.conceptId,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    strategy,
    priorConcept: history.latest.concept,
    priorConceptId: history.conceptId,
    feedback: options.feedback,
    occupiedStructuralPositions: others.flatMap((entry) =>
      structuralPositionsOf(entry.latest.concept),
    ),
    occupiedTitles: others.map((entry) => entry.latest.concept.title),
    candidateIndex: Math.min(state.histories.length, state.manifest.conceptCandidateCount),
    candidateCount: state.manifest.conceptCandidateCount,
  });

  if ('reasons' in revision) {
    throw new LaunchGateError(
      LAUNCH_EXIT_CODES.PLANNING_FAILURE,
      `the revision was not usable and no new version was written:\n${revision.reasons
        .map((reason) => `  - ${reason}`)
        .join('\n')}`,
    );
  }

  const nextVersion = history.latest.version + 1;
  const record: LaunchConceptVersion = {
    recordVersion: 1,
    conceptId: history.conceptId,
    version: nextVersion,
    workspaceId: state.manifest.workspaceId,
    campaignId: state.manifest.campaignId,
    launchRunId: state.manifest.launchRunId,
    origin: 'REVISION',
    supersedesVersion: history.latest.version,
    authoredByAgent: revision.candidate.agentVersion,
    createdAt: options.now.toISOString(),
    revisionFeedback: options.feedback,
    conceptChecksumSha256: checksumOf(revision.candidate.concept),
    campaignPromptSha256: state.request.promptSha256,
    concept: revision.candidate.concept,
  };

  const assessment = assessLaunchConcept({
    candidate: { ...revision.candidate, conceptId: history.conceptId },
    conceptVersion: nextVersion,
    inventory: await readInventory(state),
    request: state.request,
    launchBrief: state.launchBrief,
    originality: history.latestAssessment.originality,
    governingProfiles: history.latestAssessment.governingProfiles,
  });

  await writeConceptVersion(state.runDirectory, record, assessment);
  await writeRunArtefact(
    state.runDirectory,
    `concepts/${history.conceptId}.v${nextVersion}.director.json`,
    revision.candidate.director,
  );

  return {
    decision,
    version: record,
    selectable: assessment.selectable,
    blockingReasons: assessment.blockingReasons,
  };
}

export async function readStrategy(runDirectory: string): Promise<CampaignStrategistResult> {
  const raw = JSON.parse(await readFile(join(runDirectory, 'strategy.json'), 'utf8')) as {
    strategy?: unknown;
  };
  const parsed = CampaignStrategistResultSchema.safeParse(raw.strategy);
  if (!parsed.success) {
    throw new LaunchArtefactError(
      'INVALID',
      `strategy.json does not hold a valid Campaign Strategist result: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** The merged, capture-substituted inventory this run's concepts are judged against. */
export async function readInventory(state: LaunchRunState): Promise<LaunchInventory> {
  const manifest = parseProductionAssetManifest(
    JSON.parse(await readFile(state.manifest.mergedAssetManifestPath, 'utf8')),
    state.manifest.mergedAssetManifestPath,
  );
  return {
    assets: manifest.assets,
    outputEligibleCaptureIds: new Set(state.manifest.captureVerification.outputEligibleCaptureIds),
    reviewRequiredCaptureIds: new Set(state.manifest.captureVerification.reviewRequiredCaptureIds),
  };
}

/** Everything `aamp:launch inspect` reports, as data. */
export interface LaunchInspection {
  readonly launchRunId: string;
  readonly campaignId: string;
  readonly workspaceId: string;
  readonly executionMode: string;
  readonly isRealCampaignRun: boolean;
  readonly caveat: string;
  readonly benchmarkProfileName: string;
  readonly campaignPromptSha256: string;
  readonly campaignPromptUnchanged: boolean;
  readonly approvedReviewerIds: readonly string[];
  readonly concepts: readonly {
    readonly conceptId: string;
    readonly latestVersion: number;
    readonly supersededVersions: readonly number[];
    readonly title: string;
    readonly centralIdea: string;
    readonly structure: Record<string, string>;
    readonly selectable: boolean;
    readonly blockingReasons: readonly string[];
    readonly assetFeasibility: string;
    readonly missingCaptureIds: readonly string[];
    readonly originalityRiskLevel: string;
    readonly dimensions: readonly {
      readonly dimension: string;
      readonly basis: string;
      readonly verdict: string;
      readonly finding: string;
    }[];
  }[];
  readonly decisions: readonly LaunchGateDecision[];
  readonly selection: LaunchConceptSelection | null;
  readonly renderPermitted: boolean;
}

export function inspectLaunchRun(state: LaunchRunState): LaunchInspection {
  return {
    launchRunId: state.manifest.launchRunId,
    campaignId: state.manifest.campaignId,
    workspaceId: state.manifest.workspaceId,
    executionMode: state.manifest.executionMode,
    isRealCampaignRun: state.manifest.isRealCampaignRun,
    caveat: state.manifest.caveat,
    benchmarkProfileName: state.manifest.benchmarkProfileName,
    campaignPromptSha256: state.manifest.campaignPromptSha256,
    campaignPromptUnchanged: state.request.promptSha256 === state.manifest.campaignPromptSha256,
    approvedReviewerIds: state.launchBrief.approvedReviewerIds,
    concepts: state.histories.map((history) => ({
      conceptId: history.conceptId,
      latestVersion: history.latest.version,
      supersededVersions: history.versions
        .filter((version) => version.version !== history.latest.version)
        .map((version) => version.version),
      title: history.latest.concept.title,
      centralIdea: history.latest.concept.centralIdea,
      structure: Object.fromEntries(
        structuralPositionsOf(history.latest.concept).map((position) => {
          const [axis, value] = position.split('=');
          return [axis as string, value as string];
        }),
      ),
      selectable: history.latestAssessment.selectable,
      blockingReasons: history.latestAssessment.blockingReasons,
      assetFeasibility: history.latestAssessment.assetFeasibility.verdict,
      missingCaptureIds: history.latestAssessment.assetFeasibility.missingCaptureIds,
      originalityRiskLevel: history.latestAssessment.originality.riskLevel,
      dimensions: history.latestAssessment.dimensions.map((dimension) => ({
        dimension: dimension.dimension,
        basis: dimension.basis,
        verdict: dimension.verdict,
        finding: dimension.finding,
      })),
    })),
    decisions: state.decisions,
    selection: state.selection ?? null,
    renderPermitted: state.selection !== undefined,
  };
}

/** Type guard used by the CLI to keep candidate lookups honest. */
export function conceptCandidateFrom(
  history: ConceptHistory,
  director: ConceptCandidate['director'],
): ConceptCandidate {
  return {
    conceptId: history.conceptId,
    candidateIndex: 1,
    concept: history.latest.concept,
    director,
    agentVersion: history.latest.authoredByAgent,
  };
}
