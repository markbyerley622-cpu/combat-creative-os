import {
  evenPx,
  FilterPrimitiveError,
  hexToFfmpegColor,
  hexToFfmpegColorWithAlpha,
  num,
} from './filter-primitives';

/**
 * The motion-treatment catalogue — the single authority for every piece of
 * movement, decoration and typography animation the renderer can express.
 *
 * Before this module the filter graph built motion inline: a `zoompan`
 * expression here, an `xfade` name there, a bespoke parallax chain a hundred
 * lines further down. That is precisely the "unvalidated FFmpeg filter strings
 * scattered through application code" the rules forbid, and it made two
 * properties impossible to state: which treatments exist, and whether a given
 * manifest still produces the filters it produced last week.
 *
 * So the catalogue is:
 *
 * - **Typed.** A treatment is selected by key from a closed vocabulary, never
 *   by an authored string. An unknown key is a typed error, not a filter that
 *   silently does nothing.
 * - **Validated.** Every number that reaches filter grammar goes through
 *   `num`, every colour through `hexToFfmpegColor*`, and each entry declares
 *   which source kinds it accepts — a parallax on a video source is refused
 *   here rather than producing a graph FFmpeg rejects twenty seconds into an
 *   encode.
 * - **Versioned.** `MOTION_TREATMENT_CATALOGUE_VERSION` travels in every
 *   compiled plan and into the run's storyboard, so a cut can say which
 *   catalogue produced it. Changing an entry's filters is a version bump, not
 *   an edit in place — the same versioned-immutable discipline the render
 *   manifest and the retrieval plans follow.
 * - **Pure.** No clock, no randomness, no filesystem. Identical inputs produce
 *   byte-identical filter text, which is what keeps `computeRenderKey` a
 *   content address rather than a guess.
 *
 * Creative Memory may influence *which* treatment a beat receives and how
 * intense it is — transferable structure. It supplies nothing in this file:
 * no media, no copy, no logo, no music, no copied sequence.
 */

/**
 * Bumped to 2 by the premium creative finishing milestone, which added the
 * five finishing decorations. A storyboard or provenance record saying
 * "catalogue v1" describes a catalogue that had five fewer ways to treat a
 * frame; leaving the number at 1 would make two different catalogues
 * indistinguishable in the artefacts that cite them.
 */
export const MOTION_TREATMENT_CATALOGUE_VERSION = 2 as const;

export class MotionTreatmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MotionTreatmentError';
  }
}

/** Which part of the graph a treatment belongs to. */
export const MOTION_TREATMENT_FAMILIES = [
  'SCENE',
  'TRANSITION',
  'DECORATION',
  'TYPOGRAPHY',
] as const;
export type MotionTreatmentFamily = (typeof MOTION_TREATMENT_FAMILIES)[number];

/** Source kinds a scene treatment is able to act on. */
export type TreatmentSourceKind = 'VIDEO' | 'IMAGE';

// ---------------------------------------------------------------------------
// Scene treatments
// ---------------------------------------------------------------------------

export const SCENE_TREATMENT_KEYS = [
  /** No move. A still on `STATIC_HOLD` is a deliberate choice, not an absence. */
  'STATIC_HOLD',
  'PUSH_IN',
  'PULL_OUT',
  'LATERAL_LEFT',
  'LATERAL_RIGHT',
  /** Two planes at different rates behind a bezelled screenshot. Stills only. */
  'APP_SCREENSHOT_PARALLAX',
  /** Bezelled screenshot on a blurred backplate, held still. Stills only. */
  'FRAMED_PHONE_UI',
  /** Bounded, monotonic time remap: opens slightly quick and settles. Video only. */
  'SAFE_SPEED_RAMP',
  /** Runs, then holds its final frame for the tail of the scene. Video only. */
  'IMPACT_FREEZE',
  /** A decaying white lift over the first fraction of a second. */
  'IMPACT_FLASH',
] as const;
export type SceneTreatmentKey = (typeof SCENE_TREATMENT_KEYS)[number];

export interface SceneTreatmentCompileInput {
  /** FFmpeg stream specifier for the scene's own input, e.g. `0:v`. */
  readonly inputLabel: string;
  /** Label the finished chain must produce. */
  readonly outputLabel: string;
  /** Unique per scene; every intermediate label is prefixed with it. */
  readonly scopeTag: string;
  /** 0 is imperceptible, 1 is the strongest move the treatment allows. */
  readonly intensity: number;
  readonly durationSeconds: number;
  readonly frameRate: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly sourceKind: TreatmentSourceKind;
  readonly framing: {
    readonly mode: 'COVER' | 'CONTAIN';
    readonly anchorX: number;
    readonly anchorY: number;
  };
}

export interface CompiledTreatment {
  readonly treatmentKey: string;
  readonly family: MotionTreatmentFamily;
  readonly catalogueVersion: typeof MOTION_TREATMENT_CATALOGUE_VERSION;
  /** The complete `;`-joined graph segment. */
  readonly graph: string;
  /** One line for the storyboard, so a reviewer reads intent rather than grammar. */
  readonly description: string;
}

