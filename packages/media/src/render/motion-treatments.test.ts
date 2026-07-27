import { describe, expect, it } from 'vitest';

import { FilterPrimitiveError, hexToFfmpegColorWithAlpha, num } from './filter-primitives';
import {
  captionEntranceOverride,
  catalogueInventory,
  compileDecorationTreatment,
  compileSceneTreatment,
  compileTransitionTreatment,
  ctaEntranceOverride,
  MOTION_TREATMENT_CATALOGUE_VERSION,
  MotionTreatmentError,
  SCENE_TREATMENT_KEYS,
  sceneTreatmentAccepts,
  type SceneTreatmentCompileInput,
  type SceneTreatmentKey,
} from './motion-treatments';

/**
 * The catalogue's contract is narrow and worth stating precisely: it is the
 * only producer of motion grammar, it is deterministic, and it refuses a
 * treatment a source cannot carry rather than emitting a graph FFmpeg will
 * reject mid-encode.
 */

function sceneInput(
  overrides: Partial<SceneTreatmentCompileInput> = {},
): SceneTreatmentCompileInput {
  return {
    inputLabel: '0:v',
    outputLabel: 'v0',
    scopeTag: 't0',
    intensity: 0.5,
    durationSeconds: 3,
    frameRate: 30,
    widthPx: 1080,
    heightPx: 1920,
    sourceKind: 'VIDEO',
    framing: { mode: 'COVER', anchorX: 0.5, anchorY: 0.5 },
    ...overrides,
  };
}

/** A treatment's own accepted kind, so every key can be exercised generically. */
function inputFor(key: SceneTreatmentKey): SceneTreatmentCompileInput {
  const accepts = sceneTreatmentAccepts(key);
  return sceneInput({ sourceKind: accepts.includes('VIDEO') ? 'VIDEO' : 'IMAGE' });
}

describe('motion-treatment catalogue — determinism', () => {
  it('produces byte-identical filters for identical inputs, for every treatment', () => {
    for (const key of SCENE_TREATMENT_KEYS) {
      const first = compileSceneTreatment(key, inputFor(key));
      const second = compileSceneTreatment(key, inputFor(key));
      expect(second.graph, `${key} is not deterministic`).toBe(first.graph);
    }
  });

  it('produces a different graph when the intensity changes, for every moving treatment', () => {
    const moving = SCENE_TREATMENT_KEYS.filter((key) => key !== 'STATIC_HOLD');
    for (const key of moving) {
      const low = compileSceneTreatment(key, { ...inputFor(key), intensity: 0.1 });
      const high = compileSceneTreatment(key, { ...inputFor(key), intensity: 0.9 });
      expect(high.graph, `${key} ignores its intensity`).not.toBe(low.graph);
    }
  });

  it('stamps every compiled treatment with the catalogue version', () => {
    for (const key of SCENE_TREATMENT_KEYS) {
      expect(compileSceneTreatment(key, inputFor(key)).catalogueVersion).toBe(
        MOTION_TREATMENT_CATALOGUE_VERSION,
      );
    }
  });

  it('always produces the requested output label exactly once', () => {
    for (const key of SCENE_TREATMENT_KEYS) {
      const { graph } = compileSceneTreatment(key, inputFor(key));
      const occurrences = graph.split('[v0]').length - 1;
      expect(occurrences, `${key} does not terminate on [v0] exactly once`).toBe(1);
    }
  });
});

