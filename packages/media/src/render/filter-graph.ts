import { buildAssSubtitleFile } from './ass-captions';
import { hexToFfmpegColor, num } from './filter-primitives';
import {
  MIN_TRANSITION_SECONDS,
  type Overlay,
  type OverlayAnchor,
  type RenderManifest,
  type Scene,
  type SceneMotion,
  type SceneTreatmentKeyValue,
} from './manifest';
import {
  compileDecorationTreatment,
  compileSceneTreatment,
  compileTransitionTreatment,
  ctaEntranceOverride,
  MOTION_TREATMENT_CATALOGUE_VERSION,
  type CtaEntranceKey,
} from './motion-treatments';
import type { ResolvedSource } from './source-resolution';

/**
 * Builds the complete FFmpeg invocation for one render manifest: the input
 * list, the `filter_complex` graph, the encoder settings and the auxiliary
 * files (the ASS typography file) the graph references.
 *
 * Pure — no filesystem, no clock, no randomness. Everything the graph needs
 * has already been resolved by `resolveManifestSources`. That is what makes
 * the highest-value offline test possible: assert the exact argv for a
 * fixture manifest and catch a filter-graph regression without running
 * FFmpeg.
 *
 * Two structural rules hold throughout:
 *
 * - **No operator- or agent-authored string ever becomes filter grammar.**
 *   Captions, overlay copy and CTA text go into an ASS file addressed by a
 *   bare filename; only numbers and validated enum values are interpolated
 *   into the graph.
 * - **Files the graph references are addressed relatively.** The renderer
 *   runs FFmpeg with its working directory set to the job directory, because
 *   a Windows `C:\…` path inside a filter argument collides with the `:`
 *   option separator and has no portable escaping. Input and output files
 *   stay absolute — they are argv, not graph.
 */

/** Distance overlay content keeps from the frame edge. */
export const SAFE_MARGIN_PX = 72;

/**
 * How the v1 motion vocabulary maps onto catalogue treatments.
 *
 * v1 manifests keep working unchanged and now go through exactly the same
 * compiler as v2's `treatment` field — which is the point of having one
 * catalogue. There is no second implementation of a push-in.
 */
const V1_MOTION_TO_TREATMENT: Readonly<Record<SceneMotion, SceneTreatmentKeyValue>> = {
  STATIC: 'STATIC_HOLD',
  PUSH_IN: 'PUSH_IN',
  PUSH_OUT: 'PULL_OUT',
  PAN_LEFT: 'LATERAL_LEFT',
  PAN_RIGHT: 'LATERAL_RIGHT',
  PARALLAX: 'APP_SCREENSHOT_PARALLAX',
};

export const CAPTION_ASS_FILENAME = 'typography.ass';
export const OUTPUT_TEMP_FILENAME = 'render.mp4';

export interface JobFile {
  /** Relative to the job directory; the graph references it by this name. */
  readonly name: string;
  readonly contents: string;
}

export interface SceneTiming {
  readonly sceneId: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface PlannedInput {
  readonly index: number;
  readonly role: 'SCENE' | 'OVERLAY_IMAGE' | 'AUDIO_TRACK' | 'GENERATED';
  readonly sourceId?: string;
  readonly absolutePath?: string;
}

/** What treatment each scene actually received, for the storyboard and provenance. */
export interface AppliedTreatment {
  readonly sceneId: string;
  readonly treatmentKey: string;
  readonly intensity: number;
  readonly description: string;
  readonly transitionKey: string | null;
  readonly decorationKeys: readonly string[];
}

export interface RenderPlan {
  readonly args: readonly string[];
  readonly inputs: readonly PlannedInput[];
  readonly jobFiles: readonly JobFile[];
  readonly outputFileName: string;
  readonly timeline: readonly SceneTiming[];
  readonly hasAudio: boolean;
  readonly filterComplex: string;
  /** The catalogue that produced this graph. Travels into the storyboard. */
  readonly motionCatalogueVersion: number;
  readonly treatments: readonly AppliedTreatment[];
}

export class FilterGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterGraphError';
  }
}

interface AnchorPosition {
  readonly x: string;
  readonly y: string;
}

/** Overlay-filter position expressions for an anchor, in output pixels. */
function anchorExpressions(
  anchor: OverlayAnchor,
  offsetX: number,
  offsetY: number,
): AnchorPosition {
  const dx = offsetX === 0 ? '' : `${offsetX > 0 ? '+' : '-'}${num(Math.abs(offsetX))}`;
  const dy = offsetY === 0 ? '' : `${offsetY > 0 ? '+' : '-'}${num(Math.abs(offsetY))}`;
  const left = `${SAFE_MARGIN_PX}`;
  const centreX = '(W-w)/2';
  const right = `W-w-${SAFE_MARGIN_PX}`;
  const top = `${SAFE_MARGIN_PX}`;
  const centreY = '(H-h)/2';
  const bottom = `H-h-${SAFE_MARGIN_PX}`;

  const map: Record<OverlayAnchor, AnchorPosition> = {
    TOP_LEFT: { x: left, y: top },
    TOP_CENTER: { x: centreX, y: top },
    TOP_RIGHT: { x: right, y: top },
    CENTER: { x: centreX, y: centreY },
    BOTTOM_LEFT: { x: left, y: bottom },
    BOTTOM_CENTER: { x: centreX, y: bottom },
    BOTTOM_RIGHT: { x: right, y: bottom },
  };
  const base = map[anchor];
  return { x: `${base.x}${dx}`, y: `${base.y}${dy}` };
}