interface SceneTreatmentDefinition {
  readonly key: SceneTreatmentKey;
  readonly summary: string;
  readonly accepts: readonly TreatmentSourceKind[];
  readonly compile: (input: SceneTreatmentCompileInput) => string;
}

/** Oversample before `zoompan`, so a push-in still resolves full detail at maximum zoom. */
const MOTION_OVERSAMPLE = 1.5;

function assertIntensity(intensity: number): number {
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    throw new MotionTreatmentError(`motion intensity must be between 0 and 1, got ${intensity}`);
  }
  return intensity;
}

function coverSteps(width: number, height: number, anchorX: number, anchorY: number): string[] {
  return [
    `scale=${num(width)}:${num(height)}:force_original_aspect_ratio=increase`,
    `crop=${num(width)}:${num(height)}:x='(iw-ow)*${num(anchorX)}':y='(ih-oh)*${num(anchorY)}'`,
  ];
}

/**
 * `CONTAIN` fits the whole source and fills the remainder with a blurred,
 * over-scaled copy of itself rather than hard bars — the standard vertical
 * treatment for landscape footage, and one that keeps colour continuity across
 * a cut. Written as its own labelled sub-graph because it needs a split.
 */
function containGraph(input: SceneTreatmentCompileInput, width: number, height: number): string {
  const tag = input.scopeTag;
  return [
    `[${input.inputLabel}]fps=${num(input.frameRate)},split=2[${tag}bg][${tag}fg]`,
    `[${tag}bg]scale=${num(width)}:${num(height)}:force_original_aspect_ratio=increase,crop=${num(width)}:${num(height)},gblur=sigma=40:steps=2[${tag}bgb]`,
    `[${tag}fg]scale=${num(width)}:${num(height)}:force_original_aspect_ratio=decrease[${tag}fgs]`,
    `[${tag}bgb][${tag}fgs]overlay=x=(W-w)/2:y=(H-h)/2[${tag}framed]`,
  ].join(';');
}

/**
 * The steps every scene chain ends with.
 *
 * `settb=AVTB` is not cosmetic: `xfade` refuses to join links whose timebases
 * differ, and a looped still (1/fps) and a demuxed clip (1/12800 or worse)
 * never agree on their own. Normalising here is what lets any scene follow any
 * other.
 */
function normalisingTail(durationSeconds: number): string[] {
  return [
    'setsar=1',
    `trim=duration=${num(durationSeconds)}`,
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    'format=yuv420p',
  ];
}

/**
 * `zoompan` expressions for the four simple moves. Progress is driven by `on`
 * (the output frame index) rather than by accumulating onto the previous
 * `zoom`, so the move lands on exactly the intended end point instead of
 * drifting.
 */
function zoompanExpressions(
  key: 'PUSH_IN' | 'PULL_OUT' | 'LATERAL_LEFT' | 'LATERAL_RIGHT',
  intensity: number,
  frames: number,
): { z: string; x: string; y: string } {
  const amplitude = 0.06 + 0.14 * intensity;
  const lastFrame = Math.max(1, frames - 1);
  const progress = `on/${num(lastFrame)}`;
  const centredX = 'iw/2-(iw/zoom/2)';
  const centredY = 'ih/2-(ih/zoom/2)';

  switch (key) {
    case 'PUSH_IN':
      return { z: `1+${num(amplitude)}*${progress}`, x: centredX, y: centredY };
    case 'PULL_OUT':
      return {
        z: `${num(1 + amplitude)}-${num(amplitude)}*${progress}`,
        x: centredX,
        y: centredY,
      };
    case 'LATERAL_LEFT':
      return { z: num(1 + amplitude), x: `(iw-iw/zoom)*(1-${progress})`, y: centredY };
    case 'LATERAL_RIGHT':
    default:
      return { z: num(1 + amplitude), x: `(iw-iw/zoom)*(${progress})`, y: centredY };
  }
}

/** A framed, moving or static chain built from `fps → framing → [move] → tail`. */
function simpleSceneGraph(
  input: SceneTreatmentCompileInput,
  options: { readonly oversample: boolean; readonly extra: readonly string[] },
): string {
  const targetW = options.oversample ? evenPx(input.widthPx * MOTION_OVERSAMPLE) : input.widthPx;
  const targetH = options.oversample ? evenPx(input.heightPx * MOTION_OVERSAMPLE) : input.heightPx;

  if (input.framing.mode === 'CONTAIN') {
    const framed = containGraph(input, targetW, targetH);
    const steps = [...options.extra, ...normalisingTail(input.durationSeconds)];
    return `${framed};[${input.scopeTag}framed]${steps.join(',')}[${input.outputLabel}]`;
  }

  const steps = [
    `fps=${num(input.frameRate)}`,
    ...coverSteps(targetW, targetH, input.framing.anchorX, input.framing.anchorY),
    ...options.extra,
    ...normalisingTail(input.durationSeconds),
  ];
  return `[${input.inputLabel}]${steps.join(',')}[${input.outputLabel}]`;
}

