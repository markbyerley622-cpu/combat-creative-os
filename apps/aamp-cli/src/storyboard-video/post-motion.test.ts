import { describe, expect, it } from 'vitest';

import { routeLtxCameraMotion, toLtxCameraMotion } from '@combat/providers';

import { STORYBOARD_VIDEO_EXIT_CODES, StoryboardVideoError } from './failures';
import {
  assertNoZoomOverTime,
  assertOnlyPermittedFilters,
  checkPreservedRegion,
  compilePostMotion,
  PERMITTED_POST_MOTION_FILTERS,
  POST_MOTION_PROFILE_VERSION,
  smoothstepProgress,
} from './post-motion';
import { parseSceneManifest, type ScenePostMotion } from './scene-manifest';

/**
 * The deterministic second stage, proven with no FFmpeg, no provider and no
 * key.
 *
 * Everything here is a pure compilation or a refusal. The two things that
 * needed real material — that the resulting picture actually moves, and that no
 * frame exposes a border — are measurable only against a rendered clip and are
 * checked by the run's own post-motion report; what is proven here is that the
 * grammar that would produce them cannot be anything else.
 */

const PUSH: ScenePostMotion = {
  treatment: 'SMOOTH_PUSH',
  magnitudePercent: 2,
  preservedRegion: 'the right-side space the predictor-rank interface occupies',
  prohibitions: ['no rotation', 'no random shake'],
  rationale: 'the provider carries no magnitude for a move',
};

const DRIFT: ScenePostMotion = {
  treatment: 'SMOOTH_HORIZONTAL_DRIFT',
  magnitudePercent: 1,
  direction: 'LEFT',
  preservedRegion: 'the phone geometry and the discussion-interface region',
  prohibitions: ['no zoom', 'no rotation'],
  rationale: 'the provider has no handheld quality',
};

const FRAME = { widthPx: 1080, heightPx: 1920, durationSeconds: 2.5, frameRate: 24 };

function expectFailure(fn: () => unknown, kind: string): StoryboardVideoError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StoryboardVideoError);
    expect((error as StoryboardVideoError).kind).toBe(kind);
    return error as StoryboardVideoError;
  }
  throw new Error(`expected a ${kind} failure, but nothing was thrown`);
}

describe('the failure vocabulary', () => {
  it('gives the post-motion failures their own codes', () => {
    expect(STORYBOARD_VIDEO_EXIT_CODES.POST_MOTION_NOT_EXECUTABLE).toBe(40);
    expect(STORYBOARD_VIDEO_EXIT_CODES.POST_MOTION_WOULD_CROP_PRESERVED_REGION).toBe(41);
    expect(STORYBOARD_VIDEO_EXIT_CODES.POST_MOTION_NOT_EXECUTABLE).not.toBe(
      STORYBOARD_VIDEO_EXIT_CODES.FINAL_RENDER_FAILURE,
    );
  });
});

describe('routing — a motion the provider cannot express is never substituted', () => {
  it('asks the provider for a locked-off frame for both routed motions', () => {
    for (const motion of ['HANDHELD_DRIFT', 'CONTROLLED_PUSH_IN'] as const) {
      const routing = routeLtxCameraMotion(motion);
      expect(routing.providerValue).toBe('static');
      expect(routing.deterministicPostMotionRequired).toBe(true);
    }
  });

  it('refuses to resolve a routed motion to a wire value on its own', () => {
    // The whole point: no code path can obtain `static` for a routed move by
    // accident, because the function that returns a wire value will not do it.
    expect(() => toLtxCameraMotion('CONTROLLED_PUSH_IN')).toThrow(/two stages/i);
  });

  it('still maps SLOW_PUSH_IN natively — adding a routed push removed nothing', () => {
    expect(toLtxCameraMotion('SLOW_PUSH_IN')).toBe('dolly_in');
    expect(routeLtxCameraMotion('SLOW_PUSH_IN').deterministicPostMotionRequired).toBe(false);
  });
});