interface SceneChainInput {
  readonly scene: Scene;
  readonly inputIndex: number;
  readonly frameRate: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly sourceKind: 'VIDEO' | 'IMAGE';
}

/**
 * One scene's video chain, compiled by the motion-treatment catalogue.
 *
 * This function decides *which* treatment applies and delegates the grammar.
 * It builds no filter text of its own — that separation is what makes "no
 * unvalidated FFmpeg filter strings scattered through application code" a
 * structural property rather than a habit.
 */
function buildSceneChain(input: SceneChainInput): {
  readonly graph: string;
  readonly applied: { key: string; intensity: number; description: string };
} {
  const { scene, inputIndex, frameRate, widthPx, heightPx } = input;
  const key: SceneTreatmentKeyValue = scene.treatment
    ? scene.treatment.key
    : V1_MOTION_TO_TREATMENT[scene.motion];
  const intensity = scene.treatment ? scene.treatment.intensity : scene.motionIntensity;

  const compiled = compileSceneTreatment(key, {
    inputLabel: `${inputIndex}:v`,
    outputLabel: `v${inputIndex}`,
    scopeTag: `t${inputIndex}`,
    intensity,
    durationSeconds: scene.durationSeconds,
    frameRate,
    widthPx,
    heightPx,
    sourceKind: input.sourceKind,
    framing: scene.framing,
  });

  return {
    graph: compiled.graph,
    applied: { key, intensity, description: compiled.description },
  };
}

interface OverlayImageBinding {
  readonly overlayId: string;
  readonly inputIndex: number;
  readonly widthPx: number;
  readonly opacity: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly anchor: OverlayAnchor;
  readonly offsetXPx: number;
  readonly offsetYPx: number;
  readonly animation: Overlay['animation'];
  readonly animationSeconds: number;
}

function buildImageOverlayChain(
  binding: OverlayImageBinding,
  baseLabel: string,
  outLabel: string,
): string {
  const tag = `ovl${binding.inputIndex}`;
  const fadeSeconds = binding.animation === 'NONE' ? 0 : Math.max(0.01, binding.animationSeconds);
  const prepare = [
    `[${binding.inputIndex}:v]scale=${binding.widthPx}:-2`,
    'format=rgba',
    ...(fadeSeconds > 0
      ? [
          `fade=t=in:st=${num(binding.startSeconds)}:d=${num(fadeSeconds)}:alpha=1`,
          `fade=t=out:st=${num(Math.max(binding.startSeconds, binding.endSeconds - fadeSeconds))}:d=${num(fadeSeconds)}:alpha=1`,
        ]
      : []),
    ...(binding.opacity < 1 ? [`colorchannelmixer=aa=${num(binding.opacity)}`] : []),
    `setpts=PTS-STARTPTS[${tag}]`,
  ].join(',');

  const position = anchorExpressions(binding.anchor, binding.offsetXPx, binding.offsetYPx);
  const y = applySlide(position.y, binding.animation, binding.startSeconds, fadeSeconds);

  const composite = `[${baseLabel}][${tag}]overlay=x='${position.x}':y='${y}':enable='between(t,${num(binding.startSeconds)},${num(binding.endSeconds)})':format=auto[${outLabel}]`;
  return `${prepare};${composite}`;
}

/** Position animation for an image overlay; text animation is expressed in ASS instead. */
function applySlide(
  baseY: string,
  animation: Overlay['animation'],
  startSeconds: number,
  animationSeconds: number,
): string {
  if (animation !== 'SLIDE_UP' && animation !== 'SLIDE_DOWN') return baseY;
  if (animationSeconds <= 0) return baseY;
  const travel = animation === 'SLIDE_UP' ? 120 : -120;
  const progress = `min(1,max(0,(t-${num(startSeconds)})/${num(animationSeconds)}))`;
  return `${baseY}+${num(travel)}*(1-${progress})`;
}

export interface BuildRenderPlanInput {
  readonly manifest: RenderManifest;
  readonly sources: ReadonlyMap<string, ResolvedSource>;
}

