import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  compilePlateMotion,
  compileSheetOverlay,
  compileStoryExposureGrade,
  compileUiSceneComposite,
  evaluateSceneExposure,
  INTERFACE_EXPOSURE_REQUIREMENT,
  measureExposure,
  normaliseQuadForCover,
  STORY_COMPOSITE_ALLOWED_FILTERS,
  StoryCompositeError,
} from '@combat/media';
import { describe, expect, it } from 'vitest';

import { V2_CAMPAIGN_DIRECTORY } from '../flagship/flagship2-cli';
import { calibrateSceneScreen } from './screen-calibration-set';
import {
  parseProductStoryPlan,
  PREDICTION_INTERACTION_MAX_SECONDS,
  ProductStoryError,
  SCREEN_TREATMENTS,
  type ProductStoryPlan,
  type UiCompositeScene,
} from './story-contracts';
import { applyProductStoryRouting } from './story-routing';

const DELIVERY = { widthPx: 1080, heightPx: 1920 } as const;

async function committedPlan(): Promise<ProductStoryPlan> {
  const path = join(V2_CAMPAIGN_DIRECTORY, 'product-story.json');
  return parseProductStoryPlan(JSON.parse(await readFile(path, 'utf8')), path);
}

function uiScene(plan: ProductStoryPlan, sceneNumber: number): UiCompositeScene {
  const scene = plan.scenes.find((candidate) => candidate.sceneNumber === sceneNumber);
  if (!scene || scene.kind !== 'PLATE_UI_COMPOSITE') {
    throw new Error(`scene ${sceneNumber} is not a UI composite in the committed plan`);
  }
  return scene;
}

describe('the committed product story', () => {
  it('parses, and every scene the cut needs is declared exactly once', async () => {
    const plan = await committedPlan();
    const numbers = plan.scenes.map((scene) => scene.sceneNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan.transitions).toHaveLength(9);
  });

  it('names a human reviewer and says what the mockups do not assert', async () => {
    const plan = await committedPlan();
    expect(plan.authorisation.reviewer.length).toBeGreaterThan(0);
    expect(plan.authorisation.coveredSurfaces.length).toBeGreaterThanOrEqual(9);
    expect(plan.authorisation.notAsserted).toMatch(/not asserted as live user data/i);
  });

  it('calibrates all four handset screens inside their plates', async () => {
    const plan = await committedPlan();
    for (const sceneNumber of [3, 4, 6, 10]) {
      const calibration = calibrateSceneScreen(uiScene(plan, sceneNumber), DELIVERY);
      expect(calibration.geometry.convex).toBe(true);
      expect(calibration.cornersInsidePlate).toBe(true);
      // The canvas must cover the delivery frame in both axes or the warp is
      // cropped into nothing.
      expect(calibration.interfaceCanvas.widthPx).toBeGreaterThanOrEqual(DELIVERY.widthPx);
      expect(calibration.interfaceCanvas.heightPx).toBeGreaterThanOrEqual(DELIVERY.heightPx);
      // The CSS width is the canonical phone width on every plate; only the
      // height follows the calibrated screen.
      expect(calibration.viewport.cssWidthPx).toBe(393);
    }
  });

  it('keeps every prediction interaction inside the ceiling', async () => {
    const plan = await committedPlan();
    for (const scene of plan.scenes) {
      if (scene.kind !== 'PLATE_UI_COMPOSITE') continue;
      const interaction = scene.uiTimeline.interaction;
      if (!interaction) continue;
      expect(interaction.releasedAtSeconds - interaction.contactAtSeconds).toBeLessThanOrEqual(
        PREDICTION_INTERACTION_MAX_SECONDS + 1e-9,
      );
    }
  });

  it('fills every reserved region and declares a treatment the catalogue implements', async () => {
    const plan = await committedPlan();
    for (const scene of plan.scenes) {
      if (scene.kind === 'FOOTAGE_TREATMENT' && scene.protectedRegion) {
        expect(scene.treatment).toBeDefined();
      }
      if (scene.treatment) {
        expect(SCREEN_TREATMENTS).toContain(scene.treatment.key);
      }
    }
  });
});

describe('parseProductStoryPlan', () => {
  it('refuses a reserved region with nothing to fill it', async () => {
    const plan = await committedPlan();
    const broken = {
      ...plan,
      scenes: plan.scenes.map((scene) =>
        scene.sceneNumber === 8 ? { ...scene, treatment: undefined } : scene,
      ),
    };
    expect(() => parseProductStoryPlan(JSON.parse(JSON.stringify(broken)))).toThrow(
      /reserves a protected region but declares no screen treatment/,
    );
  });

  it('refuses transitions that do not join consecutive scenes', async () => {
    const plan = await committedPlan();
    const broken = {
      ...plan,
      transitions: plan.transitions.map((transition, index) =>
        index === 4 ? { ...transition, toScene: 8 } : transition,
      ),
    };
    expect(() => parseProductStoryPlan(broken)).toThrow(/must join consecutive scenes/);
  });

  it('refuses an interaction that takes longer than one decisive action', async () => {
    const plan = await committedPlan();
    const broken = {
      ...plan,
      scenes: plan.scenes.map((scene) =>
        scene.kind === 'PLATE_UI_COMPOSITE' && scene.uiTimeline.interaction
          ? {
              ...scene,
              uiTimeline: {
                ...scene.uiTimeline,
                interaction: { ...scene.uiTimeline.interaction, releasedAtSeconds: 3.4 },
              },
            }
          : scene,
      ),
    };
    expect(() => parseProductStoryPlan(broken)).toThrow(/above the 0.9s ceiling/);
  });
});

