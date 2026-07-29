import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { NodeCommandRunner, resolveFfmpegBinaries } from '@combat/media';
import {
  ltxGenerationCostCents,
  LTX_SUPPORTED_RESOLUTION,
  smallestCoveringDuration,
  assertSupportedLtxModel,
  type LtxModel,
} from '@combat/providers';

import { V2_CAMPAIGN_DIRECTORY } from '../flagship/flagship2-cli';
import {
  STORYBOARD_VIDEO_EXIT_CODES,
  StoryboardVideoError,
  type StoryboardVideoExitCode,
} from './failures';
import {
  assertFeedbackIsActionable,
  reviewIdentitySha256,
  MOTION_REVIEW_LEDGER_VERSION,
  type MotionReviewVerdict,
  type UnsignedMotionReviewDecision,
} from './motion-review-contracts';
import { describeChange } from './motion-review-gate';
import {
  buildReadinessReport,
  runMotionReview,
  type MotionReviewOutcome,
} from './motion-review-run';
import { DEFAULT_MOTION_REVIEW_DIRECTORY, MotionReviewLedger } from './motion-review-store';
import {
  resolveStoryboardVideoContext,
  type StoryboardVideoContext,
} from './source-resolution-stage';

/**
 * `pnpm aamp:motion-review` — look at the footage before anybody renders it.
 *
 * Five subcommands, and not one of them can spend money. This module imports
 * no provider factory, never reads `LTXV_API_KEY` and constructs nothing that
 * could make a request; `status` and `inspect` are pure filesystem reads and
 * FFmpeg probes, and `approve`, `reject` and `ledger` only touch a JSON Lines
 * file. That is a property of the object graph rather than a promise in the
 * help text, and a source-level test asserts it.
 *
 *   status   — what the storyboard actually has right now, scene by scene
 *   inspect  — measure every resolved moving clip and write the gallery
 *   approve  — record a named person's approval of one scene's clip
 *   reject   — record a named person's rejection, with what must change
 *   ledger   — print every decision ever recorded
 */

export interface MotionReviewCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: Date;
}

