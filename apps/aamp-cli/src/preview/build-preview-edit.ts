import { parseRenderManifest, type RenderManifest } from '@combat/media';

import type { ResolvedAsset } from '../asset-resolution';
import type { CampaignRequest } from '../campaign-request';
import { buildAudioPlan, type AudioPlan, type AudioCueRoleKey } from './audio-plan';
import type { HumanCreativePlan } from './human-plan';
import type { SelectedSegment } from './segment-selection';

/**
 * The human plan plus the chosen segments, expressed as a v2 render manifest.
 *
 * Nothing creative is decided here. Which beats exist, how long each runs,
 * what motion it carries, what transitions it into place, what its caption
 * says and where the CTA sits were all decided by the author; which part of
 * which clip fills it was decided by deterministic segment selection. This
 * module's only job is arithmetic and expression — frames, safe areas, source
 * de-duplication and the manifest's own cross-field rules.
 *
 * Timing stays in integer frames until the last moment, for the reason the
 * source builder documents: the manifest enforces an exact-duration contract
 * and accumulating fractional seconds is the reliable way to miss it by a
 * frame.
 */

export class PreviewEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewEditError';
  }
}

export interface BuildPreviewEditOptions {
  readonly request: CampaignRequest;
  readonly plan: HumanCreativePlan;
  readonly assets: readonly ResolvedAsset[];
  /** Which asset fills each beat, by beat id. */
  readonly assetByBeatId: ReadonlyMap<string, ResolvedAsset>;
  /** Chosen windows for the video beats, by beat id. Stills have none. */
  readonly segmentByBeatId: ReadonlyMap<string, SelectedSegment>;
}

export interface PreviewEdit {
  readonly manifest: RenderManifest;
  readonly audioPlan: AudioPlan;
}

/** Beat start times on the output timeline, after transition overlaps. */
export function beatStartTimes(plan: HumanCreativePlan): readonly number[] {
  const starts: number[] = [];
  let running = 0;
  plan.beats.forEach((beat, index) => {
    const overlap = beat.transitionIn?.durationSeconds ?? 0;
    const start = index === 0 ? 0 : running - overlap;
    starts.push(Number(start.toFixed(6)));
    running = index === 0 ? beat.durationSeconds : running + beat.durationSeconds - overlap;
  });
  return starts;
}

