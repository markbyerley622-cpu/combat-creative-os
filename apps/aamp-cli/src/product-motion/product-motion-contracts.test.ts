import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseProductMotionPlan,
  PRODUCT_MOTION_LABEL,
  ProductMotionError,
  SHOT_TRANSITIONS,
} from './product-motion-contracts';

const PLAN_PATH = join(
  __dirname,
  '..',
  '..',
  'plans',
  'combat-reviews-product-motion-proof-02.json',
);

async function committedPlan(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(PLAN_PATH, 'utf8')) as Record<string, unknown>;
}

/** A structurally-valid minimum, so each refusal test changes exactly one thing. */
function minimalPlan(): Record<string, unknown> {
  return {
    planVersion: 1,
    id: 'proof',
    authoredBy: 'operator',
    brief: 'a brief',
    output: { widthPx: 1080, heightPx: 1920, frameRate: 30, durationSeconds: 5 },
    brandMarkFile: 'brand/logo.png',
    plates: [
      {
        id: 'hero',
        file: 'a.png',
        widthPx: 941,
        heightPx: 1672,
        screen: {
          topLeft: { xPx: 500, yPx: 360 },
          topRight: { xPx: 858, yPx: 338 },
          bottomLeft: { xPx: 481, yPx: 1362 },
          bottomRight: { xPx: 838, yPx: 1381 },
        },
        description: 'hero',
      },
    ],
    documents: [
      {
        id: 'card',
        surface: 'FIGHT_CARD',
        description: 'card',
      },
    ],
    // All seven beats, because the parser requires the whole narrative to be
    // present. `states[0]` scrolls and `states[1]` holds, which is what the
    // accent tests below depend on.
    states: [
      {
        id: 's1',
        state: 'EVENT_SCHEDULE_SCROLL',
        documentId: 'card',
        startSeconds: 0,
        endSeconds: 3,
        entrance: 'NONE',
        entranceSeconds: 0,
        scroll: { fromPx: 0, toPx: 100, startSeconds: 0, endSeconds: 2, easing: 'EASE_OUT_CUBIC' },
        intent: 'open',
      },
      ...(
        [
          ['s2', 'EVENT_SELECTED', 3, 3.3],
          ['s3', 'FIGHTER_COMPARISON', 3.3, 3.8],
          ['s4', 'PREDICTION_READY', 3.8, 4.3],
          ['s5', 'PREDICTION_TAP', 4.3, 4.5],
          ['s6', 'PREDICTION_CONFIRMED', 4.5, 4.8],
          ['s7', 'PREDICTOR_RANK_REWARD', 4.8, 5],
        ] as const
      ).map(([id, state, startSeconds, endSeconds]) => ({
        id,
        state,
        documentId: 'card',
        startSeconds,
        endSeconds,
        entrance: 'NONE',
        entranceSeconds: 0,
        scroll: { fromPx: 100, toPx: 100, startSeconds, endSeconds, easing: 'LINEAR' },
        intent: 'settle',
      })),
    ],
    accents: [],
    shots: [
      {
        id: 'shot-a',
        plateId: 'hero',
        startSeconds: 0,
        endSeconds: 5,
        transitionIn: 'OPENING',
        transitionNote: 'opens',
        move: { startZoom: 1.06, endZoom: 1.12, offsetU: 0, offsetV: 0 },
      },
    ],
    audio: {
      bedFile: 'audio/music-bed.wav',
      bedGainDb: -13,
      cues: [],
      integratedLufs: -14,
      truePeakDbtp: -1.5,
    },
  };
}

describe('the transition vocabulary', () => {
  it('lists only transitions this path implements', () => {
    expect([...SHOT_TRANSITIONS]).toEqual(['OPENING', 'SCREEN_POSITION_MATCH_CUT', 'TAP_CUT']);
  });

  it('has no dissolve between product states, by construction', () => {
    for (const transition of SHOT_TRANSITIONS) {
      expect(transition).not.toMatch(/CROSSFADE|DISSOLVE|FADE/);
    }
  });
});

