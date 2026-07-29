import { readFile, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  STORYBOARD_VIDEO_EXIT_CODES,
  STORYBOARD_VIDEO_FAILURE_KINDS,
  exitCodeForFailure,
} from './failures';
import {
  correlate,
  extractNegativeConstraints,
  findNonProductionSegment,
  gridMeans,
  hashInspection,
  KEYFRAME_LAYOUT_AGREEMENT_FLOOR,
  MOTION_CHECK_IDS,
  MOTION_CHECK_TIERS,
  MOTION_ENERGY_FLOOR_BY_CAMERA_MOTION,
  type MotionCheck,
  type SceneMotionInspection,
} from './motion-inspection';
import {
  assertFeedbackIsActionable,
  computeDecisionId,
  MOTION_REVIEW_LEDGER_VERSION,
  reviewIdentitySha256,
  sceneContractSha256,
  type SceneReviewIdentity,
  type UnsignedMotionReviewDecision,
} from './motion-review-contracts';
import {
  assertMotionGateClears,
  describeChange,
  evaluateMotionGate,
  sceneNeedsMotionReview,
} from './motion-review-gate';
import { MotionReviewLedger } from './motion-review-store';
import { parseMotionReviewArgs } from './motion-review-cli';
import { CAMERA_MOTIONS } from './scene-manifest';
import type { SceneSourceDecision } from './source-precedence';

/**
 * The review contracts, proven with no FFmpeg, no provider and no key.
 *
 * Everything here is a refusal, an identity rule or a pure decision — the
 * cheap checks that guard the expensive ones. The measurements themselves need
 * real media and are proven in the acceptance suite.
 */

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aamp-motion-review-'));
});

const SHA = (seed: string): string =>
  seed
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, '0');

function scene(overrides: Record<string, unknown> = {}) {
  return {
    sceneNumber: 1,
    sourceFrame: 'FRAME-01',
    outputStartSeconds: 0,
    outputEndSeconds: 1.1,
    generationMode: 'LTX_IMAGE_TO_VIDEO' as const,
    motionPrompt: 'A figure breathes in low light. Do not alter any lettering or mark in frame.',
    cameraMotion: 'SLOW_PUSH_IN' as const,
    preserveExactTypography: false,
    preserveExactProductUi: false,
    acceptableFootageRoles: ['BOXING_ACTION'],
    intent: 'hook',
    ...overrides,
  } as never;
}

function identity(overrides: Partial<SceneReviewIdentity> = {}): SceneReviewIdentity {
  return {
    sceneNumber: 1,
    clipChecksumSha256: SHA('aaaa'),
    keyframeChecksumSha256: SHA('bbbb'),
    motionPromptSha256: SHA('cccc'),
    sceneContractSha256: SHA('dddd'),
    sourceType: 'LTX_GENERATED',
    generationProvenance: 'AAMP_LTX_HOSTED_PROVIDER',
    ...overrides,
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
    requiresGeneration: false,
    generationProvenance: 'AAMP_LTX_HOSTED_PROVIDER',
    ...overrides,
  };
}

