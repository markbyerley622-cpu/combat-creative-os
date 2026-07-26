import { parseRenderManifest, type RenderManifest } from '@combat/media';

import type { CampaignGenerationManifest, ManifestAsset } from './generation-manifest';
import type { GeneratedShotResult } from './generate-shots';

/**
 * Assembles the existing `RenderManifest` from generated shots plus supplied
 * assets — the hinge between generation and the FFmpeg renderer that already
 * works.
 *
 * All timeline arithmetic is done in **frames**, as integers, and only
 * converted to seconds at the end. The render manifest enforces an exact
 * duration contract (scenes minus transition overlaps must equal the requested
 * length to within 1e-6), and accumulating fractional seconds is the reliable
 * way to miss it by a hair and get a parse error instead of a cut.
 */

const FRAME_RATE = 30;
const TRANSITION_FRAMES = 12; // 0.4s crossfade
const MIN_IMAGE_SCENE_FRAMES = TRANSITION_FRAMES + 6;

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineError';
  }
}

export interface BuildRenderManifestOptions {
  readonly manifest: CampaignGenerationManifest;
  readonly generatedShots: readonly GeneratedShotResult[];
  /** Every manifest asset with its resolved absolute path. */
  readonly resolvedAssets: readonly { asset: ManifestAsset; absolutePath: string }[];
}

interface PlannedScene {
  readonly sourceId: string;
  readonly kind: 'VIDEO' | 'IMAGE';
  /** For video: the clip's real length, in frames. Caps how long the scene can run. */
  readonly availableFrames?: number;
  frames: number;
}

/**
 * Distributes the timeline across scenes.
 *
 * Generated and licensed clips are pinned to what they actually contain — a
 * scene can never ask for more frames than its source has. Stills absorb
 * everything left over, because a still can be held for any length, and the
 * final still carries the rounding remainder so the total lands exactly.
 */
export function planTimeline(
  scenes: readonly PlannedScene[],
  totalFrames: number,
): readonly PlannedScene[] {
  if (scenes.length === 0) throw new TimelineError('a cut needs at least one scene');

  const overlapFrames = (scenes.length - 1) * TRANSITION_FRAMES;
  const requiredFrames = totalFrames + overlapFrames;

  const planned = scenes.map((scene) => ({ ...scene }));
  const videoScenes = planned.filter((scene) => scene.kind === 'VIDEO');
  const imageScenes = planned.filter((scene) => scene.kind === 'IMAGE');

  if (imageScenes.length === 0) {
    throw new TimelineError(
      'at least one still-image scene is required so the timeline can absorb the remainder',
    );
  }

  let allocated = 0;
  for (const scene of videoScenes) {
    // One frame of slack: a clip measured at 4.0333s should not be trimmed to
    // its exact last frame, where a decoder rounding difference could leave
    // the final frame short.
    const usable = Math.max(1, (scene.availableFrames ?? 0) - 1);
    scene.frames = usable;
    allocated += usable;
  }

  const remaining = requiredFrames - allocated;
  if (remaining < imageScenes.length * MIN_IMAGE_SCENE_FRAMES) {
    throw new TimelineError(
      `generated footage (${allocated} frames) leaves only ${remaining} frames for ${imageScenes.length} still scene(s), which needs at least ${imageScenes.length * MIN_IMAGE_SCENE_FRAMES}`,
    );
  }

  const perImage = Math.floor(remaining / imageScenes.length);
  imageScenes.forEach((scene, index) => {
    scene.frames =
      index === imageScenes.length - 1 ? remaining - perImage * (imageScenes.length - 1) : perImage;
  });

  return planned;
}

const frames = (count: number): number => count / FRAME_RATE;