describe('parseProductMotionPlan', () => {
  it('accepts the committed proof plan', async () => {
    const plan = parseProductMotionPlan(await committedPlan(), PLAN_PATH);
    expect(plan.id).toBe('combat-reviews-product-motion-proof-02');
    expect(plan.output.durationSeconds).toBeGreaterThanOrEqual(5);
    expect(plan.output.durationSeconds).toBeLessThanOrEqual(6);
  });

  it('covers all four required product states in the committed plan', async () => {
    const plan = parseProductMotionPlan(await committedPlan(), PLAN_PATH);
    const states = new Set(plan.states.map((state) => state.state));
    expect(states).toContain('EVENT_SCHEDULE_SCROLL');
    expect(states).toContain('FIGHTER_COMPARISON');
    expect(states).toContain('PREDICTION_READY');
    expect(states).toContain('PREDICTOR_RANK_REWARD');
  });

  it('accepts a minimal plan', () => {
    expect(() => parseProductMotionPlan(minimalPlan())).not.toThrow();
  });

  it('refuses a gap between shots rather than rendering a hole', () => {
    const plan = minimalPlan();
    (plan.shots as Record<string, unknown>[])[0]!.endSeconds = 4;
    expect(() => parseProductMotionPlan(plan)).toThrow(ProductMotionError);
    expect(() => parseProductMotionPlan(plan)).toThrow(/shots end at 4s but the cut is 5s/);
  });

  it('refuses states that do not tile the cut', () => {
    const plan = minimalPlan();
    (plan.states as Record<string, unknown>[])[1]!.startSeconds = 3.5;
    expect(() => parseProductMotionPlan(plan)).toThrow(/gap or an overlap/);
  });

  it('refuses a first shot that is not an OPENING', () => {
    const plan = minimalPlan();
    (plan.shots as Record<string, unknown>[])[0]!.transitionIn = 'TAP_CUT';
    expect(() => parseProductMotionPlan(plan)).toThrow(/first shot must declare/);
  });

  it('refuses a later shot declared as an OPENING', () => {
    const plan = minimalPlan();
    const shots = plan.shots as Record<string, unknown>[];
    shots[0]!.endSeconds = 3;
    shots.push({
      id: 'shot-b',
      plateId: 'hero',
      startSeconds: 3,
      endSeconds: 5,
      transitionIn: 'OPENING',
      transitionNote: 'x',
      move: { startZoom: 1.12, endZoom: 1.14, offsetU: 0, offsetV: 0 },
    });
    expect(() => parseProductMotionPlan(plan)).toThrow(/cannot be an OPENING/);
  });

  it('refuses an accent drawn while its document is still scrolling', () => {
    const plan = minimalPlan();
    plan.accents = [
      {
        id: 'a1',
        key: 'SELECTION_OUTLINE',
        documentId: 'card',
        documentRect: { xPx: 10, yPx: 100, widthPx: 500, heightPx: 200 },
        atScrollPx: 100,
        startSeconds: 1,
        endSeconds: 2.5,
        colorHex: '#DA0318',
        intent: 'x',
      },
    ];
    expect(() => parseProductMotionPlan(plan)).toThrow(/cannot follow a moving row/);
  });

  it('refuses an accent positioned for a scroll the state never rests at', () => {
    const plan = minimalPlan();
    plan.accents = [
      {
        id: 'a1',
        key: 'SELECTION_OUTLINE',
        documentId: 'card',
        documentRect: { xPx: 10, yPx: 100, widthPx: 500, heightPx: 200 },
        atScrollPx: 640,
        startSeconds: 3.2,
        endSeconds: 4,
        colorHex: '#DA0318',
        intent: 'x',
      },
    ];
    expect(() => parseProductMotionPlan(plan)).toThrow(/rests at 100px/);
  });

  it('allows one accent to span consecutive states at the same resting scroll', () => {
    const plan = minimalPlan();
    plan.accents = [
      {
        id: 'a1',
        key: 'SELECTION_OUTLINE',
        documentId: 'card',
        documentRect: { xPx: 10, yPx: 100, widthPx: 500, heightPx: 200 },
        atScrollPx: 100,
        startSeconds: 2.2,
        endSeconds: 3.8,
        colorHex: '#DA0318',
        intent: 'x',
      },
    ];
    expect(() => parseProductMotionPlan(plan)).not.toThrow();
  });

  it('refuses an accent shown while a different document is on screen', () => {
    const plan = minimalPlan();
    (plan.documents as Record<string, unknown>[]).push({
      id: 'board',
      surface: 'LEADERBOARD',
      description: 'board',
    });
    plan.accents = [
      {
        id: 'a1',
        key: 'SELECTION_OUTLINE',
        documentId: 'board',
        documentRect: { xPx: 10, yPx: 100, widthPx: 500, heightPx: 200 },
        atScrollPx: 100,
        startSeconds: 3.2,
        endSeconds: 4,
        colorHex: '#DA0318',
        intent: 'x',
      },
    ];
    expect(() => parseProductMotionPlan(plan)).toThrow(/rather than "board"/);
  });

  it('refuses an accent drawn during a push-up entrance', () => {
    const plan = minimalPlan();
    const states = plan.states as Record<string, unknown>[];
    states[1]!.entrance = 'PUSH_UP';
    states[1]!.entranceSeconds = 0.4;
    plan.accents = [
      {
        id: 'a1',
        key: 'SELECTION_OUTLINE',
        documentId: 'card',
        documentRect: { xPx: 10, yPx: 100, widthPx: 500, heightPx: 200 },
        atScrollPx: 100,
        startSeconds: 3.1,
        endSeconds: 4,
        colorHex: '#DA0318',
        intent: 'x',
      },
    ];
    expect(() => parseProductMotionPlan(plan)).toThrow(/still entering/);
  });

  it('refuses a duration outside the five-to-six-second proof window', () => {
    const plan = minimalPlan();
    (plan.output as Record<string, unknown>).durationSeconds = 20;
    expect(() => parseProductMotionPlan(plan)).toThrow(/durationSeconds/);
  });

  it('refuses an unknown key rather than ignoring it', () => {
    const plan = { ...minimalPlan(), somethingElse: true };
    expect(() => parseProductMotionPlan(plan)).toThrow(/Unrecognized key|unrecognized/i);
  });

  it('labels the path in one place', () => {
    expect(PRODUCT_MOTION_LABEL).toBe('PRODUCT_MOTION_PROOF');
  });
});