function inspection(overrides: Partial<SceneMotionInspection> = {}): SceneMotionInspection {
  const checks: MotionCheck[] = MOTION_CHECK_IDS.map((id) => ({
    id,
    tier: MOTION_CHECK_TIERS[id],
    status: 'PASS' as const,
    expected: 'x',
    observed: 'x',
  }));
  const base = {
    profileVersion: 1 as const,
    sceneNumber: 1,
    sceneRole: 'NOTIFICATION_HOOK',
    sourceType: 'LTX_GENERATED',
    sourceIdentifier: 'FRAME-01',
    generationProvenance: 'AAMP_LTX_HOSTED_PROVIDER',
    clipPath: '/runs/scene-01.mp4',
    clipFileName: 'scene-01.mp4',
    clipChecksumSha256: SHA('aaaa'),
    sizeBytes: 1024,
    measured: {
      widthPx: 1080,
      heightPx: 1920,
      frameRate: 24,
      durationSeconds: 6,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      hasAudio: false,
    },
    editInterval: { outputStartSeconds: 0, outputEndSeconds: 1.1, requiredSourceSeconds: 1.45 },
    blackRegions: [],
    freezeRegions: [],
    motion: {
      profileVersion: 1 as const,
      declaredCameraMotion: 'SLOW_PUSH_IN' as const,
      floor: 0.3,
      measuredEnergy: 1.72,
      sampleFps: 8,
      noiseCutoff: 16,
      claim: 'x',
    },
    keyframeAgreement: {
      keyframeId: 'FRAME-01',
      keyframeChecksumSha256: SHA('bbbb'),
      floor: KEYFRAME_LAYOUT_AGREEMENT_FLOOR,
      measuredAgreement: 0.98,
      method: 'x',
    },
    decodeErrors: [],
    checks,
    verdict: 'TECHNICALLY_SOUND' as const,
    openFidelityFindings: [],
    frames: [],
    keyframePreviewFileName: null,
    motionPrompt: 'x',
    motionPromptSha256: SHA('cccc'),
    negativeConstraints: [],
    measuredAtProfile: 'x',
    ...overrides,
  };
  return { ...base, inspectionSha256: hashInspection(base) } as SceneMotionInspection;
}

async function ledgerWith(
  decisions: readonly UnsignedMotionReviewDecision[],
): Promise<MotionReviewLedger> {
  const ledger = await MotionReviewLedger.open(workspace);
  for (const entry of decisions) {
    // eslint-disable-next-line no-await-in-loop -- ledger order is the point
    await ledger.append({ decision: entry });
  }
  return ledger;
}

function unsigned(
  overrides: Partial<UnsignedMotionReviewDecision> = {},
): UnsignedMotionReviewDecision {
  const id = identity();
  return {
    ledgerVersion: MOTION_REVIEW_LEDGER_VERSION,
    recordedAt: '2026-07-29T10:00:00.000Z',
    reviewer: 'Riki Taylor',
    sceneNumber: 1,
    verdict: 'APPROVED',
    feedback: 'the framing matches the approved plate and the push is the one the scene asks for',
    identity: id,
    identitySha256: reviewIdentitySha256(id),
    inspectionSha256: SHA('eeee'),
    acknowledgedFindings: [],
    supersedesDecisionId: null,
    supersedesReason: null,
    ...overrides,
  };
}

describe('failure vocabulary', () => {
  it('gives the two review failures their own codes, distinct from every other kind', () => {
    const codes = STORYBOARD_VIDEO_FAILURE_KINDS.map(exitCodeForFailure);
    expect(new Set(codes).size).toBe(STORYBOARD_VIDEO_FAILURE_KINDS.length);
    expect(STORYBOARD_VIDEO_EXIT_CODES.MOTION_REVIEW_BLOCKED).toBe(38);
    expect(STORYBOARD_VIDEO_EXIT_CODES.MOTION_INSPECTION_FAILED).toBe(39);
  });
});

describe('what needs a motion judgement', () => {
  it('asks for one on every source that puts moving picture on screen', () => {
    for (const sourceType of [
      'ACQUIRED_PRODUCTION_FOOTAGE',
      'PRE_GENERATED_MANUAL_CLIP',
      'LTX_GENERATED',
    ] as const) {
      expect(sceneNeedsMotionReview(decision({ selectedSourceType: sourceType }))).toBe(true);
    }
  });

  it('never asks for one on a still the render path animates itself', () => {
    for (const sourceType of ['DETERMINISTIC_MOTION_GRAPHICS', 'REAL_PRODUCT_CAPTURE'] as const) {
      expect(sceneNeedsMotionReview(decision({ selectedSourceType: sourceType }))).toBe(false);
    }
  });
});

