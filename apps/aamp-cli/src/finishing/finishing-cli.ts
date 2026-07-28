import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { resolveFfmpegBinaries, type CommandRunner } from '@combat/media';

import { CampaignRequestValidationError, loadCampaignRequest } from '../campaign-request';
import { findRepositoryRoot } from '../generate-cli';
import { loadHumanPlan } from '../preview/human-plan';
import { runDirectoryFor } from '../run-source-campaign';
import {
  CREATIVE_FINISHING_BRIEF_VERSION,
  FINISHING_EXIT_CODES,
  FINISHING_MEASUREMENT_NOTICE,
  FINISHING_RUN_NOTICE,
  FinishingContractError,
  REVISION_STAGES,
  TimestampedDefectSchema,
  parseCreativeFinishingBrief,
  sha256OfJson,
  type FinishingExitCode,
  type RevisionStage,
  type TimestampedDefect,
} from './finishing-contracts';
import {
  buildDirectiveTemplate,
  parseStageDirectiveSet,
  STAGE_AXIS_POLICY,
} from './finishing-directives';
import {
  buildStageSelection,
  currentStage,
  FinishingGateError,
  readFinishingRunState,
  requireFinishedPlan,
  requireStageIsNext,
  resolveStageBasePlan,
  type FinishingRunState,
} from './finishing-gate';
import { PlanEditError } from './finishing-plan-edits';
import { proposeStage } from './finishing-propose';
import {
  buildScorecardTemplate,
  evaluateFinishingVerdict,
  parsePremiumScorecard,
} from './finishing-scorecard';
import {
  readScorecardRaw,
  readStageComparison,
  writeBrief,
  writeOpeningPlan,
  writeProvenance,
  writeRunManifest,
  writeScorecard,
  writeStageDirectives,
  writeStageSelection,
  writeVerdict,
  type FinishingRunManifest,
} from './finishing-store';

/**
 * `pnpm aamp:finish` — the premium creative finishing workflow.
 *
 * Eight subcommands along one line: only `propose` renders, and
 * everything else reads, validates or records a decision. Like the launch
 * gate, none of these paths constructs a reasoning provider, a generation
 * provider or a database client — a finishing round is footage, a plan, a
 * person's judgement and FFmpeg, and "this cannot spend money" is a property
 * of what this module imports rather than a promise in its help text.
 */

export const FINISHING_USAGE = [
  'Usage: pnpm aamp:finish <command> [options]',
  '',
  'Commands:',
  '  brief      --request <campaign-request.json> --plan <plan.json> --master <master.mp4>',
  '             --out <brief.json>',
  '             Emits a critique skeleton pinned to that exact plan and master. Every prose',
  '             field says TODO: the brief is the reviewer’s, not this tool’s.',
  '',
  '  open       --request <r.json> --plan <plan.json> --brief <brief.json>',
  '             [--assets <dir>] [--output-dir <dir>] [--opened-by <name>] [--json]',
  '             Verifies the critique against the plan and master it names, and opens a run.',
  '',
  '  directives --run <run-directory> --out <directives.json>',
  '             Emits a directive skeleton for the stage this run is actually at.',
  '',
  '  propose    --run <run-directory> --directives <directives.json> [--skip-render] [--json]',
  '             Applies the directives, adds the unchanged control, renders every candidate',
  '             through the existing preview path and writes a comparison to watch.',
  '',
  '  inspect    --run <run-directory> [--json]',
  '             Reads the run. Renders nothing and decides nothing.',
  '',
  '  select     --run <run-directory> --candidate <id> --reviewer <name> --reason <file>',
  '             [--feedback <file>] [--json]',
  '             Records the human decision for the current stage and pins the approved bytes.',
  '',
  '  scorecard  --run <run-directory> --out <scorecard.json>',
  '             Emits an empty premium scorecard for the finished master. Nothing in this',
  '             repository produces, suggests or defaults a craft score.',
  '',
  '  finalize   --run <run-directory> --scorecard <scorecard.json> [--json]',
  '             Validates the submitted scorecard against the measured master and writes the',
  '             verdict. PREMIUM_READY requires every gate, and names every blocker.',
].join('\n');

