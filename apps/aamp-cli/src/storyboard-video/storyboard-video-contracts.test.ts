import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { LTX_CAMERA_MOTIONS, routeLtxCameraMotion, toLtxCameraMotion } from '@combat/providers';

import { findArtefactSafetyProblems, assertStoryboardVideoArtefactSafe } from './artefact-safety';
import { assertWithinCostCeiling, buildCostEstimate } from './cost-estimate';
import {
  exitCodeForFailure,
  STORYBOARD_VIDEO_EXIT_CODES,
  STORYBOARD_VIDEO_FAILURE_KINDS,
  StoryboardVideoError,
} from './failures';
import { computeGenerationCacheKey, GenerationCache } from './generation-cache';
import { canonicalFrameId, resolveKeyframeLibrary } from './keyframe-library';
import {
  MANUAL_GENERATION_PROVENANCE,
  PROVIDER_GENERATION_PROVENANCE,
} from './pre-generated-clips';
import {
  assertPromptsAreSafe,
  findPromptViolations,
  splitProhibitionClause,
} from './prompt-safety';
import {
  assertSceneManifestMatchesStoryboard,
  modeReachesGenerationProvider,
  parseSceneManifest,
  GENERATION_MODES,
  POST_MOTION_MAX_MAGNITUDE_PERCENT,
} from './scene-manifest';
import { parseStoryboardVideoArgs } from './storyboard-video-cli';
import {
  assertNoSilentStillFallback,
  buildSourceDecisionReport,
  nextRequiredGenerationScene,
  resolveSceneSources,
  SOURCE_TYPES,
} from './source-precedence';

/**
 * Contracts that need no FFmpeg, no network and no API key.
 *
 * Everything here is a refusal or a pure decision, which is deliberate: the
 * expensive parts of this command are guarded by cheap checks, and these are
 * the cheap checks.
 */

const STORYBOARD_ID = 'TEST-STORYBOARD-02';

function scene(sceneNumber: number, overrides: Record<string, unknown> = {}) {
  const slots: [number, number][] = [
    [0.0, 1.1],
    [1.1, 2.3],
    [2.3, 3.8],
    [3.8, 5.1],
    [5.1, 6.6],
    [6.6, 8.0],
    [8.0, 8.9],
    [8.9, 10.7],
    [10.7, 12.7],
    [12.7, 15.0],
  ];
  const slot = slots[sceneNumber - 1] as [number, number];
  const generative = [1, 2, 5, 7, 8, 9].includes(sceneNumber);
  return {
    sceneNumber,
    sourceFrame: canonicalFrameId(sceneNumber),
    outputStartSeconds: slot[0],
    outputEndSeconds: slot[1],
    generationMode: generative
      ? 'LTX_IMAGE_TO_VIDEO'
      : sceneNumber === 10
        ? 'STATIC_BRAND_COMPOSITION'
        : 'EXACT_UI_MOTION',
    motionPrompt: generative
      ? 'A figure moves in low light while haze drifts behind. The camera holds. Do not alter any lettering, mark or numeral in frame.'
      : 'Deterministic only. This scene is never submitted to a generation provider.',
    cameraMotion: 'STATIC',
    preserveExactTypography: !generative,
    preserveExactProductUi: !generative,
    // Mirrors the real campaign manifest: only the breadth and face-off beats
    // accept a boxing plate, so a single acquired original cannot fill the hook.
    acceptableFootageRoles: generative
      ? sceneNumber === 1
        ? ['TALENT_PHONE_NOTIFICATION']
        : sceneNumber === 2 || sceneNumber === 5
          ? ['BOXING_ACTION']
          : ['WINNER_CELEBRATION']
      : [],
    intent: `scene ${sceneNumber}`,
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    storyboardId: STORYBOARD_ID,
    authoredBy: 'a person',
    scenes: Array.from({ length: 10 }, (_, index) => scene(index + 1)),
    ...overrides,
  };
}

const storyboardStub = {
  storyboardId: STORYBOARD_ID,
  frames: Array.from({ length: 10 }, (_, index) => ({
    sequence: index + 1,
    sceneRole: [
      'NOTIFICATION_HOOK',
      'COMBAT_SPORT_BREADTH',
      'EVENT_DISCOVERY',
      'RANKINGS_RESEARCH',
      'FIGHTER_COMPARISON',
      'FREE_PREDICTION',
      'PREDICTION_SUBMITTED',
      'PREDICTOR_STATUS_REWARD',
      'COMMUNITY_DISCUSSION',
      'BRAND_CTA',
    ][index] as string,
  })),
};

