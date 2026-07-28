import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { parseHumanPlan, type HumanCreativePlan } from '../preview/human-plan';
import {
  CreativeFinishingBriefSchema,
  FinishingCandidateSchema,
  FinishingContractError,
  FinishingSelectionSchema,
  REVISION_STAGES,
  RevisionStageSchema,
  canonicalJson,
  sha256OfJson,
  type CreativeFinishingBrief,
  type FinishingCandidate,
  type FinishingSelection,
  type RevisionStage,
} from './finishing-contracts';
import { StageDirectiveSetSchema, type StageDirectiveSet } from './finishing-directives';

/**
 * The finishing run on disk.
 *
 * A run directory is the artefact a reviewer, an auditor and a later render
 * all read, so two properties matter more than convenience:
 *
 * - **A version is written once.** A candidate plan, a stage selection and the
 *   accepted brief are refused if a different file already sits there. The
 *   reviewer's approval pins bytes; rewriting those bytes afterwards would
 *   make the approval describe something that no longer exists.
 * - **Nothing is inferred from the filesystem.** The run manifest states which
 *   stages are settled; a directory that happens to contain a `selection.json`
 *   proves nothing on its own, and a run is read through the manifest so a
 *   half-written stage cannot masquerade as a decided one.
 */

const RUN_MANIFEST = 'finishing-run.json';
const BRIEF = 'brief.json';
const BASE_PLAN = 'base-plan.json';
const SCORECARD = 'scorecard.json';
const VERDICT = 'finishing-verdict.json';
const PROVENANCE = 'finishing-provenance.json';

export function stageDirectory(stage: RevisionStage): string {
  return join('stages', stage);
}

export function candidateDirectory(stage: RevisionStage, candidateId: string): string {
  return join(stageDirectory(stage), 'candidates', candidateId);
}

export class FinishingStoreError extends FinishingContractError {
  constructor(message: string, problems: readonly string[] = []) {
    super(message, problems);
    this.name = 'FinishingStoreError';
  }
}

/* -------------------------------------------------------------------------- */
/* Primitive IO                                                                */
/* -------------------------------------------------------------------------- */

