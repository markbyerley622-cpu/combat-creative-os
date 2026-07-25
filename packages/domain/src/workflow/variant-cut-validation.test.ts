import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VERTICAL_SHORT_FORM_V1 } from '../schemas/delivery-profile';
import type {
  RetainedCaption,
  RetainedClip,
  VariantCutPoint,
} from '../schemas/variant-specification';
import {
  timelineBoundaries,
  validateVariantCut,
  type VariantCutValidationInput,
  type VariantCutViolationCode,
} from './variant-cut-validation';

/**
 * Fixture master: four shots at 30fps on a 450-frame (15s) timeline —
 * HOOK 0..120, PROMISE 120..270, FEATURE 270..390, CTA 390..450. Chosen so
 * both shorter targets land exactly on shot boundaries: 10s (300 frames) =
 * HOOK + FEATURE + CTA, and 6s (180 frames) = HOOK + CTA.
 */
const SHOT_HOOK = randomUUID();
const SHOT_PROMISE = randomUUID();
const SHOT_FEATURE = randomUUID();
const SHOT_CTA = randomUUID();

const ENTRIES = [
  { shotId: SHOT_HOOK, order: 0, startFrame: 0, durationFrames: 120 },
  { shotId: SHOT_PROMISE, order: 1, startFrame: 120, durationFrames: 150 },
  { shotId: SHOT_FEATURE, order: 2, startFrame: 270, durationFrames: 120 },
  { shotId: SHOT_CTA, order: 3, startFrame: 390, durationFrames: 60 },
];
const BEATS: Record<string, string> = {
  [SHOT_HOOK]: 'HOOK',
  [SHOT_PROMISE]: 'PROMISE',
  [SHOT_FEATURE]: 'FEATURE',
  [SHOT_CTA]: 'CTA',
};
const SEGMENTS = timelineBoundaries(ENTRIES, BEATS);

/**
 * Discrete SFX/VO cues, aligned to shot boundaries. The continuous MUSIC bed
 * spanning 0..450 is deliberately NOT here — it is re-mixed to length, not a
 * hard cut boundary (see `AudioCueSegment`'s doc comment).
 */
const AUDIO_CUES = [
  { soundCueId: randomUUID(), startFrame: 120, endFrame: 270 },
  { soundCueId: randomUUID(), startFrame: 390, endFrame: 450 },
];
const CAPTION_SEGMENTS = [
  { startFrame: 0, endFrame: 120 },
  { startFrame: 120, endFrame: 270 },
  { startFrame: 270, endFrame: 390 },
  { startFrame: 390, endFrame: 450 },
];
const PARENT_CTA = { startFrame: 390, endFrame: 450 };

function clip(shotId: string, start: number, end: number, order: number): RetainedClip {
  return {
    order,
    shotId,
    shotIndex: order,
    sourceAssetId: randomUUID(),
    beat: BEATS[shotId] as RetainedClip['beat'],
    sourceStartFrame: start,
    sourceEndFrame: end,
    transitionIn: 'CUT',
  };
}

function caption(start: number, end: number): RetainedCaption {
  return { text: 'caption', variantStartFrame: start, variantEndFrame: end, safeArea: 'BOTTOM' };
}

/**
 * The legal 10s cut: HOOK (0..120) + FEATURE+CTA (270..450) = 300 frames,
 * every boundary on a real TimelineEntry edge, PROMISE dropped.
 */
function tenSecondCut(): VariantCutPoint[] {
  return [
    { order: 0, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 0 },
    { order: 1, sourceStartFrame: 270, sourceEndFrame: 450, variantStartFrame: 120 },
  ];
}

function buildInput(overrides: Partial<VariantCutValidationInput> = {}): VariantCutValidationInput {
  const cutPoints = overrides.cutPoints ?? tenSecondCut();
  return {
    profile: VERTICAL_SHORT_FORM_V1,
    targetDurationSeconds: 10,
    cutPoints,
    retainedClips: overrides.retainedClips ?? [
      clip(SHOT_HOOK, 0, 120, 0),
      clip(SHOT_FEATURE, 270, 390, 1),
      clip(SHOT_CTA, 390, 450, 2),
    ],
    retainedCues: overrides.retainedCues ?? [],
    retainedCaptions: overrides.retainedCaptions ?? [caption(0, 120), caption(120, 300)],
    ctaPlacement: overrides.ctaPlacement ?? {
      present: true,
      variantStartFrame: 240,
      variantEndFrame: 300,
      shotId: SHOT_CTA,
    },
    safeAreas: overrides.safeAreas ?? ['BOTTOM'],
    timelineSegments: overrides.timelineSegments ?? SEGMENTS,
    audioCues: overrides.audioCues ?? AUDIO_CUES,
    captionSegments: overrides.captionSegments ?? CAPTION_SEGMENTS,
    parentCtaSegment: 'parentCtaSegment' in overrides ? overrides.parentCtaSegment : PARENT_CTA,
    ...overrides,
  };
}

