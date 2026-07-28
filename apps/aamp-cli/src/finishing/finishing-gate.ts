import type { HumanCreativePlan } from '../preview/human-plan';
import {
  FINISHING_EXIT_CODES,
  REVISION_STAGES,
  sha256OfJson,
  type FinishingExitCode,
  type FinishingSelection,
  type RevisionStage,
  type TimestampedDefect,
} from './finishing-contracts';
import {
  candidatePlanFile,
  readBrief,
  readCandidate,
  readOpeningPlan,
  readPlanAt,
  readRunManifest,
  readStageComparison,
  readStageSelection,
  stageHasComparison,
  type FinishingRunManifest,
} from './finishing-store';
import type { CreativeFinishingBrief } from './finishing-contracts';

/**
 * The stage gate.
 *
 * Staged elimination only means anything if the stages actually happen in
 * order and each one ends with a person choosing. Two failure modes this
 * exists to make impossible:
 *
 * - **Skipping ahead.** Comparing pacing against an unsettled hook is
 *   comparing a variable against a variable. `requireStageIsNext` refuses it
 *   by name rather than producing four candidates that mean nothing.
 * - **A selection nobody made.** There is no `--latest`, no default and no
 *   "the highest-scoring candidate". The only way to obtain a settled stage is
 *   a recorded `FinishingSelection` naming a reviewer, an instant, a candidate
 *   and the checksum of the bytes they approved — and the checksum is verified
 *   against the plan on disk every time it is read back.
 */

export class FinishingGateError extends Error {
  constructor(
    message: string,
    public readonly exitCode: FinishingExitCode,
  ) {
    super(message);
    this.name = 'FinishingGateError';
  }
}

export interface FinishingRunState {
  readonly runDirectory: string;
  readonly manifest: FinishingRunManifest;
  readonly brief: CreativeFinishingBrief;
  readonly openingPlan: HumanCreativePlan;
  readonly selections: Readonly<Partial<Record<RevisionStage, FinishingSelection>>>;
  readonly comparedStages: readonly RevisionStage[];
}

export async function readFinishingRunState(runDirectory: string): Promise<FinishingRunState> {
  const manifest = await readRunManifest(runDirectory);
  const brief = await readBrief(runDirectory);
  const openingPlan = await readOpeningPlan(runDirectory);

  const selections: Partial<Record<RevisionStage, FinishingSelection>> = {};
  const comparedStages: RevisionStage[] = [];
  for (const stage of REVISION_STAGES) {
    if (await stageHasComparison(runDirectory, stage)) comparedStages.push(stage);
    const selection = await readStageSelection(runDirectory, stage);
    if (selection) selections[stage] = selection;
  }

  return { runDirectory, manifest, brief, openingPlan, selections, comparedStages };
}

/** The first stage with no recorded selection, or `FINAL` when all four are settled. */
export function currentStage(state: FinishingRunState): RevisionStage | 'FINAL' {
  for (const stage of REVISION_STAGES) {
    if (!state.selections[stage]) return stage;
  }
  return 'FINAL';
}

export function requireStageIsNext(state: FinishingRunState, stage: RevisionStage): void {
  const expected = currentStage(state);
  if (expected === 'FINAL') {
    throw new FinishingGateError(
      `every stage in this run is settled (${REVISION_STAGES.join(' → ')}). There is nothing left to compare; submit a scorecard and finalize.`,
      FINISHING_EXIT_CODES.STAGE_OUT_OF_ORDER,
    );
  }
  if (expected !== stage) {
    const unsettled = REVISION_STAGES.filter(
      (candidate) =>
        REVISION_STAGES.indexOf(candidate) < REVISION_STAGES.indexOf(stage) &&
        !state.selections[candidate],
    );
    throw new FinishingGateError(
      `this run is at the ${expected} stage, not ${stage}. ${
        unsettled.length > 0
          ? `${unsettled.join(', ')} ${unsettled.length === 1 ? 'is' : 'are'} still open, and comparing ${stage} against an unsettled ${unsettled[0]} means comparing a variable against a variable.`
          : ''
      }`.trim(),
      FINISHING_EXIT_CODES.STAGE_OUT_OF_ORDER,
    );
  }
}

/**
 * The plan a stage varies from: the previous stage's approved candidate, or
 * the opening plan for the first stage.
 *
 * Read from the selection rather than from a "current plan" file that some
 * command keeps up to date, because the file would eventually disagree with
 * the decision and the decision is the thing with a name attached to it.
 */
export async function resolveStageBasePlan(
  state: FinishingRunState,
  stage: RevisionStage,
): Promise<{ readonly plan: HumanCreativePlan; readonly planSha256: string }> {
  const index = REVISION_STAGES.indexOf(stage);
  if (index <= 0) {
    return { plan: state.openingPlan, planSha256: sha256OfJson(state.openingPlan) };
  }
  const previous = REVISION_STAGES[index - 1] as RevisionStage;
  const selection = state.selections[previous];
  if (!selection) {
    throw new FinishingGateError(
      `the ${previous} stage has no recorded selection, so there is no approved plan for ${stage} to vary from.`,
      FINISHING_EXIT_CODES.HUMAN_SELECTION_REQUIRED,
    );
  }
  return loadApprovedPlan(state, previous, selection);
}

/**
 * Loads the exact bytes a reviewer approved, and proves they are still those
 * bytes.
 *
 * A candidate plan edited after selection would render perfectly and be a
 * different advertisement from the one that was approved — which is precisely
 * what pinning a checksum in the selection is for.
 */