export type FinishingCommand =
  'brief' | 'open' | 'directives' | 'propose' | 'inspect' | 'select' | 'scorecard' | 'finalize';

const COMMANDS: readonly FinishingCommand[] = [
  'brief',
  'open',
  'directives',
  'propose',
  'inspect',
  'select',
  'scorecard',
  'finalize',
];

export interface FinishingCliOptions {
  readonly command: FinishingCommand;
  readonly requestPath?: string;
  readonly planPath?: string;
  readonly masterPath?: string;
  readonly briefPath?: string;
  readonly directivesPath?: string;
  readonly scorecardPath?: string;
  readonly reasonPath?: string;
  readonly feedbackPath?: string;
  readonly outPath?: string;
  readonly runDirectory?: string;
  readonly outputDirectory?: string;
  readonly assetRoot?: string;
  readonly candidateId?: string;
  readonly reviewer?: string;
  readonly openedBy?: string;
  readonly skipRender: boolean;
  readonly json: boolean;
}

export interface FinishingCliContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
  readonly runner?: CommandRunner;
  readonly workflowRunId?: string;
}

export function parseFinishingCliArguments(argv: readonly string[]): FinishingCliOptions {
  const command = argv[0];
  if (!COMMANDS.includes(command as FinishingCommand)) {
    throw new Error(`${FINISHING_USAGE}\n\nUnknown command "${command ?? ''}".`);
  }

  const values: Record<string, string | undefined> = {};
  let skipRender = false;
  let json = false;

  const flags: Readonly<Record<string, string>> = {
    '--request': 'requestPath',
    '--plan': 'planPath',
    '--master': 'masterPath',
    '--brief': 'briefPath',
    '--directives': 'directivesPath',
    '--scorecard': 'scorecardPath',
    '--reason': 'reasonPath',
    '--feedback': 'feedbackPath',
    '--out': 'outPath',
    '--run': 'runDirectory',
    '--output-dir': 'outputDirectory',
    '--assets': 'assetRoot',
    '--candidate': 'candidateId',
    '--reviewer': 'reviewer',
    '--opened-by': 'openedBy',
  };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--skip-render') {
      skipRender = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    const key = flags[argument];
    if (!key) throw new Error(`${FINISHING_USAGE}\n\nUnknown option "${argument}".`);
    index += 1;
    const value = argv[index];
    if (value === undefined) throw new Error(`${argument} needs a value.`);
    values[key] = value;
  }

  return {
    command: command as FinishingCommand,
    ...values,
    skipRender,
    json,
  } as FinishingCliOptions;
}

