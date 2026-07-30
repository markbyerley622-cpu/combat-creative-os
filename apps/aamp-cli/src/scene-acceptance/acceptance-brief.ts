import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { StoryboardVideoError } from '../storyboard-video/failures';
import { CAMERA_MOTIONS, GENERATION_MODES } from '../storyboard-video/scene-manifest';
import type { SceneManifestEntry } from '../storyboard-video/scene-manifest';

/**
 * The Scene-1 acceptance brief — authored by a person, validated here.
 *
 * Every creative decision in this milestone lives in this document: the motion
 * prompt, the camera move, the notification copy, its timing and its colours.
 * No default is supplied for any of them, because a "sensible default"
 * headline or a fallback prompt would make this code the author of the
 * advertisement rather than the thing that executes it. A field that is
 * missing is a refusal.
 *
 * The scene block is deliberately the same shape the production scene manifest
 * uses. That is what lets the existing prompt gate, the existing motion
 * inspection and the existing review identity all apply unchanged — a Scene-1
 * acceptance run is judged against exactly the contract the fifteen-second cut
 * would judge it against, not a looser one written for a proof.
 */

export const ACCEPTANCE_BRIEF_VERSION = 1 as const;

/** The one scene this milestone proves. Scenes 2–10 are explicitly out of scope. */
export const ACCEPTANCE_SCENE_NUMBER = 1 as const;
export const ACCEPTANCE_SCENE_ROLE = 'NOTIFICATION_HOOK' as const;

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

const SceneSchema = z
  .object({
    sceneNumber: z.literal(ACCEPTANCE_SCENE_NUMBER),
    sourceFrame: z.literal('FRAME-01'),
    outputStartSeconds: z.number().min(0),
    outputEndSeconds: z.number().positive(),
    generationMode: z.enum(GENERATION_MODES),
    motionPrompt: z.string().min(1).max(4000),
    cameraMotion: z.enum(CAMERA_MOTIONS),
    preserveExactTypography: z.boolean(),
    preserveExactProductUi: z.boolean(),
    acceptableFootageRoles: z.array(z.string().min(1).max(80)).max(8).default([]),
    intent: z.string().min(1).max(600),
  })
  .strict();

/**
 * The notification, as a person specified it.
 *
 * `treatment` names where the card lives and `treatmentReason` says why, in
 * the author's own words. The decision to composite in screen space rather
 * than tracked into the handset is a real creative and technical trade-off,
 * and an artefact that recorded the choice without the reasoning would leave
 * the next person to rediscover it.
 */
const NotificationSchema = z
  .object({
    treatment: z.enum(['SCREEN_SPACE_MOTION_GRAPHICS', 'TRACKED_IN_SCREEN']),
    treatmentReason: z.string().min(20).max(800),
    headline: z.string().min(1).max(60),
    entranceStartSeconds: z.number().min(0),
    settleStepSeconds: z.number().positive().max(0.5),
    pulseStartSeconds: z.number().min(0),
    pulseDurationSeconds: z.number().positive().max(1),
    cardTopPx: z.number().int().positive(),
    cardHeightPx: z.number().int().positive(),
    safeMarginPx: z.number().int().min(24),
    accentColorHex: HexColor,
    cardColorHex: HexColor,
    headlineColorHex: HexColor,
    fontFamily: z.string().min(1).max(60),
    fontSizePx: z.number().int().positive().max(200),
  })
  .strict();
export type NotificationBrief = z.infer<typeof NotificationSchema>;

const BriefSchema = z
  .object({
    briefVersion: z.literal(ACCEPTANCE_BRIEF_VERSION),
    storyboardId: z.string().min(1).max(120),
    /** A named person. There is no default and no "system" author. */
    authoredBy: z.string().min(2).max(200),
    plateFrameId: z.literal('FRAME-01'),
    model: z.string().min(1).max(60),
    generationDurationSeconds: z.number().positive(),
    generateAudio: z.boolean(),
    maximumAuthorisedCostCents: z.number().int().positive().max(10_000),
    scene: SceneSchema,
    notification: NotificationSchema,
  })
  .strict();

export interface AcceptanceBrief {
  readonly briefVersion: typeof ACCEPTANCE_BRIEF_VERSION;
  readonly storyboardId: string;
  readonly authoredBy: string;
  readonly plateFrameId: 'FRAME-01';
  readonly model: string;
  readonly generationDurationSeconds: number;
  readonly generateAudio: boolean;
  readonly maximumAuthorisedCostCents: number;
  readonly scene: SceneManifestEntry;
  readonly notification: NotificationBrief;
}

export function parseAcceptanceBrief(value: unknown, path?: string): AcceptanceBrief {
  const result = BriefSchema.safeParse(value);
  if (!result.success) {
    throw new StoryboardVideoError(
      'INVALID_STORYBOARD',
      `the Scene-1 acceptance brief${path ? ` at ${path}` : ''} is invalid:\n${result.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  const brief = result.data;
  assertBriefIsCoherent(brief, path);
  return brief;
}

export async function loadAcceptanceBrief(path: string): Promise<AcceptanceBrief> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new StoryboardVideoError(
      'INVALID_STORYBOARD',
      `the Scene-1 acceptance brief at ${path} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseAcceptanceBrief(raw, path);
}

/**
 * The cross-field rules a schema cannot state.
 *
 * The structural one is the same rule the production manifest enforces:
 * exact typography and exact product UI can never be regenerated, so either
 * flag makes `LTX_IMAGE_TO_VIDEO` unreachable. The rest keep the notification
 * inside the picture and inside its own clip.
 */
function assertBriefIsCoherent(brief: AcceptanceBrief, path?: string): void {
  const problems: string[] = [];
  const { scene, notification } = brief;

  if (scene.outputEndSeconds <= scene.outputStartSeconds) {
    problems.push('the scene ends at or before it starts');
  }
  if (
    scene.generationMode === 'LTX_IMAGE_TO_VIDEO' &&
    (scene.preserveExactTypography || scene.preserveExactProductUi)
  ) {
    problems.push(
      `the scene is LTX_IMAGE_TO_VIDEO but declares ${
        scene.preserveExactTypography ? 'preserveExactTypography' : 'preserveExactProductUi'
      }: exact typography and exact product UI can never be regenerated, because a model asked to redraw an interface invents its contents`,
    );
  }
  if (notification.entranceStartSeconds >= brief.generationDurationSeconds) {
    problems.push(
      `the notification enters at ${notification.entranceStartSeconds}s, at or after the ${brief.generationDurationSeconds}s the clip runs`,
    );
  }
  if (
    notification.pulseStartSeconds + notification.pulseDurationSeconds >
    brief.generationDurationSeconds + 1e-9
  ) {
    problems.push('the accent pulse runs past the end of the clip');
  }
  if (notification.pulseStartSeconds < notification.entranceStartSeconds) {
    problems.push('the accent pulse fires before the card it belongs to has arrived');
  }
  if (problems.length > 0) {
    throw new StoryboardVideoError(
      'INVALID_STORYBOARD',
      `the Scene-1 acceptance brief${path ? ` at ${path}` : ''} is not coherent:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
  }
}
