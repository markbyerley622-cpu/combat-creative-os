import { buildAssSubtitleFile } from './ass-captions';
import {
  MIN_TRANSITION_SECONDS,
  type Overlay,
  type OverlayAnchor,
  type RenderManifest,
  type Scene,
  type SceneMotion,
  type SceneTransition,
  secondsToFrames,
} from './manifest';
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

/** Oversample factor before `zoompan`, so a push-in still resolves full detail at maximum zoom. */
const MOTION_OVERSAMPLE = 1.5;
/** Distance overlay content keeps from the frame edge. */
export const SAFE_MARGIN_PX = 72;

const TRANSITION_TO_XFADE: Record<SceneTransition, string> = {
  // A one-frame blend is a cut; expressing it as an xfade keeps the whole
  // timeline a single chain instead of splicing concat runs into it.
  CUT: 'fade',
  CROSSFADE: 'fade',
  DIP_TO_BLACK: 'fadeblack',
  /** Directional smear — the closest xfade has to a motion-blurred whip pan. */
  WHIP_PAN: 'smoothleft',
  /** Two-frame white flash on the cut. */
  IMPACT_CUT: 'fadewhite',
  /** The incoming app-interface scene is revealed behind an expanding mask. */
  MASKED_UI_REVEAL: 'circleopen',
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

export interface RenderPlan {
  readonly args: readonly string[];
  readonly inputs: readonly PlannedInput[];
  readonly jobFiles: readonly JobFile[];
  readonly outputFileName: string;
  readonly timeline: readonly SceneTiming[];
  readonly hasAudio: boolean;
  readonly filterComplex: string;
}

export class FilterGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterGraphError';
  }
}

/** Fixed-precision so the same manifest always produces byte-identical argv. */
function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new FilterGraphError(`non-finite value in filter graph: ${value}`);
  }
  return Number(value.toFixed(6)).toString();
}

