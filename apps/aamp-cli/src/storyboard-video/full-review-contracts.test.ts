import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertWithinGenerationCeiling, buildCostEstimate } from './cost-estimate';
import { STORYBOARD_VIDEO_EXIT_CODES, StoryboardVideoError } from './failures';
import { DEFAULT_MAX_GENERATIONS, parseFullReviewArgs } from './full-review-cli';
import {
  assertMotionGateClears,
  assertReviewCandidateTechnicallySound,
  type MotionGateReport,
  type SceneGateRow,
} from './motion-review-gate';
import { buildPendingReviewLedger, STORYBOARD_VIDEO_OUTPUT_INTENTS } from './run-storyboard-video';
import {
  buildAudioReport,
  buildUiCompositingReport,
  findBenchmarkAudio,
  REFUSED_TRANSITION_KINDS,
  sceneWindows,
} from './review-candidate-reports';
import { parseSceneManifest } from './scene-manifest';
import type { SceneSourceDecision } from './source-precedence';

/**
 * The review candidate's contracts, proven with no FFmpeg, no provider and no
 * key.
 *
 * The one that matters most is the last group: that the production gate is
 * unchanged. A review-candidate path that quietly loosened the master's gate
 * would be the bypass this whole design exists to avoid, and it would look
 * exactly like this feature.
 */

const SHA = (seed: string): string =>
  seed
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, '0');

function row(overrides: Partial<SceneGateRow> = {}): SceneGateRow {
  return {
    sceneNumber: 1,
    sceneRole: 'NOTIFICATION_HOOK',
    sourceType: 'LTX_GENERATED',
    status: 'NOT_REVIEWED',
    identitySha256: SHA('aaaa'),
    clipChecksumSha256: SHA('bbbb'),
    inspectionVerdict: 'TECHNICALLY_SOUND',
    openFidelityFindings: [],
    decidedBy: null,
    decidedAt: null,
    decisionId: null,
    feedback: null,
    remedy: 'look at it',
    ...overrides,
  };
}

function gate(rows: readonly SceneGateRow[]): MotionGateReport {
  const blockingScenes = rows.filter((r) => r.status !== 'APPROVED').map((r) => r.sceneNumber);
  return {
    evaluatedAt: '2026-07-31T00:00:00.000Z',
    rows,
    blockingScenes,
    technicallyInvalidScenes: rows
      .filter((r) => r.status === 'TECHNICALLY_INVALID' || r.status === 'MISSING_SOURCE')
      .map((r) => r.sceneNumber),
    clears: blockingScenes.length === 0,
    notice: 'x',
  };
}

function decision(overrides: Partial<SceneSourceDecision> = {}): SceneSourceDecision {
  return {
    sceneNumber: 1,
    sceneRole: 'NOTIFICATION_HOOK',
    slotSeconds: 1.1,
    generationMode: 'LTX_IMAGE_TO_VIDEO',
    selectedSourceType: 'LTX_GENERATED',
    selectedIdentifier: 'FRAME-01',
    reasonSelected: 'because',
    rejectedAlternatives: [],
    requiresGeneration: true,
    ...overrides,
  };
}

describe('the two output intents', () => {
  it('lists exactly the two that exist', () => {
    expect([...STORYBOARD_VIDEO_OUTPUT_INTENTS]).toEqual([
      'PRODUCTION_MASTER',
      'FULL_LENGTH_REVIEW_CANDIDATE',
    ]);
  });

  it('offers no flag that changes the intent', () => {
    // The safety property is that the intent is fixed by which entry point ran.
    // A flag reaching it would be the bypass the gate exists to prevent.
    for (const flag of ['--output-intent', '--production', '--skip-review', '--force']) {
      expect(() => parseFullReviewArgs([flag, 'x'])).toThrow(/unknown option/);
    }
  });

  it('offers no flag that approves a scene', () => {
    for (const flag of ['--approve', '--reviewer', '--approved-by']) {
      expect(() => parseFullReviewArgs([flag, 'Riki Taylor'])).toThrow(/unknown option/);
    }
  });

  it('defaults the generation ceiling rather than leaving it unbounded', () => {
    expect(DEFAULT_MAX_GENERATIONS).toBe(5);
    expect(parseFullReviewArgs([]).maxGenerations).toBeUndefined();
  });
});

describe('the production gate is unchanged', () => {
  it('still refuses an unreviewed moving scene', () => {
    expect(() => assertMotionGateClears(gate([row({ status: 'NOT_REVIEWED' })]))).toThrow(
      /not cleared for rendering/,
    );
  });

  it('still refuses a rejected scene and a superseded approval', () => {
    for (const status of ['REJECTED', 'APPROVAL_SUPERSEDED_BY_CHANGE'] as const) {
      expect(() => assertMotionGateClears(gate([row({ status })]))).toThrow();
    }
  });
});

