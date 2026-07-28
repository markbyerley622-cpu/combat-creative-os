import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { probeMedia, NodeCommandRunner, resolveFfmpegBinaries } from '@combat/media';

import { parseHumanPlan, type HumanCreativePlan } from '../preview/human-plan';
import { runFinishingCli, type FinishingCliContext } from './finishing-cli';
import { FINISHING_EXIT_CODES, REVISION_STAGES, sha256OfJson } from './finishing-contracts';
import { CRAFT_DIMENSIONS } from './finishing-scorecard';

/**
 * The premium creative finishing workflow, end to end, against real FFmpeg.
 *
 * What this proves: a reviewer's timestamped critique opens a run; each of the
 * four stages produces a control plus the alternatives they authored; every
 * candidate is a genuinely rendered, measured master; a named person selects
 * one per stage; the last selection is the finished cut; and `PREMIUM_READY`
 * arrives only with a submitted human scorecard on top of a passing QA.
 *
 * What it does not prove: that any of it is good. Every craft judgement in
 * this test is a number a fixture reviewer wrote, and the whole point of the
 * scorecard is that no code — including this test — can produce one.
 *
 * The environment is hostile on purpose: `REASONING_PROVIDER=claude` with no
 * API key, where a campaign run exits 3. A finishing round constructs no
 * provider at all, so it works.
 */

const EXAMPLES = resolve(__dirname, '..', '..', 'examples');
const REPOSITORY_ROOT = resolve(__dirname, '..', '..', '..', '..');
const REQUEST = join(EXAMPLES, 'combat-reviews-preview.request.json');
const PLAN = join(EXAMPLES, 'combat-reviews-preview.plan.json');
const ASSET_ROOT = resolve(REPOSITORY_ROOT, 'packages', 'media', 'fixtures', 'preview-asset-root');

const binaries = resolveFfmpegBinaries(process.env);

function available(): boolean {
  if (spawnSync(binaries.ffprobe, ['-version'], { timeout: 15_000 }).status !== 0) return false;
  return (
    spawnSync(process.execPath, [
      '-e',
      `require('fs').statSync(${JSON.stringify(join(ASSET_ROOT, 'combat-clips', 'gym-session.mp4'))})`,
    ]).status === 0
  );
}

const runnable = available();
const suite = runnable ? describe : describe.skip;

if (!runnable) {
  // eslint-disable-next-line no-console -- a silently skipped acceptance test is worse than a noisy one
  console.warn(
    `[finishing-acceptance] SKIPPED: needs a runnable ffprobe at "${binaries.ffprobe}" and the generated preview asset root at ${ASSET_ROOT}. Run "pnpm aamp:fixtures".`,
  );
}

const HOSTILE_ENV = {
  NODE_ENV: 'development',
  REASONING_PROVIDER: 'claude',
  VIDEO_GENERATION_PROVIDER: 'comfyui',
  ...(process.env.FFMPEG_PATH ? { FFMPEG_PATH: process.env.FFMPEG_PATH } : {}),
  ...(process.env.FFPROBE_PATH ? { FFPROBE_PATH: process.env.FFPROBE_PATH } : {}),
} as const;

/**
 * One authored alternative per stage.
 *
 * A reviewer wrote these, in the sense that matters here: they are data in a
 * test, not behaviour in the module. The PACING candidate deliberately reaches
 * for two of the new finishing decorations, so the round proves they survive
 * all the way into a rendered, QA-passing file.
 */
const STAGE_OPERATIONS: Readonly<Record<string, readonly unknown[]>> = {
  HOOK: [{ kind: 'SET_HOOK_LATENCY', latencySeconds: 0 }],
  PACING: [
    {
      kind: 'RETIME_BEAT',
      beatId: 'hook-count',
      durationSeconds: 2.8,
      compensateWithBeatId: 'discussion-screen',
    },
    {
      kind: 'ADD_DECORATION',
      beatId: 'prediction-screen',
      treatment: 'FOCUS_DIM',
      colour: 'PRIMARY',
      opacity: 0.55,
      xPx: 120,
      yPx: 620,
      widthPx: 840,
      heightPx: 700,
      thicknessPx: 6,
    },
    {
      kind: 'ADD_DECORATION',
      beatId: 'prediction-screen',
      treatment: 'LIGHT_SWEEP',
      colour: 'ACCENT',
      opacity: 0.28,
      xPx: 120,
      yPx: 620,
      widthPx: 840,
      heightPx: 700,
      thicknessPx: 4,
    },
  ],
  AUDIO: [{ kind: 'SET_MIX', musicGainDb: -11 }],
  CTA: [{ kind: 'SET_CTA_TIMING', holdSeconds: 2.6, entrance: 'FADE_HOLD' }],
};