describe('failures — every kind has its own exit code', () => {
  it('maps every kind, and no two share a code except the shared invalid-argument one', () => {
    const codes = STORYBOARD_VIDEO_FAILURE_KINDS.map(exitCodeForFailure);
    expect(codes.every((code) => Number.isInteger(code))).toBe(true);
    expect(new Set(codes).size).toBe(STORYBOARD_VIDEO_FAILURE_KINDS.length);
  });

  it('never collides with the campaign exit codes, whose highest is 12', () => {
    const specific = STORYBOARD_VIDEO_FAILURE_KINDS.filter((k) => k !== 'INVALID_ARGUMENTS').map(
      exitCodeForFailure,
    );
    expect(Math.min(...specific)).toBeGreaterThan(12);
  });

  it('carries its exit code on the error itself', () => {
    const error = new StoryboardVideoError('PAYMENT_REQUIRED', 'no credits', 4);
    expect(error.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.PAYMENT_REQUIRED);
    expect(error.sceneNumber).toBe(4);
  });
});

describe('scene manifest — checked against the locked storyboard', () => {
  it('accepts a manifest that matches', () => {
    expect(() =>
      assertSceneManifestMatchesStoryboard(parseSceneManifest(manifest()), storyboardStub as never),
    ).not.toThrow();
  });

  it('refuses a scene off its locked slot', () => {
    const bad = manifest({
      scenes: Array.from({ length: 10 }, (_, i) =>
        i === 3 ? scene(4, { outputStartSeconds: 3.8, outputEndSeconds: 5.4 }) : scene(i + 1),
      ),
    });
    expect(() =>
      assertSceneManifestMatchesStoryboard(parseSceneManifest(bad), storyboardStub as never),
    ).toThrow(/locked slot/i);
  });

  it('refuses a scene that renders a frame that is not its own', () => {
    const bad = manifest({
      scenes: Array.from({ length: 10 }, (_, i) =>
        i === 1 ? scene(2, { sourceFrame: 'FRAME-05' }) : scene(i + 1),
      ),
    });
    expect(() =>
      assertSceneManifestMatchesStoryboard(parseSceneManifest(bad), storyboardStub as never),
    ).toThrow(/renders its own frame/i);
  });

  it('refuses a manifest written for a different storyboard', () => {
    expect(() =>
      assertSceneManifestMatchesStoryboard(
        parseSceneManifest(manifest({ storyboardId: 'SOMETHING-ELSE' })),
        storyboardStub as never,
      ),
    ).toThrow(/written for storyboard/i);
  });

  it('refuses generation on a scene that preserves exact product UI', () => {
    const bad = manifest({
      scenes: Array.from({ length: 10 }, (_, i) =>
        i === 2
          ? scene(3, {
              generationMode: 'LTX_IMAGE_TO_VIDEO',
              preserveExactProductUi: true,
              motionPrompt: 'Move it. Do not alter anything.',
            })
          : scene(i + 1),
      ),
    });
    expect(() =>
      assertSceneManifestMatchesStoryboard(parseSceneManifest(bad), storyboardStub as never),
    ).toThrow(/invents its contents/i);
  });

  it('refuses a manifest that does not tile exactly fifteen seconds', () => {
    const bad = manifest({
      scenes: Array.from({ length: 10 }, (_, i) =>
        i === 9 ? scene(10, { outputEndSeconds: 14.5 }) : scene(i + 1),
      ),
    });
    expect(() =>
      assertSceneManifestMatchesStoryboard(parseSceneManifest(bad), storyboardStub as never),
    ).toThrow(/exactly 15 seconds|tile/i);
  });

  it('names exactly one mode that reaches a generation provider', () => {
    expect(GENERATION_MODES.filter(modeReachesGenerationProvider)).toEqual(['LTX_IMAGE_TO_VIDEO']);
  });
});