export function buildRenderPlan(input: BuildRenderPlanInput): RenderPlan {
  const { manifest, sources } = input;
  const { output } = manifest;
  const frameRate = output.frameRate;
  const duration = output.durationSeconds;

  const requireSource = (id: string): ResolvedSource => {
    const source = sources.get(id);
    if (!source) {
      throw new FilterGraphError(`source "${id}" was not resolved`);
    }
    return source;
  };

  const inputArgs: string[] = [];
  const inputs: PlannedInput[] = [];
  let nextIndex = 0;

  const addInput = (
    args: readonly string[],
    role: PlannedInput['role'],
    sourceId?: string,
    absolutePath?: string,
  ): number => {
    const index = nextIndex;
    nextIndex += 1;
    inputArgs.push(...args);
    inputs.push({ index, role, sourceId, absolutePath });
    return index;
  };

  // ---- scene inputs -------------------------------------------------------
  const sceneChains: string[] = [];
  const sceneLabels: string[] = [];
  const timeline: SceneTiming[] = [];
  const treatments: AppliedTreatment[] = [];
  let runningLength = 0;

  manifest.scenes.forEach((scene, sceneIndex) => {
    const source = requireSource(scene.sourceId);
    if (source.kind === 'AUDIO') {
      throw new FilterGraphError(`scene "${scene.id}" resolves to an AUDIO source`);
    }
    const index =
      source.kind === 'IMAGE'
        ? addInput(
            [
              '-loop',
              '1',
              '-framerate',
              num(frameRate),
              '-t',
              num(scene.durationSeconds),
              '-i',
              source.absolutePath,
            ],
            'SCENE',
            source.id,
            source.absolutePath,
          )
        : addInput(
            [
              '-ss',
              num(scene.trim?.inSeconds ?? 0),
              '-t',
              num(scene.durationSeconds),
              '-i',
              source.absolutePath,
            ],
            'SCENE',
            source.id,
            source.absolutePath,
          );

    const chain = buildSceneChain({
      scene,
      inputIndex: index,
      frameRate,
      widthPx: output.widthPx,
      heightPx: output.heightPx,
      sourceKind: source.kind,
    });
    sceneChains.push(chain.graph);
    sceneLabels.push(`v${index}`);
    treatments.push({
      sceneId: scene.id,
      treatmentKey: chain.applied.key,
      intensity: chain.applied.intensity,
      description: chain.applied.description,
      transitionKey: scene.transitionIn?.kind ?? null,
      decorationKeys: (scene.decorations ?? []).map((decoration) => decoration.key),
    });

    const overlap = scene.transitionIn?.durationSeconds ?? 0;
    const startSeconds = sceneIndex === 0 ? 0 : runningLength - overlap;
    runningLength =
      sceneIndex === 0 ? scene.durationSeconds : runningLength + scene.durationSeconds - overlap;
    timeline.push({
      sceneId: scene.id,
      startSeconds,
      endSeconds: startSeconds + scene.durationSeconds,
    });
  });

  // ---- transition chain ---------------------------------------------------
  const transitionChains: string[] = [];
  let mergedLabel = sceneLabels[0];
  if (!mergedLabel) {
    throw new FilterGraphError('a manifest must contain at least one scene');
  }
  let mergedLength = manifest.scenes[0]?.durationSeconds ?? 0;

  for (let i = 1; i < manifest.scenes.length; i += 1) {
    const scene = manifest.scenes[i];
    const label = sceneLabels[i];
    if (!scene || !label) continue;
    const transition = scene.transitionIn;
    if (!transition) {
      throw new FilterGraphError(`scene "${scene.id}" is missing a transitionIn`);
    }
    if (transition.durationSeconds < MIN_TRANSITION_SECONDS - 1e-9) {
      throw new FilterGraphError(
        `transition into "${scene.id}" is ${transition.durationSeconds}s; the shortest expressible overlap is one frame (${MIN_TRANSITION_SECONDS.toFixed(4)}s)`,
      );
    }
    const offset = mergedLength - transition.durationSeconds;
    if (offset < 0) {
      throw new FilterGraphError(
        `transition into "${scene.id}" is longer than everything before it`,
      );
    }
    const outLabel = `x${i}`;
    const compiledTransition = compileTransitionTreatment(transition.kind);
    transitionChains.push(
      `[${mergedLabel}][${label}]xfade=transition=${compiledTransition.xfadeName}:duration=${num(transition.durationSeconds)}:offset=${num(offset)}[${outLabel}]`,
    );
    mergedLabel = outLabel;
    mergedLength = mergedLength + scene.durationSeconds - transition.durationSeconds;
  }

  // ---- overlays, branding, CTA card, typography ---------------------------
  const overlayChains: string[] = [];
  let baseLabel = mergedLabel;
  let compositeStep = 0;
  const nextCompositeLabel = (): string => {
    compositeStep += 1;
    return `c${compositeStep}`;
  };

  // Decorations sit directly on the composited picture, beneath every image
  // overlay and beneath typography: a callout is part of the frame, not a
  // badge on top of the brand lockup.
  for (const scene of manifest.scenes) {
    for (const decoration of scene.decorations ?? []) {
      const outLabel = nextCompositeLabel();
      overlayChains.push(
        compileDecorationTreatment(decoration.key, {
          baseLabel,
          outputLabel: outLabel,
          frameWidthPx: manifest.output.widthPx,
          frameHeightPx: manifest.output.heightPx,
          colorHex: decoration.colorHex,
          opacity: decoration.opacity,
          xPx: decoration.xPx,
          yPx: decoration.yPx,
          widthPx: decoration.widthPx,
          heightPx: decoration.heightPx,
          thicknessPx: decoration.thicknessPx,
          startSeconds: decoration.startSeconds,
          endSeconds: decoration.endSeconds,
        }).graph,
      );
      baseLabel = outLabel;
    }
  }

  for (const overlay of manifest.overlays) {
    if (overlay.kind !== 'IMAGE') continue;
    const source = requireSource(overlay.sourceId);
    const index = addInput(
      ['-loop', '1', '-framerate', num(frameRate), '-t', num(duration), '-i', source.absolutePath],
      'OVERLAY_IMAGE',
      source.id,
      source.absolutePath,
    );
    const outLabel = nextCompositeLabel();
    overlayChains.push(
      buildImageOverlayChain(
        {
          overlayId: overlay.id,
          inputIndex: index,
          widthPx: overlay.widthPx,
          opacity: overlay.opacity,
          startSeconds: overlay.startSeconds,
          endSeconds: overlay.endSeconds,
          anchor: overlay.anchor,
          offsetXPx: overlay.offsetXPx,
          offsetYPx: overlay.offsetYPx,
          animation: overlay.animation,
          animationSeconds: overlay.animationSeconds,
        },
        baseLabel,
        outLabel,
      ),
    );
    baseLabel = outLabel;
  }

  if (manifest.branding) {
    const branding = manifest.branding;
    const source = requireSource(branding.logoSourceId);
    const index = addInput(
      ['-loop', '1', '-framerate', num(frameRate), '-t', num(duration), '-i', source.absolutePath],
      'OVERLAY_IMAGE',
      source.id,
      source.absolutePath,
    );
    const windows =
      branding.windows.length > 0 ? branding.windows : [{ startSeconds: 0, endSeconds: duration }];
    // One prepared logo stream, composited once per scheduled window.
    const tag = `logo${index}`;
    overlayChains.push(
      `[${index}:v]scale=${branding.widthPx}:-2,format=rgba,colorchannelmixer=aa=${num(branding.opacity)},setpts=PTS-STARTPTS,split=${windows.length}${windows
        .map((_, windowIndex) => `[${tag}_${windowIndex}]`)
        .join('')}`,
    );
    windows.forEach((window, windowIndex) => {
      const position = anchorExpressions(branding.anchor, branding.offsetXPx, branding.offsetYPx);
      const outLabel = nextCompositeLabel();
      overlayChains.push(
        `[${baseLabel}][${tag}_${windowIndex}]overlay=x='${position.x}':y='${position.y}':enable='between(t,${num(window.startSeconds)},${num(window.endSeconds)})':format=auto[${outLabel}]`,
      );
      baseLabel = outLabel;
    });
  }

  const jobFiles: JobFile[] = [];
  const assEvents = buildTypographyFile(manifest);
  if (assEvents) {
    jobFiles.push({ name: CAPTION_ASS_FILENAME, contents: assEvents });
  }

  if (manifest.cta) {
    const cta = manifest.cta;
    // A generated colour source rather than `drawbox`, because only an
    // overlaid stream can carry an alpha fade — the end card animates in.
    const cardIndex = addInput(
      [
        '-f',
        'lavfi',
        '-t',
        num(duration),
        '-i',
        `color=c=${hexToFfmpegColor(cta.backgroundHex)}:s=${output.widthPx}x${output.heightPx}:r=${num(frameRate)}`,
      ],
      'GENERATED',
    );
    // `holdSeconds` is a promise about the *settled* card, so the animation
    // has to finish before the hold begins. Deriving the fade from it — rather
    // than fading for a fixed 0.3s and hoping — is what makes the hold QA
    // measures and the hold the graph produces the same number.
    const cardFade = ctaAnimationSeconds(cta.startSeconds, cta.endSeconds, cta.holdSeconds);
    const cardOut = nextCompositeLabel();
    overlayChains.push(
      `[${cardIndex}:v]format=rgba,fade=t=in:st=${num(cta.startSeconds)}:d=${num(cardFade)}:alpha=1,setpts=PTS-STARTPTS[ctacard];[${baseLabel}][ctacard]overlay=x=0:y=0:enable='between(t,${num(cta.startSeconds)},${num(cta.endSeconds)})':format=auto[${cardOut}]`,
    );
    baseLabel = cardOut;

    if (cta.logoSourceId) {
      const source = requireSource(cta.logoSourceId);
      const index = addInput(
        [
          '-loop',
          '1',
          '-framerate',
          num(frameRate),
          '-t',
          num(duration),
          '-i',
          source.absolutePath,
        ],
        'OVERLAY_IMAGE',
        source.id,
        source.absolutePath,
      );
      const outLabel = nextCompositeLabel();
      overlayChains.push(
        `[${index}:v]scale=${cta.logoWidthPx}:-2,format=rgba,fade=t=in:st=${num(cta.startSeconds)}:d=${num(cardFade)}:alpha=1,setpts=PTS-STARTPTS[ctalogo];[${baseLabel}][ctalogo]overlay=x='(W-w)/2':y='${num(Math.round(output.heightPx * 0.34))}':enable='between(t,${num(cta.startSeconds)},${num(cta.endSeconds)})':format=auto[${outLabel}]`,
      );
      baseLabel = outLabel;
    }
  }

  // Typography last so captions and CTA copy sit above every image layer.
  if (assEvents) {
    const outLabel = nextCompositeLabel();
    overlayChains.push(`[${baseLabel}]ass=filename=${CAPTION_ASS_FILENAME}[${outLabel}]`);
    baseLabel = outLabel;
  }

  const videoOutLabel = 'vout';
  overlayChains.push(
    `[${baseLabel}]trim=duration=${num(duration)},setpts=PTS-STARTPTS,fps=${num(frameRate)},setsar=1,format=${output.pixelFormat}[${videoOutLabel}]`,
  );

  // ---- audio --------------------------------------------------------------
  const audio = buildAudioGraph({
    manifest,
    sources,
    addInput,
    timeline,
  });

  const filterComplex = [
    ...sceneChains,
    ...transitionChains,
    ...overlayChains,
    ...audio.chains,
  ].join(';');

  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    ...inputArgs,
    '-filter_complex',
    filterComplex,
    '-map',
    `[${videoOutLabel}]`,
  ];

  if (audio.outputLabel) {
    args.push('-map', `[${audio.outputLabel}]`);
  }

  args.push(
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-level',
    '4.0',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    output.pixelFormat,
    '-r',
    num(frameRate),
    '-fps_mode',
    'cfr',
    '-g',
    num(frameRate * 2),
    '-keyint_min',
    num(frameRate),
    '-sc_threshold',
    '0',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
  );

  if (audio.outputLabel) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push(
    '-t',
    num(duration),
    '-movflags',
    '+faststart',
    // Deterministic bytes for identical inputs: no encoder version string, no
    // creation timestamp, no random dither.
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    ...(audio.outputLabel ? ['-flags:a', '+bitexact'] : []),
    '-y',
    OUTPUT_TEMP_FILENAME,
  );

  return {
    args,
    inputs,
    jobFiles,
    outputFileName: OUTPUT_TEMP_FILENAME,
    timeline,
    hasAudio: audio.outputLabel !== null,
    filterComplex,
    motionCatalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
    treatments,
  };
}

