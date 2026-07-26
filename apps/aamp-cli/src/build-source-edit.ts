import { parseRenderManifest, type RenderManifest } from '@combat/media';

import type { ResolvedAsset } from './asset-resolution';
import type { CampaignRequest } from './campaign-request';
import type { ShotSelection } from './source-selection';

/**
 * Turns the agents' plan plus the selected sources into the existing
 * `RenderManifest`.
 *
 * Everything prompt-specific arrives here already decided: which beats exist
 * and in what order (Script/Timing Director), what each shot is doing
 * (Shot-Prompt Engineer), and which real asset fills it (source selection).
 * This module's job is purely to express that as a timeline the deterministic
 * renderer accepts — frame arithmetic, transition choice, overlay placement,
 * safe areas, caption timing and per-shot provenance.
 *
 * All timing is integer frames until the last moment, for the reason the
 * previous milestone's builder documents: the render manifest enforces an
 * exact-duration contract and accumulating fractional seconds is the reliable
 * way to miss it by a frame.
 */

const FRAME_RATE = 30;
const TRANSITION_FRAMES = 9; // 0.3s — quick enough for a feed, long enough to read as a transition
const MIN_SCENE_FRAMES = TRANSITION_FRAMES + 9;

export class EditConstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditConstructionError';
  }
}

export interface BuildSourceEditOptions {
  readonly request: CampaignRequest;
  readonly selections: readonly ShotSelection[];
  /** Every resolved asset, so branding and music can be located by id. */
  readonly assets: readonly ResolvedAsset[];
  /** Caption lines, in beat order, from the script. */
  readonly captionLines: readonly string[];
}

const frames = (count: number): number => count / FRAME_RATE;

/**
 * Chooses the transition into a scene from the story move being made.
 *
 * A cut from the hook into the event detail should feel like an edit; a move
 * between two informational app screens should feel continuous. Encoding that
 * as an explicit rule keeps the edit legible and reviewable, rather than
 * applying one crossfade everywhere because it is safe.
 */
export type EditTransition =
  'CUT' | 'CROSSFADE' | 'DIP_TO_BLACK' | 'IMPACT_CUT' | 'MASKED_UI_REVEAL';

export function transitionFor(previous: ShotSelection, current: ShotSelection): EditTransition {
  if (current.storyBeat === 'CTA') return 'DIP_TO_BLACK';
  const enteringApp = current.asset.asset.role === 'APP_SCREENSHOT';
  const leavingFootage = previous.asset.asset.role === 'SOURCE_CLIP';
  if (enteringApp && leavingFootage) return 'MASKED_UI_REVEAL';
  if (enteringApp && previous.asset.asset.role === 'APP_SCREENSHOT') return 'CROSSFADE';
  if (current.storyBeat === 'EVENT_DETAIL') return 'IMPACT_CUT';
  return 'CUT';
}

/**
 * Distributes the timeline across the selected shots.
 *
 * Video scenes are capped by what their source actually contains; stills absorb
 * the remainder, and the last still carries the rounding difference so the
 * total lands exactly on the requested duration.
 */
export function planSceneFrames(
  selections: readonly ShotSelection[],
  totalFrames: number,
): readonly number[] {
  if (selections.length === 0) throw new EditConstructionError('a cut needs at least one scene');

  const overlapFrames = (selections.length - 1) * TRANSITION_FRAMES;
  const requiredFrames = totalFrames + overlapFrames;

  const planned = selections.map((selection) => {
    const requested = Math.round(selection.shot.durationSeconds * FRAME_RATE);
    if (selection.asset.asset.kind === 'VIDEO') {
      // One frame of slack: never trim to a source's exact final frame.
      const available = Math.max(
        1,
        Math.floor((selection.asset.measuredDurationSeconds ?? 0) * FRAME_RATE) - 1,
      );
      return { frames: Math.max(MIN_SCENE_FRAMES, Math.min(requested, available)), elastic: false };
    }
    return { frames: Math.max(MIN_SCENE_FRAMES, requested), elastic: true };
  });

  const elasticIndices = planned
    .map((entry, index) => (entry.elastic ? index : -1))
    .filter((index) => index >= 0);
  if (elasticIndices.length === 0) {
    throw new EditConstructionError(
      'every scene is fixed-length footage, so the timeline cannot be balanced to the requested duration — include at least one still or brand card',
    );
  }

  const fixedTotal = planned
    .filter((entry) => !entry.elastic)
    .reduce((sum, entry) => sum + entry.frames, 0);
  const remaining = requiredFrames - fixedTotal;
  if (remaining < elasticIndices.length * MIN_SCENE_FRAMES) {
    throw new EditConstructionError(
      `selected footage occupies ${fixedTotal} frames, leaving only ${remaining} for ${elasticIndices.length} still scene(s), which need at least ${elasticIndices.length * MIN_SCENE_FRAMES}`,
    );
  }

  const perElastic = Math.floor(remaining / elasticIndices.length);
  elasticIndices.forEach((planIndex, ordinal) => {
    const entry = planned[planIndex];
    if (!entry) return;
    entry.frames =
      ordinal === elasticIndices.length - 1
        ? remaining - perElastic * (elasticIndices.length - 1)
        : perElastic;
  });

  return planned.map((entry) => entry.frames);
}