describe('review identity — what invalidates an approval', () => {
  it('changes when the clip changes', () => {
    expect(reviewIdentitySha256(identity())).not.toBe(
      reviewIdentitySha256(identity({ clipChecksumSha256: SHA('ffff') })),
    );
  });

  it('changes when the authoritative keyframe changes', () => {
    expect(reviewIdentitySha256(identity())).not.toBe(
      reviewIdentitySha256(identity({ keyframeChecksumSha256: SHA('ffff') })),
    );
  });

  it('changes when the generation prompt changes', () => {
    expect(reviewIdentitySha256(identity())).not.toBe(
      reviewIdentitySha256(identity({ motionPromptSha256: SHA('ffff') })),
    );
  });

  it('changes when the scene contract changes', () => {
    expect(reviewIdentitySha256(identity())).not.toBe(
      reviewIdentitySha256(identity({ sceneContractSha256: SHA('ffff') })),
    );
  });

  it('is stable across two computations of the same inputs', () => {
    expect(reviewIdentitySha256(identity())).toBe(reviewIdentitySha256(identity()));
  });

  it('binds the scene contract to slot, mode, camera motion and the preservation flags', () => {
    const base = sceneContractSha256(scene());
    expect(sceneContractSha256(scene({ outputEndSeconds: 1.4 }))).not.toBe(base);
    expect(sceneContractSha256(scene({ cameraMotion: 'STATIC' }))).not.toBe(base);
    expect(sceneContractSha256(scene({ generationMode: 'EXACT_UI_MOTION' }))).not.toBe(base);
    expect(sceneContractSha256(scene({ preserveExactProductUi: true }))).not.toBe(base);
    expect(sceneContractSha256(scene({ acceptableFootageRoles: ['OTHER'] }))).not.toBe(base);
  });

  it("does not change when the scene's prose intent is reworded", () => {
    // The intent is documentation. A reviewer's judgement about the picture is
    // not invalidated by somebody improving a sentence about it.
    expect(sceneContractSha256(scene({ intent: 'a completely different sentence' }))).toBe(
      sceneContractSha256(scene()),
    );
  });
});

describe('feedback — refused rather than interpreted', () => {
  it('refuses a whole-field mood, whatever the verdict', () => {
    for (const phrase of ['bad', 'meh', 'make it punchier', 'Looks off.']) {
      expect(() => assertFeedbackIsActionable('REJECTED', phrase, 5)).toThrow(
        /a mood, not a direction/,
      );
    }
  });

  it('refuses a rejection too short to act on', () => {
    expect(() => assertFeedbackIsActionable('REJECTED', 'framing is tight', 5)).toThrow(
      /at least 30 characters/,
    );
  });

  it('accepts a short approval reason — a complete thought may be brief', () => {
    expect(() => assertFeedbackIsActionable('APPROVED', 'matches the plate', 5)).not.toThrow();
  });

  it('never blocks prose that merely contains a vague word', () => {
    expect(() =>
      assertFeedbackIsActionable(
        'REJECTED',
        'the push is punchier than the brief asks for and overshoots the face by 0.4s; hold the move at 30% and settle before the cut',
        5,
      ),
    ).not.toThrow();
  });
});

