import { describe, expect, it } from 'vitest';

import { FilterPrimitiveError, hexToFfmpegColorWithAlpha, num } from './filter-primitives';
import {
  captionEntranceOverride,
  catalogueInventory,
  compileDecorationTreatment,
  compileSceneGrade,
  compileSceneTreatment,
  compileTransitionTreatment,
  ctaEntranceOverride,
  GRADE_TREATMENT_KEYS,
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

function firstOf<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('expected at least one value');
  return value;
}

function lastOf<T>(values: readonly T[]): T {
  const value = values[values.length - 1];
  if (value === undefined) throw new Error('expected at least one value');
  return value;
}

/** The geometry every finishing-decoration case starts from. */
const FINISHING_BASE = {
  baseLabel: 'c1',
  outputLabel: 'c2',
  frameWidthPx: 1080,
  frameHeightPx: 1920,
  colorHex: '#0A0A0A',
  opacity: 0.72,
  xPx: 0,
  yPx: 0,
  widthPx: 1080,
  heightPx: 1920,
  thicknessPx: 6,
  startSeconds: 1,
  endSeconds: 3,
} as const;

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
      frameWidthPx: 1080,
      frameHeightPx: 1920,
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
        frameWidthPx: 1080,
        frameHeightPx: 1920,
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

  it('dims all four bands around a focus region and leaves the region alone', () => {
    const compiled = compileDecorationTreatment('FOCUS_DIM', {
      ...FINISHING_BASE,
      xPx: 140,
      yPx: 600,
      widthPx: 800,
      heightPx: 700,
    });
    const boxes = compiled.graph.match(/drawbox=/g) ?? [];
    expect(boxes).toHaveLength(4);
    // Above, below, left, right — and never the region itself.
    expect(compiled.graph).toContain('drawbox=x=0:y=0:w=1080:h=600');
    expect(compiled.graph).toContain('drawbox=x=0:y=1300:w=1080:h=620');
    expect(compiled.graph).toContain('drawbox=x=0:y=600:w=140:h=700');
    expect(compiled.graph).toContain('drawbox=x=940:y=600:w=140:h=700');
    expect(compiled.graph).not.toContain('drawbox=x=140:y=600:w=800:h=700');
  });

  it('omits an empty band rather than emitting a zero-extent drawbox', () => {
    const compiled = compileDecorationTreatment('FOCUS_DIM', {
      ...FINISHING_BASE,
      xPx: 0,
      yPx: 400,
      widthPx: 1080,
      heightPx: 700,
    });
    expect(compiled.graph.match(/drawbox=/g) ?? []).toHaveLength(2);
    expect(compiled.graph).not.toContain(':w=0:');
    expect(compiled.graph).not.toContain(':h=0:');
  });

  it('refuses a FOCUS_DIM that leaves nothing in focus', () => {
    expect(() =>
      compileDecorationTreatment('FOCUS_DIM', {
        ...FINISHING_BASE,
        xPx: 0,
        yPx: 0,
        widthPx: 1080,
        heightPx: 1920,
      }),
    ).toThrow(MotionTreatmentError);
  });

  /**
   * The property that matters for both moving decorations: `drawbox` cannot
   * evaluate a timestamp, so movement has to be a series of static boxes with
   * disjoint enable windows. A graph containing `t` inside an expression would
   * be reading the thickness and standing still.
   */
  for (const key of ['TAP_INDICATOR', 'LIGHT_SWEEP'] as const) {
    it(`${key} moves by stepping static boxes, never by an unevaluated expression`, () => {
      const compiled = compileDecorationTreatment(key, {
        ...FINISHING_BASE,
        xPx: 100,
        yPx: 700,
        widthPx: 700,
        heightPx: 400,
        startSeconds: 2,
        endSeconds: 3,
      });
      const steps = compiled.graph.match(/enable='between\(t,[\d.]+,[\d.]+\)'/g) ?? [];
      expect(steps.length).toBeGreaterThan(4);
      expect(new Set(steps).size).toBe(steps.length);
      // No drawbox geometry is quoted, which is what an expression would need.
      expect(compiled.graph).not.toMatch(/[xywh]='/);
      // Every step sits inside the decoration's own window.
      for (const step of steps) {
        const [from, to] = (step.match(/between\(t,([\d.]+),([\d.]+)\)/) ?? [])
          .slice(1)
          .map(Number);
        expect(from).toBeGreaterThanOrEqual(2);
        expect(to).toBeLessThanOrEqual(3);
      }
    });
  }

  it('sweeps a light band across the region without spilling outside it', () => {
    const compiled = compileDecorationTreatment('LIGHT_SWEEP', {
      ...FINISHING_BASE,
      xPx: 100,
      yPx: 700,
      widthPx: 700,
      heightPx: 400,
    });
    const bands = [...compiled.graph.matchAll(/drawbox=x=(\d+):y=\d+:w=(\d+)/g)].map(
      ([, x, width]) => ({ x: Number(x), width: Number(width) }),
    );
    expect(bands.length).toBeGreaterThan(4);
    for (const band of bands) {
      expect(band.x).toBeGreaterThanOrEqual(100);
      expect(band.x + band.width).toBeLessThanOrEqual(800);
    }
    // It actually travels: the last band starts well right of the first.
    expect(lastOf(bands).x).toBeGreaterThan(firstOf(bands).x);
  });

  it('fades the tap indicator as it expands', () => {
    const compiled = compileDecorationTreatment('TAP_INDICATOR', {
      ...FINISHING_BASE,
      xPx: 400,
      yPx: 800,
      widthPx: 280,
      heightPx: 280,
    });
    const widths = [...compiled.graph.matchAll(/drawbox=x=-?\d+:y=-?\d+:w=(\d+)/g)].map(
      ([, width]) => Number(width),
    );
    expect(lastOf(widths)).toBeGreaterThan(firstOf(widths));
    const alphas = [...compiled.graph.matchAll(/@([\d.]+):/g)].map(([, value]) => Number(value));
    expect(lastOf(alphas)).toBeLessThan(firstOf(alphas));
  });

  it('binds the whole-frame finishes to their declared window', () => {
    for (const key of ['EDGE_VIGNETTE', 'FILM_GRAIN'] as const) {
      const compiled = compileDecorationTreatment(key, {
        ...FINISHING_BASE,
        xPx: 0,
        yPx: 0,
        widthPx: 1080,
        heightPx: 1920,
      });
      expect(compiled.graph).toContain("enable='between(t,1,3)'");
    }
  });

  it('refuses a whole-frame finish that was given a partial region', () => {
    for (const key of ['EDGE_VIGNETTE', 'FILM_GRAIN'] as const) {
      expect(() =>
        compileDecorationTreatment(key, {
          ...FINISHING_BASE,
          xPx: 40,
          yPx: 40,
          widthPx: 600,
          heightPx: 600,
        }),
      ).toThrow(MotionTreatmentError);
    }
  });

  it('refuses a decoration window that ends before it starts', () => {
    expect(() =>
      compileDecorationTreatment('ACCENT_OUTLINE', {
        baseLabel: 'c1',
        outputLabel: 'c2',
        frameWidthPx: 1080,
        frameHeightPx: 1920,
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

describe('colour grades', () => {
  it('wires the chain from the label it was given to the label it was asked for', () => {
    const compiled = compileSceneGrade('BRAND_NOIR', {
      inputLabel: 'g3',
      outputLabel: 'v3',
      intensity: 0.5,
    });
    expect(compiled.graph.startsWith('[g3]')).toBe(true);
    expect(compiled.graph.endsWith('[v3]')).toBe(true);
    expect(compiled.family).toBe('GRADE');
    expect(compiled.catalogueVersion).toBe(MOTION_TREATMENT_CATALOGUE_VERSION);
  });

  it('leaves the picture alone at zero intensity', () => {
    const compiled = compileSceneGrade('BRAND_NOIR', {
      inputLabel: 'a',
      outputLabel: 'b',
      intensity: 0,
    });
    expect(compiled.graph).toContain('contrast=1');
    expect(compiled.graph).toContain('saturation=1');
    expect(compiled.graph).toContain('gamma=1');
  });

  it('tints only in BRAND_EMBER — BRAND_NOIR unifies without moving a hue', () => {
    const noir = compileSceneGrade('BRAND_NOIR', {
      inputLabel: 'a',
      outputLabel: 'b',
      intensity: 1,
    });
    const ember = compileSceneGrade('BRAND_EMBER', {
      inputLabel: 'a',
      outputLabel: 'b',
      intensity: 1,
    });
    expect(noir.graph).not.toContain('colorbalance');
    expect(ember.graph).toContain('colorbalance');
  });

  it('keeps the red lift out of the highlights, so a grade never becomes a cast', () => {
    const ember = compileSceneGrade('BRAND_EMBER', {
      inputLabel: 'a',
      outputLabel: 'b',
      intensity: 1,
    });
    // Shadows (`rs`) and midtones (`rm`) only. A highlight term would be `rh`.
    expect(ember.graph).toMatch(/colorbalance=rs=[^:]+:rm=[^:]+:bs=[^:]+:bm=[^:\]]+/);
    expect(ember.graph).not.toContain('rh=');
  });

  it('is deterministic — the same input compiles to byte-identical grammar', () => {
    const once = compileSceneGrade('BRAND_EMBER', {
      inputLabel: 'g0',
      outputLabel: 'v0',
      intensity: 0.62,
    });
    const twice = compileSceneGrade('BRAND_EMBER', {
      inputLabel: 'g0',
      outputLabel: 'v0',
      intensity: 0.62,
    });
    expect(once.graph).toBe(twice.graph);
  });

  it('refuses an unknown grade rather than passing the picture through ungraded', () => {
    expect(() =>
      compileSceneGrade('SEPIA' as 'BRAND_NOIR', {
        inputLabel: 'a',
        outputLabel: 'b',
        intensity: 0.5,
      }),
    ).toThrow(MotionTreatmentError);
  });

  it('refuses an out-of-range intensity', () => {
    for (const intensity of [-0.1, 1.4, Number.NaN]) {
      expect(() =>
        compileSceneGrade('BRAND_NOIR', { inputLabel: 'a', outputLabel: 'b', intensity }),
      ).toThrow(MotionTreatmentError);
    }
  });

  it('lists the grade family in the catalogue inventory', () => {
    expect(catalogueInventory().GRADE).toEqual(GRADE_TREATMENT_KEYS);
  });
});