describe('what a review candidate may and may not carry', () => {
  it('carries an unreviewed scene — that is what it is for', () => {
    expect(() =>
      assertReviewCandidateTechnicallySound(gate([row({ status: 'NOT_REVIEWED' })])),
    ).not.toThrow();
  });

  it('carries a rejected scene, because the reviewer may want to see it in place', () => {
    expect(() =>
      assertReviewCandidateTechnicallySound(gate([row({ status: 'REJECTED' })])),
    ).not.toThrow();
  });

  it('refuses a technically broken clip, the same as the master does', () => {
    // A reviewer looking at a broken clip is being asked the wrong question.
    let error: unknown;
    try {
      assertReviewCandidateTechnicallySound(
        gate([row({ status: 'TECHNICALLY_INVALID', inspectionVerdict: 'TECHNICALLY_INVALID' })]),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StoryboardVideoError);
    expect((error as StoryboardVideoError).kind).toBe('MOTION_INSPECTION_FAILED');
    expect((error as StoryboardVideoError).exitCode).toBe(
      STORYBOARD_VIDEO_EXIT_CODES.MOTION_INSPECTION_FAILED,
    );
  });

  it('refuses a scene with no source at all', () => {
    expect(() =>
      assertReviewCandidateTechnicallySound(gate([row({ status: 'MISSING_SOURCE' })])),
    ).toThrow();
  });
});

describe('the pending-human-review ledger', () => {
  it('records every unapproved moving scene as pending, with no reviewer and no verdict', () => {
    const ledger = buildPendingReviewLedger({
      gate: gate([row({ sceneNumber: 1 }), row({ sceneNumber: 5, status: 'REJECTED' })]),
      reviewDirectory: '/reviews',
      galleryPath: null,
    }) as Record<string, unknown>;

    expect(ledger.productionUseAuthorised).toBe(false);
    expect(ledger.pendingSceneCount).toBe(2);
    for (const entry of ledger.rows as Record<string, unknown>[]) {
      expect(entry.reviewStatus).toBe('PENDING_HUMAN_REVIEW');
      expect(entry.decidedBy).toBeNull();
    }
    expect(String(ledger.notice)).toMatch(/approved nothing and cannot/i);
  });

  it('marks a demoted scene as absent from the cut rather than pending', () => {
    // There is no generated motion in the cut for it, so there is nothing to
    // approve — what it needs is a decision about paying for a replacement.
    const ledger = buildPendingReviewLedger({
      gate: gate([row({ sceneNumber: 5, status: 'TECHNICALLY_INVALID' })]),
      reviewDirectory: '/reviews',
      galleryPath: null,
      defectSubstitutions: [
        {
          sceneNumber: 5,
          sceneRole: 'FIGHTER_COMPARISON',
          rejectedClipChecksumSha256: SHA('cccc'),
          failedBindingChecks: ['SUFFICIENT_MOTION_FOR_DECLARED_REQUIREMENT: observed 0.1407'],
          substitutedWith: 'DETERMINISTIC_MOTION_GRAPHICS',
          costOfARetryCents: 36,
        },
      ],
    }) as Record<string, unknown>;

    const entry = (ledger.rows as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(String(entry.reviewStatus)).toMatch(/NOT_IN_THIS_CUT/);
    expect(ledger.pendingSceneCount).toBe(0);
    expect((ledger.defectSubstitutions as unknown[]).length).toBe(1);
  });
});

describe('the two ceilings', () => {
  const estimate = (generating: readonly number[]) =>
    buildCostEstimate({
      decisions: Array.from({ length: 10 }, (_unused, index) =>
        decision({
          sceneNumber: index + 1,
          requiresGeneration: generating.includes(index + 1),
        }),
      ),
      model: 'ltx-2-3-fast',
      resolution: '1080x1920',
      ceilingCents: 100_000,
      requiredSourceSecondsForScene: () => 2,
    });

  it('refuses more billable submissions than authorised, naming the scenes', () => {
    let error: unknown;
    try {
      assertWithinGenerationCeiling(estimate([1, 2, 3, 4, 5, 6]), 5);
    } catch (caught) {
      error = caught;
    }
    expect((error as StoryboardVideoError).kind).toBe('COST_CEILING_EXCEEDED');
    expect((error as StoryboardVideoError).message).toMatch(/scenes 1, 2, 3, 4, 5, 6/);
    expect((error as StoryboardVideoError).message).toMatch(/nothing has been spent/i);
  });

  it('accepts exactly the authorised number', () => {
    expect(() => assertWithinGenerationCeiling(estimate([1, 5, 7, 8, 9]), 5)).not.toThrow();
  });

  it('binds nothing when no request ceiling was given', () => {
    expect(() =>
      assertWithinGenerationCeiling(estimate([1, 2, 3, 4, 5, 6]), undefined),
    ).not.toThrow();
  });
});

describe('benchmark audio needs three yeses', () => {
  it('is unusable when no directory was supplied', async () => {
    const finding = await findBenchmarkAudio(undefined);
    expect(finding.usable).toBe(false);
    expect(finding.reason).toMatch(/no audio benchmark directory/i);
  });

  it('is unusable when the pack has no final report', async () => {
    const finding = await findBenchmarkAudio(join(__dirname, 'does-not-exist'));
    expect(finding.usable).toBe(false);
    expect(finding.reportPresent).toBe(false);
  });

  it('marks the cut AUDIO_TEMPORARY whenever the benchmark is unusable', () => {
    const report = buildAudioReport({
      plan: {
        audio: {
          musicAssetId: 'music-bed',
          musicGainDb: -10,
          sourceAudioGainDb: -18,
          cueDuckingDb: 7,
          targetLufs: -14,
          peakCeilingDbtp: -1.5,
          cueAssetIds: {},
        },
      } as never,
      benchmark: {
        directory: '/packs/audio',
        reportPresent: true,
        reportStatus: 'IN PROGRESS',
        selectedMixCount: 0,
        usable: false,
        reason: 'the model chain has not completed',
      },
      measured: null,
    }) as Record<string, unknown>;

    expect(report.disposition).toBe('AUDIO_TEMPORARY');
    expect(String(report.notice)).toMatch(/not a mix/i);
  });
});

describe('the transition decision for this cut', () => {
  it('refuses the two kinds that read as "these shots are interchangeable" or "the film ended"', () => {
    expect([...REFUSED_TRANSITION_KINDS].sort()).toEqual(['CROSSFADE', 'DIP_TO_BLACK']);
  });

  it('derives scene windows that land on the locked cue boundaries', () => {
    const plan = {
      beats: [
        { id: 'a', durationSeconds: 1.1 },
        { id: 'b', durationSeconds: 1.4, transitionIn: { kind: 'CUT', durationSeconds: 0.2 } },
        { id: 'c', durationSeconds: 1.8, transitionIn: { kind: 'CUT', durationSeconds: 0.3 } },
      ],
    } as never;
    const windows = sceneWindows(plan);
    expect(windows.map((window) => window.endSeconds)).toEqual([1.1, 2.3, 3.8]);
  });
});

describe('the committed plan against this cut', () => {
  const planPath = join(
    __dirname,
    '..',
    '..',
    'campaigns',
    'combat-reviews-flagship-02',
    'creative-plan.json',
  );

  async function plan(): Promise<{
    beats: { id: string; transitionIn?: { kind: string; durationSeconds: number } }[];
  }> {
    return JSON.parse(await readFile(planPath, 'utf8'));
  }

  it('uses no crossfade and no dip to black anywhere', async () => {
    const kinds = (await plan()).beats
      .map((beat) => beat.transitionIn?.kind)
      .filter((kind): kind is string => Boolean(kind));
    expect(kinds.length).toBe(9);
    for (const kind of kinds) {
      expect(REFUSED_TRANSITION_KINDS).not.toContain(kind);
    }
  });

  it('keeps the locked cue boundaries exactly', async () => {
    const windows = sceneWindows((await plan()) as never);
    expect(windows.map((window) => Number(window.endSeconds.toFixed(2)))).toEqual([
      1.1, 2.3, 3.8, 5.1, 6.6, 8.0, 8.9, 10.7, 12.7, 15.0,
    ]);
  });
});

describe('the UI-compositing report', () => {
  it('names every scene that reached a generative model as needing a human look', async () => {
    const manifestPath = join(
      __dirname,
      '..',
      '..',
      'campaigns',
      'combat-reviews-flagship-02',
      'scene-manifest.json',
    );
    const manifest = parseSceneManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    const report = buildUiCompositingReport({
      sceneManifest: manifest,
      decisions: [decision({ sceneNumber: 1, selectedSourceType: 'LTX_GENERATED' })],
      stillSceneNumbers: new Set<number>(),
      plateSubstitutionsDeclined: [{ sceneNumber: 3, frameId: 'FRAME-03', reason: 'blank screen' }],
    }) as Record<string, unknown>;

    const scenes = report.scenes as Record<string, unknown>[];
    const one = scenes.find((scene) => scene.sceneNumber === 1) as Record<string, unknown>;
    expect(one.reachedGenerativeModel).toBe(true);
    expect(one.humanJudgementRequired).toBeTruthy();
    // Every prompt that reaches a model must carry its prohibition clause.
    expect(one.promptProhibitsRedrawingUi).toBe(true);
    expect((report.plateSubstitutionsDeclined as unknown[]).length).toBe(1);
  });
});