/** FFmpeg colour literal. No `@alpha` suffix — the `color` source rejects it on a hex value. */
function hexToFfmpegColor(hex: string): string {
  return `0x${hex.replace('#', '').toUpperCase()}`;
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

/**
 * `zoompan` expressions for each motion. Progress is driven by `on` (the
 * output frame index) rather than by accumulating onto the previous `zoom`,
 * so the move lands on exactly the intended end point instead of drifting.
 */
function motionExpressions(
  motion: Exclude<SceneMotion, 'PARALLAX'>,
  intensity: number,
  frames: number,
): { z: string; x: string; y: string } | null {
  if (motion === 'STATIC') return null;
  const amplitude = 0.06 + 0.14 * intensity;
  const lastFrame = Math.max(1, frames - 1);
  const progress = `on/${num(lastFrame)}`;
  const centredX = 'iw/2-(iw/zoom/2)';
  const centredY = 'ih/2-(ih/zoom/2)';

  switch (motion) {
    case 'PUSH_IN':
      return { z: `1+${num(amplitude)}*${progress}`, x: centredX, y: centredY };
    case 'PUSH_OUT':
      return {
        z: `${num(1 + amplitude)}-${num(amplitude)}*${progress}`,
        x: centredX,
        y: centredY,
      };
    case 'PAN_LEFT':
      return {
        z: num(1 + amplitude),
        x: `(iw-iw/zoom)*(1-${progress})`,
        y: centredY,
      };
    case 'PAN_RIGHT':
      return {
        z: num(1 + amplitude),
        x: `(iw-iw/zoom)*(${progress})`,
        y: centredY,
      };
    default:
      return null;
  }
}

interface SceneChainInput {
  readonly scene: Scene;
  readonly inputIndex: number;
  readonly frameRate: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** One scene's video chain: framing, motion, exact length, `[vN]`. */
function buildSceneChain(input: SceneChainInput): string {
  const { scene, inputIndex, frameRate, widthPx, heightPx } = input;
  const label = `v${inputIndex}`;
  const frames = secondsToFrames(scene.durationSeconds, frameRate);
  const overWidth = Math.round((widthPx * MOTION_OVERSAMPLE) / 2) * 2;
  const overHeight = Math.round((heightPx * MOTION_OVERSAMPLE) / 2) * 2;

  if (scene.motion === 'PARALLAX') {
    return buildParallaxChain({ ...input, label, frames });
  }

  const moving = scene.motion !== 'STATIC';
  const targetW = moving ? overWidth : widthPx;
  const targetH = moving ? overHeight : heightPx;

  const framing =
    scene.framing.mode === 'CONTAIN'
      ? containChain(targetW, targetH)
      : coverChain(targetW, targetH, scene.framing.anchorX, scene.framing.anchorY);

  const steps: string[] = [`fps=${num(frameRate)}`, ...framing];

  const motion = motionExpressions(scene.motion, scene.motionIntensity, frames);
  if (motion) {
    steps.push(
      `zoompan=z='${motion.z}':x='${motion.x}':y='${motion.y}':d=1:s=${widthPx}x${heightPx}:fps=${num(frameRate)}`,
    );
  }

  steps.push(
    'setsar=1',
    `trim=duration=${num(scene.durationSeconds)}`,
    'setpts=PTS-STARTPTS',
    // `xfade` refuses to join links whose timebases differ, and a looped
    // still (1/fps) and a demuxed clip (1/12800 or worse) never agree on
    // their own. Normalising here is what lets any scene follow any other.
    'settb=AVTB',
    'format=yuv420p',
  );

  return `[${inputIndex}:v]${steps.join(',')}[${label}]`;
}

function coverChain(width: number, height: number, anchorX: number, anchorY: number): string[] {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}:x='(iw-ow)*${num(anchorX)}':y='(ih-oh)*${num(anchorY)}'`,
  ];
}

/**
 * `CONTAIN` fits the whole source and fills the remainder with a blurred,
 * over-scaled copy of itself rather than hard bars — the standard vertical
 * treatment for landscape footage, and one that keeps the frame's colour
 * continuity across a cut.
 */
function containChain(width: number, height: number): string[] {
  return [
    `split=2[bg_%L%][fg_%L%];[bg_%L%]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=40:steps=2[bgb_%L%];[fg_%L%]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgs_%L%];[bgb_%L%][fgs_%L%]overlay=x=(W-w)/2:y=(H-h)/2`,
  ];
}

interface ParallaxChainInput extends SceneChainInput {
  readonly label: string;
  readonly frames: number;
}

/**
 * Layered movement rather than a single pan: an over-scaled, blurred copy of
 * the screenshot pushes in slowly as a backplate while the sharp screenshot
 * — inside a light bezel, as an app interface reads — drifts vertically at a
 * different rate. Two planes moving at different speeds is what separates
 * this from a slideshow.
 */
function buildParallaxChain(input: ParallaxChainInput): string {
  const { scene, inputIndex, frameRate, widthPx, heightPx, label, frames } = input;
  const tag = `p${inputIndex}`;
  const backWidth = Math.round((widthPx * 1.8) / 2) * 2;
  const backHeight = Math.round((heightPx * 1.8) / 2) * 2;
  const foregroundWidth = Math.round(widthPx * 0.76);
  const bezelPx = 10;
  const lastFrame = Math.max(1, frames - 1);
  const drift = 60 + 90 * scene.motionIntensity;
  const duration = scene.durationSeconds;

  const back = [
    `[${inputIndex}:v]fps=${num(frameRate)}`,
    `scale=${backWidth}:${backHeight}:force_original_aspect_ratio=increase`,
    `crop=${backWidth}:${backHeight}`,
    'gblur=sigma=28:steps=2',
    'eq=brightness=-0.12:saturation=0.85',
    `zoompan=z='1+${num(0.05 + 0.07 * scene.motionIntensity)}*on/${num(lastFrame)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${widthPx}x${heightPx}:fps=${num(frameRate)}`,
    'setsar=1',
    `trim=duration=${num(duration)}`,
    'setpts=PTS-STARTPTS',
    `format=yuv420p[${tag}back]`,
  ].join(',');

  const fore = [
    `[${inputIndex}:v]fps=${num(frameRate)}`,
    `scale=${foregroundWidth}:-2`,
    `pad=iw+${bezelPx * 2}:ih+${bezelPx * 2}:${bezelPx}:${bezelPx}:color=white`,
    `trim=duration=${num(duration)}`,
    'setpts=PTS-STARTPTS',
    `format=yuv420p[${tag}fore]`,
  ].join(',');

  // The foreground rises past the centre line while the backplate zooms —
  // different planes, different rates.
  const composite = `[${tag}back][${tag}fore]overlay=x='(W-w)/2':y='(H-h)/2+${num(drift / 2)}-${num(drift)}*t/${num(duration)}':format=auto,setsar=1,trim=duration=${num(duration)},setpts=PTS-STARTPTS,settb=AVTB,format=yuv420p[${label}]`;

  return [`${back}`, `${fore}`, composite].join(';');
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
  let runningLength = 0;

  manifest.scenes.forEach((scene, sceneIndex) => {
    const source = requireSource(scene.sourceId);
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

    sceneChains.push(
      buildSceneChain({
        scene,
        inputIndex: index,
        frameRate,
        widthPx: output.widthPx,
        heightPx: output.heightPx,
      }).replace(/%L%/g, `s${index}`),
    );
    sceneLabels.push(`v${index}`);

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
    transitionChains.push(
      `[${mergedLabel}][${label}]xfade=transition=${TRANSITION_TO_XFADE[transition.kind]}:duration=${num(transition.durationSeconds)}:offset=${num(offset)}[${outLabel}]`,
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
    const cardFade = 0.3;
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
        `[${index}:v]scale=${cta.logoWidthPx}:-2,format=rgba,fade=t=in:st=${num(cta.startSeconds + 0.15)}:d=0.35:alpha=1,setpts=PTS-STARTPTS[ctalogo];[${baseLabel}][ctalogo]overlay=x='(W-w)/2':y='${num(Math.round(output.heightPx * 0.34))}':enable='between(t,${num(cta.startSeconds)},${num(cta.endSeconds)})':format=auto[${outLabel}]`,
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
    chains.push(
      `[${sceneInput}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,${commonTail(timing.startSeconds, 0.05, 0.05).join(',')}[${label}]`,
    );
    otherLabels.push(label);
  });

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
    chains.push(
      musicLabels.length === 1
        ? `[${musicLabels[0]}]anull[${musicBus}]`
        : `${musicLabels.map((l) => `[${l}]`).join('')}amix=inputs=${musicLabels.length}:duration=longest:normalize=0[${musicBus}]`,
    );

    if (voiceBus && duckingDb > 0) {
      // The voice bus is needed twice — as the compressor's key and in the
      // final mix — so it is split rather than consumed.
      chains.push(`[${voiceBus}]asplit=2[voicemix][voicekey]`);
      const ratio = Math.min(20, Math.max(1, 1 + duckingDb));
      chains.push(
        `[${musicBus}][voicekey]sidechaincompress=threshold=0.03:ratio=${num(ratio)}:attack=20:release=350:makeup=1:level_sc=1[musicducked]`,
      );
      mixInputs.push('musicducked', 'voicemix');
    } else {
      mixInputs.push(musicBus);
      if (voiceBus) mixInputs.push(voiceBus);
    }
  } else if (voiceBus) {
    mixInputs.push(voiceBus);
  }

  mixInputs.push(...otherLabels);

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

  chains.push(
    `[${mixed}]loudnorm=I=${num(loudness.integratedLufs)}:TP=${num(loudness.truePeakDbtp)}:LRA=${num(loudness.loudnessRange)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${num(duration)},asetpts=PTS-STARTPTS[aout]`,
  );

  return { chains, outputLabel: 'aout' };
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
        // Rises into place and scales up: the "animated typography"
        // requirement applied to the end card.
        override: `{\\an5\\pos(${Math.round(manifest.output.widthPx / 2)},${Math.round(manifest.output.heightPx * 0.55)})\\fad(260,180)\\fscx88\\fscy88\\t(0,320,\\fscx100\\fscy100)}`,
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
          startSeconds: cta.startSeconds + 0.2,
          endSeconds: cta.endSeconds,
          text: cta.subline.toUpperCase(),
          override: `{\\an5\\pos(${Math.round(manifest.output.widthPx / 2)},${Math.round(manifest.output.heightPx * 0.63)})\\fad(240,180)\\move(${Math.round(manifest.output.widthPx / 2)},${Math.round(manifest.output.heightPx * 0.63 + 40)},${Math.round(manifest.output.widthPx / 2)},${Math.round(manifest.output.heightPx * 0.63)},0,300)}`,
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
