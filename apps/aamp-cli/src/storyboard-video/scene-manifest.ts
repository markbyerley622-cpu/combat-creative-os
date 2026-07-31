import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { routeLtxCameraMotion } from '@combat/providers';

import {
  LOCKED_SCENE_ROLES,
  LOCKED_SCENE_SLOTS,
  STORYBOARD_V2_DURATION_SECONDS,
  type VerifiedStoryboardV2,
} from '../flagship/storyboard-v2';
import { StoryboardVideoError } from './failures';
import { canonicalFrameId, KEYFRAME_COUNT } from './keyframe-library';

/**
 * The ordered scene manifest — how each locked storyboard scene is turned into
 * moving picture.
 *
 * This is a narrow extension, and the narrowness is the design. It adds the
 * eight fields a generation run genuinely needs and nothing else; scene order,
 * scene roles, slot timing and the rights position all still come from the
 * locked storyboard package, and this document is *checked against* them
 * rather than allowed to restate them. A manifest that disagrees with the
 * storyboard about when scene 4 starts is refused, because the storyboard is
 * the locked art direction and this file is a production instruction.
 *
 * The three generation modes are three different claims about a scene:
 *
 * - `LTX_IMAGE_TO_VIDEO` — a photographic plate a model may animate.
 * - `EXACT_UI_MOTION` — a Combat Reviews interface. Never sent to a model,
 *   because a generative model regenerating a rankings table produces
 *   plausible fighters who do not exist. Animated deterministically.
 * - `STATIC_BRAND_COMPOSITION` — restrained motion and a clean hold, for the
 *   brand and CTA frame.
 *
 * `preserveExactTypography` and `preserveExactProductUi` are the structural
 * enforcement of that: either one set true makes `LTX_IMAGE_TO_VIDEO`
 * unreachable for the scene, by refusal at parse time rather than by a check
 * somewhere downstream that could be forgotten.
 */

export const SCENE_MANIFEST_VERSION = 1 as const;

export const GENERATION_MODES = [
  'LTX_IMAGE_TO_VIDEO',
  'EXACT_UI_MOTION',
  'STATIC_BRAND_COMPOSITION',
] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

/** Modes that never construct a generation request. A property of the enum, checked by a test. */
export function modeReachesGenerationProvider(mode: GenerationMode): boolean {
  return mode === 'LTX_IMAGE_TO_VIDEO';
}

/**
 * Camera motion vocabulary.
 *
 * Closed, because it travels into a paid request and an unbounded free-text
 * field is one place a factual claim could leave the prompt gate's reach. The
 * value is passed to LTX as its own `camera_motion` argument, separate from
 * the prose prompt.
 */
export const CAMERA_MOTIONS = [
  'STATIC',
  'SLOW_PUSH_IN',
  /**
   * A push held to a stated percentage, carried in two stages.
   *
   * Distinct from `SLOW_PUSH_IN`, and the distinction is evidence rather than
   * taste. `SLOW_PUSH_IN` maps to the provider's own `dolly_in`, which is a
   * push and is honestly named — but the first live Scene-1 generation asked
   * for a restrained push and came back at roughly 1.75x, ending with the
   * subject's eyes outside frame. "Slow" lives in the prose prompt and the
   * model is free to read it as it likes; there is no magnitude field on the
   * wire, and a fabricated one would be a guess with a number in it.
   *
   * So a push whose *magnitude is part of the art direction* is routed: the
   * provider is asked for a locked-off frame and AAMP performs the push
   * deterministically, to the exact percentage a person wrote down. This is
   * not a substitution — the shot is still a push — it is a decision about
   * which stage owns the number.
   */
  'CONTROLLED_PUSH_IN',
  'SLOW_PULL_OUT',
  'HANDHELD_DRIFT',
  'LATERAL_TRACK_LEFT',
  'LATERAL_TRACK_RIGHT',
  'TILT_UP',
  'TILT_DOWN',
  'ORBIT_LEFT',
  'ORBIT_RIGHT',
] as const;
export type CameraMotion = (typeof CAMERA_MOTIONS)[number];

/**
 * Under 200 words, and the limit is enforced in words rather than characters
 * because that is the unit the model's own guidance is written in.
 */
export const MOTION_PROMPT_MAX_WORDS = 200;