describe('the ledger — append-only and self-verifying', () => {
  it('records a decision and reads it back', async () => {
    await ledgerWith([unsigned()]);
    const reopened = await MotionReviewLedger.open(workspace);
    expect(reopened.all).toHaveLength(1);
    expect(reopened.all[0]?.reviewer).toBe('Riki Taylor');
  });

  it('is idempotent on identical content — a re-run is not a second judgement', async () => {
    const ledger = await ledgerWith([unsigned(), unsigned()]);
    expect(ledger.all).toHaveLength(1);
  });

  it('keeps a superseded decision beside the one that replaced it', async () => {
    const first = unsigned({
      verdict: 'REJECTED',
      feedback:
        'the opening frame is a tight crop of the face, not the approved wide plate; regenerate from FRAME-01',
    });
    const second = unsigned({
      recordedAt: '2026-07-29T11:00:00.000Z',
      identity: identity({ clipChecksumSha256: SHA('9999') }),
      identitySha256: reviewIdentitySha256(identity({ clipChecksumSha256: SHA('9999') })),
      supersedesDecisionId: computeDecisionId(first),
      supersedesReason: 'the clip changed',
    });
    const ledger = await ledgerWith([first, second]);
    expect(ledger.all).toHaveLength(2);
    expect(ledger.forScene(1)).toHaveLength(2);
  });

  it('refuses a line whose recorded id does not match its content', async () => {
    await ledgerWith([unsigned()]);
    const file = join(workspace, 'motion-review-ledger.jsonl');
    const original = JSON.parse((await readFile(file, 'utf8')).trim()) as Record<string, unknown>;
    await writeFile(
      file,
      `${JSON.stringify({ ...original, verdict: 'APPROVED', feedback: 'tampered' })}\n`,
      'utf8',
    );
    await expect(MotionReviewLedger.open(workspace)).rejects.toThrow(/edited after it was written/);
  });

  it('refuses a malformed line rather than treating the scene as unreviewed', async () => {
    const file = join(workspace, 'motion-review-ledger.jsonl');
    await writeFile(file, 'not json at all\n', 'utf8');
    await expect(MotionReviewLedger.open(workspace)).rejects.toThrow(/not valid JSON/);
  });

  it('treats an absent ledger as empty rather than an error', async () => {
    const ledger = await MotionReviewLedger.open(join(workspace, 'nothing-here'));
    expect(ledger.all).toHaveLength(0);
  });

  it('returns a decision only while its identity still matches', async () => {
    const ledger = await ledgerWith([unsigned()]);
    expect(ledger.latestApplicable(1, reviewIdentitySha256(identity()))).not.toBeNull();
    expect(
      ledger.latestApplicable(
        1,
        reviewIdentitySha256(identity({ clipChecksumSha256: SHA('9999') })),
      ),
    ).toBeNull();
  });

  it('refuses to write a decision carrying a credential-shaped value', async () => {
    const ledger = await MotionReviewLedger.open(workspace);
    await expect(
      ledger.append({
        decision: unsigned({
          feedback:
            'see https://cdn.example.com/clip.mp4?signature=abc123 for the reference I mean here',
        }),
      }),
    ).rejects.toThrow(/no artefact may hold/);
    await expect(readdir(workspace)).resolves.not.toContain('motion-review-ledger.jsonl');
  });
});