describe('screen calibration', () => {
  it('refuses a corner off the plate rather than clamping it', async () => {
    const plan = await committedPlan();
    const scene = uiScene(plan, 3);
    expect(() =>
      calibrateSceneScreen(
        { ...scene, screen: { ...scene.screen, topLeft: { xPx: -40, yPx: 464 } } },
        DELIVERY,
      ),
    ).toThrow(ProductStoryError);
  });

  it('refuses a transposed pair, which the geometry checks cannot catch', async () => {
    const plan = await committedPlan();
    const scene = uiScene(plan, 3);
    expect(() =>
      calibrateSceneScreen(
        {
          ...scene,
          screen: {
            ...scene.screen,
            bottomLeft: scene.screen.bottomRight,
            bottomRight: scene.screen.bottomLeft,
          },
        },
        DELIVERY,
      ),
    ).toThrow(/transposed/);
  });
});

describe('the story compositor', () => {
  const quad = normaliseQuadForCover(
    {
      topLeft: { xPx: 114, yPx: 464 },
      topRight: { xPx: 408, yPx: 499 },
      bottomLeft: { xPx: 115, yPx: 1336 },
      bottomRight: { xPx: 415, yPx: 1304 },
    },
    { sourceWidthPx: 941, sourceHeightPx: 1672, outputWidthPx: 1080, outputHeightPx: 1920 },
  );
  const move = { startZoom: 1, endZoom: 1.02, panCentreU: 0.5, panCentreV: 0.5, frames: 60 };

  const spec = {
    sceneId: 'scene03',
    plateInputIndex: 0,
    uiInputIndex: 1,
    outputWidthPx: 1080,
    outputHeightPx: 1920,
    uiCanvasWidthPx: 1572,
    uiCanvasHeightPx: 4412,
    frameRate: 30,
    durationSeconds: 2,
    quad,
    move,
  } as const;

  it('never emits a filter that could expose a border or letterbox the frame', () => {
    const graph = compileUiSceneComposite(spec).graph;
    expect(graph).not.toMatch(/\bpad=/);
    expect(graph).not.toMatch(/\bfillborders=/);
    expect(graph).not.toMatch(/\brotate=/);
    expect(graph).not.toMatch(/\bnoise=/);
    expect(STORY_COMPOSITE_ALLOWED_FILTERS).not.toContain('pad');
  });

  it('cuts the interface to the screen with the same expressions as the picture warp', () => {
    const graph = compileUiSceneComposite(spec).graph;
    // Two `perspective` calls — the picture and its alpha field — and they must
    // be identical up to the interpolation, or the cut-out drifts off the glass.
    const warps = graph.match(/perspective=[^[]*?sense=destination:eval=frame/g) ?? [];
    expect(warps).toHaveLength(2);
    expect(warps[0]).toBe(warps[1]);
    expect(graph).toContain('alphamerge');
  });

  it('refuses an interface canvas smaller than the delivery frame', () => {
    expect(() =>
      compileUiSceneComposite({ ...spec, uiCanvasWidthPx: 800, uiCanvasHeightPx: 1400 }),
    ).toThrow(StoryCompositeError);
  });

  it('refuses a pan that zoompan would silently clamp', () => {
    expect(() =>
      compileUiSceneComposite({
        ...spec,
        move: { ...move, panCentreU: 0.05, startZoom: 1, endZoom: 1 },
      }),
    ).toThrow(/reaches past the plate/);
  });

  it('refuses a zoom below 1, which would expose a border', () => {
    expect(() =>
      compilePlateMotion({
        sceneId: 'scene01',
        plateInputIndex: 0,
        outputWidthPx: 1080,
        outputHeightPx: 1920,
        frameRate: 30,
        durationSeconds: 1.45,
        move: { ...move, startZoom: 0.9, endZoom: 1 },
      }),
    ).toThrow(/no longer fills the frame/);
  });

  it('refuses a pass that would do nothing at all', () => {
    expect(() =>
      compileSheetOverlay({
        sceneId: 'scene05',
        baseInputIndex: 0,
        sheetInputIndex: null,
        outputWidthPx: 1080,
        outputHeightPx: 1920,
        frameRate: 30,
        durationSeconds: 2,
      }),
    ).toThrow(/neither a sheet nor a grade/);
  });
});

describe('the exposure grade', () => {
  it('pins the endpoints, so black stays black and white stays white', () => {
    const compiled = compileStoryExposureGrade(
      { midtonePoints: [{ x: 0.1, y: 0.2 }], saturation: 1 },
      'scene',
    );
    expect(compiled).toContain("curves=all='0/0 0.1/0.2 1/1'");
  });

  it('refuses a control point that would darken rather than lift', () => {
    expect(() =>
      compileStoryExposureGrade({ midtonePoints: [{ x: 0.4, y: 0.2 }], saturation: 1 }, 'scene'),
    ).toThrow(/pulls the midtones \*down\*/);
  });

  it('refuses a point on the endpoints, which is how a black floor gets raised', () => {
    expect(() =>
      compileStoryExposureGrade({ midtonePoints: [{ x: 0, y: 0.2 }], saturation: 1 }, 'scene'),
    ).toThrow(/strictly inside the unit square/);
  });
});

describe('exposure measurement', () => {
  const histogramOf = (
    levels: readonly [number, number][],
  ): { counts: number[]; sampleCount: number } => {
    const counts = new Array<number>(256).fill(0);
    let total = 0;
    for (const [level, count] of levels) {
      counts[level] = count;
      total += count;
    }
    return { counts, sampleCount: total };
  };

  it('reports a subject on a black set as readable, which a median floor would not', () => {
    // 80% black set, 20% lit fighter. The whole point of the readable fraction.
    const measurement = measureExposure(
      histogramOf([
        [2, 800],
        [180, 200],
      ]),
    );
    expect(measurement.medianLuma).toBe(2);
    expect(measurement.percentAtOrAboveReadableLevel).toBeCloseTo(20, 3);
    const verdict = evaluateSceneExposure({
      sceneNumber: 2,
      frame: measurement,
      subject: measurement,
    });
    expect(verdict.status).toBe('PASS');
  });

  it('fails a handset showing nothing at all', () => {
    const blank = measureExposure(histogramOf([[3, 1000]]));
    const verdict = evaluateSceneExposure({
      sceneNumber: 3,
      frame: blank,
      subject: blank,
      requirement: INTERFACE_EXPOSURE_REQUIREMENT,
    });
    expect(verdict.status).toBe('FAIL');
    expect(verdict.failures.join(' ')).toMatch(/90th-percentile/);
  });

  it('never reports an unmeasurable scene as a passing one', () => {
    const verdict = evaluateSceneExposure({ sceneNumber: 4, frame: null, subject: null });
    expect(verdict.status).toBe('NOT_MEASURED');
    expect(verdict.status).not.toBe('PASS');
  });
});

describe('product-story routing', () => {
  const decision = (sceneNumber: number, requiresGeneration: boolean) => ({
    sceneNumber,
    sceneRole: 'ROLE',
    slotSeconds: 1.5,
    generationMode: 'LTX_IMAGE_TO_VIDEO' as const,
    selectedSourceType: 'LTX_GENERATED' as const,
    selectedIdentifier: `FRAME-${String(sceneNumber).padStart(2, '0')}`,
    reasonSelected: 'because',
    rejectedAlternatives: [],
    requiresGeneration,
  });

  it('stops every composited scene from requiring generation, so none can spend', async () => {
    const plan = await committedPlan();
    const decisions = plan.scenes.map((scene) => decision(scene.sceneNumber, true));
    const { decisions: routed, changes } = applyProductStoryRouting({ decisions, plan });
    const composited = plan.scenes
      .filter((scene) => scene.kind !== 'FOOTAGE_TREATMENT')
      .map((scene) => scene.sceneNumber);
    expect(changes.map((change) => change.sceneNumber).sort((a, b) => a - b)).toEqual(
      [...composited].sort((a, b) => a - b),
    );
    for (const sceneNumber of composited) {
      const row = routed.find((candidate) => candidate.sceneNumber === sceneNumber);
      expect(row?.requiresGeneration).toBe(false);
    }
  });

  it('leaves footage scenes exactly as the source precedence resolved them', async () => {
    const plan = await committedPlan();
    const decisions = plan.scenes.map((scene) => decision(scene.sceneNumber, true));
    const { decisions: routed } = applyProductStoryRouting({ decisions, plan });
    for (const scene of plan.scenes) {
      if (scene.kind !== 'FOOTAGE_TREATMENT') continue;
      const before = decisions.find((row) => row.sceneNumber === scene.sceneNumber);
      const after = routed.find((row) => row.sceneNumber === scene.sceneNumber);
      expect(after).toBe(before);
    }
  });

  it('refuses to composite a scene the run never resolved', async () => {
    const plan = await committedPlan();
    expect(() => applyProductStoryRouting({ decisions: [], plan })).toThrow(ProductStoryError);
  });
});