export function buildPreviewEdit(options: BuildPreviewEditOptions): PreviewEdit {
  const { request, plan, assets } = options;

  const assetsById = new Map(assets.map((asset) => [asset.asset.id, asset]));
  const logo = assetsById.get(plan.brandConstraints.logoAssetId);
  if (!logo) {
    throw new PreviewEditError(
      `brandConstraints.logoAssetId "${plan.brandConstraints.logoAssetId}" is not present in the production asset manifest`,
    );
  }

  const music = plan.audio.musicAssetId ? assetsById.get(plan.audio.musicAssetId) : undefined;
  if (plan.audio.musicAssetId && !music) {
    throw new PreviewEditError(
      `audio.musicAssetId "${plan.audio.musicAssetId}" is not present in the production asset manifest`,
    );
  }

  const starts = beatStartTimes(plan);

  // ---- audio cues, placed on the output timeline ---------------------------
  const cueRequests: {
    role: AudioCueRoleKey;
    assetId: string;
    atSeconds: number;
    gainDb: number;
    ducksMusic: boolean;
    beatId: string;
  }[] = [];
  for (const [index, beat] of plan.beats.entries()) {
    const beatStart = starts[index] ?? 0;
    for (const cue of beat.audioCues) {
      const assetId = plan.audio.cueAssetIds[cue.role];
      if (!assetId) continue;
      if (!assetsById.has(assetId)) {
        throw new PreviewEditError(
          `audio cue ${cue.role} names asset "${assetId}", which is not in the production asset manifest`,
        );
      }
      cueRequests.push({
        role: cue.role,
        assetId,
        atSeconds: Number((beatStart + cue.atOffsetSeconds).toFixed(6)),
        gainDb: cue.gainDb,
        ducksMusic: cue.ducksMusic,
        beatId: beat.id,
      });
    }
  }

  const audioPlan = buildAudioPlan({
    cues: cueRequests,
    assetsById,
    sourceAudioGainDb: plan.audio.sourceAudioGainDb,
    cueDuckingDb: plan.audio.cueDuckingDb,
    musicCrossfadeSeconds: plan.audio.musicCrossfadeSeconds,
    peakCeilingDbtp: plan.audio.peakCeilingDbtp,
    outputDurationSeconds: plan.targetDurationSeconds,
  });

  const hasAudio = Boolean(music) || audioPlan.cues.length > 0;

  // ---- sources -------------------------------------------------------------
  const used = new Map<string, ResolvedAsset>();
  for (const asset of options.assetByBeatId.values()) used.set(asset.asset.id, asset);
  used.set(logo.asset.id, logo);
  if (music) used.set(music.asset.id, music);
  for (const cue of audioPlan.cues) {
    const asset = assetsById.get(cue.assetId);
    if (asset) used.set(asset.asset.id, asset);
  }

  const sources: RenderManifest['sources'] = [...used.values()]
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
      // Always present in this mode: QA's provenance completeness check is
      // binding here, and it is binding because every byte is accounted for.
      expectedChecksum: entry.checksumSha256,
    }));

  // ---- scenes --------------------------------------------------------------
  const primaryColour = plan.brandConstraints.primaryColorHex;
  const accentColour = plan.brandConstraints.accentColorHex;

  const scenes = plan.beats.map((beat, index) => {
    const asset = options.assetByBeatId.get(beat.id);
    if (!asset) {
      throw new PreviewEditError(`beat "${beat.id}" has no resolved source asset`);
    }
    const isVideo = asset.asset.kind === 'VIDEO';
    const segment = options.segmentByBeatId.get(beat.id);
    if (isVideo && !segment) {
      throw new PreviewEditError(
        `beat "${beat.id}" draws on video "${asset.asset.id}" but no segment was selected for it`,
      );
    }

    const beatStart = starts[index] ?? 0;
    const decorations = beat.decorations.map((decoration, decorationIndex) => ({
      id: `${beat.id}-dec-${decorationIndex}`,
      key: decoration.key,
      colorHex: decoration.colour === 'PRIMARY' ? primaryColour : accentColour,
      opacity: decoration.opacity,
      xPx: decoration.xPx,
      yPx: decoration.yPx,
      widthPx: decoration.widthPx,
      heightPx: decoration.heightPx,
      thicknessPx: decoration.thicknessPx,
      startSeconds: beatStart,
      endSeconds: Number(
        Math.min(beatStart + beat.durationSeconds, plan.targetDurationSeconds).toFixed(6),
      ),
    }));

    return {
      id: beat.id,
      sourceId: asset.asset.id,
      durationSeconds: beat.durationSeconds,
      ...(isVideo && segment
        ? { trim: { inSeconds: segment.inSeconds, outSeconds: segment.outSeconds } }
        : {}),
      framing: { mode: 'COVER' as const, anchorX: 0.5, anchorY: 0.5 },
      // v1's `motion` stays at its default; the treatment supersedes it and is
      // the field a reader should look at.
      treatment: { key: beat.motion.treatment, intensity: beat.motion.intensity },
      ...(beat.grade ? { grade: { key: beat.grade.key, intensity: beat.grade.intensity } } : {}),
      ...(decorations.length > 0 ? { decorations } : {}),
      ...(beat.transitionIn
        ? {
            transitionIn: {
              kind: beat.transitionIn.kind,
              durationSeconds: beat.transitionIn.durationSeconds,
            },
          }
        : {}),
      // Source audio only where the clip actually has some; the plan can ask,
      // and a clip with no audio stream would fail the graph rather than the
      // parse.
      useSourceAudio: beat.useSourceAudio && isVideo && assetHasAudio(asset),
    };
  });

  // ---- captions ------------------------------------------------------------
  const ctaStartSeconds = Number(
    (plan.targetDurationSeconds - plan.cta.durationSeconds).toFixed(6),
  );
  const cues = plan.beats
    .map((beat, index) => {
      const text = beat.caption?.text?.trim();
      if (!text) return null;
      const startSeconds = starts[index] ?? 0;
      const endSeconds = Number(
        Math.min(startSeconds + beat.durationSeconds, ctaStartSeconds).toFixed(6),
      );
      if (endSeconds - startSeconds < 0.5) return null;
      return { startSeconds, endSeconds, text: text.slice(0, 240) };
    })
    .filter(
      (cue): cue is { startSeconds: number; endSeconds: number; text: string } => cue !== null,
    );

  // Every beat declares its own entrance; the manifest carries one for the
  // caption track, so the first beat that asked for one wins and the choice is
  // recorded rather than averaged.
  const captionEntrance = plan.beats.find((beat) => beat.caption)?.caption?.entrance ?? 'FADE';

  const draft = {
    manifestVersion: 2 as const,
    name: request.name,
    campaignId: plan.campaignId,
    workspaceId: plan.workspaceId,
    campaignPrompt: request.campaignPrompt.slice(0, 4000),
    output: {
      durationSeconds: plan.targetDurationSeconds,
      aspectRatio: '9:16' as const,
      widthPx: 1080 as const,
      heightPx: 1920 as const,
      frameRate: 30 as const,
      container: 'mp4' as const,
      videoCodec: 'h264' as const,
      audioCodec: hasAudio ? ('aac' as const) : null,
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
              fontFamily: plan.brandConstraints.captionFontFamily,
              fontSizePx: 56,
              primaryColorHex: '#FFFFFF',
              outlineColorHex: '#000000',
              outlineWidthPx: 4,
              bold: true,
              uppercase: true,
              marginBottomPx: plan.brandConstraints.safeAreaBottomPx,
              marginHorizontalPx: 96,
            },
            cues,
            entrance: captionEntrance,
          },
        }
      : {}),
    branding: {
      logoSourceId: logo.asset.id,
      anchor: 'TOP_CENTER' as const,
      offsetXPx: 0,
      // Inside the declared top safe area, so the logo never collides with a
      // platform's own overlaid UI.
      offsetYPx: Math.max(48, Math.round(plan.brandConstraints.safeAreaTopPx / 2)),
      widthPx: 300,
      opacity: 0.92,
      windows: plan.brandConstraints.logoWindows,
    },
    cta: {
      headline: plan.cta.headline,
      ...(plan.cta.subline ? { subline: plan.cta.subline } : {}),
      startSeconds: ctaStartSeconds,
      endSeconds: plan.targetDurationSeconds,
      backgroundHex: primaryColour,
      headlineColorHex: '#FFFFFF',
      sublineColorHex: accentColour,
      logoSourceId: logo.asset.id,
      logoWidthPx: 420,
      entrance: plan.cta.entrance,
      holdSeconds: plan.cta.holdSeconds,
    },
    ...(hasAudio
      ? {
          audio: {
            tracks: music
              ? [
                  {
                    id: 'music-bed',
                    sourceId: music.asset.id,
                    role: 'MUSIC' as const,
                    startSeconds: 0,
                    sourceOffsetSeconds: 0,
                    gainDb: plan.audio.musicGainDb,
                    fadeInSeconds: 0.4,
                    fadeOutSeconds: 1,
                    loop: true,
                  },
                ]
              : // `AudioSchema` needs at least one track, and a cut with cues
                // but no bed is a legitimate mix. The cues themselves are the
                // programme, so the first one doubles as the track.
                [
                  {
                    id: 'cue-only-bed',
                    sourceId: audioPlan.cues[0]?.assetId ?? '',
                    role: 'SFX' as const,
                    startSeconds: audioPlan.cues[0]?.atSeconds ?? 0,
                    sourceOffsetSeconds: 0,
                    gainDb: audioPlan.cues[0]?.gainDb ?? 0,
                    fadeInSeconds: 0,
                    fadeOutSeconds: 0.2,
                    loop: false,
                  },
                ],
            loudness: {
              integratedLufs: plan.audio.targetLufs,
              truePeakDbtp: plan.audio.peakCeilingDbtp,
              loudnessRange: 11,
            },
            musicDuckingDb: 12,
            design: music
              ? audioPlan.design
              : // With no bed there is nothing to duck, and the first cue is
                // already in the track list above.
                { ...audioPlan.design, cues: audioPlan.design.cues.slice(1) },
          },
        }
      : {}),
  };

  // Parsed, not cast: the render manifest's own cross-field rules are the
  // authority on whether this timeline is coherent, and a builder bug should
  // surface here rather than as an opaque FFmpeg failure.
  return { manifest: parseRenderManifest(draft), audioPlan };
}

function assetHasAudio(asset: ResolvedAsset): boolean {
  // The production asset resolver measures duration and geometry but not the
  // presence of an audio stream, so a beat asking for source audio on a silent
  // clip is caught by the filter graph. Preflight warns about it first.
  return asset.asset.kind === 'VIDEO';
}
