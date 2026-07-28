import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseHumanPlan, type HumanCreativePlan } from '../preview/human-plan';
import {
  CREATIVE_FINISHING_BRIEF_VERSION,
  parseCreativeFinishingBrief,
  sha256OfJson,
  type CreativeFinishingBrief,
} from './finishing-contracts';
import {
  parseStageDirectiveSet,
  STAGE_AXIS_POLICY,
  type FinishingOperation,
} from './finishing-directives';
import { applyFinishingOperations, PlanEditError } from './finishing-plan-edits';
import {
  evaluateFinishingVerdict,
  GATED_DIMENSIONS,
  CRAFT_DIMENSIONS,
  parsePremiumScorecard,
} from './finishing-scorecard';

/**
 * What the finishing workflow refuses.
 *
 * Everything here runs with no FFmpeg, no filesystem run directory and no
 * renders: these are the checks that happen *before* anything is encoded,
 * which is the only place they are worth anything. A directive that would
 * produce an invalid plan should cost nothing to discover.
 */

const EXAMPLES = resolve(__dirname, '..', '..', 'examples');

async function loadExamplePlan(): Promise<HumanCreativePlan> {
  return parseHumanPlan(
    JSON.parse(await readFile(join(EXAMPLES, 'combat-reviews-preview.plan.json'), 'utf8')),
  );
}

/** A minimal, valid critique over the example plan. Authored here, as a reviewer would. */
function briefFor(plan: HumanCreativePlan): CreativeFinishingBrief {
  return parseCreativeFinishingBrief({
    briefVersion: CREATIVE_FINISHING_BRIEF_VERSION,
    briefId: 'round-1',
    workspaceId: plan.workspaceId,
    campaignId: plan.campaignId,
    sourceMasterPath: 'master.mp4',
    sourceMasterSha256: 'a'.repeat(64),
    sourcePlanPath: 'plan.json',
    sourcePlanSha256: sha256OfJson(plan),
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
        severity: 'BLOCKING',
      },
    ],
    protectedStrengths: [],
    selectedCreativeDirection:
      'Keep the documentary feel and the specific count, but get to the movement faster and let the app screens breathe.',
    approvedFootageAssetIds: ['clip-gym-session', 'clip-ring-walk'],
    approvedUiAssetIds: ['screen-predictions', 'screen-scorecards'],
    prohibitions: { assets: [], brands: [], claims: [], implications: [] },
    platform: 'TIKTOK',
    durationSeconds: plan.targetDurationSeconds,
    cta: { headline: plan.cta.headline, subline: plan.cta.subline ?? 'n/a' },
    thresholds: { gatedDimensionMinimum: 8, overallHumanMinimum: 8 },
  });
}

function directiveSet(
  stage: 'HOOK' | 'PACING' | 'AUDIO' | 'CTA',
  basePlanSha256: string,
  operations: readonly FinishingOperation[],
): unknown {
  return {
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
        addressesDefectIds: [],
        operations,
      },
    ],
  };
}

describe('the critique refuses feedback a render cannot act on', () => {
  it('refuses a defect that reads as a feeling rather than an observation', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    expect(() =>
      parseCreativeFinishingBrief({
        ...brief,
        defects: [{ ...brief.defects[0], observed: 'make it punchier', id: 'd1' }],
      }),
    ).toThrow(/reads as a feeling/i);
  });

  it('refuses a defect with no duration, and one past the end of the cut', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    expect(() =>
      parseCreativeFinishingBrief({
        ...brief,
        defects: [{ ...brief.defects[0], startSeconds: 2, endSeconds: 2 }],
      }),
    ).toThrow(/names no moment/i);
    expect(() =>
      parseCreativeFinishingBrief({
        ...brief,
        defects: [{ ...brief.defects[0], startSeconds: 1, endSeconds: 99 }],
      }),
    ).toThrow(/past the/i);
  });

  it('refuses a brief that both approves and prohibits the same asset', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    expect(() =>
      parseCreativeFinishingBrief({
        ...brief,
        prohibitions: {
          ...brief.prohibitions,
          assets: [{ assetId: 'clip-ring-walk', reason: 'rights lapsed last week' }],
        },
      }),
    ).toThrow(/both approved and prohibited/i);
  });
});