function required(
  options: FinishingCliOptions,
  key: keyof FinishingCliOptions,
  flag: string,
): string {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${flag} is required for "${options.command}".`);
  }
  return value;
}

function absolute(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

async function sha256OfFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

async function runBriefTemplate(
  options: FinishingCliOptions,
  context: FinishingCliContext,
  root: string,
): Promise<number> {
  const requestPath = absolute(root, required(options, 'requestPath', '--request'));
  const planPath = absolute(root, required(options, 'planPath', '--plan'));
  const masterPath = absolute(root, required(options, 'masterPath', '--master'));
  const outPath = absolute(root, required(options, 'outPath', '--out'));

  const request = await loadCampaignRequest(requestPath);
  const plan = await loadHumanPlan(planPath, request);
  const now = (context.now ? context.now() : new Date()).toISOString();

  await writeJsonFile(outPath, {
    briefVersion: CREATIVE_FINISHING_BRIEF_VERSION,
    briefId: 'TODO — a short id for this finishing round.',
    workspaceId: request.workspaceId,
    campaignId: request.campaignId,
    sourceMasterPath: masterPath,
    sourceMasterSha256: await sha256OfFile(masterPath),
    sourcePlanPath: planPath,
    // Canonical-JSON checksum, the same notion every other plan checksum in a
    // finishing run uses, so the two can be compared without conversion.
    sourcePlanSha256: sha256OfJson(plan),
    reviewer: { name: 'TODO — your name.', role: 'TODO — your role.' },
    reviewedAt: now,
    defects: [
      {
        id: 'todo-defect-1',
        startSeconds: 0,
        endSeconds: 1,
        category: 'FIRST_FRAME',
        observed: 'TODO — what is visibly on screen or audible here. Not how it made you feel.',
        requiredCorrection:
          'TODO — what must change. A render decision has to be able to act on it.',
        severity: 'MAJOR',
      },
    ],
    protectedStrengths: [],
    selectedCreativeDirection:
      'TODO — the direction for this round, in your own words. At least a couple of sentences: this is what the whole round is steered by.',
    approvedFootageAssetIds: plan.beats
      .map((beat) => beat.source.assetId)
      .filter((assetId): assetId is string => typeof assetId === 'string'),
    approvedUiAssetIds: [],
    prohibitions: { assets: [], brands: [], claims: [], implications: [] },
    platform: 'TIKTOK',
    durationSeconds: plan.targetDurationSeconds,
    cta: { headline: plan.cta.headline, subline: plan.cta.subline ?? 'TODO — the CTA subline.' },
    thresholds: { gatedDimensionMinimum: 8, overallHumanMinimum: 8 },
  });

  context.stderr(
    `Wrote a critique skeleton to ${outPath}.\nEvery TODO is a decision this tool will not make for you; the schema refuses vague ones.\n`,
  );
  return FINISHING_EXIT_CODES.SUCCESS;
}

async function runOpen(
  options: FinishingCliOptions,
  context: FinishingCliContext,
  root: string,
): Promise<number> {
  const requestPath = absolute(root, required(options, 'requestPath', '--request'));
  const planPath = absolute(root, required(options, 'planPath', '--plan'));
  const briefPath = absolute(root, required(options, 'briefPath', '--brief'));

  const request = await loadCampaignRequest(requestPath);
  const plan = await loadHumanPlan(planPath, request);
  const brief = parseCreativeFinishingBrief(
    JSON.parse(await readFile(briefPath, 'utf8')),
    briefPath,
  );

  // The critique has to be about this plan, this campaign and this master.
  const problems: string[] = [];
  if (brief.workspaceId !== request.workspaceId) {
    problems.push(
      `brief is for workspace ${brief.workspaceId}, the request is for ${request.workspaceId}`,
    );
  }
  if (brief.campaignId !== request.campaignId) {
    problems.push(
      `brief is for campaign ${brief.campaignId}, the request is for ${request.campaignId}`,
    );
  }
  const planSha256 = sha256OfJson(plan);
  if (brief.sourcePlanSha256 !== planSha256) {
    problems.push(
      `the brief critiques plan ${brief.sourcePlanSha256.slice(0, 16)}…, but --plan hashes to ${planSha256.slice(0, 16)}…. A critique of a different cut would be answered by changing this one.`,
    );
  }
  const masterPath = absolute(root, brief.sourceMasterPath);
  try {
    const masterSha256 = await sha256OfFile(masterPath);
    if (masterSha256 !== brief.sourceMasterSha256) {
      problems.push(
        `the master at ${masterPath} hashes to ${masterSha256.slice(0, 16)}…, but the brief pins ${brief.sourceMasterSha256.slice(0, 16)}…`,
      );
    }
  } catch (error) {
    problems.push(
      `could not read the master the brief names (${masterPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Math.abs(brief.durationSeconds - plan.targetDurationSeconds) > 1e-6) {
    problems.push(
      `the brief is written against a ${brief.durationSeconds}s cut, the plan is cut for ${plan.targetDurationSeconds}s`,
    );
  }
  if (problems.length > 0) {
    context.stderr(`The finishing brief was refused:\n  - ${problems.join('\n  - ')}\n`);
    return FINISHING_EXIT_CODES.BRIEF_REFUSED;
  }

  const workflowRunId = context.workflowRunId ?? `aamp-finish-${randomUUID()}`;
  const outputRoot = options.outputDirectory
    ? absolute(root, options.outputDirectory)
    : absolute(root, request.outputDirectory);
  const runDirectory = runDirectoryFor(outputRoot, `${request.name}-finishing`, workflowRunId);
  const assetRoot = options.assetRoot
    ? absolute(root, options.assetRoot)
    : dirname(request.sourceAssetManifestPath);

  const manifest: FinishingRunManifest = {
    runVersion: 1,
    runId: workflowRunId,
    workspaceId: request.workspaceId,
    campaignId: request.campaignId,
    briefId: brief.briefId,
    briefSha256: sha256OfJson(brief),
    openingPlanSha256: planSha256,
    requestPath,
    assetRoot,
    openedBy: options.openedBy ?? brief.reviewer.name,
    openedAt: (context.now ? context.now() : new Date()).toISOString(),
    stageOrder: [...REVISION_STAGES],
    paidProviderCalls: 0,
    isRealCampaignRun: false,
  };

  await writeRunManifest(runDirectory, manifest);
  await writeBrief(runDirectory, brief);
  await writeOpeningPlan(runDirectory, plan);

  if (options.json) {
    context.stdout(
      `${JSON.stringify({ runDirectory, stage: REVISION_STAGES[0], briefId: brief.briefId, paidProviderCalls: 0 }, null, 2)}\n`,
    );
  } else {
    context.stderr(
      [
        '',
        FINISHING_RUN_NOTICE,
        '',
        `run directory: ${runDirectory}`,
        `defects:       ${brief.defects.length} (${brief.defects.filter((defect) => defect.severity === 'BLOCKING').length} blocking)`,
        `stage order:   ${REVISION_STAGES.join(' → ')}`,
        `next:          aamp:finish directives --run ${runDirectory} --out directives.json`,
        '',
      ].join('\n'),
    );
  }
  return FINISHING_EXIT_CODES.SUCCESS;
}

async function runDirectivesTemplate(
  options: FinishingCliOptions,
  context: FinishingCliContext,
  root: string,
): Promise<number> {
  const runDirectory = absolute(root, required(options, 'runDirectory', '--run'));
  const outPath = absolute(root, required(options, 'outPath', '--out'));
  const state = await readFinishingRunState(runDirectory);
  const stage = currentStage(state);
  if (stage === 'FINAL') {
    context.stderr('Every stage in this run is settled. There are no directives left to author.\n');
    return FINISHING_EXIT_CODES.STAGE_OUT_OF_ORDER;
  }
  const base = await resolveStageBasePlan(state, stage);
  await writeJsonFile(
    outPath,
    buildDirectiveTemplate(
      stage,
      base.planSha256,
      (context.now ? context.now() : new Date()).toISOString(),
    ),
  );
  context.stderr(
    `Wrote a ${stage} directive skeleton to ${outPath}. This stage compares ${STAGE_AXIS_POLICY[stage].primaryAxis}.\n`,
  );
  return FINISHING_EXIT_CODES.SUCCESS;
}

async function runPropose(
  options: FinishingCliOptions,
  context: FinishingCliContext,
  root: string,
): Promise<number> {
  const runDirectory = absolute(root, required(options, 'runDirectory', '--run'));
  const directivesPath = absolute(root, required(options, 'directivesPath', '--directives'));
  const state = await readFinishingRunState(runDirectory);
  const directives = parseStageDirectiveSet(
    JSON.parse(await readFile(directivesPath, 'utf8')),
    directivesPath,
  );

  requireStageIsNext(state, directives.stage);
  const base = await resolveStageBasePlan(state, directives.stage);
  const request = await loadCampaignRequest(state.manifest.requestPath);

  const result = await proposeStage({
    runDirectory,
    request,
    brief: state.brief,
    stage: directives.stage,
    basePlan: base.plan,
    basePlanSha256: base.planSha256,
    directives,
    assetRoot: state.manifest.assetRoot,
    repositoryRoot: root,
    binaries: resolveFfmpegBinaries(context.env),
    workflowRunId: state.manifest.runId,
    now: context.now ? context.now() : new Date(),
    ...(context.runner ? { runner: context.runner } : {}),
    skipRender: options.skipRender,
    onProgress: (message) => {
      if (!options.json) context.stderr(`  ${message}\n`);
    },
  });

  // Written only once the proposal stands. A refused set that left a
  // `directives.json` behind would be recorded as the stage's directives while
  // no candidate it describes exists, and the write-once rule would then block
  // the corrected set.
  await writeStageDirectives(runDirectory, directives);

  if (options.json) {
    context.stdout(`${JSON.stringify(result.comparison, null, 2)}\n`);
  } else {
    context.stderr(
      [
        '',
        `${directives.stage}: ${result.comparison.entries.length} candidates, ${result.renderedCount} rendered, ${result.failedCount} without a master`,
        `watch: ${result.comparisonHtmlPath}`,
        `then:  aamp:finish select --run ${runDirectory} --candidate <id> --reviewer <name> --reason <file>`,
        '',
      ].join('\n'),
    );
  }
  // A stage where nothing rendered is not a comparison, and reporting success
  // would hand the reviewer an empty gallery with a zero exit code.
  return result.renderedCount === 0 && !options.skipRender
    ? FINISHING_EXIT_CODES.RENDERING_FAILURE
    : FINISHING_EXIT_CODES.SUCCESS;
}

async function runInspect(
  options: FinishingCliOptions,
  context: FinishingCliContext,
  root: string,
): Promise<number> {
  const runDirectory = absolute(root, required(options, 'runDirectory', '--run'));
  const state = await readFinishingRunState(runDirectory);
  const stage = currentStage(state);

  const stages = await Promise.all(
    REVISION_STAGES.map(async (entry) => {
      const selection = state.selections[entry];
      const compared = state.comparedStages.includes(entry);
      const comparison = compared ? await readStageComparison(runDirectory, entry) : undefined;
      return {
        stage: entry,
        compared,
        candidates: comparison?.entries.map((candidate) => candidate.candidateId) ?? [],
        selected: selection?.selectedCandidateId ?? null,
        reviewer: selection?.reviewer ?? null,
        selectedAt: selection?.selectedAt ?? null,
      };
    }),
  );

  const report = {
    runDirectory,
    briefId: state.brief.briefId,
    currentStage: stage,
    stages,
    scorecardSubmitted: (await readScorecardRaw(runDirectory)) !== undefined,
    paidProviderCalls: 0,
    notice: FINISHING_RUN_NOTICE,
    measurementNotice: FINISHING_MEASUREMENT_NOTICE,
  };

  if (options.json) {
    context.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    context.stderr(
      [
        '',
        `brief:   ${report.briefId}`,
        `at:      ${report.currentStage}`,
        ...stages.map(
          (entry) =>
            `  ${entry.stage.padEnd(7)} ${entry.compared ? `${entry.candidates.length} candidates` : 'not proposed'}${
              entry.selected ? ` → ${entry.selected} (${entry.reviewer ?? 'unknown'})` : ''
            }`,
        ),
        '',
      ].join('\n'),
    );
  }
  return FINISHING_EXIT_CODES.SUCCESS;
}

async function readFeedback(path: string | undefined): Promise<readonly TimestampedDefect[]> {
  if (!path) return [];
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry, index) => {
    const result = TimestampedDefectSchema.safeParse(entry);
    if (!result.success) {
      throw new FinishingContractError(
        `carried-forward note ${index} in ${path} was refused:\n  - ${result.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('\n  - ')}`,
      );
    }
    return result.data;
  });
}