const STAGE_LABELS: Readonly<Record<string, string>> = {
  HOOK: 'Straight in on the count',
  PACING: 'Longer look at the prediction screen',
  AUDIO: 'Bed two decibels back',
  CTA: 'Longer settled hold',
};

suite('premium creative finishing, end to end', () => {
  let workspace: string;
  let runDirectory: string;
  let plan: HumanCreativePlan;
  let stderr = '';
  let finalizeExit = -1;

  const context = (): FinishingCliContext => ({
    cwd: REPOSITORY_ROOT,
    env: HOSTILE_ENV,
    // The verdict is read from the artefact on disk, not from what was printed.
    stdout: () => undefined,
    stderr: (text) => {
      stderr += text;
    },
    runner: new NodeCommandRunner(),
  });

  const run = async (argv: readonly string[]): Promise<number> => {
    stderr = '';
    return runFinishingCli(argv, context());
  };

  const artefact = async <T>(...parts: string[]): Promise<T> =>
    JSON.parse(await readFile(join(runDirectory, ...parts), 'utf8')) as T;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'aamp-finishing-'));
    plan = parseHumanPlan(JSON.parse(await readFile(PLAN, 'utf8')));

    // A stand-in for the master under review. Nothing here decodes it: what
    // `open` proves is that the critique is pinned to specific bytes, and these
    // are specific bytes. The masters that get judged are the ones the four
    // stages actually render.
    const masterPath = join(workspace, 'master.mp4');
    await writeFile(masterPath, 'the master under review, pinned by these bytes', 'utf8');
    const masterSha256 = createHash('sha256')
      .update(await readFile(masterPath))
      .digest('hex');

    const briefPath = join(workspace, 'brief.json');
    await writeFile(
      briefPath,
      JSON.stringify({
        briefVersion: 1,
        briefId: 'finishing-round-1',
        workspaceId: plan.workspaceId,
        campaignId: plan.campaignId,
        sourceMasterPath: masterPath,
        sourceMasterSha256: masterSha256,
        sourcePlanPath: PLAN,
        sourcePlanSha256: sha256OfJson(plan),
        reviewer: { name: 'A Reviewer', role: 'Creative director' },
        reviewedAt: '2026-07-28T09:00:00.000Z',
        defects: [
          {
            id: 'slow-open',
            startSeconds: 0,
            endSeconds: 1.2,
            category: 'FIRST_FRAME',
            observed:
              'The opening holds a wide of the room for half a second before the count appears.',
            requiredCorrection: 'Land the count immediately; remove the wait at the head.',
            severity: 'BLOCKING',
          },
          {
            id: 'screen-unreadable',
            startSeconds: 7,
            endSeconds: 10,
            category: 'PRODUCT_COMPREHENSION',
            observed:
              'The prediction screen is on for three seconds and the eye has nowhere to land on it.',
            requiredCorrection: 'Direct attention to one region of the screen and hold it.',
            severity: 'MAJOR',
          },
        ],
        protectedStrengths: [
          {
            id: 'walkout',
            startSeconds: 3,
            endSeconds: 6.6,
            description: 'The walkout shot carries the whole middle and must not be shortened.',
          },
        ],
        selectedCreativeDirection:
          'Keep the documentary texture and the specific count. Get to the movement immediately, give the product screen somewhere for the eye to land, and let the end card settle rather than snap.',
        approvedFootageAssetIds: ['clip-gym-session', 'clip-ring-walk'],
        approvedUiAssetIds: ['screen-predictions', 'screen-scorecards'],
        prohibitions: { assets: [], brands: [], claims: [], implications: [] },
        platform: 'TIKTOK',
        durationSeconds: plan.targetDurationSeconds,
        cta: { headline: plan.cta.headline, subline: plan.cta.subline ?? 'n/a' },
        thresholds: { gatedDimensionMinimum: 8, overallHumanMinimum: 8 },
      }),
      'utf8',
    );

    expect(
      await run([
        'open',
        '--request',
        REQUEST,
        '--plan',
        PLAN,
        '--brief',
        briefPath,
        '--assets',
        ASSET_ROOT,
        '--output-dir',
        workspace,
      ]),
    ).toBe(FINISHING_EXIT_CODES.SUCCESS);

    const entries = (await readdir(workspace, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    runDirectory = join(workspace, entries[0] ?? '');

    // Four rounds, in the fixed order, each ending with a recorded decision.
    for (const stage of REVISION_STAGES) {
      const manifest = await artefact<{ openingPlanSha256: string }>('finishing-run.json');
      const previousIndex = REVISION_STAGES.indexOf(stage) - 1;
      const basePlanSha256 =
        previousIndex < 0
          ? manifest.openingPlanSha256
          : (
              await artefact<{ selectedPlanSha256: string }>(
                'stages',
                REVISION_STAGES[previousIndex] as string,
                'selection.json',
              )
            ).selectedPlanSha256;

      const directivesPath = join(workspace, `${stage}.directives.json`);
      await writeFile(
        directivesPath,
        JSON.stringify({
          directiveVersion: 1,
          stage,
          authoredBy: 'A Reviewer',
          authoredAt: '2026-07-28T09:05:00.000Z',
          basePlanSha256,
          candidates: [
            {
              candidateId: 'reviewers-alternative',
              label: STAGE_LABELS[stage] as string,
              rationale:
                'The alternative the reviewer asked for at this stage, expressed as structural operations on the approved plan.',
              addressesDefectIds: [],
              operations: STAGE_OPERATIONS[stage] as readonly unknown[],
            },
          ],
        }),
        'utf8',
      );

      expect(
        await run(['propose', '--run', runDirectory, '--directives', directivesPath]),
        `proposing ${stage}: ${stderr}`,
      ).toBe(FINISHING_EXIT_CODES.SUCCESS);

      const reasonPath = join(workspace, `${stage}.reason.txt`);
      await writeFile(
        reasonPath,
        'Watched both. This one answers the note without losing the walkout, so it is the one to build on.',
        'utf8',
      );
      expect(
        await run([
          'select',
          '--run',
          runDirectory,
          '--candidate',
          'reviewers-alternative',
          '--reviewer',
          'A Reviewer',
          '--reason',
          reasonPath,
        ]),
        `selecting ${stage}: ${stderr}`,
      ).toBe(FINISHING_EXIT_CODES.SUCCESS);
    }

    // The reviewer's scorecard. Written by a person, in this case a fixture one.
    const scorecardPath = join(workspace, 'scorecard.json');
    expect(await run(['scorecard', '--run', runDirectory, '--out', scorecardPath])).toBe(
      FINISHING_EXIT_CODES.SUCCESS,
    );
    const template = JSON.parse(await readFile(scorecardPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      scorecardPath,
      JSON.stringify({
        ...template,
        reviewer: 'A Reviewer',
        scores: CRAFT_DIMENSIONS.map((dimension) => ({
          dimension,
          score: 9,
          note: 'Watched at delivery size on a phone; this is what the finished file actually does here.',
        })),
        overallScore: 9,
        resolvedDefectIds: ['slow-open', 'screen-unreadable'],
        remainingConcerns: [],
      }),
      'utf8',
    );

    finalizeExit = await run([
      'finalize',
      '--run',
      runDirectory,
      '--scorecard',
      scorecardPath,
      '--json',
    ]);
  }, 1_800_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });

  it('settles all four stages in order, each on a recorded human decision', async () => {
    for (const stage of REVISION_STAGES) {
      const selection = await artefact<{
        selectedCandidateId: string;
        reviewer: string;
        reason: string;
        selectedPlanSha256: string;
      }>('stages', stage, 'selection.json');
      expect(selection.selectedCandidateId).toBe('reviewers-alternative');
      expect(selection.reviewer).toBe('A Reviewer');
      expect(selection.reason.length).toBeGreaterThan(20);
      expect(selection.selectedPlanSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('offers the unchanged control against every alternative, and renders both', async () => {
    for (const stage of REVISION_STAGES) {
      const comparison = await artefact<{
        entries: { candidateId: string; rendered: boolean; qaVerdict: string | null }[];
      }>('stages', stage, 'comparison.json');
      expect(comparison.entries.map((entry) => entry.candidateId)).toEqual([
        'control',
        'reviewers-alternative',
      ]);
      for (const entry of comparison.entries) {
        expect(entry.rendered, `${stage}/${entry.candidateId} produced no master`).toBe(true);
        expect(entry.qaVerdict).toBe('PASS');
      }
    }
  });

  it('carries each stage’s approved plan forward as the next stage’s base', async () => {
    for (let index = 1; index < REVISION_STAGES.length; index += 1) {
      const previous = await artefact<{ selectedPlanSha256: string }>(
        'stages',
        REVISION_STAGES[index - 1] as string,
        'selection.json',
      );
      const comparison = await artefact<{ basePlanSha256: string }>(
        'stages',
        REVISION_STAGES[index] as string,
        'comparison.json',
      );
      expect(comparison.basePlanSha256).toBe(previous.selectedPlanSha256);
    }
  });

  it('produces a genuine 1080×1920 master at the requested duration', async () => {
    const comparison = await artefact<{
      entries: { candidateId: string; outputPath: string | null }[];
    }>('stages', 'CTA', 'comparison.json');
    const winner = comparison.entries.find(
      (entry) => entry.candidateId === 'reviewers-alternative',
    );
    expect(winner?.outputPath).toBeTruthy();

    const probe = await probeMedia(
      new NodeCommandRunner(),
      join(runDirectory, winner?.outputPath ?? ''),
      { ffprobePath: binaries.ffprobe },
    );
    expect(probe.mediaType).toBe('VIDEO');
    if (probe.mediaType !== 'VIDEO') return;
    expect(probe.widthPx).toBe(1080);
    expect(probe.heightPx).toBe(1920);
    expect(probe.durationSeconds).toBeCloseTo(plan.targetDurationSeconds, 1);
  });

  it('carries the new finishing decorations into the rendered cut', async () => {
    // The PACING alternative asked for FOCUS_DIM and LIGHT_SWEEP; the approved
    // plan for the final stage must still carry them, and the render that
    // produced the master went through the same catalogue.
    const finalPlan = await artefact<HumanCreativePlan>(
      'stages',
      'CTA',
      'candidates',
      'reviewers-alternative',
      'plan.json',
    );
    const decorations = finalPlan.beats.flatMap((beat) => beat.decorations.map((one) => one.key));
    expect(decorations).toContain('FOCUS_DIM');
    expect(decorations).toContain('LIGHT_SWEEP');
  });

  it('reaches PREMIUM_READY only with the human scorecard, and says what it rests on', async () => {
    expect(finalizeExit, stderr).toBe(FINISHING_EXIT_CODES.SUCCESS);
    const verdict = await artefact<{
      verdict: string;
      blockers: string[];
      human: { reviewer: string; ungatedAssessment: string };
      measured: { qaVerdict: string };
      agencyGradeClaim: string;
      requiresHumanApproval: boolean;
      notice: string;
    }>('finishing-verdict.json');

    expect(verdict.verdict).toBe('PREMIUM_READY');
    expect(verdict.blockers).toHaveLength(0);
    expect(verdict.measured.qaVerdict).toBe('PASS');
    expect(verdict.human.reviewer).toBe('A Reviewer');
    expect(verdict.human.ungatedAssessment).toBe('HUMAN_JUDGEMENT_REQUIRED');
    // The three claims the system never makes on its own behalf.
    expect(verdict.agencyGradeClaim).toBe('NOT_ASSESSED');
    expect(verdict.requiresHumanApproval).toBe(true);
    expect(verdict.notice).toMatch(/no machine score/i);
  });

  it('records a provenance trail naming every decision and its author', async () => {
    const provenance = await artefact<{
      stages: { stage: string; selectedCandidateId: string | null; reviewer: string | null }[];
      paidProviderCalls: number;
      isRealCampaignRun: boolean;
      masterSha256: string;
      finishedPlanSha256: string;
    }>('finishing-provenance.json');

    expect(provenance.stages.map((stage) => stage.stage)).toEqual([...REVISION_STAGES]);
    for (const stage of provenance.stages) {
      expect(stage.selectedCandidateId).toBe('reviewers-alternative');
      expect(stage.reviewer).toBe('A Reviewer');
    }
    expect(provenance.paidProviderCalls).toBe(0);
    expect(provenance.isRealCampaignRun).toBe(false);
    expect(provenance.masterSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.finishedPlanSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes a comparison page that needs no server, no network and no script', async () => {
    const html = await readFile(join(runDirectory, 'stages', 'HOOK', 'comparison.html'), 'utf8');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('control');
    // It states what changed; it never says which one is better.
    expect(html).not.toMatch(/\b(recommended|best|winner|preferred)\b/i);
  });

  it('holds no absolute path in the artefacts a reviewer would share', async () => {
    const comparison = await readFile(
      join(runDirectory, 'stages', 'CTA', 'comparison.json'),
      'utf8',
    );
    expect(comparison).not.toContain(runDirectory);
    expect(comparison).not.toMatch(/[A-Za-z]:\\\\/);
  });
});