interface AudioGraphInput {
  readonly manifest: RenderManifest;
  readonly sources: ReadonlyMap<string, ResolvedSource>;
  readonly addInput: (
    args: readonly string[],
    role: PlannedInput['role'],
    sourceId?: string,
    absolutePath?: string,
  ) => number;
  readonly timeline: readonly SceneTiming[];
}

interface AudioGraphResult {
  readonly chains: readonly string[];
  readonly outputLabel: string | null;
}

/**
 * Music, voice and scene audio are prepared onto separate buses so ducking
 * can key music off the actual speech envelope (`sidechaincompress`) rather
 * than off a guessed schedule, and so loudness normalisation sees the final
 * programme rather than one stem.
 */
function buildAudioGraph(input: AudioGraphInput): AudioGraphResult {
  const { manifest, sources, addInput, timeline } = input;
  if (manifest.output.audioCodec === null) {
    return { chains: [], outputLabel: null };
  }

  const duration = manifest.output.durationSeconds;
  const chains: string[] = [];
  const musicLabels: string[] = [];
  const voiceLabels: string[] = [];
  const otherLabels: string[] = [];

  const commonTail = (startSeconds: number, fadeIn: number, fadeOut: number): string[] => {
    const steps: string[] = [];
    if (startSeconds > 0) {
      const delayMs = Math.round(startSeconds * 1000);
      steps.push(`adelay=${delayMs}|${delayMs}`);
    }
    if (fadeIn > 0) {
      steps.push(`afade=t=in:st=${num(startSeconds)}:d=${num(fadeIn)}`);
    }
    if (fadeOut > 0) {
      steps.push(`afade=t=out:st=${num(Math.max(0, duration - fadeOut))}:d=${num(fadeOut)}`);
    }
    // Pad-then-trim guarantees every bus is exactly the cut's length, so
    // `amix` cannot shorten the programme or leave a tail.
    steps.push('apad', `atrim=0:${num(duration)}`, 'asetpts=PTS-STARTPTS');
    return steps;
  };

  for (const track of manifest.audio?.tracks ?? []) {
    const source = sources.get(track.sourceId);
    if (!source) {
      throw new FilterGraphError(`audio source "${track.sourceId}" was not resolved`);
    }
    const index = addInput(
      [...(track.loop ? ['-stream_loop', '-1'] : []), '-i', source.absolutePath],
      'AUDIO_TRACK',
      source.id,
      source.absolutePath,
    );
    const label = `atrk${index}`;
    const steps: string[] = [
      ...(track.sourceOffsetSeconds > 0
        ? [`atrim=start=${num(track.sourceOffsetSeconds)}`, 'asetpts=PTS-STARTPTS']
        : []),
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      ...(track.gainDb !== 0 ? [`volume=${num(track.gainDb)}dB`] : []),
      ...commonTail(track.startSeconds, track.fadeInSeconds, track.fadeOutSeconds),
    ];
    chains.push(`[${index}:a]${steps.join(',')}[${label}]`);

    if (track.role === 'MUSIC') musicLabels.push(label);
    else if (track.role === 'VOICEOVER') voiceLabels.push(label);
    else otherLabels.push(label);
  }

  const design = manifest.audio?.design;

  manifest.scenes.forEach((scene, sceneIndex) => {
    if (!scene.useSourceAudio) return;
    const source = sources.get(scene.sourceId);
    if (!source || source.kind !== 'VIDEO') return;
    if (source.probe.mediaType === 'VIDEO' && !source.probe.hasAudio) {
      throw new FilterGraphError(
        `scene "${scene.id}" sets useSourceAudio but source "${source.id}" has no audio stream`,
      );
    }
    const timing = timeline[sceneIndex];
    if (!timing) return;
    // Scene inputs are added first and in order, so a scene's FFmpeg input
    // index is its position in `manifest.scenes`. Its own `-ss`/`-t` already
    // trimmed the audio to the scene window; it only needs placing on the
    // output timeline.
    const sceneInput = sceneIndex;
    const label = `ascene${sceneIndex}`;
    const sourceGainDb = design?.sourceAudioGainDb ?? 0;
    chains.push(
      `[${sceneInput}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo${
        sourceGainDb === 0 ? '' : `,volume=${num(sourceGainDb)}dB`
      },${commonTail(timing.startSeconds, 0.05, 0.05).join(',')}[${label}]`,
    );
    otherLabels.push(label);
  });

  // ---- placed sound events ------------------------------------------------
  // Each cue is its own input, trimmed, gained, faded and delayed to its
  // moment. Cues that duck the bed are split so the same signal can key the
  // compressor and still be heard — a duck keyed off a cue nobody hears is a
  // gap in the music with no cause.
  const cueLabels: string[] = [];
  const duckingKeyLabels: string[] = [];
  for (const cue of design?.cues ?? []) {
    const source = sources.get(cue.sourceId);
    if (!source) {
      throw new FilterGraphError(`audio cue source "${cue.sourceId}" was not resolved`);
    }
    const index = addInput(
      ['-i', source.absolutePath],
      'AUDIO_TRACK',
      source.id,
      source.absolutePath,
    );
    const label = `acue${index}`;
    const steps: string[] = [
      ...(cue.sourceOffsetSeconds > 0
        ? [`atrim=start=${num(cue.sourceOffsetSeconds)}`, 'asetpts=PTS-STARTPTS']
        : []),
      ...(cue.durationSeconds === undefined
        ? []
        : [`atrim=duration=${num(cue.durationSeconds)}`, 'asetpts=PTS-STARTPTS']),
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      ...(cue.gainDb !== 0 ? [`volume=${num(cue.gainDb)}dB`] : []),
      ...commonTail(cue.atSeconds, cue.fadeInSeconds, 0),
    ];
    chains.push(`[${index}:a]${steps.join(',')}[${label}]`);

    if (cue.ducksMusic) {
      chains.push(`[${label}]asplit=2[${label}mix][${label}key]`);
      cueLabels.push(`${label}mix`);
      duckingKeyLabels.push(`${label}key`);
    } else {
      cueLabels.push(label);
    }
  }

  const mixInputs: string[] = [];
  const duckingDb = manifest.audio?.musicDuckingDb ?? 0;
  const hasVoice = voiceLabels.length > 0;

  let voiceBus: string | null = null;
  if (hasVoice) {
    voiceBus = 'voicebus';
    chains.push(
      voiceLabels.length === 1
        ? `[${voiceLabels[0]}]anull[${voiceBus}]`
        : `${voiceLabels.map((l) => `[${l}]`).join('')}amix=inputs=${voiceLabels.length}:duration=longest:normalize=0[${voiceBus}]`,
    );
  }

  if (musicLabels.length > 0) {
    const musicBus = 'musicbus';
    const crossfadeSeconds = design?.musicCrossfadeSeconds ?? 0;
    if (musicLabels.length === 1) {
      chains.push(`[${musicLabels[0]}]anull[${musicBus}]`);
    } else if (musicLabels.length === 2 && crossfadeSeconds > 0) {
      // Two beds means a handover, and a handover wants an equal-power
      // crossfade rather than a sum: mixing them would double the level
      // through the overlap and leave a hump exactly where the change is
      // meant to be least noticeable.
      chains.push(
        `[${musicLabels[0]}][${musicLabels[1]}]acrossfade=d=${num(crossfadeSeconds)}:c1=tri:c2=tri[${musicBus}]`,
      );
    } else {
      chains.push(
        `${musicLabels.map((l) => `[${l}]`).join('')}amix=inputs=${musicLabels.length}:duration=longest:normalize=0[${musicBus}]`,
      );
    }

    let currentMusic = musicBus;

    if (voiceBus && duckingDb > 0) {
      // The voice bus is needed twice — as the compressor's key and in the
      // final mix — so it is split rather than consumed.
      chains.push(`[${voiceBus}]asplit=2[voicemix][voicekey]`);
      const ratio = Math.min(20, Math.max(1, 1 + duckingDb));
      chains.push(
        `[${currentMusic}][voicekey]sidechaincompress=threshold=0.03:ratio=${num(ratio)}:attack=20:release=350:makeup=1:level_sc=1[musicducked]`,
      );
      currentMusic = 'musicducked';
      mixInputs.push(currentMusic, 'voicemix');
    } else {
      if (duckingKeyLabels.length > 0 && (design?.cueDuckingDb ?? 0) > 0) {
        // Cue ducking is a second, independent duck: a bell or an impact
        // should open a hole in the bed even when there is no voiceover at
        // all, which is the case for every source-only cut.
        const key =
          duckingKeyLabels.length === 1
            ? (duckingKeyLabels[0] as string)
            : ((): string => {
                chains.push(
                  `${duckingKeyLabels.map((l) => `[${l}]`).join('')}amix=inputs=${duckingKeyLabels.length}:duration=longest:normalize=0[cuekey]`,
                );
                return 'cuekey';
              })();
        const cueRatio = Math.min(20, Math.max(1, 1 + (design?.cueDuckingDb ?? 0)));
        chains.push(
          `[${currentMusic}][${key}]sidechaincompress=threshold=0.05:ratio=${num(cueRatio)}:attack=5:release=250:makeup=1:level_sc=1[musiccueducked]`,
        );
        currentMusic = 'musiccueducked';
      }
      mixInputs.push(currentMusic);
      if (voiceBus) mixInputs.push(voiceBus);
    }
  } else if (voiceBus) {
    mixInputs.push(voiceBus);
  }

  mixInputs.push(...otherLabels, ...cueLabels);

  if (mixInputs.length === 0) {
    return { chains: [], outputLabel: null };
  }

  const loudness = manifest.audio?.loudness ?? {
    integratedLufs: -14,
    truePeakDbtp: -1,
    loudnessRange: 11,
  };

  const mixed = 'amixed';
  chains.push(
    mixInputs.length === 1
      ? `[${mixInputs[0]}]anull[${mixed}]`
      : `${mixInputs.map((l) => `[${l}]`).join('')}amix=inputs=${mixInputs.length}:duration=longest:normalize=0[${mixed}]`,
  );

  // Peak protection sits *ahead* of loudness normalisation on purpose: a
  // stacked bell and impact can clip the sum even though each cue is well
  // under the ceiling on its own, and `loudnorm` corrects the programme's
  // level rather than rescuing samples that already wrapped.
  const limiter =
    design?.limiterEnabled === false
      ? []
      : [
          `alimiter=level_in=1:level_out=1:limit=${num(dbToLinear(design?.peakCeilingDbtp ?? -1.5))}:attack=5:release=50:level=disabled`,
        ];

  chains.push(
    `[${mixed}]${[
      ...limiter,
      `loudnorm=I=${num(loudness.integratedLufs)}:TP=${num(loudness.truePeakDbtp)}:LRA=${num(loudness.loudnessRange)}`,
      'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `atrim=0:${num(duration)}`,
      'asetpts=PTS-STARTPTS',
    ].join(',')}[aout]`,
  );

  return { chains, outputLabel: 'aout' };
}