describe('the manifest contract for a routed scene', () => {
  const scene = (overrides: Record<string, unknown>) => ({
    sceneNumber: 1,
    sourceFrame: 'FRAME-01',
    outputStartSeconds: 0,
    outputEndSeconds: 1.1,
    generationMode: 'LTX_IMAGE_TO_VIDEO',
    motionPrompt: 'A figure breathes in low light. Do not alter any lettering in frame.',
    cameraMotion: 'CONTROLLED_PUSH_IN',
    preserveExactTypography: false,
    preserveExactProductUi: false,
    acceptableFootageRoles: [],
    intent: 'hook',
    ...overrides,
  });

  const manifest = (first: Record<string, unknown>) => ({
    manifestVersion: 1,
    storyboardId: 'sb',
    authoredBy: 'a person',
    scenes: [
      scene(first),
      ...Array.from({ length: 9 }, (_unused, index) =>
        scene({
          sceneNumber: index + 2,
          sourceFrame: `FRAME-${String(index + 2).padStart(2, '0')}`,
          cameraMotion: 'STATIC',
          postMotion: undefined,
        }),
      ),
    ].map((entry) => Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined))),
  });

  it('refuses a routed scene that does not say what its second stage is', () => {
    const failure = expectFailure(
      () => parseSceneManifest(manifest({ postMotion: undefined })),
      'INVALID_STORYBOARD',
    );
    expect(failure.message).toMatch(/still labelled as a drift/i);
  });

  it('refuses a natively-carried motion that claims a second stage', () => {
    expectFailure(
      () => parseSceneManifest(manifest({ cameraMotion: 'SLOW_PUSH_IN', postMotion: PUSH })),
      'INVALID_STORYBOARD',
    );
  });

  it('accepts a routed scene that states its second stage', () => {
    const parsed = parseSceneManifest(manifest({ postMotion: PUSH }));
    expect(parsed.scenes[0]?.postMotion?.treatment).toBe('SMOOTH_PUSH');
  });

  it('carries an optional preserved-region rectangle through the schema', () => {
    const parsed = parseSceneManifest(
      manifest({
        postMotion: {
          ...PUSH,
          preservedRegionRect: {
            xFraction: 0.5,
            yFraction: 0.3,
            widthFraction: 0.4,
            heightFraction: 0.3,
          },
        },
      }),
    );
    expect(parsed.scenes[0]?.postMotion?.preservedRegionRect?.widthFraction).toBe(0.4);
  });
});