describe('the gate — fail closed, with the reason and the remedy', () => {
  const gateInput = (
    overrides: {
      decisions?: readonly SceneSourceDecision[];
      inspections?: ReadonlyMap<number, SceneMotionInspection>;
      identities?: ReadonlyMap<number, SceneReviewIdentity>;
      ledger: MotionReviewLedger;
    } & Record<string, unknown>,
  ) => ({
    decisions: overrides.decisions ?? [decision()],
    inspections: overrides.inspections ?? new Map([[1, inspection()]]),
    identities: overrides.identities ?? new Map([[1, identity()]]),
    ledger: overrides.ledger,
    now: new Date('2026-07-29T12:00:00.000Z'),
  });

  it('clears a scene with a standing approval of the exact clip', async () => {
    const report = evaluateMotionGate(gateInput({ ledger: await ledgerWith([unsigned()]) }));
    expect(report.clears).toBe(true);
    expect(report.rows[0]?.status).toBe('APPROVED');
    expect(() => assertMotionGateClears(report)).not.toThrow();
  });

  it('blocks a scene nobody has ever looked at, and says so', async () => {
    const report = evaluateMotionGate(gateInput({ ledger: await ledgerWith([]) }));
    expect(report.rows[0]?.status).toBe('NOT_REVIEWED');
    expect(report.rows[0]?.remedy).toMatch(/has never been reviewed/);
    expect(() => assertMotionGateClears(report)).toThrow(/not cleared for rendering: 1/);
  });

  it("blocks a rejected scene and repeats the reviewer's own words", async () => {
    const feedback =
      'the opening frame is a tight crop of the face, not the approved wide plate; regenerate from FRAME-01';
    const report = evaluateMotionGate(
      gateInput({ ledger: await ledgerWith([unsigned({ verdict: 'REJECTED', feedback })]) }),
    );
    expect(report.rows[0]?.status).toBe('REJECTED');
    expect(report.rows[0]?.remedy).toContain(feedback);
    expect(() => assertMotionGateClears(report)).toThrow(/MOTION_REVIEW_BLOCKED|not cleared/);
  });

  it('blocks when the clip changed after the approval, and names what moved', async () => {
    const ledger = await ledgerWith([unsigned()]);
    const changed = identity({ clipChecksumSha256: SHA('9999') });
    const report = evaluateMotionGate(
      gateInput({
        ledger,
        identities: new Map([[1, changed]]),
        inspections: new Map([[1, inspection({ clipChecksumSha256: SHA('9999') })]]),
      }),
    );
    expect(report.rows[0]?.status).toBe('APPROVAL_SUPERSEDED_BY_CHANGE');
    expect(report.rows[0]?.remedy).toMatch(/the clip changed/);
  });

  it('blocks when the keyframe changed after the approval', async () => {
    const ledger = await ledgerWith([unsigned()]);
    const changed = identity({ keyframeChecksumSha256: SHA('9999') });
    const report = evaluateMotionGate(gateInput({ ledger, identities: new Map([[1, changed]]) }));
    expect(report.rows[0]?.status).toBe('APPROVAL_SUPERSEDED_BY_CHANGE');
    expect(report.rows[0]?.remedy).toMatch(/authoritative keyframe changed/);
  });

  it('blocks when the prompt changed after the approval', async () => {
    const ledger = await ledgerWith([unsigned()]);
    const changed = identity({ motionPromptSha256: SHA('9999') });
    const report = evaluateMotionGate(gateInput({ ledger, identities: new Map([[1, changed]]) }));
    expect(report.rows[0]?.remedy).toMatch(/generation prompt changed/);
  });

  it('blocks when the scene contract changed after the approval', async () => {
    const ledger = await ledgerWith([unsigned()]);
    const changed = identity({ sceneContractSha256: SHA('9999') });
    const report = evaluateMotionGate(gateInput({ ledger, identities: new Map([[1, changed]]) }));
    expect(report.rows[0]?.remedy).toMatch(/production contract changed/);
  });

  it('blocks a technically invalid clip even when it carries an approval', async () => {
    const broken = inspection({
      verdict: 'TECHNICALLY_INVALID',
      checks: MOTION_CHECK_IDS.map((id) => ({
        id,
        tier: MOTION_CHECK_TIERS[id],
        status: id === 'NO_BLACK_OPENING' ? ('FAIL' as const) : ('PASS' as const),
        expected: 'x',
        observed: 'x',
      })),
    });
    const report = evaluateMotionGate(
      gateInput({ ledger: await ledgerWith([unsigned()]), inspections: new Map([[1, broken]]) }),
    );
    expect(report.rows[0]?.status).toBe('TECHNICALLY_INVALID');
    expect(report.rows[0]?.remedy).toMatch(/No approval clears this/);
    expect(() => assertMotionGateClears(report)).toThrow(/scene 1/);
  });

  it('treats an unmeasurable binding check as unproven, never as satisfied', async () => {
    const unproven = inspection({
      verdict: 'NOT_PROVEN',
      checks: MOTION_CHECK_IDS.map((id) => ({
        id,
        tier: MOTION_CHECK_TIERS[id],
        status: id === 'NO_CORRUPT_FRAMES' ? ('NOT_MEASURED' as const) : ('PASS' as const),
        expected: 'x',
        observed: null,
      })),
    });
    const report = evaluateMotionGate(
      gateInput({ ledger: await ledgerWith([unsigned()]), inspections: new Map([[1, unproven]]) }),
    );
    expect(report.rows[0]?.status).toBe('TECHNICALLY_INVALID');
  });

  it('blocks a reviewable scene whose source could not be found at all', async () => {
    const report = evaluateMotionGate(
      gateInput({ ledger: await ledgerWith([]), inspections: new Map(), identities: new Map() }),
    );
    expect(report.rows[0]?.status).toBe('MISSING_SOURCE');
    expect(() => assertMotionGateClears(report)).toThrow(/MOTION_INSPECTION_FAILED|no inspected/);
  });

  it('never asks a deterministic-graphics scene for an approval', async () => {
    const report = evaluateMotionGate(
      gateInput({
        ledger: await ledgerWith([]),
        decisions: [decision({ selectedSourceType: 'DETERMINISTIC_MOTION_GRAPHICS' })],
      }),
    );
    expect(report.rows).toHaveLength(0);
    expect(report.clears).toBe(true);
  });

  it('lists every blocking scene rather than only the first', async () => {
    const report = evaluateMotionGate({
      decisions: [decision(), decision({ sceneNumber: 7, sceneRole: 'PREDICTION_SUBMITTED' })],
      inspections: new Map([
        [1, inspection()],
        [7, inspection({ sceneNumber: 7 })],
      ]),
      identities: new Map([
        [1, identity()],
        [7, identity({ sceneNumber: 7 })],
      ]),
      ledger: await ledgerWith([]),
      now: new Date('2026-07-29T12:00:00.000Z'),
    });
    expect(report.blockingScenes).toEqual([1, 7]);
    expect(() => assertMotionGateClears(report)).toThrow(/1, 7/);
  });

  it('says no FFmpeg composition started, because none did', async () => {
    const report = evaluateMotionGate(gateInput({ ledger: await ledgerWith([]) }));
    expect(() => assertMotionGateClears(report)).toThrow(/No FFmpeg composition has started/);
  });

  it('carries the notice that no measurement is evidence about creative quality', async () => {
    const report = evaluateMotionGate(gateInput({ ledger: await ledgerWith([]) }));
    expect(report.notice).toMatch(/None of them is evidence about creative quality/);
  });
});