describe('prompt safety — refuses, never rewrites', () => {
  const generative = (prompt: string) => scene(1, { motionPrompt: prompt }) as never;

  it('refuses a fighter record', () => {
    expect(
      findPromptViolations(generative('He is 21-3 and moves in. Do not alter anything.')),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FIGHTER_RECORD' })]));
  });

  it('refuses a ranking position', () => {
    expect(
      findPromptViolations(generative('The ranked #3 contender waits. Do not alter anything.')),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RANKING_POSITION' })]));
  });

  it('refuses a calendar date', () => {
    expect(
      findPromptViolations(generative('It is March 14 in the arena. Do not alter anything.')),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CALENDAR_DATE' })]));
  });

  it('refuses a countable claim about events', () => {
    expect(
      findPromptViolations(generative('Show 12 fights on the wall. Do not alter anything.')),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'EVENT_COUNT' })]));
  });

  it('refuses literal on-screen copy', () => {
    expect(
      findPromptViolations(generative('A caption that says FIGHT NIGHT. Do not alter anything.')),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ON_SCREEN_COPY' })]));
  });

  it('refuses the brand mark', () => {
    expect(
      findPromptViolations(generative('Draw the logo above him. Do not alter anything.')),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LOGO_OR_MARK' })]));
  });

  it('refuses the product interface', () => {
    expect(
      findPromptViolations(generative('Animate the rankings table rows. Do not alter anything.')),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PRODUCT_UI' })]));
  });

  it('exempts the prohibition clause, which necessarily names what it forbids', () => {
    const prompt =
      'A figure breathes in low light. Do not alter the logo, any caption that says something, any record such as 21-3, or the rankings table.';
    expect(findPromptViolations(generative(prompt))).toEqual([]);
    expect(splitProhibitionClause(prompt).prohibition).toMatch(/^Do not alter/);
  });

  it('requires a prohibition clause on every submitted prompt', () => {
    expect(() =>
      assertPromptsAreSafe([scene(1, { motionPrompt: 'A figure breathes.' }) as never], () => true),
    ).toThrow(/prohibited mutations/i);
  });

  it('enforces the 200-word limit', () => {
    const long = `${'word '.repeat(210)}Do not alter anything.`;
    expect(() =>
      assertPromptsAreSafe([scene(1, { motionPrompt: long }) as never], () => true),
    ).toThrow(/200-word limit/i);
  });

  it('never checks a prompt that will not be submitted', () => {
    // An exact-UI scene's prompt is a note to a human, not a request.
    expect(() =>
      assertPromptsAreSafe(
        [scene(3, { motionPrompt: 'Animate the rankings table showing 21-3.' }) as never],
        (s) => modeReachesGenerationProvider(s.generationMode),
      ),
    ).not.toThrow();
  });

  it('returns a checksum per checked prompt', () => {
    const checked = assertPromptsAreSafe([scene(1) as never], () => true);
    expect(checked[0]?.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('source precedence', () => {
  const keyframes = {
    framesDirectory: '/frames',
    ignoredFiles: [],
    frames: Array.from({ length: 10 }, (_, index) => ({
      sceneNumber: index + 1,
      frameId: canonicalFrameId(index + 1),
      absolutePath: `/frames/${canonicalFrameId(index + 1)}.png`,
      fileName: `${canonicalFrameId(index + 1)}.png`,
      checksumSha256: 'a'.repeat(64),
      sizeBytes: 100,
      widthPx: 1080,
      heightPx: 1920,
      mimeType: 'image/png',
    })),
  };

  const baseInput = {
    sceneManifest: parseSceneManifest(manifest()),
    storyboardRolesBySceneNumber: new Map(
      storyboardStub.frames.map((f) => [f.sequence, f.sceneRole]),
    ),
    keyframes,
    footagePack: null,
    preGeneratedClips: { directory: '', present: false, clips: [], ignoredFiles: [] },
    regenerateScenes: new Set<number>(),
    captureLibrary: null,
    requiredSourceSecondsForScene: () => 2.0,
  };

  it('sends exact-UI and brand scenes to deterministic motion graphics, never to LTX', () => {
    const decisions = resolveSceneSources(baseInput as never);
    for (const sceneNumber of [3, 4, 6, 10]) {
      const decision = decisions.find((d) => d.sceneNumber === sceneNumber);
      expect(decision?.selectedSourceType).toBe('DETERMINISTIC_MOTION_GRAPHICS');
      expect(decision?.requiresGeneration).toBe(false);
    }
  });

  it('routes the six photographic scenes to generation when nothing else exists', () => {
    const decisions = resolveSceneSources(baseInput as never);
    expect(decisions.filter((d) => d.requiresGeneration).map((d) => d.sceneNumber)).toEqual([
      1, 2, 5, 7, 8, 9,
    ]);
  });

  it('prefers a hand-animated clip over a paid generation and records its provenance', () => {
    const decisions = resolveSceneSources({
      ...(baseInput as Record<string, unknown>),
      preGeneratedClips: {
        directory: '/frames/generated-clips',
        present: true,
        ignoredFiles: [],
        clips: [1, 7].map((sceneNumber) => ({
          sceneNumber,
          frameId: canonicalFrameId(sceneNumber),
          absolutePath: `/frames/generated-clips/${canonicalFrameId(sceneNumber)}.mp4`,
          fileName: `${canonicalFrameId(sceneNumber)}.mp4`,
          checksumSha256: 'b'.repeat(64),
          sizeBytes: 10,
          durationSeconds: 6,
          widthPx: 1080,
          heightPx: 1920,
          frameRate: 24,
          videoCodec: 'h264',
          hasAudio: false,
          provenance: MANUAL_GENERATION_PROVENANCE,
        })),
      },
    } as never);

    for (const sceneNumber of [1, 7]) {
      const decision = decisions.find((d) => d.sceneNumber === sceneNumber);
      expect(decision?.selectedSourceType).toBe('PRE_GENERATED_MANUAL_CLIP');
      expect(decision?.requiresGeneration).toBe(false);
      expect(decision?.generationProvenance).toBe(MANUAL_GENERATION_PROVENANCE);
      // It must never be described as something this pipeline produced.
      expect(decision?.reasonSelected).toMatch(/did not produce these bytes/i);
    }
    expect(decisions.filter((d) => d.requiresGeneration).map((d) => d.sceneNumber)).toEqual([
      2, 5, 8, 9,
    ]);
  });

  it('regenerates a scene that already has a clip only when asked by name', () => {
    const withClips = {
      ...(baseInput as Record<string, unknown>),
      preGeneratedClips: {
        directory: '/x',
        present: true,
        ignoredFiles: [],
        clips: [
          {
            sceneNumber: 1,
            frameId: 'FRAME-01',
            absolutePath: '/x/FRAME-01.mp4',
            fileName: 'FRAME-01.mp4',
            checksumSha256: 'b'.repeat(64),
            sizeBytes: 10,
            durationSeconds: 6,
            widthPx: 1080,
            heightPx: 1920,
            frameRate: 24,
            videoCodec: 'h264',
            hasAudio: false,
            provenance: MANUAL_GENERATION_PROVENANCE,
          },
        ],
      },
    } as never;

    expect(
      resolveSceneSources(withClips).find((d) => d.sceneNumber === 1)?.requiresGeneration,
    ).toBe(false);

    const forced = resolveSceneSources({
      ...(withClips as Record<string, unknown>),
      regenerateScenes: new Set([1]),
    } as never);
    const decision = forced.find((d) => d.sceneNumber === 1);
    expect(decision?.requiresGeneration).toBe(true);
    expect(decision?.generationProvenance).toBe(PROVIDER_GENERATION_PROVENANCE);
    // Only that scene is affected.
    expect(forced.filter((d) => d.requiresGeneration).map((d) => d.sceneNumber)).toEqual([
      1, 2, 5, 7, 8, 9,
    ]);
  });

  it('prefers a full-resolution acquired original over generation, and claims it once', () => {
    const original = {
      assetId: 'CRF02-BOXING_ACTION-PX1',
      role: 'BOXING_ACTION',
      absolutePath: '/pack/a.mp4',
      relativePath: 'approved-free-originals/a.mp4',
      checksumSha256: 'c'.repeat(64),
      sizeBytes: 1,
      measured: {
        widthPx: 4096,
        heightPx: 2160,
        durationSeconds: 8.88,
        frameRate: 25,
        videoCodec: 'h264',
        hasAudio: false,
      },
      declared: { widthPx: 4096, heightPx: 2160, durationSeconds: 8.88 },
      discrepancies: [],
      provider: 'Pexels',
      creator: 'someone',
      licence: 'Pexels License',
      sourcePage: 'https://example.test/x',
      visualReviewScore: 88,
      watermarkPresent: false,
    };
    const decisions = resolveSceneSources({
      ...(baseInput as Record<string, unknown>),
      footagePack: {
        packRoot: '/pack',
        originals: [original],
        refusedByLocationCount: 40,
        unfilledRoles: [],
        ingestionMapPresent: true,
      },
    } as never);

    // Scene 1 does not accept BOXING_ACTION; scene 2 does, and takes it.
    expect(decisions.find((d) => d.sceneNumber === 1)?.selectedSourceType).toBe('LTX_GENERATED');
    expect(decisions.find((d) => d.sceneNumber === 2)?.selectedSourceType).toBe(
      'ACQUIRED_PRODUCTION_FOOTAGE',
    );
    // Claimed once: scene 5 also accepts it but must not reuse the same footage.
    expect(decisions.find((d) => d.sceneNumber === 5)?.selectedSourceType).toBe('LTX_GENERATED');
    expect(
      decisions
        .find((d) => d.sceneNumber === 5)
        ?.rejectedAlternatives.some((r) => /already claimed/i.test(r.reason)),
    ).toBe(true);
  });

  it('rejects an acquired original that is too short, with the reason recorded', () => {
    const decisions = resolveSceneSources({
      ...(baseInput as Record<string, unknown>),
      requiredSourceSecondsForScene: () => 20,
      footagePack: {
        packRoot: '/pack',
        originals: [
          {
            assetId: 'SHORT',
            role: 'BOXING_ACTION',
            absolutePath: '/pack/s.mp4',
            relativePath: 'approved-free-originals/s.mp4',
            checksumSha256: 'd'.repeat(64),
            sizeBytes: 1,
            measured: {
              widthPx: 1080,
              heightPx: 1920,
              durationSeconds: 3,
              frameRate: 24,
              videoCodec: 'h264',
              hasAudio: false,
            },
            declared: { widthPx: 1080, heightPx: 1920, durationSeconds: 3 },
            discrepancies: [],
            provider: 'Pexels',
            creator: 'x',
            licence: 'y',
            sourcePage: 'https://example.test/s',
            visualReviewScore: 90,
            watermarkPresent: false,
          },
        ],
        refusedByLocationCount: 0,
        unfilledRoles: [],
        ingestionMapPresent: true,
      },
    } as never);
    const scene2 = decisions.find((d) => d.sceneNumber === 2);
    expect(scene2?.selectedSourceType).toBe('LTX_GENERATED');
    expect(scene2?.rejectedAlternatives.some((r) => /short of/i.test(r.reason))).toBe(true);
  });

  it('names the next scene the pipeline must generate, lowest first', () => {
    const decisions = resolveSceneSources(baseInput as never);
    expect(nextRequiredGenerationScene(decisions)?.sceneNumber).toBe(1);
  });

  it('refuses to let a failed generation become a slideshow', () => {
    const decisions = resolveSceneSources(baseInput as never);
    expect(() => assertNoSilentStillFallback(decisions, new Set([1, 2, 5, 7, 8]))).toThrow(
      /rather than holding the still/i,
    );
    expect(() => assertNoSilentStillFallback(decisions, new Set([1, 2, 5, 7, 8, 9]))).not.toThrow();
  });

  it('lists every source type in precedence order', () => {
    expect(SOURCE_TYPES).toEqual([
      'REAL_PRODUCT_CAPTURE',
      'ACQUIRED_PRODUCTION_FOOTAGE',
      'PRE_GENERATED_MANUAL_CLIP',
      'LTX_GENERATED',
      'DETERMINISTIC_MOTION_GRAPHICS',
    ]);
  });

  it('reports generated versus used duration and the discarded remainder', () => {
    const decisions = resolveSceneSources(baseInput as never);
    const rows = buildSourceDecisionReport({
      decisions,
      outcomes: new Map([
        [
          1,
          {
            sceneNumber: 1,
            ltxCalled: true,
            requestedGenerationSeconds: 6,
            usedSeconds: 1.45,
            costCents: 36,
          },
        ],
      ]),
      finalManifestSourceByScene: new Map([
        [1, { assetId: 'storyboard-panel-01', checksumSha256: 'e'.repeat(64) }],
      ]),
    });
    const first = rows.find((r) => r.sceneNumber === 1);
    expect(first).toMatchObject({
      ltxCalled: true,
      requestedGenerationSeconds: 6,
      usedSeconds: 1.45,
      discardedSeconds: 4.55,
      costCents: 36,
      finalManifestSource: 'storyboard-panel-01',
    });
    expect(first?.rejectedAlternatives).toBeDefined();
  });
});

describe('cost estimate — computed and enforced before any upload', () => {
  const decisions = [
    {
      sceneNumber: 1,
      sceneRole: 'A',
      requiresGeneration: true,
      selectedSourceType: 'LTX_GENERATED',
    },
    {
      sceneNumber: 2,
      sceneRole: 'B',
      requiresGeneration: true,
      selectedSourceType: 'LTX_GENERATED',
    },
    {
      sceneNumber: 3,
      sceneRole: 'C',
      requiresGeneration: false,
      selectedSourceType: 'DETERMINISTIC_MOTION_GRAPHICS',
    },
  ] as never;

  it('prices only the generated scenes, at the requested duration', () => {
    const estimate = buildCostEstimate({
      decisions,
      model: 'ltx-2-3-fast',
      resolution: '1080x1920',
      ceilingCents: 1000,
      requiredSourceSecondsForScene: () => 1.8,
    });
    expect(estimate.generatedSceneCount).toBe(2);
    expect(estimate.totalGeneratedSeconds).toBe(12);
    expect(estimate.maximumTotalCostCents).toBe(72);
    expect(estimate.withinCeiling).toBe(true);
  });

  it('prices pro higher than fast', () => {
    const pro = buildCostEstimate({
      decisions,
      model: 'ltx-2-3-pro',
      resolution: '1080x1920',
      ceilingCents: 1000,
      requiredSourceSecondsForScene: () => 1.8,
    });
    expect(pro.maximumTotalCostCents).toBe(96);
  });

  it('refuses before any upload when the ceiling is too low, and says what it needs', () => {
    const estimate = buildCostEstimate({
      decisions,
      model: 'ltx-2-3-fast',
      resolution: '1080x1920',
      ceilingCents: 50,
      requiredSourceSecondsForScene: () => 1.8,
    });
    expect(() => assertWithinCostCeiling(estimate)).toThrow(/nothing has been uploaded/i);
    expect(() => assertWithinCostCeiling(estimate)).toThrow(/at least 72/);
    try {
      assertWithinCostCeiling(estimate);
    } catch (error) {
      expect((error as StoryboardVideoError).exitCode).toBe(
        STORYBOARD_VIDEO_EXIT_CODES.COST_CEILING_EXCEEDED,
      );
    }
  });
});

describe('generation cache', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ltx-cache-'));
  });

  const key = {
    inputFrameChecksumSha256: 'a'.repeat(64),
    motionPromptSha256: 'b'.repeat(64),
    model: 'ltx-2-3-fast',
    durationSeconds: 6,
    resolution: '1080x1920',
    fps: 24,
    generateAudio: false,
    cameraMotion: 'STATIC',
  };

  it('changes when any input changes', () => {
    const base = computeGenerationCacheKey(key);
    expect(computeGenerationCacheKey({ ...key, model: 'ltx-2-3-pro' })).not.toBe(base);
    expect(computeGenerationCacheKey({ ...key, durationSeconds: 8 })).not.toBe(base);
    expect(computeGenerationCacheKey({ ...key, generateAudio: true })).not.toBe(base);
    expect(computeGenerationCacheKey({ ...key, cameraMotion: 'SLOW_PUSH_IN' })).not.toBe(base);
    expect(computeGenerationCacheKey({ ...key, motionPromptSha256: 'c'.repeat(64) })).not.toBe(
      base,
    );
    expect(computeGenerationCacheKey({ ...key, lastFrameChecksumSha256: 'd'.repeat(64) })).not.toBe(
      base,
    );
  });

  it('is stable for identical inputs', () => {
    expect(computeGenerationCacheKey(key)).toBe(computeGenerationCacheKey(key));
  });

  it('returns a hit only when the bytes still verify', async () => {
    const cache = await GenerationCache.open(directory);
    await mkdir(join(directory, 'originals'), { recursive: true });
    const bytes = Buffer.from('a real clip would go here');
    await writeFile(join(directory, 'originals', 'c.mp4'), bytes);
    const checksum = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');

    await cache.record({
      cacheKey: computeGenerationCacheKey(key),
      sceneNumber: 1,
      relativePath: 'originals/c.mp4',
      checksumSha256: checksum,
      sizeBytes: bytes.byteLength,
      durationSeconds: 6,
      widthPx: 1080,
      heightPx: 1920,
      model: 'ltx-2-3-fast',
      requestedDurationSeconds: 6,
      costCents: 36,
      recordedAt: 'run:test',
    });

    expect(await cache.lookup(computeGenerationCacheKey(key))).not.toBeNull();

    // Altered bytes are a miss, not a hit.
    await writeFile(join(directory, 'originals', 'c.mp4'), Buffer.from('tampered'));
    expect(await cache.lookup(computeGenerationCacheKey(key))).toBeNull();
  });

  it('survives a reopen', async () => {
    const cache = await GenerationCache.open(directory);
    await mkdir(join(directory, 'originals'), { recursive: true });
    const bytes = Buffer.from('x');
    await writeFile(join(directory, 'originals', 'c.mp4'), bytes);
    const checksum = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    await cache.record({
      cacheKey: computeGenerationCacheKey(key),
      sceneNumber: 1,
      relativePath: 'originals/c.mp4',
      checksumSha256: checksum,
      sizeBytes: 1,
      durationSeconds: 6,
      widthPx: 1080,
      heightPx: 1920,
      model: 'ltx-2-3-fast',
      requestedDurationSeconds: 6,
      costCents: 36,
      recordedAt: 'run:test',
    });
    const reopened = await GenerationCache.open(directory);
    expect(reopened.size).toBe(1);
  });

  it('treats a corrupt cache file as an empty cache', async () => {
    await writeFile(join(directory, 'generation-cache.json'), 'not json');
    expect((await GenerationCache.open(directory)).size).toBe(0);
  });
});

describe('artefact safety — fails closed', () => {
  it('refuses a signed URL', () => {
    expect(
      findArtefactSafetyProblems({ where: 'https://uploads.ltx.io/x?signature=abc' }),
    ).toHaveLength(1);
  });

  it('refuses a forbidden key even with an innocent value', () => {
    expect(findArtefactSafetyProblems({ upload_url: 'nothing' })).toHaveLength(1);
    expect(findArtefactSafetyProblems({ nested: { apiKey: 'x' } })).toHaveLength(1);
  });

  it('refuses a bearer token and a JWT anywhere', () => {
    expect(findArtefactSafetyProblems({ note: 'Bearer abcdefghijklmnop' }).length).toBeGreaterThan(
      0,
    );
    expect(
      findArtefactSafetyProblems({
        note: 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q',
      }).length,
    ).toBeGreaterThan(0);
  });

  it('permits a host and a pathname', () => {
    expect(findArtefactSafetyProblems({ source: 'https://www.pexels.com/video/x-123/' })).toEqual(
      [],
    );
  });

  it('throws with every problem named', () => {
    expect(() =>
      assertStoryboardVideoArtefactSafe({ apiKey: 'a', video_url: 'b' }, 'test.json'),
    ).toThrow(/apiKey[\s\S]*video_url/);
  });
});

describe('CLI argument parsing', () => {
  it('refuses an unknown option by name', () => {
    expect(() => parseStoryboardVideoArgs(['--nope'])).toThrow(/unknown option "--nope"/);
  });

  it('collects repeated --regenerate-scene values', () => {
    const options = parseStoryboardVideoArgs([
      '--regenerate-scene',
      '2',
      '--regenerate-scene',
      '5',
    ]);
    expect(options.regenerateScenes).toEqual([2, 5]);
  });

  it('refuses a scene number outside the storyboard', () => {
    expect(() => parseStoryboardVideoArgs(['--regenerate-scene', '11'])).toThrow(
      /between 1 and 10/,
    );
    expect(() => parseStoryboardVideoArgs(['--regenerate-scene', 'x'])).toThrow();
  });

  it('parses the full documented invocation', () => {
    const options = parseStoryboardVideoArgs([
      '--storyboard',
      'sb',
      '--frames-dir',
      'frames',
      '--footage-pack',
      'pack',
      '--pre-generated-clips-dir',
      'clips',
      '--output-dir',
      'out',
      '--provider',
      'ltx-hosted',
      '--model',
      'ltx-2-3-fast',
      '--max-cost-cents',
      '250',
      '--dry-run',
      '--json',
      '--generate-audio',
    ]);
    expect(options).toMatchObject({
      storyboard: 'sb',
      framesDir: 'frames',
      footagePack: 'pack',
      preGeneratedClipsDir: 'clips',
      outputDir: 'out',
      provider: 'ltx-hosted',
      model: 'ltx-2-3-fast',
      maxCostCents: '250',
      dryRun: true,
      json: true,
      generateAudio: true,
    });
  });
});

describe('keyframe library', () => {
  let directory: string;
  const runner = {
    run: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }] }),
      stderr: '',
    }),
  } as never;
  const binaries = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } as never;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ltx-frames-'));
  });

  it('resolves all ten and ignores unrelated files', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await writeFile(join(directory, `${canonicalFrameId(i)}.png`), Buffer.from([1, 2, 3]));
    }
    await writeFile(join(directory, 'Storyboard1.jpeg'), Buffer.from([1]));

    const library = await resolveKeyframeLibrary({ framesDirectory: directory, runner, binaries });
    expect(library.frames).toHaveLength(10);
    expect(library.frames[0]?.frameId).toBe('FRAME-01');
    expect(library.ignoredFiles).toContain('Storyboard1.jpeg');
  });

  it('refuses a missing number and names it', async () => {
    for (let i = 1; i <= 9; i += 1) {
      await writeFile(join(directory, `${canonicalFrameId(i)}.png`), Buffer.from([1]));
    }
    await expect(
      resolveKeyframeLibrary({ framesDirectory: directory, runner, binaries }),
    ).rejects.toThrow(/FRAME-10 is missing/);
  });

  it('refuses an ambiguous number rather than choosing', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await writeFile(join(directory, `${canonicalFrameId(i)}.png`), Buffer.from([1]));
    }
    await writeFile(join(directory, 'FRAME-03.jpg'), Buffer.from([1]));
    await expect(
      resolveKeyframeLibrary({ framesDirectory: directory, runner, binaries }),
    ).rejects.toThrow(/FRAME-03 is ambiguous/);
  });

  it('refuses a file that is not a decodable image', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await writeFile(join(directory, `${canonicalFrameId(i)}.png`), Buffer.from([1]));
    }
    const failing = {
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'invalid data' }),
    } as never;
    await expect(
      resolveKeyframeLibrary({ framesDirectory: directory, runner: failing, binaries }),
    ).rejects.toThrow(/could not be decoded/);
  });

  it('refuses an empty file', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await writeFile(join(directory, `${canonicalFrameId(i)}.png`), Buffer.from([1]));
    }
    await writeFile(join(directory, 'FRAME-05.png'), Buffer.alloc(0));
    await expect(
      resolveKeyframeLibrary({ framesDirectory: directory, runner, binaries }),
    ).rejects.toThrow(/non-empty file/);
  });
});