/**
 * A bounded, monotonic time remap.
 *
 * The output PTS is a quadratic function of the input time chosen so that the
 * scene consumes exactly its own duration of source and lands exactly on its
 * own duration of output — a ramp redistributes time, it does not create or
 * destroy any. Playback opens at `1/k` speed and settles to `1/(2-k)`, with
 * `k` never below 0.75, so the fastest a frame can ever run is a third quicker
 * than real time. That bound is what makes it *safe*: an unbounded ramp is how
 * a 15-second cut quietly becomes 14.6 seconds and fails the duration check.
 */
function speedRampSteps(intensity: number, durationSeconds: number): string[] {
  const k = 1 - 0.25 * intensity;
  const a = k;
  const b = (2 * (1 - k)) / durationSeconds;
  // `t` is the frame's own time with the stream's start removed, so the
  // expression is independent of where the trim began.
  const t = `((PTS-STARTPTS)*TB)`;
  return [`setpts='(${num(a)}*${t}+${num(b / 2)}*${t}*${t})/TB'`];
}

/**
 * Run, then hold. `tpad` clones the final frame for the tail, so the freeze is
 * a genuine held frame rather than a slowed one, and the scene still occupies
 * exactly its declared duration.
 */
function impactFreezeSteps(
  intensity: number,
  durationSeconds: number,
  frameRate: number,
): string[] {
  const requested = 0.1 + 0.3 * intensity;
  const hold = Math.min(requested, durationSeconds / 2);
  const running = durationSeconds - hold;
  // Two frames is the shortest running segment that reads as motion at all.
  // Below it the "freeze" is the whole scene, which is a still — and a still
  // dressed up as an impact beat is worse than an honest refusal.
  const minimumRunning = 2 / frameRate;
  if (running < minimumRunning) {
    throw new MotionTreatmentError(
      `IMPACT_FREEZE needs at least ${num(minimumRunning)}s of motion before its ${num(hold)}s hold, but the scene is only ${num(durationSeconds)}s`,
    );
  }
  return [
    `trim=duration=${num(running)}`,
    'setpts=PTS-STARTPTS',
    `tpad=stop_mode=clone:stop_duration=${num(hold)}`,
  ];
}

/**
 * A decaying white lift over the first fraction of a second. `eq` evaluates
 * `brightness` per frame, so this is one filter rather than a scheduled
 * overlay, and it decays to exactly zero at the end of the window.
 */
function impactFlashSteps(intensity: number): string[] {
  const peak = 0.2 + 0.35 * intensity;
  const windowSeconds = 0.12;
  return [
    `eq=brightness='if(lt(t,${num(windowSeconds)}),${num(peak)}*(1-t/${num(windowSeconds)}),0)':eval=frame`,
  ];
}

/**
 * Layered movement rather than a single pan: an over-scaled, blurred copy of
 * the screenshot pushes in slowly as a backplate while the sharp screenshot —
 * inside a light bezel, as an app interface reads — drifts vertically at a
 * different rate. Two planes moving at different speeds is what separates this
 * from a slideshow.
 */
function parallaxGraph(input: SceneTreatmentCompileInput): string {
  const tag = input.scopeTag;
  const frames = Math.max(1, Math.round(input.durationSeconds * input.frameRate));
  const backWidth = evenPx(input.widthPx * 1.8);
  const backHeight = evenPx(input.heightPx * 1.8);
  const foregroundWidth = evenPx(input.widthPx * 0.76);
  const bezelPx = 10;
  const lastFrame = Math.max(1, frames - 1);
  const drift = 60 + 90 * input.intensity;
  const duration = input.durationSeconds;

  const back = [
    `[${input.inputLabel}]fps=${num(input.frameRate)}`,
    `scale=${num(backWidth)}:${num(backHeight)}:force_original_aspect_ratio=increase`,
    `crop=${num(backWidth)}:${num(backHeight)}`,
    'gblur=sigma=28:steps=2',
    'eq=brightness=-0.12:saturation=0.85',
    `zoompan=z='1+${num(0.05 + 0.07 * input.intensity)}*on/${num(lastFrame)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${num(input.widthPx)}x${num(input.heightPx)}:fps=${num(input.frameRate)}`,
    'setsar=1',
    `trim=duration=${num(duration)}`,
    'setpts=PTS-STARTPTS',
    `format=yuv420p[${tag}back]`,
  ].join(',');

  const fore = [
    `[${input.inputLabel}]fps=${num(input.frameRate)}`,
    `scale=${num(foregroundWidth)}:-2`,
    `pad=iw+${num(bezelPx * 2)}:ih+${num(bezelPx * 2)}:${num(bezelPx)}:${num(bezelPx)}:color=white`,
    `trim=duration=${num(duration)}`,
    'setpts=PTS-STARTPTS',
    `format=yuv420p[${tag}fore]`,
  ].join(',');

  const composite = `[${tag}back][${tag}fore]overlay=x='(W-w)/2':y='(H-h)/2+${num(drift / 2)}-${num(drift)}*t/${num(duration)}':format=auto,${normalisingTail(duration).join(',')}[${input.outputLabel}]`;

  return [back, fore, composite].join(';');
}

/**
 * The same bezelled composition, held still.
 *
 * Distinct from parallax on purpose: a UI shot that has to be *read* — a fight
 * card, a scorecard — is easier to read when it is not moving, and a catalogue
 * that only offered the moving variant would push every screenshot into drift
 * whether or not the copy on it needs a second to land.
 */