/** dBFS to linear amplitude, for filters that take a ratio rather than decibels. */
function dbToLinear(db: number): number {
  return Number(Math.pow(10, db / 20).toFixed(6));
}

/**
 * How long the end card has to animate, given how long it must sit settled.
 *
 * A CTA that never finishes arriving is a CTA nobody acts on, so the hold wins
 * and the animation takes whatever is left — floored at one frame's worth so a
 * card still fades rather than popping, and capped at the historical 0.3 s so
 * a manifest that asks for no hold behaves exactly as it did before.
 */
export function ctaAnimationSeconds(
  startSeconds: number,
  endSeconds: number,
  holdSeconds: number | undefined,
): number {
  const onScreen = endSeconds - startSeconds;
  if (holdSeconds === undefined) return Math.min(0.3, Math.max(0.05, onScreen / 2));
  return Math.min(0.3, Math.max(0.05, onScreen - holdSeconds));
}

/**
 * Every piece of typography — captions, text overlays and the CTA copy — is
 * emitted into one ASS file. Text therefore never becomes filter grammar,
 * and libass gives real animated typography (`\move`, `\fad`, `\t`) that
 * `drawtext` cannot express.
 */
export function buildTypographyFile(manifest: RenderManifest): string | null {
  const textOverlays = manifest.overlays.filter(
    (overlay): overlay is Extract<Overlay, { kind: 'TEXT' }> => overlay.kind === 'TEXT',
  );
  const hasCaptions = Boolean(manifest.captions);
  if (!hasCaptions && textOverlays.length === 0 && !manifest.cta) return null;

  const base = manifest.captions
    ? buildAssSubtitleFile({
        style: manifest.captions.style,
        cues: manifest.captions.cues,
        widthPx: manifest.output.widthPx,
        heightPx: manifest.output.heightPx,
        ...(manifest.captions.entrance ? { entrance: manifest.captions.entrance } : {}),
      })
    : buildAssSubtitleFile({
        style: {
          fontFamily: 'Arial',
          fontSizePx: 56,
          primaryColorHex: '#FFFFFF',
          outlineColorHex: '#000000',
          outlineWidthPx: 4,
          bold: true,
          uppercase: true,
          marginBottomPx: 420,
          marginHorizontalPx: 96,
        },
        cues: [],
        widthPx: manifest.output.widthPx,
        heightPx: manifest.output.heightPx,
      });

  const extraStyles: string[] = [];
  const extraEvents: string[] = [];

  textOverlays.forEach((overlay, index) => {
    const styleName = `Overlay${index}`;
    extraStyles.push(
      assStyleLine({
        name: styleName,
        fontFamily: 'Arial',
        fontSizePx: overlay.fontSizePx,
        primaryColorHex: overlay.colorHex,
        outlineColorHex: overlay.outlineColorHex,
        outlineWidthPx: overlay.outlineWidthPx,
        bold: true,
      }),
    );
    extraEvents.push(
      assDialogueLine({
        styleName,
        startSeconds: overlay.startSeconds,
        endSeconds: overlay.endSeconds,
        text: overlay.uppercase ? overlay.text.toUpperCase() : overlay.text,
        override: overlayOverride(overlay, manifest.output.widthPx, manifest.output.heightPx),
      }),
    );
  });

  if (manifest.cta) {
    const cta = manifest.cta;
    const entrance: CtaEntranceKey = cta.entrance ?? 'RISE_AND_SCALE';
    const fadeMs = Math.round(
      ctaAnimationSeconds(cta.startSeconds, cta.endSeconds, cta.holdSeconds) * 1000,
    );
    const centreX = Math.round(manifest.output.widthPx / 2);

    extraStyles.push(
      assStyleLine({
        name: 'CtaHeadline',
        fontFamily: 'Arial',
        fontSizePx: 92,
        primaryColorHex: cta.headlineColorHex,
        outlineColorHex: '#000000',
        outlineWidthPx: 0,
        bold: true,
      }),
    );
    extraEvents.push(
      assDialogueLine({
        styleName: 'CtaHeadline',
        startSeconds: cta.startSeconds,
        endSeconds: cta.endSeconds,
        text: cta.headline.toUpperCase(),
        override: ctaEntranceOverride(entrance, {
          xPx: centreX,
          yPx: Math.round(manifest.output.heightPx * 0.55),
          alignment: 5,
          fadeMs,
        }),
      }),
    );
    if (cta.subline) {
      extraStyles.push(
        assStyleLine({
          name: 'CtaSubline',
          fontFamily: 'Arial',
          fontSizePx: 56,
          primaryColorHex: cta.sublineColorHex,
          outlineColorHex: '#000000',
          outlineWidthPx: 0,
          bold: true,
        }),
      );
      extraEvents.push(
        assDialogueLine({
          styleName: 'CtaSubline',
          startSeconds: cta.startSeconds,
          endSeconds: cta.endSeconds,
          text: cta.subline.toUpperCase(),
          override: ctaEntranceOverride(entrance, {
            xPx: centreX,
            yPx: Math.round(manifest.output.heightPx * 0.63),
            alignment: 5,
            fadeMs,
          }),
        }),
      );
    }
  }

  if (extraStyles.length === 0 && extraEvents.length === 0) return base;

  const lines = base.split('\r\n');
  const eventsHeaderIndex = lines.findIndex((line) => line.startsWith('Format: Layer,'));
  if (eventsHeaderIndex === -1) {
    throw new FilterGraphError('generated ASS file is missing its events header');
  }
  const stylesHeaderIndex = lines.findIndex((line) => line.startsWith('Style: Caption'));
  if (stylesHeaderIndex === -1) {
    throw new FilterGraphError('generated ASS file is missing its caption style');
  }

  const withStyles = [
    ...lines.slice(0, stylesHeaderIndex + 1),
    ...extraStyles,
    ...lines.slice(stylesHeaderIndex + 1),
  ];
  const newEventsHeaderIndex = withStyles.findIndex((line) => line.startsWith('Format: Layer,'));
  return [
    ...withStyles.slice(0, newEventsHeaderIndex + 1),
    ...extraEvents,
    ...withStyles.slice(newEventsHeaderIndex + 1),
  ].join('\r\n');
}