export function buildSourceEdit(options: BuildSourceEditOptions): RenderManifest {
  const { request, selections, assets } = options;

  const logo = assets.find((entry) => entry.asset.id === request.brandKit.logoAssetId);
  if (!logo) {
    throw new EditConstructionError(
      `brandKit.logoAssetId "${request.brandKit.logoAssetId}" is not present in the production asset manifest`,
    );
  }
  const music = assets.find((entry) => entry.asset.role === 'MUSIC');

  // One render source per distinct asset actually used, plus the logo and any
  // music bed. Deduplicated because a manifest may not declare the same id twice.
  const usedAssets = new Map<string, ResolvedAsset>();
  for (const selection of selections) usedAssets.set(selection.asset.asset.id, selection.asset);
  usedAssets.set(logo.asset.id, logo);
  if (music) usedAssets.set(music.asset.id, music);

  const sources: RenderManifest['sources'] = [...usedAssets.values()]
    .sort((a, b) => a.asset.id.localeCompare(b.asset.id))
    .map((entry) => ({
      id: entry.asset.id,
      kind: entry.asset.kind,
      path: entry.absolutePath,
      description: entry.asset.description,
      license: {
        // The renderer's vocabulary has two output-eligible classes; a
        // COMMISSIONED asset is ours outright, so it maps to OWNED.
        usageClass:
          entry.asset.rights.classification === 'LICENSED_FOR_OUTPUT'
            ? ('LICENSED_FOR_OUTPUT' as const)
            : ('OWNED' as const),
        rightsHolder: entry.asset.rights.owner,
        licenseType: entry.asset.rights.classification,
        ...(entry.asset.rights.expiresAt ? { expiresAt: entry.asset.rights.expiresAt } : {}),
        ...(entry.asset.rights.attribution ? { attribution: entry.asset.rights.attribution } : {}),
        restrictions: entry.asset.rights.restrictions,
      },
      expectedChecksum: entry.checksumSha256,
    }));

  const totalFrames = Math.round(request.targetDurationSeconds * FRAME_RATE);
  const sceneFrames = planSceneFrames(selections, totalFrames);

  const scenes = selections.map((selection, index) => {
    const durationFrames = sceneFrames[index] ?? MIN_SCENE_FRAMES;
    const previous = selections[index - 1];
    const isVideo = selection.asset.asset.kind === 'VIDEO';
    return {
      id: `s${index}-${selection.storyBeat.toLowerCase()}`,
      sourceId: selection.asset.asset.id,
      durationSeconds: frames(durationFrames),
      ...(isVideo ? { trim: { inSeconds: 0, outSeconds: frames(durationFrames) } } : {}),
      framing: { mode: 'COVER' as const, anchorX: 0.5, anchorY: 0.5 },
      // Stills get a slow push so a static screenshot still reads as motion in
      // a feed; footage is left alone because it already moves.
      motion: isVideo ? ('STATIC' as const) : ('PUSH_IN' as const),
      motionIntensity: isVideo ? 0 : 0.3,
      ...(previous && index > 0
        ? {
            transitionIn: {
              kind: transitionFor(previous, selection),
              durationSeconds: frames(TRANSITION_FRAMES),
            },
          }
        : {}),
      useSourceAudio: false,
    };
  });

  const ctaStartSeconds = request.targetDurationSeconds - request.cta.durationSeconds;
  const cues = buildCaptionCues(options.captionLines, sceneFrames, ctaStartSeconds);

  const draft = {
    manifestVersion: 1 as const,
    name: request.name,
    campaignId: request.campaignId,
    workspaceId: request.workspaceId,
    campaignPrompt: request.campaignPrompt.slice(0, 4000),
    output: {
      durationSeconds: request.targetDurationSeconds,
      aspectRatio: '9:16' as const,
      widthPx: 1080 as const,
      heightPx: 1920 as const,
      frameRate: 30 as const,
      container: 'mp4' as const,
      videoCodec: 'h264' as const,
      audioCodec: music ? ('aac' as const) : null,
      pixelFormat: 'yuv420p' as const,
      durationToleranceFrames: 2,
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      deliveryProfileVersion: 1,
    },
    sources,
    scenes,
    overlays: [],
    ...(cues.length > 0
      ? {
          captions: {
            style: {
              fontFamily: request.brandKit.captionFontFamily,
              fontSizePx: 56,
              primaryColorHex: '#FFFFFF',
              outlineColorHex: '#000000',
              outlineWidthPx: 4,
              bold: true,
              uppercase: true,
              marginBottomPx: request.brandKit.safeAreaBottomPx,
              marginHorizontalPx: 96,
            },
            cues,
          },
        }
      : {}),
    branding: {
      logoSourceId: logo.asset.id,
      anchor: 'TOP_CENTER' as const,
      offsetXPx: 0,
      // Inside the declared top safe area, so the logo never collides with a
      // platform's own overlaid UI.
      offsetYPx: Math.max(48, Math.round(request.brandKit.safeAreaTopPx / 2)),
      widthPx: 300,
      opacity: 0.92,
      windows: [],
    },
    cta: {
      headline: request.cta.headline,
      ...(request.cta.subline ? { subline: request.cta.subline } : {}),
      startSeconds: ctaStartSeconds,
      endSeconds: request.targetDurationSeconds,
      backgroundHex: request.brandKit.primaryColorHex,
      headlineColorHex: '#FFFFFF',
      sublineColorHex: request.brandKit.accentColorHex,
      logoSourceId: logo.asset.id,
      logoWidthPx: 420,
    },
    ...(music
      ? {
          audio: {
            tracks: [
              {
                id: 'music-bed',
                sourceId: music.asset.id,
                role: 'MUSIC' as const,
                startSeconds: 0,
                sourceOffsetSeconds: 0,
                gainDb: -6,
                fadeInSeconds: 0.4,
                fadeOutSeconds: 1,
                loop: true,
              },
            ],
            loudness: {},
            musicDuckingDb: 12,
          },
        }
      : {}),
  };

  // Parsed, not cast: the render manifest's own cross-field rules are the
  // authority on whether this timeline is coherent, and a builder bug should
  // surface here rather than as an opaque FFmpeg failure.
  return parseRenderManifest(draft);
}

/**
 * Places one caption per scene, aligned to that scene's own window, stopping
 * before the CTA card so copy never collides with the end frame's headline.
 */
function buildCaptionCues(
  lines: readonly string[],
  sceneFrames: readonly number[],
  untilSeconds: number,
): { startSeconds: number; endSeconds: number; text: string }[] {
  const cues: { startSeconds: number; endSeconds: number; text: string }[] = [];
  let cursorFrames = 0;

  for (let index = 0; index < sceneFrames.length; index += 1) {
    const sceneLength = sceneFrames[index] ?? 0;
    const line = lines[index]?.trim();
    const startFrames = cursorFrames === 0 ? 0 : cursorFrames - TRANSITION_FRAMES;
    cursorFrames = startFrames + sceneLength;

    if (!line) continue;
    const endSeconds = Math.min(frames(cursorFrames), untilSeconds);
    const startSeconds = frames(startFrames);
    if (endSeconds - startSeconds < 0.5) continue;
    cues.push({ startSeconds, endSeconds, text: line.slice(0, 240) });
  }

  return cues;
}