function framedPhoneUiGraph(input: SceneTreatmentCompileInput): string {
  const tag = input.scopeTag;
  const backWidth = evenPx(input.widthPx * 1.4);
  const backHeight = evenPx(input.heightPx * 1.4);
  const foregroundWidth = evenPx(input.widthPx * (0.72 + 0.06 * input.intensity));
  const bezelPx = 12;
  const duration = input.durationSeconds;

  const back = [
    `[${input.inputLabel}]fps=${num(input.frameRate)}`,
    `scale=${num(backWidth)}:${num(backHeight)}:force_original_aspect_ratio=increase`,
    `crop=${num(input.widthPx)}:${num(input.heightPx)}`,
    'gblur=sigma=34:steps=2',
    'eq=brightness=-0.18:saturation=0.7',
    'setsar=1',
    `trim=duration=${num(duration)}`,
    'setpts=PTS-STARTPTS',
    `format=yuv420p[${tag}back]`,
  ].join(',');

  const fore = [
    `[${input.inputLabel}]fps=${num(input.frameRate)}`,
    `scale=${num(foregroundWidth)}:-2`,
    `pad=iw+${num(bezelPx * 2)}:ih+${num(bezelPx * 2)}:${num(bezelPx)}:${num(bezelPx)}:color=white`,
    `trim=duration=${num(duration)}`,
    'setpts=PTS-STARTPTS',
    `format=yuv420p[${tag}fore]`,
  ].join(',');

  const composite = `[${tag}back][${tag}fore]overlay=x='(W-w)/2':y='(H-h)/2':format=auto,${normalisingTail(duration).join(',')}[${input.outputLabel}]`;

  return [back, fore, composite].join(';');
}

const SCENE_TREATMENTS: Readonly<Record<SceneTreatmentKey, SceneTreatmentDefinition>> = {
  STATIC_HOLD: {
    key: 'STATIC_HOLD',
    summary: 'held frame, no camera move',
    accepts: ['VIDEO', 'IMAGE'],
    compile: (input) => simpleSceneGraph(input, { oversample: false, extra: [] }),
  },
  PUSH_IN: {
    key: 'PUSH_IN',
    summary: 'slow push in toward the centre of frame',
    accepts: ['VIDEO', 'IMAGE'],
    compile: (input) => zoompanSceneGraph(input, 'PUSH_IN'),
  },
  PULL_OUT: {
    key: 'PULL_OUT',
    summary: 'slow pull out from the centre of frame',
    accepts: ['VIDEO', 'IMAGE'],
    compile: (input) => zoompanSceneGraph(input, 'PULL_OUT'),
  },
  LATERAL_LEFT: {
    key: 'LATERAL_LEFT',
    summary: 'lateral drift to the left across the frame',
    accepts: ['VIDEO', 'IMAGE'],
    compile: (input) => zoompanSceneGraph(input, 'LATERAL_LEFT'),
  },
  LATERAL_RIGHT: {
    key: 'LATERAL_RIGHT',
    summary: 'lateral drift to the right across the frame',
    accepts: ['VIDEO', 'IMAGE'],
    compile: (input) => zoompanSceneGraph(input, 'LATERAL_RIGHT'),
  },
  APP_SCREENSHOT_PARALLAX: {
    key: 'APP_SCREENSHOT_PARALLAX',
    summary: 'bezelled app screen drifting over a blurred backplate at a different rate',
    accepts: ['IMAGE'],
    compile: parallaxGraph,
  },
  FRAMED_PHONE_UI: {
    key: 'FRAMED_PHONE_UI',
    summary: 'bezelled app screen held still over a blurred backplate',
    accepts: ['IMAGE'],
    compile: framedPhoneUiGraph,
  },
  SAFE_SPEED_RAMP: {
    key: 'SAFE_SPEED_RAMP',
    summary: 'bounded time remap: opens quick and settles, exact duration preserved',
    accepts: ['VIDEO'],
    compile: (input) =>
      simpleSceneGraph(input, {
        oversample: false,
        extra: speedRampSteps(input.intensity, input.durationSeconds),
      }),
  },
  IMPACT_FREEZE: {
    key: 'IMPACT_FREEZE',
    summary: 'runs, then holds its final frame for the tail of the scene',
    accepts: ['VIDEO'],
    compile: (input) =>
      simpleSceneGraph(input, {
        oversample: false,
        extra: impactFreezeSteps(input.intensity, input.durationSeconds, input.frameRate),
      }),
  },
  IMPACT_FLASH: {
    key: 'IMPACT_FLASH',
    summary: 'decaying white lift over the first tenth of a second',
    accepts: ['VIDEO', 'IMAGE'],
    compile: (input) =>
      simpleSceneGraph(input, { oversample: false, extra: impactFlashSteps(input.intensity) }),
  },
};