describe('motion-treatment catalogue — refusals', () => {
  it('refuses a still-only treatment on a video source, naming what it accepts', () => {
    expect(() =>
      compileSceneTreatment('APP_SCREENSHOT_PARALLAX', sceneInput({ sourceKind: 'VIDEO' })),
    ).toThrow(MotionTreatmentError);
    expect(() =>
      compileSceneTreatment('FRAMED_PHONE_UI', sceneInput({ sourceKind: 'VIDEO' })),
    ).toThrow(/accepts IMAGE/);
  });

  it('refuses a video-only treatment on a still', () => {
    expect(() =>
      compileSceneTreatment('SAFE_SPEED_RAMP', sceneInput({ sourceKind: 'IMAGE' })),
    ).toThrow(/accepts VIDEO/);
    expect(() =>
      compileSceneTreatment('IMPACT_FREEZE', sceneInput({ sourceKind: 'IMAGE' })),
    ).toThrow(/accepts VIDEO/);
  });

  it('refuses an out-of-range intensity rather than clamping it', () => {
    expect(() => compileSceneTreatment('PUSH_IN', sceneInput({ intensity: 1.4 }))).toThrow(
      /between 0 and 1/,
    );
    expect(() => compileSceneTreatment('PUSH_IN', sceneInput({ intensity: -0.1 }))).toThrow(
      /between 0 and 1/,
    );
    expect(() => compileSceneTreatment('PUSH_IN', sceneInput({ intensity: Number.NaN }))).toThrow(
      /between 0 and 1/,
    );
  });

  it('refuses a non-positive duration', () => {
    expect(() => compileSceneTreatment('PUSH_IN', sceneInput({ durationSeconds: 0 }))).toThrow(
      /positive duration/,
    );
  });

  it('refuses an unknown treatment key', () => {
    expect(() =>
      compileSceneTreatment('NOT_A_TREATMENT' as SceneTreatmentKey, sceneInput()),
    ).toThrow(MotionTreatmentError);
  });
});

describe('motion-treatment catalogue — what each treatment actually emits', () => {
  it('drives a push-in and a pull-out in opposite directions', () => {
    const inGraph = compileSceneTreatment('PUSH_IN', sceneInput()).graph;
    const outGraph = compileSceneTreatment('PULL_OUT', sceneInput()).graph;
    expect(inGraph).toContain('zoompan=');
    expect(outGraph).toContain('zoompan=');
    expect(inGraph).not.toBe(outGraph);
  });

  it('keeps a speed ramp monotonic and bounded, so the scene still lands on its duration', () => {
    const graph = compileSceneTreatment(
      'SAFE_SPEED_RAMP',
      sceneInput({ intensity: 1, durationSeconds: 4 }),
    ).graph;
    expect(graph).toContain('setpts=');
    // The ramp's own trim is the scene duration: a ramp redistributes time, it
    // never creates or destroys any.
    expect(graph).toContain(`trim=duration=${num(4)}`);
  });

  it('holds a real frame for an impact freeze rather than slowing the picture', () => {
    const graph = compileSceneTreatment(
      'IMPACT_FREEZE',
      sceneInput({ intensity: 0.5, durationSeconds: 3 }),
    ).graph;
    expect(graph).toContain('tpad=stop_mode=clone');
  });

  it('refuses an impact freeze whose hold would not fit the scene', () => {
    expect(() =>
      compileSceneTreatment('IMPACT_FREEZE', sceneInput({ durationSeconds: 0.001 })),
    ).toThrow(MotionTreatmentError);
  });

  it('decays an impact flash to zero rather than leaving the frame lifted', () => {
    const graph = compileSceneTreatment('IMPACT_FLASH', sceneInput()).graph;
    expect(graph).toContain('eq=brightness=');
    expect(graph).toContain('eval=frame');
  });

  it('gives a parallax two moving planes and a framed UI only one', () => {
    const parallax = compileSceneTreatment(
      'APP_SCREENSHOT_PARALLAX',
      sceneInput({ sourceKind: 'IMAGE' }),
    ).graph;
    const framed = compileSceneTreatment(
      'FRAMED_PHONE_UI',
      sceneInput({ sourceKind: 'IMAGE' }),
    ).graph;
    expect(parallax).toContain('zoompan=');
    expect(framed).not.toContain('zoompan=');
    // Both bezel the screenshot; only one drifts it.
    expect(parallax).toContain('pad=iw+');
    expect(framed).toContain('pad=iw+');
  });

  it('pads a CONTAIN scene with a blurred backplate rather than hard bars', () => {
    const graph = compileSceneTreatment(
      'STATIC_HOLD',
      sceneInput({ framing: { mode: 'CONTAIN', anchorX: 0.5, anchorY: 0.5 } }),
    ).graph;
    expect(graph).toContain('gblur=');
    expect(graph).toContain('force_original_aspect_ratio=decrease');
  });

  it('normalises every scene onto a shared timebase so any scene can follow any other', () => {
    for (const key of SCENE_TREATMENT_KEYS) {
      expect(compileSceneTreatment(key, inputFor(key)).graph, `${key} omits settb`).toContain(
        'settb=AVTB',
      );
    }
  });
});