function codes(result: { violations: readonly { code: VariantCutViolationCode }[] }) {
  return result.violations.map((v) => v.code);
}

describe('validateVariantCut — legal cuts', () => {
  it('accepts the 15s full-length cut (the master itself)', () => {
    const result = validateVariantCut(
      buildInput({
        targetDurationSeconds: 15,
        cutPoints: [{ order: 0, sourceStartFrame: 0, sourceEndFrame: 450, variantStartFrame: 0 }],
        retainedClips: [
          clip(SHOT_HOOK, 0, 120, 0),
          clip(SHOT_PROMISE, 120, 270, 1),
          clip(SHOT_FEATURE, 270, 390, 2),
          clip(SHOT_CTA, 390, 450, 3),
        ],
        ctaPlacement: {
          present: true,
          variantStartFrame: 390,
          variantEndFrame: 450,
          shotId: SHOT_CTA,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.variantDurationFrames).toBe(450);
  });

  it('accepts the 10s cut that drops PROMISE and keeps the CTA in the tail', () => {
    const result = validateVariantCut(buildInput());

    expect(codes(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.variantDurationFrames).toBe(300);
  });

  it('accepts the 6s cut: HOOK + CTA, exactly 180 frames on real boundaries', () => {
    const result = validateVariantCut(
      buildInput({
        targetDurationSeconds: 6,
        cutPoints: [
          { order: 0, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 0 },
          { order: 1, sourceStartFrame: 390, sourceEndFrame: 450, variantStartFrame: 120 },
        ],
        retainedClips: [clip(SHOT_HOOK, 0, 120, 0), clip(SHOT_CTA, 390, 450, 1)],
        retainedCaptions: [caption(0, 120), caption(120, 180)],
        ctaPlacement: {
          present: true,
          variantStartFrame: 120,
          variantEndFrame: 180,
          shotId: SHOT_CTA,
        },
      }),
    );

    expect(codes(result)).toEqual([]);
    expect(result.variantDurationFrames).toBe(180);
  });

  it('exempts the 6s cut from the CTA-presence rule (below the profile minimum)', () => {
    const result = validateVariantCut(
      buildInput({
        targetDurationSeconds: 6,
        cutPoints: [
          { order: 0, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 0 },
          { order: 1, sourceStartFrame: 270, sourceEndFrame: 330, variantStartFrame: 120 },
        ],
        retainedClips: [clip(SHOT_HOOK, 0, 120, 0)],
        // No CTA retained — permitted, since 6 < ctaMinimumDurationSeconds (10).
        ctaPlacement: { present: false },
      }),
    );

    expect(codes(result)).not.toContain('CTA_MISSING');
    expect(codes(result)).not.toContain('CTA_NOT_IN_TAIL');
  });
});

describe('validateVariantCut — illegal cuts', () => {
  it('rejects a cut whose duration misses the target', () => {
    const result = validateVariantCut(
      buildInput({
        cutPoints: [{ order: 0, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 0 }],
      }),
    );

    expect(codes(result)).toContain('DURATION_MISMATCH');
  });

  it('rejects a mid-clip cut that is not on a timeline boundary', () => {
    const result = validateVariantCut(
      buildInput({
        cutPoints: [
          { order: 0, sourceStartFrame: 0, sourceEndFrame: 180, variantStartFrame: 0 },
          { order: 1, sourceStartFrame: 270, sourceEndFrame: 390, variantStartFrame: 180 },
        ],
      }),
    );

    expect(codes(result)).toContain('CUT_NOT_ON_TIMELINE_BOUNDARY');
    expect(codes(result)).toContain('CUT_SPLITS_CLIP');
  });

  it('rejects a cut that splits an audio cue', () => {
    const result = validateVariantCut(
      buildInput({
        // A discrete cue that does not align to shot boundaries: 100..200
        // straddles the 120 cut.
        audioCues: [{ soundCueId: randomUUID(), startFrame: 100, endFrame: 200 }],
      }),
    );

    expect(codes(result)).toContain('CUT_SPLITS_AUDIO_CUE');
  });

  it('rejects a cut that splits a caption span', () => {
    const result = validateVariantCut(
      buildInput({ captionSegments: [{ startFrame: 100, endFrame: 200 }] }),
    );

    expect(codes(result)).toContain('CUT_SPLITS_CAPTION');
  });

  it('rejects a cut that splits the CTA', () => {
    const result = validateVariantCut(
      buildInput({
        cutPoints: [
          { order: 0, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 0 },
          { order: 1, sourceStartFrame: 270, sourceEndFrame: 420, variantStartFrame: 120 },
        ],
        timelineSegments: timelineBoundaries(
          [...ENTRIES, { shotId: SHOT_CTA, order: 4, startFrame: 420, durationFrames: 30 }],
          BEATS,
        ),
      }),
    );

    expect(codes(result)).toContain('CUT_SPLITS_CTA');
  });

  it('rejects a cut that reorders the narrative', () => {
    const result = validateVariantCut(
      buildInput({
        cutPoints: [
          { order: 0, sourceStartFrame: 270, sourceEndFrame: 450, variantStartFrame: 0 },
          { order: 1, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 180 },
        ],
      }),
    );

    expect(codes(result)).toContain('NARRATIVE_ORDER_VIOLATED');
  });

  it('rejects overlapping cut points', () => {
    const result = validateVariantCut(
      buildInput({
        cutPoints: [
          { order: 0, sourceStartFrame: 0, sourceEndFrame: 270, variantStartFrame: 0 },
          { order: 1, sourceStartFrame: 120, sourceEndFrame: 270, variantStartFrame: 270 },
        ],
      }),
    );

    expect(codes(result)).toContain('OVERLAPPING_CUT_POINTS');
  });

  it('rejects a variant timeline with a gap', () => {
    const result = validateVariantCut(
      buildInput({
        cutPoints: [
          { order: 0, sourceStartFrame: 0, sourceEndFrame: 120, variantStartFrame: 0 },
          { order: 1, sourceStartFrame: 270, sourceEndFrame: 450, variantStartFrame: 999 },
        ],
      }),
    );

    expect(codes(result)).toContain('VARIANT_TIMELINE_NOT_CONTIGUOUS');
  });

  it('rejects a 10s cut that drops the CTA entirely', () => {
    const result = validateVariantCut(buildInput({ ctaPlacement: { present: false } }));

    expect(codes(result)).toContain('CTA_MISSING');
  });

  it('rejects a CTA that survived but no longer sits in the final two seconds', () => {
    const result = validateVariantCut(
      buildInput({
        ctaPlacement: {
          present: true,
          variantStartFrame: 0,
          variantEndFrame: 60,
          shotId: SHOT_CTA,
        },
      }),
    );

    expect(codes(result)).toContain('CTA_NOT_IN_TAIL');
  });

  it('rejects a cut retaining no captions when the profile requires a burn-in', () => {
    const result = validateVariantCut(buildInput({ retainedCaptions: [] }));

    expect(codes(result)).toContain('CAPTIONS_REQUIRED_BUT_ABSENT');
  });

  it('rejects a caption placed outside the profile safe areas', () => {
    const result = validateVariantCut(
      buildInput({
        retainedCaptions: [
          { text: 'x', variantStartFrame: 0, variantEndFrame: 120, safeArea: 'FULL_SAFE' },
        ],
      }),
    );

    expect(codes(result)).toContain('CAPTION_OUTSIDE_SAFE_AREA');
  });

  it('rejects a variant carrying no safe-area metadata', () => {
    const result = validateVariantCut(buildInput({ safeAreas: [] }));

    expect(codes(result)).toContain('SAFE_AREA_METADATA_MISSING');
  });

  it('rejects a retained clip that is not a span of any TimelineEntry', () => {
    const result = validateVariantCut(
      buildInput({ retainedClips: [clip(randomUUID(), 0, 120, 0)] }),
    );

    expect(codes(result)).toContain('RETAINED_CLIP_NOT_ON_TIMELINE');
  });

  it('rejects an empty cut outright', () => {
    const result = validateVariantCut(buildInput({ cutPoints: [] }));

    expect(codes(result)).toEqual(['NO_CUT_POINTS']);
    expect(result.variantDurationFrames).toBe(0);
  });
});

describe('timelineBoundaries', () => {
  it('turns TimelineEntries into ordered, exclusive-end legal boundaries with beats', () => {
    expect(timelineBoundaries(ENTRIES, BEATS)).toEqual([
      { order: 0, shotId: SHOT_HOOK, startFrame: 0, endFrame: 120, beat: 'HOOK' },
      { order: 1, shotId: SHOT_PROMISE, startFrame: 120, endFrame: 270, beat: 'PROMISE' },
      { order: 2, shotId: SHOT_FEATURE, startFrame: 270, endFrame: 390, beat: 'FEATURE' },
      { order: 3, shotId: SHOT_CTA, startFrame: 390, endFrame: 450, beat: 'CTA' },
    ]);
  });
});