describe('a stage compares one axis at a time', () => {
  it('refuses an operation the stage does not own', async () => {
    const plan = await loadExamplePlan();
    // Retuning the mix inside the HOOK stage: the reviewer would be choosing a
    // hook and silently getting an audio decision with it.
    expect(() =>
      parseStageDirectiveSet(
        directiveSet('HOOK', sha256OfJson(plan), [
          { kind: 'SET_HOOK_LATENCY', latencySeconds: 0 },
          { kind: 'SET_MIX', musicGainDb: -12 },
        ]),
      ),
    ).toThrow(/Settle one axis at a time/);
  });

  it('refuses a candidate that never moves the axis under comparison', async () => {
    const plan = await loadExamplePlan();
    expect(() =>
      parseStageDirectiveSet(
        directiveSet('HOOK', sha256OfJson(plan), [
          { kind: 'SET_CAPTION_ENTRANCE', beatId: 'hook-count', entrance: 'POP' },
        ]),
      ),
    ).toThrow(/never moves HOOK/);
  });

  it('reserves the control id, so the unchanged cut is always the run’s own', async () => {
    const plan = await loadExamplePlan();
    const set = directiveSet('HOOK', sha256OfJson(plan), [
      { kind: 'SET_HOOK_LATENCY', latencySeconds: 0 },
    ]) as { candidates: { candidateId: string }[] };
    set.candidates[0]!.candidateId = 'control';
    expect(() => parseStageDirectiveSet(set)).toThrow(/reserved/i);
  });

  it('gives every stage a primary axis it actually compares', () => {
    for (const [stage, policy] of Object.entries(STAGE_AXIS_POLICY)) {
      expect(policy.dependentAxes).not.toContain(policy.primaryAxis);
      expect(stage.length).toBeGreaterThan(0);
    }
  });
});

describe('applying directives refuses rather than repairs', () => {
  it('refuses a retime that does not say where the time comes from', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    expect(() =>
      applyFinishingOperations(
        plan,
        [
          {
            kind: 'RETIME_BEAT',
            beatId: 'hook-count',
            durationSeconds: 2.4,
            compensateWithBeatId: 'hook-count',
          },
        ],
        brief,
      ),
    ).toThrow(PlanEditError);
  });

  it('refuses a retime that would empty the donor beat', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    expect(() =>
      applyFinishingOperations(
        plan,
        [
          {
            kind: 'RETIME_BEAT',
            beatId: 'hook-count',
            durationSeconds: 9,
            compensateWithBeatId: 'prediction-screen',
          },
        ],
        brief,
      ),
    ).toThrow(/donor beat/i);
  });

  it('keeps the timeline landing exactly on the requested duration', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    const edited = applyFinishingOperations(
      plan,
      [
        {
          kind: 'RETIME_BEAT',
          beatId: 'hook-count',
          durationSeconds: 2.5,
          compensateWithBeatId: 'discussion-screen',
        },
      ],
      brief,
    );
    const total =
      edited.plan.beats.reduce((sum, beat) => sum + beat.durationSeconds, 0) -
      edited.plan.beats.reduce((sum, beat) => sum + (beat.transitionIn?.durationSeconds ?? 0), 0);
    expect(total).toBeCloseTo(plan.targetDurationSeconds, 6);
  });

  it('compensates a lengthened transition in the other direction', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    const edited = applyFinishingOperations(
      plan,
      [
        {
          kind: 'SET_BEAT_TRANSITION',
          beatId: 'prediction-screen',
          transitionKind: 'CROSSFADE',
          durationSeconds: 0.6,
          compensateWithBeatId: 'event-detail-walkout',
        },
      ],
      brief,
    );
    const total =
      edited.plan.beats.reduce((sum, beat) => sum + beat.durationSeconds, 0) -
      edited.plan.beats.reduce((sum, beat) => sum + (beat.transitionIn?.durationSeconds ?? 0), 0);
    expect(total).toBeCloseTo(plan.targetDurationSeconds, 6);
  });

  it('refuses footage the brief never approved', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    expect(() =>
      applyFinishingOperations(
        plan,
        [{ kind: 'SET_BEAT_SOURCE', beatId: 'hook-count', assetId: 'clip-somebody-elses' }],
        brief,
      ),
    ).toThrow(/did not approve/i);
  });

  it('refuses an operation naming a beat the plan does not have', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    expect(() =>
      applyFinishingOperations(
        plan,
        [{ kind: 'CLEAR_DECORATIONS', beatId: 'no-such-beat' }],
        brief,
      ),
    ).toThrow(/does not have/i);
  });

  it('cannot write a caption, only change how one arrives', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    const before = plan.beats.find((beat) => beat.id === 'hook-count')?.caption?.text;
    const edited = applyFinishingOperations(
      plan,
      [{ kind: 'SET_CAPTION_ENTRANCE', beatId: 'hook-count', entrance: 'SNAP' }],
      brief,
    );
    const after = edited.plan.beats.find((beat) => beat.id === 'hook-count')?.caption;
    expect(after?.text).toBe(before);
    expect(after?.entrance).toBe('SNAP');
  });

  it('is deterministic: the same operations produce the same checksum', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    const operations: readonly FinishingOperation[] = [
      { kind: 'SET_HOOK_LATENCY', latencySeconds: 0 },
      {
        kind: 'ADD_DECORATION',
        beatId: 'prediction-screen',
        treatment: 'FOCUS_DIM',
        colour: 'PRIMARY',
        opacity: 0.6,
        xPx: 120,
        yPx: 700,
        widthPx: 840,
        heightPx: 700,
        thicknessPx: 6,
      },
    ];
    const first = applyFinishingOperations(plan, operations, brief);
    const second = applyFinishingOperations(plan, operations, brief);
    expect(first.planSha256).toBe(second.planSha256);
    expect(first.planSha256).not.toBe(sha256OfJson(plan));
  });

  it('leaves the base plan untouched', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    const before = sha256OfJson(plan);
    applyFinishingOperations(plan, [{ kind: 'SET_HOOK_LATENCY', latencySeconds: 0 }], brief);
    expect(sha256OfJson(plan)).toBe(before);
  });
});