describe('motion-treatment catalogue — transitions and decorations', () => {
  it('maps every transition onto an xfade name', () => {
    for (const key of catalogueInventory().TRANSITION) {
      const compiled = compileTransitionTreatment(key as 'CUT');
      expect(compiled.xfadeName.length).toBeGreaterThan(0);
      expect(compiled.catalogueVersion).toBe(MOTION_TREATMENT_CATALOGUE_VERSION);
    }
  });

  it('refuses an unknown transition rather than falling back to a cut', () => {
    expect(() => compileTransitionTreatment('SWIRL' as 'CUT')).toThrow(MotionTreatmentError);
  });

  it('fills a callout and outlines an accent, with a validated colour', () => {
    const base = {
      baseLabel: 'c1',
      outputLabel: 'c2',
      colorHex: '#FF3B30',
      opacity: 0.9,
      xPx: 60,
      yPx: 1400,
      widthPx: 400,
      heightPx: 120,
      thicknessPx: 6,
      startSeconds: 1,
      endSeconds: 3,
    };
    const callout = compileDecorationTreatment('BRAND_COLOUR_CALLOUT', base);
    const outline = compileDecorationTreatment('ACCENT_OUTLINE', base);

    expect(callout.graph).toContain('t=fill');
    expect(outline.graph).toContain('t=6');
    expect(callout.graph).toContain(hexToFfmpegColorWithAlpha('#FF3B30', 0.9));
    expect(callout.graph).toContain("enable='between(t,1,3)'");
  });

  it('refuses a colour that is not #RRGGBB, rather than interpolating it', () => {
    expect(() =>
      compileDecorationTreatment('ACCENT_OUTLINE', {
        baseLabel: 'c1',
        outputLabel: 'c2',
        colorHex: 'red:t=fill',
        opacity: 1,
        xPx: 0,
        yPx: 0,
        widthPx: 10,
        heightPx: 10,
        thicknessPx: 2,
        startSeconds: 0,
        endSeconds: 1,
      }),
    ).toThrow(FilterPrimitiveError);
  });

  it('refuses a decoration window that ends before it starts', () => {
    expect(() =>
      compileDecorationTreatment('ACCENT_OUTLINE', {
        baseLabel: 'c1',
        outputLabel: 'c2',
        colorHex: '#FFFFFF',
        opacity: 1,
        xPx: 0,
        yPx: 0,
        widthPx: 10,
        heightPx: 10,
        thicknessPx: 2,
        startSeconds: 3,
        endSeconds: 1,
      }),
    ).toThrow(MotionTreatmentError);
  });
});

describe('motion-treatment catalogue — typography', () => {
  const anchor = { xPx: 540, yPx: 1500, alignment: 2, fadeMs: 240 };

  it('produces a distinct ASS override per caption entrance', () => {
    const overrides = catalogueInventory()
      .TYPOGRAPHY.filter((key) => ['FADE', 'RISE', 'POP', 'SNAP'].includes(key))
      .map((key) => captionEntranceOverride(key as 'FADE', anchor));
    expect(new Set(overrides).size).toBe(overrides.length);
    for (const override of overrides) {
      expect(override.startsWith('{')).toBe(true);
      expect(override.endsWith('}')).toBe(true);
    }
  });

  it('never lets a coordinate reach an override as anything but an integer', () => {
    const override = captionEntranceOverride('RISE', { ...anchor, xPx: 540.4, yPx: 1500.6 });
    expect(override).toContain('540');
    expect(override).not.toMatch(/540\.4/);
  });

  it('gives the CTA a settled hold under every entrance', () => {
    for (const key of ['RISE_AND_SCALE', 'FADE_HOLD', 'SNAP_HOLD'] as const) {
      const override = ctaEntranceOverride(key, anchor);
      expect(override).toContain('\\pos(540,1500)');
    }
  });

  it('refuses an unknown entrance rather than silently rendering static type', () => {
    expect(() => captionEntranceOverride('SPIN' as 'FADE', anchor)).toThrow(MotionTreatmentError);
    expect(() => ctaEntranceOverride('SPIN' as 'FADE_HOLD', anchor)).toThrow(MotionTreatmentError);
  });
});