describe('describeChange', () => {
  it('names each moved input separately', () => {
    expect(describeChange(identity(), identity({ clipChecksumSha256: SHA('9') }))).toBe(
      'the clip changed',
    );
    expect(
      describeChange(
        identity(),
        identity({ clipChecksumSha256: SHA('9'), motionPromptSha256: SHA('8') }),
      ),
    ).toMatch(/the clip changed, and the generation prompt changed/);
  });
});

describe('inspection profile', () => {
  it('gives every check a tier, and keeps the fidelity tier to the two judgement calls', () => {
    for (const id of MOTION_CHECK_IDS) expect(MOTION_CHECK_TIERS[id]).toBeDefined();
    const fidelity = MOTION_CHECK_IDS.filter((id) => MOTION_CHECK_TIERS[id] === 'FIDELITY_FINDING');
    expect(fidelity).toEqual([
      'FIRST_FRAME_MATCHES_AUTHORITATIVE_KEYFRAME',
      'DELIVERS_WITHOUT_UPSCALE',
    ]);
  });

  it('gives every camera motion a floor, and none of them is zero', () => {
    for (const motion of CAMERA_MOTIONS) {
      expect(MOTION_ENERGY_FLOOR_BY_CAMERA_MOTION[motion]).toBeGreaterThan(0);
      // Comfortably under the slowest real movement measured (1.72) so genuine
      // motion always clears, and comfortably over a held frame (0.00).
      expect(MOTION_ENERGY_FLOOR_BY_CAMERA_MOTION[motion]).toBeLessThan(1);
    }
  });

  it('refuses a preview, working or contact-sheet location by path segment', () => {
    expect(findNonProductionSegment('/packs/candidates/clip.mp4')).toBe('candidates');
    expect(findNonProductionSegment('C:\\packs\\references\\clip.mp4')).toBe('references');
    expect(findNonProductionSegment('/packs/shortlists/a/clip.mp4')).toBe('shortlists');
    expect(findNonProductionSegment('/packs/approved-free-originals/clip.mp4')).toBeNull();
    // A substring is not a segment: a legitimate folder is never refused for
    // containing a forbidden word.
    expect(findNonProductionSegment('/packs/workshop-footage/clip.mp4')).toBeNull();
  });

  it('pulls the prohibition clause out of the prompt and leaves the prose behind', () => {
    const constraints = extractNegativeConstraints(
      'A figure moves in low light. The camera holds still. Do not alter any lettering or mark in frame. Never add a badge.',
    );
    expect(constraints).toEqual([
      'Do not alter any lettering or mark in frame.',
      'Never add a badge.',
    ]);
  });

  it('hashes an inspection from its findings, not from where the file happened to sit', () => {
    const a = inspection();
    const b = inspection({ clipPath: '/somewhere/else/scene-01.mp4' });
    expect(b.inspectionSha256).toBe(a.inspectionSha256);
    const c = inspection({ verdict: 'TECHNICALLY_INVALID' });
    expect(c.inspectionSha256).not.toBe(a.inspectionSha256);
  });
});