/**
 * The committed campaign against the provider's real vocabulary.
 *
 * Pinned as its own test because it is a live blocker on the advertisement, not
 * a detail of the adapter: two scenes ask `ltx-hosted` for a move it cannot
 * perform, so they are refused before any upload. Nothing here decides what the
 * author should write instead — it records, in executable form, that a decision
 * is owed.
 */
describe('the committed campaign manifest against the LTX vocabulary', () => {
  const manifestPath = join(
    __dirname,
    '..',
    '..',
    'campaigns',
    'combat-reviews-flagship-02',
    'scene-manifest.json',
  );

  async function campaign() {
    return parseSceneManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  }

  it('routes the two HANDHELD_DRIFT scenes to a locked-off frame plus post-motion', async () => {
    const manifest = await campaign();
    const routed = manifest.scenes
      .filter((scene) => modeReachesGenerationProvider(scene.generationMode))
      .filter((scene) => routeLtxCameraMotion(scene.cameraMotion).deterministicPostMotionRequired);

    expect(routed.map((scene) => scene.sceneNumber)).toEqual([8, 9]);
    for (const scene of routed) {
      expect(scene.cameraMotion).toBe('HANDHELD_DRIFT');
      expect(routeLtxCameraMotion(scene.cameraMotion).providerValue).toBe('static');
      // The authored second stage exists, or the manifest would not parse.
      expect(scene.postMotion).toBeDefined();
    }
  });

  it('carries the authored drift the reviewer specified for each of them', async () => {
    const manifest = await campaign();
    const eight = manifest.scenes.find((scene) => scene.sceneNumber === 8);
    const nine = manifest.scenes.find((scene) => scene.sceneNumber === 9);

    expect(eight?.postMotion?.treatment).toBe('SMOOTH_PUSH');
    expect(eight?.postMotion?.magnitudePercent).toBe(2);
    expect(eight?.postMotion?.direction).toBeUndefined();
    expect(eight?.postMotion?.preservedRegion).toMatch(/predictor-rank/i);
    expect(eight?.postMotion?.prohibitions.join(' ')).toMatch(/no rotation/i);
    expect(eight?.postMotion?.prohibitions.join(' ')).toMatch(/no random shake/i);

    expect(nine?.postMotion?.treatment).toBe('SMOOTH_HORIZONTAL_DRIFT');
    expect(nine?.postMotion?.magnitudePercent).toBe(1);
    expect(nine?.postMotion?.direction).toBe('LEFT');
    expect(nine?.postMotion?.preservedRegion).toMatch(/phone geometry/i);
    expect(nine?.postMotion?.prohibitions.join(' ')).toMatch(/no zoom/i);
    expect(nine?.postMotion?.prohibitions.join(' ')).toMatch(/no rotation/i);
    expect(nine?.postMotion?.prohibitions.join(' ')).toMatch(/no random shake/i);
  });

  it('never substitutes another LTX camera move for the authored drift', async () => {
    const manifest = await campaign();
    for (const scene of manifest.scenes.filter(
      (candidate) => candidate.cameraMotion === 'HANDHELD_DRIFT',
    )) {
      const value = routeLtxCameraMotion(scene.cameraMotion).providerValue;
      expect(value).toBe('static');
      for (const forbidden of [
        'dolly_in',
        'dolly_out',
        'dolly_left',
        'dolly_right',
        'jib_up',
        'jib_down',
      ]) {
        expect(value).not.toBe(forbidden);
      }
    }
  });

  it('can express every other scene that reaches the provider', async () => {
    const manifest = await campaign();
    const native = manifest.scenes
      .filter((scene) => modeReachesGenerationProvider(scene.generationMode))
      .filter((scene) => scene.cameraMotion !== 'HANDHELD_DRIFT');

    expect(native.length).toBeGreaterThan(0);
    for (const scene of native) {
      expect(LTX_CAMERA_MOTIONS).toContain(toLtxCameraMotion(scene.cameraMotion));
      expect(scene.postMotion).toBeUndefined();
    }
  });

  it('binds Scene 1 to the move that was actually generated', async () => {
    const manifest = await campaign();
    const scene = manifest.scenes.find((candidate) => candidate.sceneNumber === 1);
    expect(scene?.cameraMotion).toBe('SLOW_PUSH_IN');
    expect(toLtxCameraMotion(scene?.cameraMotion as string)).toBe('dolly_in');
  });
});