describe('compilation — the push', () => {
  it('crops from an oversample, so no window it reaches can expose a border', () => {
    const compiled = compilePostMotion({ postMotion: PUSH, ...FRAME });
    expect(compiled.headroomScale).toBe(1.02);
    expect(compiled.oversampledWidthPx).toBeGreaterThan(FRAME.widthPx);
    expect(compiled.oversampledHeightPx).toBeGreaterThan(FRAME.heightPx);
    // Every window is at most the whole oversampled picture.
    expect(compiled.narrowestVisibleFraction).toBeLessThanOrEqual(1);
    expect(compiled.filterChain).toContain('scale=1102:1958');
    expect(compiled.filterChain).toContain('s=1080x1920');
  });

  it('moves the magnification over time, and lands exactly on the stated percent', () => {
    const compiled = compilePostMotion({ postMotion: PUSH, ...FRAME });
    expect(compiled.magnificationChangesOverTime).toBe(true);
    expect(compiled.filterChain).toContain("z='1+0.02*");
  });

  it('eases with a smoothstep on the output frame index, never on a clock', () => {
    const compiled = compilePostMotion({ postMotion: PUSH, ...FRAME });
    expect(compiled.filterChain).toContain(smoothstepProgress(compiled.frameCount - 1));
    // Nothing may read wall-clock time or a random source.
    expect(compiled.filterChain).not.toMatch(/random|rand\(|gauss/i);
  });

  it('refuses a horizontal direction, which a push along the lens axis has none of', () => {
    expectFailure(
      () => compilePostMotion({ postMotion: { ...PUSH, direction: 'LEFT' }, ...FRAME }),
      'POST_MOTION_NOT_EXECUTABLE',
    );
  });
});

describe('compilation — the drift', () => {
  it('holds one magnification for the whole interval', () => {
    const compiled = compilePostMotion({ postMotion: DRIFT, ...FRAME });
    expect(compiled.magnificationChangesOverTime).toBe(false);
    // `zoom` is a literal. A viewer sees one scale from first frame to last,
    // which is what the "no zoom" prohibition means.
    expect(compiled.filterChain).toContain("z='1.01'");
    expect(() => assertNoZoomOverTime('1.01')).not.toThrow();
  });

  it('refuses a magnification expression that varies with time', () => {
    expectFailure(() => assertNoZoomOverTime('1+0.01*on'), 'POST_MOTION_NOT_EXECUTABLE');
    expectFailure(() => assertNoZoomOverTime('1+0.01*t'), 'POST_MOTION_NOT_EXECUTABLE');
  });

  it('walks the window the opposite way for each direction', () => {
    const left = compilePostMotion({ postMotion: DRIFT, ...FRAME });
    const right = compilePostMotion({
      postMotion: { ...DRIFT, direction: 'RIGHT' },
      ...FRAME,
    });
    expect(left.filterChain).not.toBe(right.filterChain);
  });

  it('refuses a drift that states no direction', () => {
    const { direction: _omitted, ...withoutDirection } = DRIFT;
    expectFailure(
      () => compilePostMotion({ postMotion: withoutDirection as ScenePostMotion, ...FRAME }),
      'POST_MOTION_NOT_EXECUTABLE',
    );
  });
});

describe('what cannot be expressed', () => {
  it('emits only filters on the allow-list', () => {
    for (const postMotion of [PUSH, DRIFT]) {
      const compiled = compilePostMotion({ postMotion, ...FRAME });
      expect(() => assertOnlyPermittedFilters(compiled.filterChain)).not.toThrow();
      for (const banned of ['rotate', 'noise', 'pad', 'fillborders', 'vibrance', 'deshake']) {
        expect(compiled.filterChain).not.toContain(banned);
      }
      // A trim would quantise the output onto the frame grid and can come back
      // a few milliseconds short, which strips the transition handle the
      // segment selector needs. The input is already exactly the scene window.
      expect(compiled.filterChain).not.toContain('trim=');
      expect(PERMITTED_POST_MOTION_FILTERS).not.toContain('trim');
    }
  });

  it('refuses a chain reaching for a filter outside the allow-list', () => {
    const failure = expectFailure(
      () => assertOnlyPermittedFilters('fps=24,rotate=0.01,format=yuv420p'),
      'POST_MOTION_NOT_EXECUTABLE',
    );
    expect(failure.message).toContain('rotate');
    expect(PERMITTED_POST_MOTION_FILTERS).not.toContain('rotate');
  });

  it('is deterministic: the same inputs compile to the same grammar', () => {
    const once = compilePostMotion({ postMotion: DRIFT, ...FRAME });
    const twice = compilePostMotion({ postMotion: DRIFT, ...FRAME });
    expect(once.filterChain).toBe(twice.filterChain);
    expect(once.profileVersion).toBe(POST_MOTION_PROFILE_VERSION);
  });

  it('refuses material too short to move across', () => {
    expectFailure(
      () => compilePostMotion({ postMotion: PUSH, ...FRAME, durationSeconds: 0.02 }),
      'POST_MOTION_NOT_EXECUTABLE',
    );
  });

  it('refuses a frame size that is not one', () => {
    expectFailure(
      () => compilePostMotion({ postMotion: PUSH, ...FRAME, widthPx: 0 }),
      'POST_MOTION_NOT_EXECUTABLE',
    );
  });
});

describe('the preserved region', () => {
  it('says it could not be measured when the scene declares only prose', () => {
    const compiled = compilePostMotion({ postMotion: PUSH, ...FRAME });
    expect(compiled.preservedRegionCheck.status).toBe('NOT_MEASURED');
    expect(compiled.preservedRegionCheck.notMeasuredReason).toMatch(/prose/i);
    // An unmeasured check is never reported as a pass.
    expect(compiled.preservedRegionCheck.worstCaseMarginFraction).toBeNull();
  });

  it('passes a region that survives the tightest window a push reaches', () => {
    const check = compilePostMotion({
      postMotion: PUSH,
      ...FRAME,
      preservedRegionRect: {
        xFraction: 0.55,
        yFraction: 0.35,
        widthFraction: 0.35,
        heightFraction: 0.3,
      },
    }).preservedRegionCheck;
    expect(check.status).toBe('PRESERVED');
    expect(check.worstCaseMarginFraction).toBeGreaterThan(0);
  });

  it('refuses a push that would crop the region the scene says must survive', () => {
    const failure = expectFailure(
      () =>
        compilePostMotion({
          postMotion: { ...PUSH, magnitudePercent: 5 },
          ...FRAME,
          preservedRegionRect: {
            xFraction: 0.0,
            yFraction: 0.0,
            widthFraction: 1.0,
            heightFraction: 1.0,
          },
        }),
      'POST_MOTION_WOULD_CROP_PRESERVED_REGION',
    );
    expect(failure.message).toMatch(/Reduce the magnitude/);
  });

  it('holds a drift to the worse of its two extremes, not the one it ends on', () => {
    // A region hard against the left edge survives the window that starts at 0
    // and is cropped by the one that ends at 1. Checking only the end state
    // would pass it.
    expectFailure(
      () =>
        checkPreservedRegion({
          rect: { xFraction: 0, yFraction: 0, widthFraction: 0.5, heightFraction: 1 },
          narrowestVisibleFraction: 0.99,
          treatment: 'SMOOTH_HORIZONTAL_DRIFT',
          direction: 'LEFT',
        }),
      'POST_MOTION_WOULD_CROP_PRESERVED_REGION',
    );
  });

  it('refuses a rectangle that is not inside the frame at all', () => {
    expectFailure(
      () =>
        checkPreservedRegion({
          rect: { xFraction: 0.8, yFraction: 0, widthFraction: 0.5, heightFraction: 0.5 },
          narrowestVisibleFraction: 0.98,
          treatment: 'SMOOTH_PUSH',
        }),
      'POST_MOTION_NOT_EXECUTABLE',
    );
  });
});
