import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseHumanPlan } from '../preview/human-plan';
import { runFinishingCli, type FinishingCliContext } from './finishing-cli';
import { FINISHING_EXIT_CODES, sha256OfJson } from './finishing-contracts';

/**
 * The gate, without a frame being encoded.
 *
 * Every refusal here is one that must happen before FFmpeg is involved — a
 * stage taken out of order, a selection with nothing to select from, a
 * candidate nobody watched, an artefact rewritten after a reviewer read it.
 * That they cost nothing to discover is the point: a gate that only fires
 * after a twelve-render round is a gate people learn to route around.
 *
 * Runs with `REASONING_PROVIDER=claude` and no API key, which a campaign run
 * refuses outright. Nothing on this path constructs a provider, so it works.
 */

const EXAMPLES = resolve(__dirname, '..', '..', 'examples');
const REPOSITORY_ROOT = resolve(__dirname, '..', '..', '..', '..');
const REQUEST = join(EXAMPLES, 'combat-reviews-preview.request.json');
const PLAN = join(EXAMPLES, 'combat-reviews-preview.plan.json');

const HOSTILE_ENV = {
  NODE_ENV: 'development',
  REASONING_PROVIDER: 'claude',
} as const;

describe('the finishing gate refuses before anything is rendered', () => {
  let workspace: string;
  let runDirectory: string;
  let briefPath: string;
  let openingPlanSha256: string;
  let stderr = '';

  const context = (): FinishingCliContext => ({
    cwd: REPOSITORY_ROOT,
    env: HOSTILE_ENV,
    stdout: () => undefined,
    stderr: (text) => {
      stderr += text;
    },
    now: () => new Date('2026-07-28T10:00:00.000Z'),
  });

  const run = async (argv: readonly string[]): Promise<number> => {
    stderr = '';
    return runFinishingCli(argv, context());
  };

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'aamp-finishing-gate-'));

    // A stand-in master. Nothing here decodes it: `open` proves the critique is
    // pinned to specific bytes, and these are specific bytes.
    const masterPath = join(workspace, 'master.mp4');
    await writeFile(masterPath, 'not a real encode, but exactly these bytes', 'utf8');
    const masterSha256 = createHash('sha256')
      .update(await readFile(masterPath))
      .digest('hex');

    const plan = parseHumanPlan(JSON.parse(await readFile(PLAN, 'utf8')));
    openingPlanSha256 = sha256OfJson(plan);

    briefPath = join(workspace, 'brief.json');
    await writeFile(
      briefPath,
      JSON.stringify({
        briefVersion: 1,
        briefId: 'gate-round',
        workspaceId: plan.workspaceId,
        campaignId: plan.campaignId,
        sourceMasterPath: masterPath,
        sourceMasterSha256: masterSha256,
        sourcePlanPath: PLAN,
        sourcePlanSha256: openingPlanSha256,
        reviewer: { name: 'A Reviewer', role: 'Creative director' },
        reviewedAt: '2026-07-28T09:00:00.000Z',
        defects: [
          {
            id: 'd1',
            startSeconds: 0,
            endSeconds: 1.2,
            category: 'FIRST_FRAME',
            observed:
              'The opening frame holds a wide of the room for most of a second before anything moves.',
            requiredCorrection: 'Start on movement; cut the dead frames at the head.',
            severity: 'MAJOR',
          },
        ],
        protectedStrengths: [],
        selectedCreativeDirection:
          'Keep the documentary feel and the specific count, but get to the movement faster.',
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

    const code = await run([
      'open',
      '--request',
      REQUEST,
      '--plan',
      PLAN,
      '--brief',
      briefPath,
      '--output-dir',
      workspace,
    ]);
    expect(code).toBe(FINISHING_EXIT_CODES.SUCCESS);
    const entries = (await readdir(workspace, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    runDirectory = join(workspace, entries[0] ?? '');
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });

  const directiveFile = async (
    name: string,
    stage: string,
    basePlanSha256: string,
    operations: readonly unknown[],
  ): Promise<string> => {
    const path = join(workspace, name);
    await writeFile(
      path,
      JSON.stringify({
        directiveVersion: 1,
        stage,
        authoredBy: 'A Reviewer',
        authoredAt: '2026-07-28T09:05:00.000Z',
        basePlanSha256,
        candidates: [
          {
            candidateId: 'faster-open',
            label: 'Faster open',
            rationale: 'Get to the movement sooner, per the note on the first second.',
            addressesDefectIds: ['d1'],
            operations,
          },
        ],
      }),
      'utf8',
    );
    return path;
  };

  it('refuses a stage taken out of order, and says which one is open', async () => {
    const path = await directiveFile('pacing-first.json', 'PACING', openingPlanSha256, [
      {
        kind: 'RETIME_BEAT',
        beatId: 'hook-count',
        durationSeconds: 2.8,
        compensateWithBeatId: 'discussion-screen',
      },
    ]);
    const code = await run(['propose', '--run', runDirectory, '--directives', path]);
    expect(code).toBe(FINISHING_EXIT_CODES.STAGE_OUT_OF_ORDER);
    expect(stderr).toContain('HOOK');
    expect(stderr).toMatch(/variable against a variable/);
  });

  it('refuses directives written against a plan this stage does not vary from', async () => {
    const path = await directiveFile('stale.json', 'HOOK', 'f'.repeat(64), [
      { kind: 'SET_HOOK_LATENCY', latencySeconds: 0 },
    ]);
    const code = await run(['propose', '--run', runDirectory, '--directives', path]);
    expect(code).toBe(FINISHING_EXIT_CODES.DIRECTIVES_REFUSED);
    expect(stderr).toMatch(/their author never saw/);
  });

  it('refuses a selection when the stage has no comparison to choose from', async () => {
    const reasonPath = join(workspace, 'reason.txt');
    await writeFile(reasonPath, 'It lands the count before the viewer decides to scroll.', 'utf8');
    const code = await run([
      'select',
      '--run',
      runDirectory,
      '--candidate',
      'faster-open',
      '--reviewer',
      'A Reviewer',
      '--reason',
      reasonPath,
    ]);
    expect(code).toBe(FINISHING_EXIT_CODES.STAGE_OUT_OF_ORDER);
    expect(stderr).toMatch(/no comparison yet/);
  });

  describe('once a stage has been proposed without rendering', () => {
    beforeAll(async () => {
      const path = await directiveFile('hook.json', 'HOOK', openingPlanSha256, [
        { kind: 'SET_HOOK_LATENCY', latencySeconds: 0 },
      ]);
      const code = await run([
        'propose',
        '--run',
        runDirectory,
        '--directives',
        path,
        '--skip-render',
      ]);
      expect(code).toBe(FINISHING_EXIT_CODES.SUCCESS);
    });

    it('adds the unchanged control alongside the authored candidate', async () => {
      const comparison = JSON.parse(
        await readFile(join(runDirectory, 'stages', 'HOOK', 'comparison.json'), 'utf8'),
      ) as { entries: { candidateId: string; planSha256: string }[] };
      const ids = comparison.entries.map((entry) => entry.candidateId);
      expect(ids).toContain('control');
      expect(ids).toContain('faster-open');
      const control = comparison.entries.find((entry) => entry.candidateId === 'control');
      expect(control?.planSha256).toBe(openingPlanSha256);
    });

    it('refuses a candidate nobody could have watched', async () => {
      const reasonPath = join(workspace, 'reason.txt');
      await writeFile(
        reasonPath,
        'It lands the count before the viewer decides to scroll.',
        'utf8',
      );
      const code = await run([
        'select',
        '--run',
        runDirectory,
        '--candidate',
        'faster-open',
        '--reviewer',
        'A Reviewer',
        '--reason',
        reasonPath,
      ]);
      expect(code).toBe(FINISHING_EXIT_CODES.CANDIDATE_STALE_OR_UNKNOWN);
      expect(stderr).toMatch(/never produced a master/);
    });

    it('refuses a candidate the comparison does not offer, and lists what it does', async () => {
      const reasonPath = join(workspace, 'reason.txt');
      await writeFile(
        reasonPath,
        'It lands the count before the viewer decides to scroll.',
        'utf8',
      );
      const code = await run([
        'select',
        '--run',
        runDirectory,
        '--candidate',
        'a-candidate-nobody-made',
        '--reviewer',
        'A Reviewer',
        '--reason',
        reasonPath,
      ]);
      expect(code).toBe(FINISHING_EXIT_CODES.CANDIDATE_STALE_OR_UNKNOWN);
      expect(stderr).toContain('control');
      expect(stderr).toContain('faster-open');
    });

    it('writes a candidate plan once: a changed one is refused, an identical one is not', async () => {
      const { writeCandidate, readCandidate } = await import('./finishing-store');
      const candidate = await readCandidate(runDirectory, 'HOOK', 'faster-open');
      const plan = parseHumanPlan(
        JSON.parse(
          await readFile(
            join(runDirectory, 'stages', 'HOOK', 'candidates', 'faster-open', 'plan.json'),
            'utf8',
          ),
        ),
      );
      // Re-running the same proposal is expected and harmless.
      await expect(writeCandidate(runDirectory, candidate, plan)).resolves.toBeDefined();
      // Rewriting the record with different content is not.
      await expect(
        writeCandidate(runDirectory, { ...candidate, label: 'A different label entirely' }, plan),
      ).rejects.toThrow(/written once/i);
    });

    it('refuses a run whose approved bytes were changed after the fact', async () => {
      const { readFinishingRunState, loadApprovedPlan } = await import('./finishing-gate');
      const state = await readFinishingRunState(runDirectory);
      await expect(
        loadApprovedPlan(state, 'HOOK', {
          stage: 'HOOK',
          selectedCandidateId: 'faster-open',
          selectedPlanSha256: 'e'.repeat(64),
          reviewer: 'A Reviewer',
          selectedAt: '2026-07-28T10:30:00.000Z',
          reason: 'It lands the count before the viewer decides to scroll away.',
          feedback: [],
        }),
      ).rejects.toThrow(/changed after the decision/);
    });

    it('refuses to finish a run with stages still open', async () => {
      const scorecardPath = join(workspace, 'scorecard.json');
      await writeFile(scorecardPath, '{}', 'utf8');
      const code = await run(['finalize', '--run', runDirectory, '--scorecard', scorecardPath]);
      expect(code).toBe(FINISHING_EXIT_CODES.HUMAN_SELECTION_REQUIRED);
      expect(stderr).toMatch(/no recorded human selection/);
    });

    it('reports the run without deciding anything', async () => {
      let json = '';
      const code = await runFinishingCli(['inspect', '--run', runDirectory, '--json'], {
        ...context(),
        stdout: (text) => {
          json += text;
        },
      });
      expect(code).toBe(FINISHING_EXIT_CODES.SUCCESS);
      const report = JSON.parse(json) as {
        currentStage: string;
        paidProviderCalls: number;
        stages: { stage: string; compared: boolean; selected: string | null }[];
      };
      expect(report.currentStage).toBe('HOOK');
      expect(report.paidProviderCalls).toBe(0);
      expect(report.stages.find((stage) => stage.stage === 'HOOK')?.compared).toBe(true);
      expect(report.stages.every((stage) => stage.selected === null)).toBe(true);
    });
  });
});
