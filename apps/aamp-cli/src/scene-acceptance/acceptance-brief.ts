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
 * `treatment` names what the card *is* and `treatmentReason` says why, in the
 * author's own words. `LAYERED_SURFACE_COMPOSITE` is a designed surface —
 * logo, header, timestamp, headline, supporting line, accent edge, shadow —
 * laid out as one document and rasterised to transparent pixels, then
 * composited over the picture as a single assembled unit. It replaced a
 * prototype that drew a filled rectangle with `drawbox` and dropped a line of
 * subtitle text on top; that treatment could not express a corner radius, a
 * translucent surface, a shadow, a second line of type or a mark that sat
 * anywhere but where the filter graph put it.
 *
 * Every creative decision below is a person's. The ranges are the visual
 * specification the author signed off — a height outside 190–220px or a corner
 * radius outside 28–36px is not a smaller mistake than a missing headline, so
 * both are refused here rather than rendered.
 */
export const NOTIFICATION_SURFACE_DESIGN_VERSION = 2 as const;

/** The easings this treatment can actually execute. Named, never numeric. */
export const NOTIFICATION_EASINGS = ['EASE_OUT_CUBIC', 'EASE_OUT_QUINT'] as const;
/** Which edge of the card carries the accent. */
export const NOTIFICATION_ACCENT_EDGES = ['BOTTOM', 'LEFT'] as const;

const NotificationSchema = z
  .object({
    treatment: z.enum(['LAYERED_SURFACE_COMPOSITE', 'TRACKED_IN_SCREEN']),
    treatmentReason: z.string().min(20).max(1200),
    surfaceDesignVersion: z.literal(NOTIFICATION_SURFACE_DESIGN_VERSION),

    // --- the copy, in the author's own words ---------------------------------
    headerLabel: z.string().min(1).max(40),
    timestampLabel: z.string().min(1).max(12),
    headline: z.string().min(1).max(60),
    supportingLine: z.string().min(1).max(80),

    // --- geometry, in delivery pixels ----------------------------------------
    /** Fraction of the delivery width. The specification asks for about 0.75. */
    widthFraction: z.number().min(0.6).max(0.85),
    cardHeightPx: z.number().int().min(190).max(220),
    cornerRadiusPx: z.number().int().min(28).max(36),
    /** Where the resting card is centred vertically. */
    cardCentreYPx: z.number().int().positive(),
    safeMarginPx: z.number().int().min(24),
    horizontalPaddingPx: z.number().int().min(16).max(64),

    // --- the surface ---------------------------------------------------------
    surfaceColorHex: HexColor,
    /** Lightly translucent. Opaque is not this design and neither is a ghost. */
    surfaceOpacity: z.number().min(0.7).max(0.98),
    shadowBlurPx: z.number().int().min(8).max(48),
    shadowOffsetYPx: z.number().int().min(0).max(24),
    shadowOpacity: z.number().min(0).max(0.6),
    accentColorHex: HexColor,
    accentEdge: z.enum(NOTIFICATION_ACCENT_EDGES),
    accentThicknessPx: z.number().int().min(3).max(10),
    accentGlowBlurPx: z.number().int().min(0).max(40),
    accentRestOpacity: z.number().min(0).max(1),
    accentPulsePeakOpacity: z.number().min(0).max(1),

    // --- typography ----------------------------------------------------------
    fontFamily: z.string().min(1).max(60),
    headerColorHex: HexColor,
    headerFontSizePx: z.number().int().min(14).max(40),
    headlineColorHex: HexColor,
    headlineFontSizePx: z.number().int().min(28).max(80),
    supportingColorHex: HexColor,
    supportingFontSizePx: z.number().int().min(14).max(48),
    markHeightPx: z.number().int().min(24).max(96),

    // --- the entrance --------------------------------------------------------
    entranceStartSeconds: z.number().min(0),
    entranceSettleSeconds: z.number().positive(),
    entranceSteps: z.number().int().min(3).max(10),
    entranceEasing: z.enum(NOTIFICATION_EASINGS),
    /** How far the card travels upward as it arrives. */
    entranceRisePx: z.number().int().min(8).max(40),
    entranceStartScale: z.number().min(0.9).max(0.995),

    // --- the single accent pulse ---------------------------------------------
    pulseStartSeconds: z.number().min(0),
    pulseEndSeconds: z.number().positive(),
    pulseSteps: z.number().int().min(2).max(8),

    /** The card holds, unfaded, to here — the Scene-1 cut. */
    readableUntilSeconds: z.number().positive(),
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
  if (notification.entranceSettleSeconds <= notification.entranceStartSeconds) {
    problems.push('the notification settles at or before it starts entering');
  }
  if (notification.pulseEndSeconds <= notification.pulseStartSeconds) {
    problems.push('the accent pulse ends at or before it starts');
  }
  if (notification.pulseStartSeconds + 1e-9 < notification.entranceSettleSeconds) {
    // The pulse is a note struck on a card that has arrived. Firing it mid-entrance
    // would read as an error light rather than an accent.
    problems.push('the accent pulse fires before the card it belongs to has settled');
  }
  if (notification.pulseEndSeconds > notification.readableUntilSeconds + 1e-9) {
    problems.push('the accent pulse runs past the cut it is meant to lead into');
  }
  if (notification.readableUntilSeconds > brief.generationDurationSeconds + 1e-9) {
    problems.push('the notification is required to stay readable past the end of the clip');
  }
  if (
    Math.abs(notification.readableUntilSeconds - scene.outputEndSeconds) > 1e-6 ||
    scene.outputStartSeconds !== 0
  ) {
    // "Readable until the Scene-1 cut" is the specification. A card that stops
    // short of the cut fades out, and this treatment has no fade-out.
    problems.push(
      `the notification stays readable to ${notification.readableUntilSeconds}s but Scene 1 is cut at ${scene.outputEndSeconds}s from ${scene.outputStartSeconds}s`,
    );
  }
  if (notification.accentPulsePeakOpacity <= notification.accentRestOpacity) {
    problems.push('the accent pulse peaks at or below its resting opacity, so nothing pulses');
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