async function runSelect(
  options: FinishingCliOptions,
  context: FinishingCliContext,
  root: string,
): Promise<number> {
  const runDirectory = absolute(root, required(options, 'runDirectory', '--run'));
  const candidateId = required(options, 'candidateId', '--candidate');
  const reviewer = required(options, 'reviewer', '--reviewer');
  const reasonPath = absolute(root, required(options, 'reasonPath', '--reason'));

  const state = await readFinishingRunState(runDirectory);
  const stage = currentStage(state);
  if (stage === 'FINAL') {
    context.stderr('Every stage in this run is already settled.\n');
    return FINISHING_EXIT_CODES.STAGE_OUT_OF_ORDER;
  }

  const reason = (await readFile(reasonPath, 'utf8')).trim();
  const selection = await buildStageSelection({
    state,
    stage,
    candidateId,
    reviewer,
    reason,
    feedback: await readFeedback(
      options.feedbackPath ? absolute(root, options.feedbackPath) : undefined,
    ),
    selectedAt: (context.now ? context.now() : new Date()).toISOString(),
  });

  await writeStageSelection(runDirectory, selection);
  const next = currentStage(await readFinishingRunState(runDirectory));

  if (options.json) {
    context.stdout(`${JSON.stringify({ ...selection, nextStage: next }, null, 2)}\n`);
  } else {
    context.stderr(
      `\n${stage}: "${candidateId}" selected by ${reviewer}, pinned at ${selection.selectedPlanSha256.slice(0, 16)}….\nnext: ${next}\n\n`,
    );
  }
  return FINISHING_EXIT_CODES.SUCCESS;
}