describe('the premium verdict', () => {
  const scorecardFor = (
    brief: CreativeFinishingBrief,
    masterSha256: string,
    score: number,
    resolvedDefectIds: readonly string[],
  ): unknown => ({
    scorecardVersion: 1,
    briefId: brief.briefId,
    masterSha256,
    reviewer: 'A Reviewer',
    reviewedAt: '2026-07-28T12:00:00.000Z',
    scores: CRAFT_DIMENSIONS.map((dimension) => ({
      dimension,
      score,
      note: 'A note long enough to say what was actually seen on screen here.',
    })),
    overallScore: score,
    resolvedDefectIds: [...resolvedDefectIds],
    remainingConcerns: [],
  });

  it('refuses a partial scorecard', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    const partial = scorecardFor(brief, 'b'.repeat(64), 9, ['d1']) as { scores: unknown[] };
    partial.scores = partial.scores.slice(0, 3);
    expect(() => parsePremiumScorecard(partial)).toThrow();
  });

  it('is PREMIUM_READY only when every gate clears, and names each blocker otherwise', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    const masterSha256 = 'b'.repeat(64);
    const master = { qaVerdict: 'PASS', measuredDurationSeconds: 15, measuredLoudnessLufs: -13.8 };

    const ready = evaluateFinishingVerdict({
      brief,
      scorecard: parsePremiumScorecard(scorecardFor(brief, masterSha256, 9, ['d1'])),
      master,
      masterSha256,
    });
    expect(ready.verdict).toBe('PREMIUM_READY');
    expect(ready.blockers).toHaveLength(0);
    expect(ready.agencyGradeClaim).toBe('NOT_ASSESSED');
    expect(ready.requiresHumanApproval).toBe(true);
    expect(ready.human.ungatedAssessment).toBe('HUMAN_JUDGEMENT_REQUIRED');

    // An unresolved BLOCKING defect blocks on its own, however high the scores.
    const unresolved = evaluateFinishingVerdict({
      brief,
      scorecard: parsePremiumScorecard(scorecardFor(brief, masterSha256, 10, [])),
      master,
      masterSha256,
    });
    expect(unresolved.verdict).toBe('NOT_PREMIUM_READY');
    expect(unresolved.blockers.join(' ')).toContain('d1');

    // A failed QA blocks whatever the reviewer thought of it.
    const failed = evaluateFinishingVerdict({
      brief,
      scorecard: parsePremiumScorecard(scorecardFor(brief, masterSha256, 10, ['d1'])),
      master: { qaVerdict: 'FAIL', qaFailedChecks: ['loudness'] },
      masterSha256,
    });
    expect(failed.verdict).toBe('NOT_PREMIUM_READY');
    expect(failed.blockers.join(' ')).toContain('loudness');

    // A score under the brief's own threshold blocks, and names the dimension.
    const low = evaluateFinishingVerdict({
      brief,
      scorecard: parsePremiumScorecard(scorecardFor(brief, masterSha256, 6, ['d1'])),
      master,
      masterSha256,
    });
    expect(low.verdict).toBe('NOT_PREMIUM_READY');
    for (const dimension of GATED_DIMENSIONS) {
      expect(low.blockers.join(' ')).toContain(dimension);
    }
  });

  it('refuses a scorecard written against a different master', async () => {
    const plan = await loadExamplePlan();
    const brief = briefFor(plan);
    const verdict = evaluateFinishingVerdict({
      brief,
      scorecard: parsePremiumScorecard(scorecardFor(brief, 'c'.repeat(64), 10, ['d1'])),
      master: { qaVerdict: 'PASS' },
      masterSha256: 'b'.repeat(64),
    });
    expect(verdict.verdict).toBe('NOT_PREMIUM_READY');
    expect(verdict.blockers.join(' ')).toContain('Score the file that exists');
  });
});