export function buildRenderManifest(options: BuildRenderManifestOptions): RenderManifest {
  const { manifest, generatedShots, resolvedAssets } = options;
  const byRole = (role: ManifestAsset['role']) =>
    resolvedAssets.filter((entry) => entry.asset.role === role);

  const logo = byRole('LOGO')[0];
  if (!logo) throw new TimelineError('no LOGO asset resolved');
  const screenshots = byRole('APP_SCREENSHOT');
  if (screenshots.length === 0) throw new TimelineError('no APP_SCREENSHOT asset resolved');
  const licensedClips = byRole('LICENSED_CLIP');
  const music = byRole('MUSIC')[0];

  const sources: RenderManifest['sources'] = [
    ...generatedShots.map((shot) => ({
      id: `gen-${shot.brief.index}`,
      kind: 'VIDEO' as const,
      path: shot.localPath,
      description: `AI-generated shot ${shot.brief.index}: ${shot.brief.description}`,
      license: {
        // Model output produced by this system from its own prompt. `OWNED`
        // is the render-side class for it; the model licence that governs
        // commercial use is recorded on the workflow profile, and the QA
        // report carries the generation provenance.
        usageClass: 'OWNED' as const,
        rightsHolder: manifest.brandName,
        licenseType: 'GENERATED_OUTPUT',
        restrictions: [],
      },
      ...(shot.checksumSha256 ? { expectedChecksum: shot.checksumSha256 } : {}),
    })),
    ...[...licensedClips, ...screenshots, logo, ...(music ? [music] : [])].map((entry) => ({
      id: entry.asset.id,
      kind: entry.asset.kind,
      path: entry.absolutePath,
      description: entry.asset.description,
      license: {
        usageClass: entry.asset.license.usageClass as 'OWNED' | 'LICENSED_FOR_OUTPUT',
        rightsHolder: entry.asset.license.rightsHolder,
        licenseType: entry.asset.license.licenseType,
        ...(entry.asset.license.expiresAt ? { expiresAt: entry.asset.license.expiresAt } : {}),
        ...(entry.asset.license.attribution
          ? { attribution: entry.asset.license.attribution }
          : {}),
        restrictions: entry.asset.license.restrictions,
      },
    })),
  ];

  const totalFrames = Math.round(manifest.outputDurationSeconds * FRAME_RATE);
  const plan = planTimeline(
    [
      ...generatedShots.map((shot) => ({
        sourceId: `gen-${shot.brief.index}`,
        kind: 'VIDEO' as const,
        availableFrames: Math.floor(shot.measuredDurationSeconds * FRAME_RATE),
        frames: 0,
      })),
      ...licensedClips.map((entry) => ({
        sourceId: entry.asset.id,
        kind: 'VIDEO' as const,
        // A supplied clip's real length is unknown here; the renderer's own
        // source resolution probes it, and the trim below asks for no more
        // than the scene needs.
        availableFrames: Math.round(manifest.generation.maxShotDurationSeconds * FRAME_RATE),
        frames: 0,
      })),
      ...screenshots.map((entry) => ({
        sourceId: entry.asset.id,
        kind: 'IMAGE' as const,
        frames: 0,
      })),
    ],
    totalFrames,
  );

  const scenes = plan.map((scene, index) => ({
    id: `scene-${index}`,
    sourceId: scene.sourceId,
    durationSeconds: frames(scene.frames),
    ...(scene.kind === 'VIDEO' ? { trim: { inSeconds: 0, outSeconds: frames(scene.frames) } } : {}),
    framing: { mode: 'COVER' as const, anchorX: 0.5, anchorY: 0.5 },
    motion: scene.kind === 'IMAGE' ? ('PUSH_IN' as const) : ('STATIC' as const),
    motionIntensity: 0.35,
    ...(index === 0
      ? {}
      : {
          transitionIn: { kind: 'CROSSFADE' as const, durationSeconds: frames(TRANSITION_FRAMES) },
        }),
    useSourceAudio: false,
  }));

  const ctaStartSeconds = manifest.outputDurationSeconds - manifest.cta.durationSeconds;

  // Captions run only up to the CTA card, so copy never collides with the end
  // frame's own headline.
  const captionCues = buildCaptionCues(manifest.keyMessages, ctaStartSeconds);

  const draft = {
    manifestVersion: 1 as const,
    name: manifest.name,
    campaignId: manifest.campaignId,
    workspaceId: manifest.workspaceId,
    campaignPrompt: manifest.campaignPrompt,
    output: {
      durationSeconds: manifest.outputDurationSeconds,
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
    ...(captionCues.length > 0 ? { captions: { style: {}, cues: captionCues } } : {}),
    branding: {
      logoSourceId: logo.asset.id,
      anchor: 'TOP_CENTER' as const,
      offsetXPx: 0,
      offsetYPx: 96,
      widthPx: 320,
      opacity: 0.92,
      windows: [],
    },
    cta: {
      headline: manifest.cta.headline,
      ...(manifest.cta.subline ? { subline: manifest.cta.subline } : {}),
      startSeconds: ctaStartSeconds,
      endSeconds: manifest.outputDurationSeconds,
      backgroundHex: '#0B0B0F',
      headlineColorHex: '#FFFFFF',
      sublineColorHex: '#FF3B30',
      logoSourceId: logo.asset.id,
      logoWidthPx: 420,
    },
    ...(music
      ? {
          audio: {
            tracks: [
              {
                id: 'music',
                sourceId: music.asset.id,
                role: 'MUSIC' as const,
                startSeconds: 0,
                sourceOffsetSeconds: 0,
                gainDb: -6,
                fadeInSeconds: 0.5,
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

  // Parsed rather than cast: the render manifest's own cross-field rules are
  // the authority on whether this timeline is coherent, and a builder bug
  // should surface here rather than as a confusing FFmpeg failure.
  return parseRenderManifest(draft);
}

function buildCaptionCues(
  messages: readonly string[],
  untilSeconds: number,
): { startSeconds: number; endSeconds: number; text: string }[] {
  const usable = messages.filter((message) => message.trim().length > 0).slice(0, 4);
  if (usable.length === 0 || untilSeconds <= 0.5) return [];

  const slotFrames = Math.floor((untilSeconds * FRAME_RATE) / usable.length);
  if (slotFrames < 15) return [];

  return usable.map((text, index) => ({
    startSeconds: frames(index * slotFrames),
    endSeconds: frames((index + 1) * slotFrames),
    // The render manifest caps caption text at 240 characters.
    text: text.trim().slice(0, 240),
  }));
}