function zoompanSceneGraph(
  input: SceneTreatmentCompileInput,
  key: 'PUSH_IN' | 'PULL_OUT' | 'LATERAL_LEFT' | 'LATERAL_RIGHT',
): string {
  const frames = Math.max(1, Math.round(input.durationSeconds * input.frameRate));
  const motion = zoompanExpressions(key, input.intensity, frames);
  return simpleSceneGraph(input, {
    oversample: true,
    extra: [
      `zoompan=z='${motion.z}':x='${motion.x}':y='${motion.y}':d=1:s=${num(input.widthPx)}x${num(input.heightPx)}:fps=${num(input.frameRate)}`,
    ],
  });
}

export function isSceneTreatmentKey(value: string): value is SceneTreatmentKey {
  return (SCENE_TREATMENT_KEYS as readonly string[]).includes(value);
}

export function sceneTreatmentSummary(key: SceneTreatmentKey): string {
  return SCENE_TREATMENTS[key].summary;
}

/** Source kinds a treatment accepts, so a caller can pick one it is allowed to use. */
export function sceneTreatmentAccepts(key: SceneTreatmentKey): readonly TreatmentSourceKind[] {
  return SCENE_TREATMENTS[key].accepts;
}

export function compileSceneTreatment(
  key: SceneTreatmentKey,
  input: SceneTreatmentCompileInput,
): CompiledTreatment {
  const definition = SCENE_TREATMENTS[key];
  if (!definition) {
    throw new MotionTreatmentError(`unknown scene treatment "${String(key)}"`);
  }
  if (!definition.accepts.includes(input.sourceKind)) {
    throw new MotionTreatmentError(
      `scene treatment ${key} accepts ${definition.accepts.join(' or ')} sources, but this scene's source is ${input.sourceKind}`,
    );
  }
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new MotionTreatmentError(
      `scene treatment ${key} needs a positive duration, got ${input.durationSeconds}`,
    );
  }
  assertIntensity(input.intensity);

  return {
    treatmentKey: key,
    family: 'SCENE',
    catalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
    graph: definition.compile(input),
    description: definition.summary,
  };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export const TRANSITION_TREATMENT_KEYS = [
  'CUT',
  'CROSSFADE',
  'DIP_TO_BLACK',
  /** Directional smear standing in for a whip pan's motion blur. */
  'WHIP_PAN',
  /** White flash on the cut — the "impact" treatment, as a transition. */
  'IMPACT_CUT',
  /** Masked UI reveal: the incoming app-interface scene wipes in behind a moving edge. */
  'MASKED_UI_REVEAL',
] as const;
export type TransitionTreatmentKey = (typeof TRANSITION_TREATMENT_KEYS)[number];

interface TransitionDefinition {
  readonly xfade: string;
  readonly summary: string;
}

const TRANSITION_TREATMENTS: Readonly<Record<TransitionTreatmentKey, TransitionDefinition>> = {
  // A one-frame blend is a cut; expressing it as an xfade keeps the whole
  // timeline a single chain instead of splicing concat runs into it.
  CUT: { xfade: 'fade', summary: 'hard cut' },
  CROSSFADE: { xfade: 'fade', summary: 'crossfade' },
  DIP_TO_BLACK: { xfade: 'fadeblack', summary: 'dip to black' },
  WHIP_PAN: { xfade: 'smoothleft', summary: 'directional smear, left to right' },
  IMPACT_CUT: { xfade: 'fadewhite', summary: 'white flash on the cut' },
  MASKED_UI_REVEAL: { xfade: 'circleopen', summary: 'masked reveal of the incoming interface' },
};

export interface CompiledTransition {
  readonly treatmentKey: TransitionTreatmentKey;
  readonly family: 'TRANSITION';
  readonly catalogueVersion: typeof MOTION_TREATMENT_CATALOGUE_VERSION;
  readonly xfadeName: string;
  readonly description: string;
}

export function compileTransitionTreatment(key: TransitionTreatmentKey): CompiledTransition {
  const definition = TRANSITION_TREATMENTS[key];
  if (!definition) {
    throw new MotionTreatmentError(`unknown transition treatment "${String(key)}"`);
  }
  return {
    treatmentKey: key,
    family: 'TRANSITION',
    catalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
    xfadeName: definition.xfade,
    description: definition.summary,
  };
}

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

export const DECORATION_TREATMENT_KEYS = [
  /** A filled brand-colour block behind a region — a callout bar. */
  'BRAND_COLOUR_CALLOUT',
  /** An unfilled accent rule around a region — an outline. */
  'ACCENT_OUTLINE',
  /**
   * Dims everything *outside* the region, leaving it at full brightness.
   *
   * Four filled boxes rather than an alpha mask, because `drawbox` is already
   * the one primitive that turns a validated colour and a validated rectangle
   * into filter grammar. A reviewer's eye goes to the undimmed part, which is
   * the whole purpose: a product screenshot has one thing worth reading and
   * fourteen things competing with it.
   */
  'FOCUS_DIM',
  /**
   * An expanding, fading square pulse centred on the region — a tap indicator.
   *
   * Square rather than circular because `drawbox` cannot draw an ellipse and
   * inventing a bespoke overlay chain for one ring would put ungoverned filter
   * grammar back into the graph. The pulse reads as a tap at delivery size.
   */
  'TAP_INDICATOR',
  /** A restrained band of light travelling horizontally across the region. */
  'LIGHT_SWEEP',
  /** Restrained luminance falloff toward frame edges. Full-frame geometry only. */
  'EDGE_VIGNETTE',
  /** Restrained temporal grain, so flat gradients do not band. Full-frame geometry only. */
  'FILM_GRAIN',
] as const;
export type DecorationTreatmentKey = (typeof DECORATION_TREATMENT_KEYS)[number];