/** The finished master and its checksum, read from the last stage's comparison. */
async function readFinishedMaster(
  state: FinishingRunState,
): Promise<{ readonly entry: Awaited<ReturnType<typeof readStageComparison>>['entries'][number] }> {
  const last = REVISION_STAGES[REVISION_STAGES.length - 1] as RevisionStage;
  const selection = state.selections[last];
  if (!selection) {
    throw new FinishingGateError(
      `the ${last} stage has no recorded selection, so there is no finished master.`,
      FINISHING_EXIT_CODES.HUMAN_SELECTION_REQUIRED,
    );
  }
  const comparison = await readStageComparison(state.runDirectory, last);
  const entry = comparison.entries.find(
    (candidate) => candidate.candidateId === selection.selectedCandidateId,
  );
  if (!entry || !entry.outputChecksumSha256) {
    throw new FinishingGateError(
      `the approved ${last} candidate has no measured master recorded, so there is nothing to score.`,
      FINISHING_EXIT_CODES.CANDIDATE_STALE_OR_UNKNOWN,
    );
  }
  return { entry };
}

async function runScorecardTemplate(
  options: FinishingCliOptions,
  context: FinishingCliContext,
  root: string,
): Promise<number> {
  const runDirectory = absolute(root, required(options, 'runDirectory', '--run'));
  const outPath = absolute(root, required(options, 'outPath', '--out'));
  const state = await readFinishingRunState(runDirectory);
  await requireFinishedPlan(state);
  const { entry } = await readFinishedMaster(state);

  await writeJsonFile(
    outPath,
    buildScorecardTemplate(
      state.brief,
      entry.outputChecksumSha256 as string,
      (context.now ? context.now() : new Date()).toISOString(),
    ),
  );
  context.stderr(
    `Wrote an empty premium scorecard to ${outPath}.\n${FINISHING_MEASUREMENT_NOTICE}\n`,
  );
  return FINISHING_EXIT_CODES.SUCCESS;
}