/**
 * The deterministic second stage of a two-stage camera motion.
 *
 * Authored, never inferred. When a scene's move cannot be expressed by the
 * generation provider, the provider is asked for a locked-off frame and this
 * block says exactly what AAMP applies afterwards — the treatment, how far, in
 * which direction, and what must not be disturbed.
 *
 * Every field is a creative decision a person made. There is no default
 * magnitude and no default treatment, because a drift nobody specified is a
 * drift nobody approved. The vocabulary is closed and lists only treatments
 * that are implementable as a smooth, deterministic transform: no rotation, no
 * random shake, and nothing that could vary between two runs of the same plan.
 */
export const POST_MOTION_TREATMENTS = ['SMOOTH_PUSH', 'SMOOTH_HORIZONTAL_DRIFT'] as const;
export type PostMotionTreatment = (typeof POST_MOTION_TREATMENTS)[number];

export const POST_MOTION_DIRECTIONS = ['LEFT', 'RIGHT'] as const;

/** Restrained by contract. A "drift" above this is a move, and a move needs its own scene. */
export const POST_MOTION_MAX_MAGNITUDE_PERCENT = 5;

const PostMotionSchema = z
  .object({
    treatment: z.enum(POST_MOTION_TREATMENTS),
    /** How far, as a percentage of frame. Restrained by the ceiling above. */
    magnitudePercent: z.number().positive().max(POST_MOTION_MAX_MAGNITUDE_PERCENT),
    /** Required by a horizontal drift, meaningless to a push. */
    direction: z.enum(POST_MOTION_DIRECTIONS).optional(),
    /**
     * What the move must not crop, obscure or distort, in the author's words.
     * A drift that walked an interface out of frame would be a defect the
     * transform itself cannot detect.
     */
    preservedRegion: z.string().min(1).max(200),
    /**
     * The same region as a rectangle, so the claim can be checked.
     *
     * Optional, and its absence is honest rather than convenient: prose cannot
     * be measured, and a run whose scene declares only prose records the
     * geometric check as `NOT_MEASURED` with that reason rather than reporting
     * a pass it never took. Supplying it turns "must not crop the rankings
     * region" into arithmetic against the tightest window the move reaches,
     * refused before FFmpeg is invoked.
     */
    preservedRegionRect: z
      .object({
        xFraction: z.number().min(0).max(1),
        yFraction: z.number().min(0).max(1),
        widthFraction: z.number().positive().max(1),
        heightFraction: z.number().positive().max(1),
      })
      .strict()
      .optional(),
    /** What this treatment may never do. Stated so a reviewer can check it. */
    prohibitions: z.array(z.string().min(1).max(120)).min(1).max(8),
    /** Why the provider cannot carry this move itself, in the author's words. */
    rationale: z.string().min(1).max(300),
  })
  .strict();
export type ScenePostMotion = z.infer<typeof PostMotionSchema>;

const SceneSchema = z
  .object({
    sceneNumber: z.number().int().min(1).max(KEYFRAME_COUNT),
    /** `FRAME-01` … `FRAME-10`, resolved against the authoritative keyframe library. */
    sourceFrame: z.string().regex(/^FRAME-(0[1-9]|10)$/, 'sourceFrame is FRAME-01 … FRAME-10'),
    /** Optional end-frame guidance for a generation that must land somewhere specific. */
    lastFrame: z
      .string()
      .regex(/^FRAME-(0[1-9]|10)$/, 'lastFrame is FRAME-01 … FRAME-10')
      .optional(),
    outputStartSeconds: z.number().min(0),
    outputEndSeconds: z.number().positive(),
    generationMode: z.enum(GENERATION_MODES),
    motionPrompt: z.string().min(1).max(4000),
    cameraMotion: z.enum(CAMERA_MOTIONS),
    preserveExactTypography: z.boolean(),
    preserveExactProductUi: z.boolean(),
    /**
     * The pack role a real acquired plate must carry to be eligible for this
     * scene. Absent means no acquired footage can serve it, which is a
     * creative judgement and belongs to the author, not to a matcher.
     */
    acceptableFootageRoles: z.array(z.string().min(1).max(80)).max(8).default([]),
    /**
     * The deterministic second stage, for a motion the provider cannot express.
     *
     * Optional so every manifest written before two-stage routing existed still
     * parses unchanged. Whether it is *required* is a cross-field rule, checked
     * against the scene's own camera motion below.
     */
    postMotion: PostMotionSchema.optional(),
    /** Why this scene is what it is, in the author's own words. Travels into the report. */
    intent: z.string().min(1).max(600),
  })
  .strict();