export interface DecorationCompileInput {
  readonly baseLabel: string;
  readonly outputLabel: string;
  /**
   * Delivery frame geometry.
   *
   * `FOCUS_DIM` has to know what "outside the region" means, and a decoration
   * that assumed 1080×1920 would be a second place the output geometry is
   * stated — which is how the two quietly disagree.
   */
  readonly frameWidthPx: number;
  readonly frameHeightPx: number;
  readonly colorHex: string;
  readonly opacity: number;
  readonly xPx: number;
  readonly yPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Outline thickness. Ignored by the filled callout. */
  readonly thicknessPx: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface CompiledDecoration {
  readonly treatmentKey: DecorationTreatmentKey;
  readonly family: 'DECORATION';
  readonly catalogueVersion: typeof MOTION_TREATMENT_CATALOGUE_VERSION;
  readonly graph: string;
  readonly description: string;
}

/**
 * A whole-frame finish refuses a partial rectangle rather than quietly
 * ignoring it. `EDGE_VIGNETTE` and `FILM_GRAIN` act on the entire picture, so
 * a manifest that gave one a region asked for something the treatment cannot
 * do, and silently widening it would make the artefact describe a cut nobody
 * authored.
 */
function assertFullFrame(key: DecorationTreatmentKey, input: DecorationCompileInput): void {
  const isFullFrame =
    Math.round(input.xPx) === 0 &&
    Math.round(input.yPx) === 0 &&
    Math.round(input.widthPx) === Math.round(input.frameWidthPx) &&
    Math.round(input.heightPx) === Math.round(input.frameHeightPx);
  if (!isFullFrame) {
    throw new MotionTreatmentError(
      `${key} is a whole-frame finish and needs 0,0,${num(input.frameWidthPx)},${num(input.frameHeightPx)} — got ` +
        `${num(input.xPx)},${num(input.yPx)},${num(input.widthPx)},${num(input.heightPx)}`,
    );
  }
}

/**
 * How many discrete positions a moving decoration is cut into, per second.
 *
 * `drawbox` looks like it takes expressions, and it does — but its `t` is the
 * *thickness*, not the timestamp, and it has no per-frame evaluation mode. An
 * `x='10+100*t'` therefore silently resolves once, against the wrong variable,
 * and draws a static box somewhere nobody asked for. Verified against FFmpeg
 * 8.1.2 rather than assumed: the box never moves.
 *
 * So animation is expressed the only way this catalogue can express it
 * honestly — as a series of statically-positioned boxes, each enabled for its
 * own slice of the window. Twelve steps a second is under the frame rate and
 * well past the point the eye reads it as continuous movement at delivery
 * size, and it keeps the graph a bounded length.
 */
const ANIMATION_STEP_TARGET_HZ = 12;
const MAX_ANIMATION_STEPS = 48;

interface AnimationStep {
  /** 0 at the start of the decoration's window, 1 at its end. */
  readonly progress: number;
  readonly enable: string;
}

function animationSteps(input: DecorationCompileInput, stepsPerSecond: number): AnimationStep[] {
  const span = input.endSeconds - input.startSeconds;
  const count = Math.min(MAX_ANIMATION_STEPS, Math.max(2, Math.round(span * stepsPerSecond)));
  return Array.from({ length: count }, (_unused, index) => {
    const from = input.startSeconds + (span * index) / count;
    const to = input.startSeconds + (span * (index + 1)) / count;
    return {
      // Sampled at the middle of the step, so the movement is centred on the
      // window rather than lagging or leading it.
      progress: (index + 0.5) / count,
      enable: `enable='between(t,${num(from)},${num(to)})'`,
    };
  });
}

/**
 * Decorations are the one place a brand colour becomes filter grammar, which
 * is why `hexToFfmpegColorWithAlpha` validates the shape rather than trusting
 * the manifest: a colour that reached here as anything but `#RRGGBB` is a
 * defect worth failing on, not a value to interpolate and hope.
 */
export function compileDecorationTreatment(
  key: DecorationTreatmentKey,
  input: DecorationCompileInput,
): CompiledDecoration {
  if (input.endSeconds <= input.startSeconds) {
    throw new MotionTreatmentError(
      `decoration ${key} ends at ${num(input.endSeconds)}s, at or before its ${num(input.startSeconds)}s start`,
    );
  }
  if (input.widthPx <= 0 || input.heightPx <= 0) {
    throw new MotionTreatmentError(`decoration ${key} needs a positive width and height`);
  }

  const colour = hexToFfmpegColorWithAlpha(input.colorHex, input.opacity);
  const enable = `enable='between(t,${num(input.startSeconds)},${num(input.endSeconds)})'`;
  const box = `x=${num(input.xPx)}:y=${num(input.yPx)}:w=${num(input.widthPx)}:h=${num(input.heightPx)}:color=${colour}`;

  switch (key) {
    case 'BRAND_COLOUR_CALLOUT':
      return {
        treatmentKey: key,
        family: 'DECORATION',
        catalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
        graph: `[${input.baseLabel}]drawbox=${box}:t=fill:${enable}[${input.outputLabel}]`,
        description: 'filled brand-colour callout block',
      };
    case 'ACCENT_OUTLINE': {
      const thickness = Math.max(1, Math.round(input.thicknessPx));
      return {
        treatmentKey: key,
        family: 'DECORATION',
        catalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
        graph: `[${input.baseLabel}]drawbox=${box}:t=${num(thickness)}:${enable}[${input.outputLabel}]`,
        description: 'accent outline around a region of frame',
      };
    }
    case 'FOCUS_DIM': {
      // The four regions outside the focus rectangle, in output pixels. Each is
      // skipped when it would be empty, because `drawbox` with a zero extent is
      // a filter that does nothing while still costing a link.
      const x = Math.round(input.xPx);
      const y = Math.round(input.yPx);
      const w = Math.round(input.widthPx);
      const h = Math.round(input.heightPx);
      const frameW = Math.round(input.frameWidthPx);
      const frameH = Math.round(input.frameHeightPx);
      const bands: { x: number; y: number; w: number; h: number }[] = [
        { x: 0, y: 0, w: frameW, h: y },
        { x: 0, y: y + h, w: frameW, h: frameH - (y + h) },
        { x: 0, y, w: x, h },
        { x: x + w, y, w: frameW - (x + w), h },
      ];
      const steps = bands
        .filter((band) => band.w > 0 && band.h > 0)
        .map(
          (band) =>
            `drawbox=x=${num(band.x)}:y=${num(band.y)}:w=${num(band.w)}:h=${num(band.h)}:color=${colour}:t=fill:${enable}`,
        );
      if (steps.length === 0) {
        throw new MotionTreatmentError(
          'FOCUS_DIM covers the whole frame, so there is nothing left in focus',
        );
      }
      return {
        treatmentKey: key,
        family: 'DECORATION',
        catalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
        graph: `[${input.baseLabel}]${steps.join(',')}[${input.outputLabel}]`,
        description: 'dims everything outside a focus region',
      };
    }
    case 'TAP_INDICATOR': {
      const centreX = Math.round(input.xPx + input.widthPx / 2);
      const centreY = Math.round(input.yPx + input.heightPx / 2);
      const radius = Math.max(8, Math.round(Math.min(input.widthPx, input.heightPx) / 2));
      const thickness = Math.max(2, Math.round(input.thicknessPx));
      const steps = animationSteps(input, ANIMATION_STEP_TARGET_HZ);
      const graph = steps
        .map((step) => {
          // The ring grows from roughly a third of its radius to full and fades
          // as it goes. Both are held constant *within* a step, because a
          // drawbox parameter is evaluated once and never again.
          const stepRadius = Math.round(radius * (0.34 + 0.66 * step.progress));
          const stepColour = hexToFfmpegColorWithAlpha(
            input.colorHex,
            input.opacity * (1 - 0.75 * step.progress),
          );
          return (
            `drawbox=x=${num(centreX - stepRadius)}:y=${num(centreY - stepRadius)}` +
            `:w=${num(2 * stepRadius)}:h=${num(2 * stepRadius)}` +
            `:color=${stepColour}:t=${num(thickness)}:${step.enable}`
          );
        })
        .join(',');
      return {
        treatmentKey: key,
        family: 'DECORATION',
        catalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
        graph: `[${input.baseLabel}]${graph}[${input.outputLabel}]`,
        description: 'expanding tap indicator pulse',
      };
    }
    case 'LIGHT_SWEEP': {
      const regionX = Math.round(input.xPx);
      const regionW = Math.round(input.widthPx);
      const bandWidth = Math.max(24, Math.round(input.widthPx * 0.12));
      const travel = regionW + bandWidth;
      const steps = animationSteps(input, ANIMATION_STEP_TARGET_HZ);
      const drawn = steps
        .map((step) => {
          // Clipped to the region rather than allowed to spill: a sweep that
          // ran past the shot it belongs to would light the frame beside it.
          const left = Math.max(regionX, Math.round(regionX - bandWidth + travel * step.progress));
          const right = Math.min(
            regionX + regionW,
            Math.round(regionX - bandWidth + travel * step.progress) + bandWidth,
          );
          return { left, width: right - left, enable: step.enable };
        })
        .filter((band) => band.width > 0)
        .map(
          (band) =>
            `drawbox=x=${num(band.left)}:y=${num(input.yPx)}:w=${num(band.width)}` +
            `:h=${num(input.heightPx)}:color=${colour}:t=fill:${band.enable}`,
        );
      if (drawn.length === 0) {
        throw new MotionTreatmentError(
          'LIGHT_SWEEP produced no visible band — the region is too narrow to sweep across',
        );
      }
      return {
        treatmentKey: key,
        family: 'DECORATION',
        catalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
        graph: `[${input.baseLabel}]${drawn.join(',')}[${input.outputLabel}]`,
        description: 'restrained light sweep across a region',
      };
    }
    case 'EDGE_VIGNETTE': {
      assertFullFrame(key, input);
      // Opacity drives the angle: a wider angle is a weaker falloff, so the
      // profile's "restrained" is expressible as a number rather than a note.
      const angle = 1.5 - 0.5 * Math.min(1, Math.max(0, input.opacity));
      return {
        treatmentKey: key,
        family: 'DECORATION',
        catalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
        graph: `[${input.baseLabel}]vignette=angle=${num(angle)}:mode=forward:eval=init:${enable}[${input.outputLabel}]`,
        description: 'restrained edge vignette',
      };
    }
    case 'FILM_GRAIN': {
      assertFullFrame(key, input);
      const strength = Math.max(1, Math.round(4 + 16 * Math.min(1, Math.max(0, input.opacity))));
      return {
        treatmentKey: key,
        family: 'DECORATION',
        catalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
        graph: `[${input.baseLabel}]noise=alls=${num(strength)}:allf=t+u:${enable}[${input.outputLabel}]`,
        description: 'restrained temporal film grain',
      };
    }
    default: {
      const unreachable: never = key;
      throw new MotionTreatmentError(`unknown decoration treatment "${String(unreachable)}"`);
    }
  }
}

/** Exposed so the CTA card's generated colour source uses the same validation. */
export function solidColourSource(
  hex: string,
  widthPx: number,
  heightPx: number,
  fps: number,
): string {
  return `color=c=${hexToFfmpegColor(hex)}:s=${num(widthPx)}x${num(heightPx)}:r=${num(fps)}`;
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const CAPTION_ENTRANCE_KEYS = ['FADE', 'RISE', 'POP', 'SNAP'] as const;
export type CaptionEntranceKey = (typeof CAPTION_ENTRANCE_KEYS)[number];

export const CTA_ENTRANCE_KEYS = ['RISE_AND_SCALE', 'FADE_HOLD', 'SNAP_HOLD'] as const;
export type CtaEntranceKey = (typeof CTA_ENTRANCE_KEYS)[number];

export interface TypographyOverrideInput {
  readonly xPx: number;
  readonly yPx: number;
  readonly alignment: number;
  readonly fadeMs: number;
}

/**
 * ASS override tags, not filter grammar.
 *
 * Typography animation lives in the generated subtitle file for the reason the
 * filter graph documents: no authored string may become filter grammar, and
 * libass gives real animated type (`\move`, `\fad`, `\t`) that `drawtext`
 * cannot express. Only numbers reach these strings.
 */
export function captionEntranceOverride(
  key: CaptionEntranceKey,
  input: TypographyOverrideInput,
): string {
  const { xPx, yPx, alignment, fadeMs } = input;
  const x = Math.round(xPx);
  const y = Math.round(yPx);
  const fade = Math.max(0, Math.round(fadeMs));

  switch (key) {
    case 'FADE':
      return `{\\an${alignment}\\pos(${x},${y})\\fad(${fade},${fade})}`;
    case 'RISE':
      return `{\\an${alignment}\\fad(${fade},${fade})\\move(${x},${y + 80},${x},${y},0,${fade})}`;
    case 'POP':
      return `{\\an${alignment}\\pos(${x},${y})\\fad(${Math.round(fade / 2)},${fade})\\fscx78\\fscy78\\t(0,${fade},\\fscx100\\fscy100)}`;
    case 'SNAP':
      return `{\\an${alignment}\\pos(${x},${y})\\fad(0,${Math.round(fade / 2)})}`;
    default: {
      const unreachable: never = key;
      throw new MotionTreatmentError(`unknown caption entrance "${String(unreachable)}"`);
    }
  }
}

export function ctaEntranceOverride(key: CtaEntranceKey, input: TypographyOverrideInput): string {
  const { xPx, yPx, alignment, fadeMs } = input;
  const x = Math.round(xPx);
  const y = Math.round(yPx);
  const fade = Math.max(0, Math.round(fadeMs));

  switch (key) {
    case 'RISE_AND_SCALE':
      return `{\\an${alignment}\\pos(${x},${y})\\fad(${fade},${Math.round(fade * 0.7)})\\fscx88\\fscy88\\t(0,${Math.round(fade * 1.2)},\\fscx100\\fscy100)}`;
    case 'FADE_HOLD':
      return `{\\an${alignment}\\pos(${x},${y})\\fad(${fade},0)}`;
    case 'SNAP_HOLD':
      return `{\\an${alignment}\\pos(${x},${y})\\fad(0,0)}`;
    default: {
      const unreachable: never = key;
      throw new MotionTreatmentError(`unknown CTA entrance "${String(unreachable)}"`);
    }
  }
}

/** Every key the catalogue knows, for provenance and for the storyboard legend. */
export function catalogueInventory(): Readonly<Record<MotionTreatmentFamily, readonly string[]>> {
  return {
    SCENE: SCENE_TREATMENT_KEYS,
    TRANSITION: TRANSITION_TREATMENT_KEYS,
    DECORATION: DECORATION_TREATMENT_KEYS,
    TYPOGRAPHY: [...CAPTION_ENTRANCE_KEYS, ...CTA_ENTRANCE_KEYS],
  };
}

export { FilterPrimitiveError };