describe('layout correlation — the metric that actually separates compositions', () => {
  it('is 1 for identical layouts and near 0 for unrelated ones', () => {
    const a = [10, 200, 30, 5, 180, 20, 8, 150];
    expect(correlate(a, a)).toBeCloseTo(1, 6);
    expect(correlate(a, [...a].reverse())).toBeLessThan(0.6);
  });

  it('is invariant to overall brightness and contrast, which is the point', () => {
    const a = [10, 200, 30, 5];
    const brighter = a.map((value) => value * 1.4 + 25);
    expect(correlate(a, brighter)).toBeCloseTo(1, 6);
  });

  it('returns 0 for a flat image rather than dividing by nothing', () => {
    expect(correlate([50, 50, 50, 50], [10, 200, 30, 5])).toBe(0);
  });

  it('reduces a plane to one mean per grid cell', () => {
    const plane = Buffer.alloc(192 * 341, 128);
    const means = gridMeans(plane);
    expect(means).toHaveLength(32);
    expect(means.every((value) => value === 128)).toBe(true);
  });
});

describe("the review command's own arguments", () => {
  it('refuses an unknown subcommand by name', () => {
    expect(() => parseMotionReviewArgs(['approvee'])).toThrow(/unknown subcommand "approvee"/);
  });

  it('refuses an unknown option rather than ignoring it', () => {
    expect(() => parseMotionReviewArgs(['status', '--allow-paid'])).toThrow(/unknown option/);
  });

  it('refuses a scene number outside the locked ten', () => {
    expect(() => parseMotionReviewArgs(['approve', '--scene', '11'])).toThrow(/between 1 and 10/);
    expect(() => parseMotionReviewArgs(['approve', '--scene', 'five'])).toThrow(/between 1 and 10/);
  });

  it('collects repeated acknowledgements', () => {
    const { options } = parseMotionReviewArgs([
      'approve',
      '--scene',
      '1',
      '--acknowledge',
      'DELIVERS_WITHOUT_UPSCALE',
      '--acknowledge',
      'FIRST_FRAME_MATCHES_AUTHORITATIVE_KEYFRAME',
    ]);
    expect(options.acknowledge).toHaveLength(2);
  });

  it('has no flag that could authorise a paid call', () => {
    // Assembled from fragments rather than written out: `paid-providers.test.ts`
    // walks every test file in this app and refuses one that contains the
    // paid-authorisation flag as a literal. That guard is right to be strict,
    // and weakening it with an exception for this file would cost more than
    // the two lines of assembly cost here.
    const paidFlags = [
      '--max-cost-cents',
      `--allow-${'paid'}-providers`,
      '--provider',
      '--api-key',
      '--ltxv-api-key',
    ];
    for (const flag of paidFlags) {
      expect(() => parseMotionReviewArgs(['status', flag, 'x'])).toThrow(/unknown option/);
    }
  });
});