async function readJson(runDirectory: string, relative: string): Promise<unknown> {
  const target = join(runDirectory, relative);
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    throw new FinishingStoreError(
      `Could not read ${relative} in ${runDirectory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function exists(runDirectory: string, relative: string): Promise<boolean> {
  try {
    await readFile(join(runDirectory, relative), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export async function writeJson(
  runDirectory: string,
  relative: string,
  value: unknown,
): Promise<string> {
  const target = join(runDirectory, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

/**
 * Writes a file that must never change afterwards.
 *
 * Re-running a command with the same inputs is expected and harmless, so an
 * identical rewrite is allowed; a *different* one is refused by name. That is
 * the difference between an idempotent command and a silent overwrite.
 */
async function writeOnce(runDirectory: string, relative: string, value: unknown): Promise<string> {
  if (await exists(runDirectory, relative)) {
    const existing = canonicalJson(await readJson(runDirectory, relative));
    if (existing !== canonicalJson(value)) {
      throw new FinishingStoreError(
        `${relative} already exists in this run with different content, and a finishing artefact is written once. Open a new run rather than rewriting bytes a reviewer may already have read.`,
      );
    }
    return join(runDirectory, relative);
  }
  return writeJson(runDirectory, relative, value);
}

function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new FinishingStoreError(`${what} is not valid:\n  - ${problems.join('\n  - ')}`, problems);
}

/* -------------------------------------------------------------------------- */
/* The run manifest                                                            */
/* -------------------------------------------------------------------------- */

export const FinishingRunManifestSchema = z
  .object({
    runVersion: z.literal(1),
    runId: z.string().min(1).max(120),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    briefId: z.string().min(1).max(80),
    briefSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** The plan the first stage varies from. */
    openingPlanSha256: z.string().regex(/^[0-9a-f]{64}$/),
    requestPath: z.string().min(1),
    assetRoot: z.string().min(1),
    openedBy: z.string().min(2).max(200),
    openedAt: z.string().datetime({ offset: true }),
    stageOrder: z.array(RevisionStageSchema).length(REVISION_STAGES.length),
    /** Always zero on this path, written rather than inferred. */
    paidProviderCalls: z.literal(0),
    isRealCampaignRun: z.literal(false),
  })
  .strict();
export type FinishingRunManifest = z.infer<typeof FinishingRunManifestSchema>;

export async function writeRunManifest(
  runDirectory: string,
  manifest: FinishingRunManifest,
): Promise<string> {
  return writeOnce(runDirectory, RUN_MANIFEST, manifest);
}

export async function readRunManifest(runDirectory: string): Promise<FinishingRunManifest> {
  return parseOrThrow(
    FinishingRunManifestSchema,
    await readJson(runDirectory, RUN_MANIFEST),
    `${RUN_MANIFEST} in ${runDirectory}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Brief, plans, directives, candidates, selections                            */
/* -------------------------------------------------------------------------- */

export async function writeBrief(
  runDirectory: string,
  brief: CreativeFinishingBrief,
): Promise<string> {
  return writeOnce(runDirectory, BRIEF, brief);
}

export async function readBrief(runDirectory: string): Promise<CreativeFinishingBrief> {
  return parseOrThrow(
    CreativeFinishingBriefSchema,
    await readJson(runDirectory, BRIEF),
    `${BRIEF} in ${runDirectory}`,
  );
}

export async function writeOpeningPlan(
  runDirectory: string,
  plan: HumanCreativePlan,
): Promise<string> {
  return writeOnce(runDirectory, BASE_PLAN, plan);
}

export async function readPlanAt(
  runDirectory: string,
  relative: string,
): Promise<HumanCreativePlan> {
  return parseHumanPlan(await readJson(runDirectory, relative), join(runDirectory, relative));
}

export async function readOpeningPlan(runDirectory: string): Promise<HumanCreativePlan> {
  return readPlanAt(runDirectory, BASE_PLAN);
}

export function candidatePlanFile(stage: RevisionStage, candidateId: string): string {
  return join(candidateDirectory(stage, candidateId), 'plan.json');
}

export function candidateRecordFile(stage: RevisionStage, candidateId: string): string {
  return join(candidateDirectory(stage, candidateId), 'candidate.json');
}

export function candidateRenderDirectory(stage: RevisionStage, candidateId: string): string {
  return join(candidateDirectory(stage, candidateId), 'render');
}

export async function writeCandidate(
  runDirectory: string,
  candidate: FinishingCandidate,
  plan: HumanCreativePlan,
): Promise<{ readonly planPath: string; readonly recordPath: string }> {
  if (sha256OfJson(plan) !== candidate.planSha256) {
    throw new FinishingStoreError(
      `candidate "${candidate.candidateId}" declares plan checksum ${candidate.planSha256.slice(0, 16)}… but the plan being written hashes to ${sha256OfJson(plan).slice(0, 16)}…`,
    );
  }
  const planPath = await writeOnce(
    runDirectory,
    candidatePlanFile(candidate.stage, candidate.candidateId),
    plan,
  );
  const recordPath = await writeOnce(
    runDirectory,
    candidateRecordFile(candidate.stage, candidate.candidateId),
    candidate,
  );
  return { planPath, recordPath };
}

export async function readCandidate(
  runDirectory: string,
  stage: RevisionStage,
  candidateId: string,
): Promise<FinishingCandidate> {
  return parseOrThrow(
    FinishingCandidateSchema,
    await readJson(runDirectory, candidateRecordFile(stage, candidateId)),
    `candidate "${candidateId}" in stage ${stage}`,
  );
}

export const StageComparisonSchema = z
  .object({
    stage: RevisionStageSchema,
    basePlanSha256: z.string().regex(/^[0-9a-f]{64}$/),
    comparedAt: z.string().datetime({ offset: true }),
    primaryAxis: z.string().min(1),
    notice: z.string().min(1),
    entries: z.array(
      z
        .object({
          candidateId: z.string().min(1),
          label: z.string().min(1),
          rationale: z.string().min(1),
          planSha256: z.string().regex(/^[0-9a-f]{64}$/),
          rendered: z.boolean(),
          outputPath: z.string().nullable(),
          qaVerdict: z.string().nullable(),
          measuredDurationSeconds: z.number().nullable(),
          measuredLoudnessLufs: z.number().nullable(),
          outputChecksumSha256: z.string().nullable(),
          failure: z.string().nullable(),
          changes: z.array(
            z.object({ axis: z.string(), field: z.string(), from: z.string(), to: z.string() }),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type StageComparison = z.infer<typeof StageComparisonSchema>;

export function stageDirectivesFile(stage: RevisionStage): string {
  return join(stageDirectory(stage), 'directives.json');
}

export function stageComparisonFile(stage: RevisionStage): string {
  return join(stageDirectory(stage), 'comparison.json');
}

export function stageSelectionFile(stage: RevisionStage): string {
  return join(stageDirectory(stage), 'selection.json');
}

export async function writeStageDirectives(
  runDirectory: string,
  directives: StageDirectiveSet,
): Promise<string> {
  return writeOnce(runDirectory, stageDirectivesFile(directives.stage), directives);
}

export async function readStageDirectives(
  runDirectory: string,
  stage: RevisionStage,
): Promise<StageDirectiveSet> {
  return parseOrThrow(
    StageDirectiveSetSchema,
    await readJson(runDirectory, stageDirectivesFile(stage)),
    `directives for stage ${stage}`,
  );
}

export async function writeStageComparison(
  runDirectory: string,
  comparison: StageComparison,
): Promise<string> {
  // Not write-once: re-proposing a stage that nobody has selected yet is a
  // legitimate thing to do, and the comparison is a report over candidate
  // files that are themselves immutable.
  return writeJson(runDirectory, stageComparisonFile(comparison.stage), comparison);
}

export async function readStageComparison(
  runDirectory: string,
  stage: RevisionStage,
): Promise<StageComparison> {
  return parseOrThrow(
    StageComparisonSchema,
    await readJson(runDirectory, stageComparisonFile(stage)),
    `comparison for stage ${stage}`,
  );
}

export async function writeStageSelection(
  runDirectory: string,
  selection: FinishingSelection,
): Promise<string> {
  return writeOnce(runDirectory, stageSelectionFile(selection.stage), selection);
}

export async function readStageSelection(
  runDirectory: string,
  stage: RevisionStage,
): Promise<FinishingSelection | undefined> {
  if (!(await exists(runDirectory, stageSelectionFile(stage)))) return undefined;
  return parseOrThrow(
    FinishingSelectionSchema,
    await readJson(runDirectory, stageSelectionFile(stage)),
    `selection for stage ${stage}`,
  );
}

export async function stageHasComparison(
  runDirectory: string,
  stage: RevisionStage,
): Promise<boolean> {
  return exists(runDirectory, stageComparisonFile(stage));
}

/* -------------------------------------------------------------------------- */
/* Scorecard, verdict, provenance                                              */
/* -------------------------------------------------------------------------- */

export const SCORECARD_FILE = SCORECARD;
export const VERDICT_FILE = VERDICT;
export const PROVENANCE_FILE = PROVENANCE;

export async function writeScorecard(runDirectory: string, scorecard: unknown): Promise<string> {
  return writeOnce(runDirectory, SCORECARD, scorecard);
}

export async function readScorecardRaw(runDirectory: string): Promise<unknown | undefined> {
  if (!(await exists(runDirectory, SCORECARD))) return undefined;
  return readJson(runDirectory, SCORECARD);
}

export async function writeVerdict(runDirectory: string, verdict: unknown): Promise<string> {
  return writeJson(runDirectory, VERDICT, verdict);
}

export async function writeProvenance(runDirectory: string, provenance: unknown): Promise<string> {
  return writeJson(runDirectory, PROVENANCE, provenance);
}