const ANCHOR_TO_ASS_ALIGNMENT: Record<OverlayAnchor, number> = {
  BOTTOM_LEFT: 1,
  BOTTOM_CENTER: 2,
  BOTTOM_RIGHT: 3,
  TOP_LEFT: 7,
  TOP_CENTER: 8,
  TOP_RIGHT: 9,
  CENTER: 5,
};

function overlayOverride(
  overlay: Extract<Overlay, { kind: 'TEXT' }>,
  widthPx: number,
  heightPx: number,
): string {
  const alignment = ANCHOR_TO_ASS_ALIGNMENT[overlay.anchor];
  const x = overlay.anchor.endsWith('LEFT')
    ? SAFE_MARGIN_PX
    : overlay.anchor.endsWith('RIGHT')
      ? widthPx - SAFE_MARGIN_PX
      : Math.round(widthPx / 2);
  const y = overlay.anchor.startsWith('TOP')
    ? SAFE_MARGIN_PX
    : overlay.anchor.startsWith('BOTTOM')
      ? heightPx - SAFE_MARGIN_PX
      : Math.round(heightPx / 2);
  const px = x + overlay.offsetXPx;
  const py = y + overlay.offsetYPx;
  const fadeMs = Math.round(overlay.animationSeconds * 1000);

  switch (overlay.animation) {
    case 'NONE':
      return `{\\an${alignment}\\pos(${px},${py})}`;
    case 'SLIDE_UP':
      return `{\\an${alignment}\\fad(${fadeMs},${fadeMs})\\move(${px},${py + 110},${px},${py},0,${fadeMs})}`;
    case 'SLIDE_DOWN':
      return `{\\an${alignment}\\fad(${fadeMs},${fadeMs})\\move(${px},${py - 110},${px},${py},0,${fadeMs})}`;
    case 'POP':
      return `{\\an${alignment}\\pos(${px},${py})\\fad(${Math.round(fadeMs / 2)},${fadeMs})\\fscx78\\fscy78\\t(0,${fadeMs},\\fscx100\\fscy100)}`;
    case 'FADE':
    default:
      return `{\\an${alignment}\\pos(${px},${py})\\fad(${fadeMs},${fadeMs})}`;
  }
}