export async function loadApprovedPlan(
  state: FinishingRunState,
  stage: RevisionStage,
  selection: FinishingSelection,
): Promise<{ readonly plan: HumanCreativePlan; readonly planSha256: string }> {
  const plan = await readPlanAt(
    state.runDirectory,
    candidatePlanFile(stage, selection.selectedCandidateId),
  );
  const planSha256 = sha256OfJson(plan);
  if (planSha256 !== selection.selectedPlanSha256) {
    throw new FinishingGateError(
      `the ${stage} stage approved candidate "${selection.selectedCandidateId}" at ${selection.selectedPlanSha256.slice(0, 16)}…, but the plan on disk now hashes to ${planSha256.slice(0, 16)}…. Approved bytes were changed after the decision.`,
      FINISHING_EXIT_CODES.CANDIDATE_STALE_OR_UNKNOWN,
    );
  }
  return { plan, planSha256 };
}

export interface RecordSelectionOptions {
  readonly state: FinishingRunState;
  readonly stage: RevisionStage;
  readonly candidateId: string;
  readonly reviewer: string;
  readonly reason: string;
  readonly feedback: readonly TimestampedDefect[];
  readonly selectedAt: string;
}

/**
 * Builds the selection record, having checked everything about it that can be
 * checked before it becomes permanent.
 *
 * Writing is the store's job; deciding whether this selection is one the run
 * can accept is this function's, and it deliberately refuses rather than
 * repairs — a reviewer who named a candidate that does not exist has a
 * different candidate in mind, and guessing which is not this code's decision.
 */
export async function buildStageSelection(
  options: RecordSelectionOptions,
): Promise<FinishingSelection> {
  const { state, stage, candidateId } = options;

  requireStageIsNext(state, stage);

  if (!(await stageHasComparison(state.runDirectory, stage))) {
    throw new FinishingGateError(
      `the ${stage} stage has no comparison yet, so there is nothing to choose from. Run "propose" first.`,
      FINISHING_EXIT_CODES.STAGE_OUT_OF_ORDER,
    );
  }

  const comparison = await readStageComparison(state.runDirectory, stage);
  const entry = comparison.entries.find((candidate) => candidate.candidateId === candidateId);
  if (!entry) {
    throw new FinishingGateError(
      `the ${stage} comparison has no candidate "${candidateId}". It offers: ${comparison.entries
        .map((candidate) => candidate.candidateId)
        .join(', ')}`,
      FINISHING_EXIT_CODES.CANDIDATE_STALE_OR_UNKNOWN,
    );
  }
  if (!entry.rendered) {
    throw new FinishingGateError(
      `candidate "${candidateId}" never produced a master${entry.failure ? ` (${entry.failure})` : ''}, so nobody has watched it. A selection is a judgement about a file that exists.`,
      FINISHING_EXIT_CODES.CANDIDATE_STALE_OR_UNKNOWN,
    );
  }

  // The record and the plan must still agree with each other and with the
  // comparison the reviewer read.
  const candidate = await readCandidate(state.runDirectory, stage, candidateId);
  const plan = await readPlanAt(state.runDirectory, candidatePlanFile(stage, candidateId));
  const planSha256 = sha256OfJson(plan);
  if (planSha256 !== candidate.planSha256 || planSha256 !== entry.planSha256) {
    throw new FinishingGateError(
      `candidate "${candidateId}" no longer matches what was compared: the plan on disk hashes to ${planSha256.slice(0, 16)}…, the candidate record says ${candidate.planSha256.slice(0, 16)}… and the comparison says ${entry.planSha256.slice(0, 16)}….`,
      FINISHING_EXIT_CODES.CANDIDATE_STALE_OR_UNKNOWN,
    );
  }

  for (const defect of options.feedback) {
    if (defect.endSeconds > state.brief.durationSeconds) {
      throw new FinishingGateError(
        `carried-forward note "${defect.id}" ends at ${defect.endSeconds}s, past the ${state.brief.durationSeconds}s cut.`,
        FINISHING_EXIT_CODES.BRIEF_REFUSED,
      );
    }
  }

  return {
    stage,
    selectedCandidateId: candidateId,
    selectedPlanSha256: planSha256,
    reviewer: options.reviewer,
    selectedAt: options.selectedAt,
    reason: options.reason,
    feedback: [...options.feedback],
  };
}

/**
 * The finished plan: the last stage's approved candidate.
 *
 * There is no path to a finished master that does not pass through here, and
 * this function has no fallback — a run missing any selection raises
 * `HUMAN_SELECTION_REQUIRED` rather than finishing from whatever is newest.
 */
export async function requireFinishedPlan(
  state: FinishingRunState,
): Promise<{ readonly plan: HumanCreativePlan; readonly planSha256: string }> {
  const missing = REVISION_STAGES.filter((stage) => !state.selections[stage]);
  if (missing.length > 0) {
    throw new FinishingGateError(
      `this run is not finished: ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no recorded human selection. Nothing is promoted without one.`,
      FINISHING_EXIT_CODES.HUMAN_SELECTION_REQUIRED,
    );
  }
  const last = REVISION_STAGES[REVISION_STAGES.length - 1] as RevisionStage;
  const selection = state.selections[last] as FinishingSelection;
  return loadApprovedPlan(state, last, selection);
}