async function runFinalize(
  options: FinishingCliOptions,
  context: FinishingCliContext,
  root: string,
): Promise<number> {
  const runDirectory = absolute(root, required(options, 'runDirectory', '--run'));
  const scorecardPath = absolute(root, required(options, 'scorecardPath', '--scorecard'));

  const state = await readFinishingRunState(runDirectory);
  const finished = await requireFinishedPlan(state);
  const { entry } = await readFinishedMaster(state);

  const scorecard = parsePremiumScorecard(
    JSON.parse(await readFile(scorecardPath, 'utf8')),
    scorecardPath,
  );
  await writeScorecard(runDirectory, scorecard);

  const verdict = evaluateFinishingVerdict({
    brief: state.brief,
    scorecard,
    master: {
      ...(entry.qaVerdict ? { qaVerdict: entry.qaVerdict } : {}),
      measuredDurationSeconds: entry.measuredDurationSeconds,
      measuredLoudnessLufs: entry.measuredLoudnessLufs,
    },
    masterSha256: entry.outputChecksumSha256 as string,
  });

  await writeVerdict(runDirectory, verdict);
  await writeProvenance(runDirectory, {
    runId: state.manifest.runId,
    briefId: state.brief.briefId,
    briefSha256: state.manifest.briefSha256,
    openingPlanSha256: state.manifest.openingPlanSha256,
    finishedPlanSha256: finished.planSha256,
    masterSha256: entry.outputChecksumSha256,
    masterPath: entry.outputPath,
    stages: REVISION_STAGES.map((stage) => {
      const selection = state.selections[stage];
      return {
        stage,
        primaryAxis: STAGE_AXIS_POLICY[stage].primaryAxis,
        selectedCandidateId: selection?.selectedCandidateId ?? null,
        selectedPlanSha256: selection?.selectedPlanSha256 ?? null,
        reviewer: selection?.reviewer ?? null,
        selectedAt: selection?.selectedAt ?? null,
      };
    }),
    verdict: verdict.verdict,
    scorecardReviewer: scorecard.reviewer,
    paidProviderCalls: 0,
    isRealCampaignRun: false,
    requiresHumanApproval: true,
    agencyGradeClaim: 'NOT_ASSESSED',
    notice: FINISHING_RUN_NOTICE,
    measurementNotice: FINISHING_MEASUREMENT_NOTICE,
  });

  if (options.json) {
    context.stdout(`${JSON.stringify(verdict, null, 2)}\n`);
  } else {
    context.stderr(
      [
        '',
        `verdict: ${verdict.verdict}`,
        ...verdict.blockers.map((blocker) => `  - ${blocker}`),
        '',
        FINISHING_MEASUREMENT_NOTICE,
        '',
      ].join('\n'),
    );
  }
  return verdict.verdict === 'PREMIUM_READY'
    ? FINISHING_EXIT_CODES.SUCCESS
    : FINISHING_EXIT_CODES.NOT_PREMIUM_READY;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export async function runFinishingCli(
  argv: readonly string[],
  context: FinishingCliContext,
): Promise<number> {
  let options: FinishingCliOptions;
  try {
    options = parseFinishingCliArguments(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return FINISHING_EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }

  const root = await findRepositoryRoot(context.cwd);

  try {
    switch (options.command) {
      case 'brief':
        return await runBriefTemplate(options, context, root);
      case 'open':
        return await runOpen(options, context, root);
      case 'directives':
        return await runDirectivesTemplate(options, context, root);
      case 'propose':
        return await runPropose(options, context, root);
      case 'inspect':
        return await runInspect(options, context, root);
      case 'select':
        return await runSelect(options, context, root);
      case 'scorecard':
        return await runScorecardTemplate(options, context, root);
      case 'finalize':
        return await runFinalize(options, context, root);
      default: {
        const unreachable: never = options.command;
        throw new Error(`unhandled command ${String(unreachable)}`);
      }
    }
  } catch (error) {
    return reportFailure(error, context);
  }
}

function reportFailure(error: unknown, context: FinishingCliContext): FinishingExitCode {
  if (error instanceof FinishingGateError) {
    context.stderr(`${error.message}\n`);
    return error.exitCode;
  }
  if (error instanceof PlanEditError) {
    context.stderr(`${error.message}\n`);
    return FINISHING_EXIT_CODES.DIRECTIVES_REFUSED;
  }
  if (error instanceof FinishingContractError) {
    context.stderr(`${error.message}\n`);
    return FINISHING_EXIT_CODES.BRIEF_REFUSED;
  }
  if (error instanceof CampaignRequestValidationError) {
    context.stderr(`${error.message}\n`);
    return FINISHING_EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
  }
  context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  return FINISHING_EXIT_CODES.INVALID_CAMPAIGN_REQUEST;
}