export type SceneManifestEntry = z.infer<typeof SceneSchema>;

const ManifestSchema = z
  .object({
    manifestVersion: z.literal(SCENE_MANIFEST_VERSION),
    storyboardId: z.string().min(1),
    authoredBy: z.string().min(1).max(200),
    scenes: z.array(SceneSchema).length(KEYFRAME_COUNT),
  })
  .strict();

export interface SceneManifest {
  readonly manifestVersion: typeof SCENE_MANIFEST_VERSION;
  readonly storyboardId: string;
  readonly authoredBy: string;
  readonly scenes: readonly SceneManifestEntry[];
}

export function parseSceneManifest(value: unknown, path?: string): SceneManifest {
  const result = ManifestSchema.safeParse(value);
  if (!result.success) {
    throw new StoryboardVideoError(
      'INVALID_STORYBOARD',
      `the scene manifest${path ? ` at ${path}` : ''} is invalid:\n${result.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  assertPostMotionCoherent(result.data, path);
  return result.data;
}

/**
 * The structural half of two-stage camera motion.
 *
 * Checked at parse time rather than against the storyboard, because it is a
 * property of the scene alone: its generation mode, its camera motion, and
 * whether the provider can carry that motion by itself. Every reader of a
 * manifest gets it, so no downstream stage has to remember the rule.
 *
 * A scene whose move the provider cannot express must say what carries it
 * instead — otherwise the provider is asked for a locked-off frame and nothing
 * supplies the movement, producing a still labelled as a drift. A scene whose
 * move the provider *can* express must not claim a second stage it does not
 * need, or two moves would be applied to one shot.
 */
export function assertPostMotionCoherent(manifest: SceneManifest, path?: string): void {
  const problems: string[] = [];

  for (const scene of manifest.scenes) {
    if (!modeReachesGenerationProvider(scene.generationMode)) {
      if (scene.postMotion) {
        problems.push(
          `scene ${scene.sceneNumber} states a postMotion but is ${scene.generationMode}, which never calls a generation provider and animates deterministically already`,
        );
      }
    } else {
      let requiresPostMotion = false;
      try {
        requiresPostMotion = routeLtxCameraMotion(
          scene.cameraMotion,
        ).deterministicPostMotionRequired;
      } catch {
        // The provider refuses this motion outright. That is its own failure,
        // raised before any upload; it is not a post-motion question.
        requiresPostMotion = false;
      }
      if (requiresPostMotion && !scene.postMotion) {
        problems.push(
          `scene ${scene.sceneNumber} declares ${scene.cameraMotion}, which the generation provider cannot express, but states no postMotion. The provider would be asked for a locked-off frame and nothing would supply the move, producing a still labelled as a drift.`,
        );
      }
      if (!requiresPostMotion && scene.postMotion) {
        problems.push(
          `scene ${scene.sceneNumber} states a postMotion but its camera motion ${scene.cameraMotion} is carried by the provider itself. Two moves would be applied to one shot.`,
        );
      }
    }

    if (scene.postMotion?.treatment === 'SMOOTH_HORIZONTAL_DRIFT' && !scene.postMotion.direction) {
      problems.push(
        `scene ${scene.sceneNumber}'s horizontal drift states no direction; left and right are different shots`,
      );
    }
    if (scene.postMotion?.treatment === 'SMOOTH_PUSH' && scene.postMotion.direction) {
      problems.push(
        `scene ${scene.sceneNumber}'s push states a horizontal direction, which a push along the lens axis does not have`,
      );
    }
  }

  if (problems.length > 0) {
    throw new StoryboardVideoError(
      'INVALID_STORYBOARD',
      `the scene manifest${path ? ` at ${path}` : ''} does not describe a coherent two-stage motion:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
  }
}

/**
 * Reads the manifest and proves it describes *this* storyboard.
 *
 * Every check here is one a plausible-looking manifest could fail. The
 * ordering, the slots and the frame binding are all restated in a second
 * document precisely so a mistake in one is visible against the other — a
 * manifest that agreed with itself and disagreed with the storyboard would
 * render perfectly and be the wrong advertisement.
 */
export async function loadSceneManifest(
  manifestPath: string,
  storyboard: VerifiedStoryboardV2,
): Promise<SceneManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new StoryboardVideoError(
      'INVALID_STORYBOARD',
      `the scene manifest at ${manifestPath} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const manifest = parseSceneManifest(raw, manifestPath);
  assertSceneManifestMatchesStoryboard(manifest, storyboard);
  return manifest;
}

export function assertSceneManifestMatchesStoryboard(
  manifest: SceneManifest,
  storyboard: VerifiedStoryboardV2,
): void {
  const problems: string[] = [];

  if (manifest.storyboardId !== storyboard.storyboardId) {
    problems.push(
      `the manifest is written for storyboard "${manifest.storyboardId}" but the package is "${storyboard.storyboardId}"`,
    );
  }

  const ordered = [...manifest.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  ordered.forEach((scene, index) => {
    const position = index + 1;
    if (scene.sceneNumber !== position) {
      problems.push(`scene ${scene.sceneNumber} sits at position ${position}`);
    }
    if (scene.sourceFrame !== canonicalFrameId(scene.sceneNumber)) {
      problems.push(
        `scene ${scene.sceneNumber} declares sourceFrame ${scene.sourceFrame}; a scene renders its own frame, so ${canonicalFrameId(scene.sceneNumber)} is the only legal value`,
      );
    }
    const slot = LOCKED_SCENE_SLOTS[index];
    if (
      slot &&
      (Math.abs(scene.outputStartSeconds - slot[0]) > 1e-6 ||
        Math.abs(scene.outputEndSeconds - slot[1]) > 1e-6)
    ) {
      problems.push(
        `scene ${scene.sceneNumber} declares ${scene.outputStartSeconds}-${scene.outputEndSeconds}s but its locked slot is ${slot[0]}-${slot[1]}s`,
      );
    }
    const frame = storyboard.frames[index];
    if (frame && frame.sceneRole !== LOCKED_SCENE_ROLES[index]) {
      problems.push(
        `the storyboard package puts ${frame.sceneRole} at position ${position}, where the locked order requires ${LOCKED_SCENE_ROLES[index]}`,
      );
    }

    // The structural half of "critical UI never reaches a generative model".
    // A mode and a preservation flag that contradict each other is refused
    // here, so no downstream stage has to remember the rule.
    if (
      modeReachesGenerationProvider(scene.generationMode) &&
      (scene.preserveExactTypography || scene.preserveExactProductUi)
    ) {
      problems.push(
        `scene ${scene.sceneNumber} is ${scene.generationMode} but declares ${
          scene.preserveExactTypography ? 'preserveExactTypography' : 'preserveExactProductUi'
        }: exact typography and exact product UI cannot be regenerated, because a model asked to redraw an interface invents its contents`,
      );
    }
    if (scene.lastFrame && !modeReachesGenerationProvider(scene.generationMode)) {
      problems.push(
        `scene ${scene.sceneNumber} declares a lastFrame but is ${scene.generationMode}, which never calls a generation provider`,
      );
    }
  });

  let expectedStart = 0;
  for (const scene of ordered) {
    if (Math.abs(scene.outputStartSeconds - expectedStart) > 1e-6) {
      problems.push(
        `scene ${scene.sceneNumber} starts at ${scene.outputStartSeconds}s but the previous scene ended at ${expectedStart}s`,
      );
    }
    expectedStart = scene.outputEndSeconds;
  }
  if (Math.abs(expectedStart - STORYBOARD_V2_DURATION_SECONDS) > 1e-6) {
    problems.push(
      `the scenes tile ${expectedStart}s, not ${STORYBOARD_V2_DURATION_SECONDS}s — the locked cut is exactly ${STORYBOARD_V2_DURATION_SECONDS} seconds`,
    );
  }

  if (problems.length > 0) {
    throw new StoryboardVideoError(
      'INVALID_STORYBOARD',
      `the scene manifest does not describe the locked storyboard:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
  }
}

/** How long of a scene's slot the cut actually occupies. */
export function sceneSlotSeconds(scene: SceneManifestEntry): number {
  return Number((scene.outputEndSeconds - scene.outputStartSeconds).toFixed(6));
}