interface AssStyleInput {
  readonly name: string;
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly primaryColorHex: string;
  readonly outlineColorHex: string;
  readonly outlineWidthPx: number;
  readonly bold: boolean;
}

function assStyleLine(style: AssStyleInput): string {
  const colour = (hex: string, alpha = 0): string => {
    const clean = hex.replace('#', '');
    const rr = clean.slice(0, 2);
    const gg = clean.slice(2, 4);
    const bb = clean.slice(4, 6);
    const aa = alpha.toString(16).padStart(2, '0');
    return `&H${aa}${bb}${gg}${rr}`.toUpperCase();
  };
  return [
    `Style: ${style.name}`,
    style.fontFamily,
    String(style.fontSizePx),
    colour(style.primaryColorHex),
    colour(style.primaryColorHex),
    colour(style.outlineColorHex),
    colour('#000000', 160),
    style.bold ? '-1' : '0',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    '1',
    String(style.outlineWidthPx),
    '0',
    '5',
    '40',
    '40',
    '40',
    '1',
  ].join(',');
}

interface AssDialogueInput {
  readonly styleName: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
  readonly override: string;
}

function assDialogueLine(input: AssDialogueInput): string {
  // Reuses the same escaping the caption path uses — the text is operator or
  // agent authored and must not be able to inject ASS override tags.
  const escaped = input.text
    .replace(/\\/g, '\u2216')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N');
  return [
    'Dialogue: 0',
    assTime(input.startSeconds),
    assTime(input.endSeconds),
    input.styleName,
    '',
    '0',
    '0',
    '0',
    '',
    `${input.override}${escaped}`,
  ].join(',');
}

function assTime(seconds: number): string {
  const totalCentiseconds = Math.round(Math.max(0, seconds) * 100);
  const cs = totalCentiseconds % 100;
  const totalSeconds = (totalCentiseconds - cs) / 100;
  const ss = totalSeconds % 60;
  const totalMinutes = (totalSeconds - ss) / 60;
  const mm = totalMinutes % 60;
  const hh = (totalMinutes - mm) / 60;
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