describe('the post-motion contract', () => {
  /** Ten valid scenes with scene 8 overridden — the two-stage scene under test. */
  const manifestWith = (overrides: Record<string, unknown>) => ({
    manifestVersion: 1,
    storyboardId: STORYBOARD_ID,
    authoredBy: 'contract test',
    scenes: Array.from({ length: 10 }, (_, index) =>
      index === 7 ? scene(8, { cameraMotion: 'HANDHELD_DRIFT', ...overrides }) : scene(index + 1),
    ),
  });

  const postMotion = {
    treatment: 'SMOOTH_PUSH',
    magnitudePercent: 2,
    preservedRegion: 'the right-side interface space',
    prohibitions: ['no rotation', 'no random shake'],
    rationale: 'the provider has no handheld value',
  };

  it('refuses a routed scene that declares no second stage', () => {
    expect(() => parseSceneManifest(manifestWith({}))).toThrow(/states no postMotion/i);
  });

  it('refuses a post-motion on a scene the provider carries itself', () => {
    expect(() =>
      parseSceneManifest(manifestWith({ cameraMotion: 'SLOW_PUSH_IN', postMotion })),
    ).toThrow(/carried by the provider itself/i);
  });

  it('refuses a horizontal drift with no direction, and a push with one', () => {
    expect(() =>
      parseSceneManifest(
        manifestWith({ postMotion: { ...postMotion, treatment: 'SMOOTH_HORIZONTAL_DRIFT' } }),
      ),
    ).toThrow(/states no direction/i);
    expect(() =>
      parseSceneManifest(manifestWith({ postMotion: { ...postMotion, direction: 'LEFT' } })),
    ).toThrow(/does not have/i);
  });

  it('refuses a magnitude beyond the restrained ceiling', () => {
    expect(() =>
      parseSceneManifest(
        manifestWith({
          postMotion: {
            ...postMotion,
            magnitudePercent: POST_MOTION_MAX_MAGNITUDE_PERCENT + 1,
          },
        }),
      ),
    ).toThrow();
  });

  it('accepts the authored two-stage scene', () => {
    expect(() => parseSceneManifest(manifestWith({ postMotion }))).not.toThrow();
  });
});