const SUBCOMMANDS = ['status', 'inspect', 'approve', 'reject', 'ledger'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

interface Options {
  storyboard?: string;
  framesDir?: string;
  footagePack?: string;
  preGeneratedClipsDir?: string;
  sceneManifest?: string;
  workPack?: string;
  campaignDirectory?: string;
  reviewDir?: string;
  model?: string;
  scene?: number;
  reviewer?: string;
  feedback?: string;
  acknowledge: string[];
  json: boolean;
  help: boolean;
}

const USAGE = `aamp:motion-review — inspect and rule on the moving footage before anything is rendered.

  status                           what each of the ten scenes actually has, and what it would cost to finish
  inspect                          measure every resolved moving clip and write the comparison gallery
  approve  --scene <n>             record an approval of the clip currently bound to that scene
  reject   --scene <n>             record a rejection, with what must change
  ledger                           print every decision ever recorded

  --storyboard <dir>               the verified ten-panel storyboard package (required)
  --frames-dir <dir>               the ten approved production keyframes (required)
  --work-pack <dir>                the pack holding asset-root/assets.json (required)

  --footage-pack <dir>             the footage acquisition pack
  --pre-generated-clips-dir <dir>  hand-animated clips (defaults to <frames-dir>/generated-clips)
  --scene-manifest <file>          the ordered scene manifest (defaults to the campaign's own)
  --campaign-dir <dir>             committed campaign source; defaults to the packaged one
  --review-dir <dir>               where decisions and artefacts live (defaults to ${DEFAULT_MOTION_REVIEW_DIRECTORY})
  --model <ltx-2-3-fast|ltx-2-3-pro>  priced for the status report only; no request is ever made
  --reviewer "<name>"              the person recording the decision (required to approve or reject)
  --feedback "<text>"              why, in your own words (required to approve or reject)
  --acknowledge <FINDING_ID>       accept an open fidelity finding by name (repeatable, approval only)
  --json                           print the machine-readable result
  --help

This command never reads LTXV_API_KEY, never constructs a generation provider
and never makes a network request. Inspection is free on purpose: it is what
you run before deciding to spend, not after.
`;

export function parseMotionReviewArgs(argv: readonly string[]): {
  subcommand: Subcommand | null;
  options: Options;
} {
  const options: Options = { acknowledge: [], json: false, help: false };
  let subcommand: Subcommand | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const value = argv[index + 1];

    if (!token.startsWith('-') && subcommand === null) {
      if (!(SUBCOMMANDS as readonly string[]).includes(token)) {
        throw new Error(
          `unknown subcommand "${token}" — expected one of ${SUBCOMMANDS.join(', ')}. Run --help.`,
        );
      }
      subcommand = token as Subcommand;
      continue;
    }

    switch (token) {
      case '--storyboard':
        options.storyboard = value;
        index += 1;
        break;
      case '--frames-dir':
        options.framesDir = value;
        index += 1;
        break;
      case '--footage-pack':
        options.footagePack = value;
        index += 1;
        break;
      case '--pre-generated-clips-dir':
        options.preGeneratedClipsDir = value;
        index += 1;
        break;
      case '--scene-manifest':
        options.sceneManifest = value;
        index += 1;
        break;
      case '--work-pack':
        options.workPack = value;
        index += 1;
        break;
      case '--campaign-dir':
        options.campaignDirectory = value;
        index += 1;
        break;
      case '--review-dir':
        options.reviewDir = value;
        index += 1;
        break;
      case '--model':
        options.model = value;
        index += 1;
        break;
      case '--scene': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
          throw new Error(`--scene takes a scene number between 1 and 10, got "${value ?? ''}"`);
        }
        options.scene = parsed;
        index += 1;
        break;
      }
      case '--reviewer':
        options.reviewer = value;
        index += 1;
        break;
      case '--feedback':
        options.feedback = value;
        index += 1;
        break;
      case '--acknowledge':
        if (!value) throw new Error('--acknowledge takes a finding id');
        options.acknowledge.push(value);
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option "${token}" — run --help.`);
    }
  }

  return { subcommand, options };
}

export async function runMotionReviewCli(
  argv: readonly string[],
  context: MotionReviewCliContext,
): Promise<StoryboardVideoExitCode> {
  let parsed: ReturnType<typeof parseMotionReviewArgs>;
  try {
    parsed = parseMotionReviewArgs(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const { subcommand, options } = parsed;
  if (options.help || subcommand === null) {
    context.stdout(USAGE);
    return options.help
      ? STORYBOARD_VIDEO_EXIT_CODES.SUCCESS
      : STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const now = context.now ?? new Date();
  const reviewDirectory = resolve(
    context.cwd,
    options.reviewDir ?? DEFAULT_MOTION_REVIEW_DIRECTORY,
  );

  if (subcommand === 'ledger') {
    return printLedger(reviewDirectory, context, options.json);
  }

  const missing = (['storyboard', 'framesDir', 'workPack'] as const).filter((key) => {
    const value = options[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  if (missing.length > 0) {
    context.stderr(
      `missing required option(s): ${missing
        .map(
          (key) =>
            ({ storyboard: '--storyboard', framesDir: '--frames-dir', workPack: '--work-pack' })[
              key
            ],
        )
        .join(', ')}\n\n${USAGE}`,
    );
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

  let model: LtxModel = 'ltx-2-3-fast';
  if (options.model) {
    try {
      model = assertSupportedLtxModel(options.model);
    } catch (error) {
      context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return STORYBOARD_VIDEO_EXIT_CODES.UNSUPPORTED_MODEL_OR_DURATION;
    }
  }

  const runner = new NodeCommandRunner();
  const binaries = resolveFfmpegBinaries(context.env);
  const scratchDirectory = await mkdtemp(join(tmpdir(), 'aamp-motion-review-'));

  try {
    const storyboardContext = await resolveStoryboardVideoContext({
      storyboardRoot: resolve(context.cwd, options.storyboard as string),
      framesDirectory: resolve(context.cwd, options.framesDir as string),
      workPackRoot: resolve(context.cwd, options.workPack as string),
      campaignDirectory: resolve(context.cwd, options.campaignDirectory ?? V2_CAMPAIGN_DIRECTORY),
      ...(options.footagePack
        ? { footagePackRoot: resolve(context.cwd, options.footagePack) }
        : {}),
      ...(options.preGeneratedClipsDir
        ? { preGeneratedClipsDirectory: resolve(context.cwd, options.preGeneratedClipsDir) }
        : {}),
      ...(options.sceneManifest
        ? { sceneManifestPath: resolve(context.cwd, options.sceneManifest) }
        : {}),
      scratchDirectory,
      regenerateScenes: new Set<number>(),
      runner,
      binaries,
      onProgress: (message) => context.stderr(`  … ${message}\n`),
    });

    const ledger = await MotionReviewLedger.open(reviewDirectory);
    const outcome = await runMotionReview({
      context: storyboardContext,
      reviewDirectory,
      ledger,
      runner,
      binaries,
      now,
      writeGallery: subcommand === 'inspect' || subcommand === 'status',
      onProgress: (message) => context.stderr(`  … ${message}\n`),
    });

    switch (subcommand) {
      case 'status':
        return printStatus({ storyboardContext, outcome, model, context, json: options.json, now });
      case 'inspect':
        return printInspection({ outcome, context, json: options.json });
      case 'approve':
      case 'reject':
        return recordDecision({
          verdict: subcommand === 'approve' ? 'APPROVED' : 'REJECTED',
          options,
          storyboardContext,
          outcome,
          ledger,
          context,
          now,
        });
      default:
        return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
    }
  } catch (error) {
    const typed =
      error instanceof StoryboardVideoError
        ? error
        : new StoryboardVideoError(
            'MOTION_REVIEW_BLOCKED',
            error instanceof Error ? error.message : String(error),
          );
    context.stderr(`\n${typed.kind}: ${typed.message}\n`);
    return typed.exitCode;
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function printStatus(input: {
  storyboardContext: StoryboardVideoContext;
  outcome: MotionReviewOutcome;
  model: LtxModel;
  context: MotionReviewCliContext;
  json: boolean;
  now: Date;
}): StoryboardVideoExitCode {
  const costByScene = new Map<number, number>();
  for (const decision of input.storyboardContext.decisions) {
    if (!decision.requiresGeneration) continue;
    const requiredSeconds =
      input.storyboardContext.requiredSecondsByScene.get(decision.sceneNumber) ?? 0;
    costByScene.set(
      decision.sceneNumber,
      ltxGenerationCostCents(
        input.model,
        LTX_SUPPORTED_RESOLUTION,
        smallestCoveringDuration(requiredSeconds),
      ),
    );
  }

  const report = buildReadinessReport({
    context: input.storyboardContext,
    gate: input.outcome.gate,
    costByScene,
    now: input.now,
  });

  if (input.json) {
    input.context.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = report.rows.map((row) => {
      const cost = row.estimatedGenerationCostCents
        ? `${String(row.estimatedGenerationCostCents).padStart(4)}¢`
        : '    —';
      return `  scene ${String(row.sceneNumber).padStart(2)}  ${row.sourceType.padEnd(30)} ${row.gateStatus.padEnd(30)} ${cost}  ${row.sourceIdentity}`;
    });
    input.context.stdout(
      [
        '',
        `storyboard readiness — ${report.storyboardId}`,
        ...lines,
        '',
        `  hand-animated (MANUAL_LTX_STUDIO):  ${format(report.manualClipScenes)}`,
        `  acquired production footage:        ${format(report.acquiredFootageScenes)}`,
        `  deterministic motion graphics:      ${format(report.deterministicGraphicsScenes)}`,
        `  still needing generation:           ${format(report.missingGenerationScenes)}`,
        `  generated by this pipeline:         ${format(report.scenesRequiringGeneration)}`,
        `  reviewed and approved:              ${format(report.reviewedAndApprovedScenes)}`,
        `  blocking the render:                ${format(report.blockingScenes)}`,
        '',
        `  remaining generation ceiling:       ${report.remainingGenerationCeilingCents}¢ at ${input.model}`,
        `  ready to render:                    ${report.readyToRender ? 'yes' : 'no'}`,
        `  paid provider calls made by this command: ${report.paidProviderCalls}`,
        '',
      ].join('\n'),
    );
  }
  return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
}

function printInspection(input: {
  outcome: MotionReviewOutcome;
  context: MotionReviewCliContext;
  json: boolean;
}): StoryboardVideoExitCode {
  if (input.json) {
    input.context.stdout(
      `${JSON.stringify(
        {
          gate: input.outcome.gate,
          galleryPath: input.outcome.galleryPath,
          scenes: input.outcome.inspections.map((inspection) => ({
            sceneNumber: inspection.sceneNumber,
            sourceType: inspection.sourceType,
            verdict: inspection.verdict,
            clipChecksumSha256: inspection.clipChecksumSha256,
            openFidelityFindings: inspection.openFidelityFindings,
            measured: inspection.measured,
            motionEnergy: inspection.motion.measuredEnergy,
            keyframeAgreement: inspection.keyframeAgreement?.measuredAgreement ?? null,
            failedChecks: inspection.checks
              .filter((check) => check.status === 'FAIL' || check.status === 'NOT_MEASURED')
              .map((check) => ({ id: check.id, status: check.status, observed: check.observed })),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
  }

  const lines = input.outcome.inspections.map((inspection) => {
    const findings = inspection.openFidelityFindings.length
      ? ` open findings: ${inspection.openFidelityFindings.join(', ')}`
      : '';
    return `  scene ${String(inspection.sceneNumber).padStart(2)}  ${inspection.verdict.padEnd(20)} motion ${String(inspection.motion.measuredEnergy ?? '—').padStart(8)}  keyframe ${String(inspection.keyframeAgreement?.measuredAgreement ?? 'n/a').padStart(7)}${findings}`;
  });

  input.context.stdout(
    [
      '',
      `inspected ${input.outcome.inspections.length} moving scene(s) — no provider, no key, no spend`,
      ...lines,
      '',
      ...input.outcome.gate.rows
        .filter((row) => row.status !== 'APPROVED')
        .map((row) => `  ! ${row.remedy}`),
      '',
      `  gallery: ${input.outcome.galleryPath ?? 'not written'}`,
      '',
    ].join('\n'),
  );
  return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
}

async function recordDecision(input: {
  verdict: MotionReviewVerdict;
  options: Options;
  storyboardContext: StoryboardVideoContext;
  outcome: MotionReviewOutcome;
  ledger: MotionReviewLedger;
  context: MotionReviewCliContext;
  now: Date;
}): Promise<StoryboardVideoExitCode> {
  const { options, context } = input;
  if (options.scene === undefined) {
    context.stderr('--scene is required to record a decision\n');
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }
  if (!options.reviewer?.trim()) {
    context.stderr(
      '--reviewer is required: a decision without a named person is not attributable, and this record exists to be attributable.\n',
    );
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }
  if (!options.feedback?.trim()) {
    context.stderr('--feedback is required: say why, in your own words.\n');
    return STORYBOARD_VIDEO_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const sceneNumber = options.scene;
  const inspection = input.outcome.inspectionsByScene.get(sceneNumber);
  const identity = input.outcome.identities.get(sceneNumber);
  if (!inspection || !identity) {
    context.stderr(
      `scene ${sceneNumber} has no inspected moving source, so there is nothing to rule on. A decision is a judgement about a file that exists.\n`,
    );
    return STORYBOARD_VIDEO_EXIT_CODES.MOTION_INSPECTION_FAILED;
  }

  assertFeedbackIsActionable(input.verdict, options.feedback, sceneNumber);

  // An approval may not be recorded while the inspection has an open fidelity
  // finding the reviewer has not named. The finding is a real disagreement
  // with the brief, and accepting one silently is how a gate becomes a
  // formality — so the reviewer states which one they are accepting.
  if (input.verdict === 'APPROVED') {
    const unacknowledged = inspection.openFidelityFindings.filter(
      (finding) => !options.acknowledge.includes(finding),
    );
    if (unacknowledged.length > 0) {
      context.stderr(
        `scene ${sceneNumber} has ${unacknowledged.length} open fidelity finding(s) this approval does not name: ${unacknowledged.join(', ')}.\n` +
          `These are real disagreements with the brief, not defects in the file: ${unacknowledged
            .map((finding) => {
              const check = inspection.checks.find((candidate) => candidate.id === finding);
              return `\n  - ${finding}: ${check?.observed ?? check?.notMeasuredReason ?? 'see the gallery'} (expected ${check?.expected ?? '—'})`;
            })
            .join('')}\n\n` +
          `Open the gallery, decide whether you accept them, and name each one you accept with --acknowledge <FINDING_ID>.\n`,
      );
      return STORYBOARD_VIDEO_EXIT_CODES.MOTION_REVIEW_BLOCKED;
    }
  }

  if (inspection.verdict !== 'TECHNICALLY_SOUND' && input.verdict === 'APPROVED') {
    context.stderr(
      `scene ${sceneNumber} is ${inspection.verdict} on binding technical checks, and no approval can clear that. Supply or regenerate the clip.\n`,
    );
    return STORYBOARD_VIDEO_EXIT_CODES.MOTION_INSPECTION_FAILED;
  }

  const identitySha256 = reviewIdentitySha256(identity);
  const superseded = input.ledger.latestAny(sceneNumber);
  const supersedes =
    superseded && superseded.identitySha256 !== identitySha256
      ? {
          supersedesDecisionId: superseded.decisionId,
          supersedesReason: describeChange(superseded.identity, identity),
        }
      : superseded
        ? {
            supersedesDecisionId: superseded.decisionId,
            supersedesReason: 'the reviewer recorded a further decision about the same clip',
          }
        : { supersedesDecisionId: null, supersedesReason: null };

  const decision: UnsignedMotionReviewDecision = {
    ledgerVersion: MOTION_REVIEW_LEDGER_VERSION,
    recordedAt: input.now.toISOString(),
    reviewer: options.reviewer.trim(),
    sceneNumber,
    verdict: input.verdict,
    feedback: options.feedback.trim(),
    identity,
    identitySha256,
    inspectionSha256: inspection.inspectionSha256,
    acknowledgedFindings: [...options.acknowledge].sort(),
    ...supersedes,
  };

  const recorded = await input.ledger.append({ decision });

  if (options.json) {
    context.stdout(`${JSON.stringify(recorded, null, 2)}\n`);
  } else {
    context.stdout(
      [
        '',
        `recorded ${recorded.verdict} for scene ${sceneNumber}`,
        `  decision:   ${recorded.decisionId}`,
        `  reviewer:   ${recorded.reviewer}`,
        `  at:         ${recorded.recordedAt}`,
        `  clip:       ${recorded.identity.clipChecksumSha256}`,
        `  identity:   ${recorded.identitySha256}`,
        ...(recorded.supersedesDecisionId
          ? [`  supersedes: ${recorded.supersedesDecisionId} (${recorded.supersedesReason ?? ''})`]
          : []),
        ...(recorded.acknowledgedFindings.length > 0
          ? [`  accepted:   ${recorded.acknowledgedFindings.join(', ')}`]
          : []),
        '',
        '  This decision applies only while the clip, the authoritative keyframe, the',
        '  generation prompt and the scene contract all stay as they are. Change any',
        '  one of them and it stops applying, because it was a judgement about what',
        '  they were.',
        '',
      ].join('\n'),
    );
  }
  return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
}

async function printLedger(
  reviewDirectory: string,
  context: MotionReviewCliContext,
  json: boolean,
): Promise<StoryboardVideoExitCode> {
  try {
    const ledger = await MotionReviewLedger.open(reviewDirectory);
    if (json) {
      context.stdout(`${JSON.stringify(ledger.all, null, 2)}\n`);
      return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
    }
    if (ledger.all.length === 0) {
      context.stdout(`no decision has ever been recorded in ${ledger.filePath}\n`);
      return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
    }
    context.stdout(
      [
        '',
        `${ledger.all.length} decision(s) in ${ledger.filePath}`,
        ...ledger.all.map(
          (decision) =>
            `  ${decision.recordedAt}  scene ${String(decision.sceneNumber).padStart(2)}  ${decision.verdict.padEnd(9)} ${decision.reviewer}\n      ${decision.feedback}`,
        ),
        '',
      ].join('\n'),
    );
    return STORYBOARD_VIDEO_EXIT_CODES.SUCCESS;
  } catch (error) {
    const typed =
      error instanceof StoryboardVideoError
        ? error
        : new StoryboardVideoError(
            'MOTION_REVIEW_BLOCKED',
            error instanceof Error ? error.message : String(error),
          );
    context.stderr(`${typed.message}\n`);
    return typed.exitCode;
  }
}

function format(scenes: readonly number[]): string {
  return scenes.length > 0 ? scenes.join(', ') : 'none';
}
