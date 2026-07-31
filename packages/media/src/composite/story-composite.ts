import { evenPx, num } from '../render/filter-primitives';
import {
  perspectiveCornerExpressions,
  zoomExpression,
  type CameraMove,
  type NormalisedQuad,
} from './screen-quad';

/**
 * The full-frame product-story compositor.
 *
 * `screen-composite.ts` already proved the hard part: a photographed plate
 * moves, the four screen corners are carried through the *same* move
 * analytically, and the interface is warped once at delivery resolution so
 * type never picks up the camera's own zoom factor. This module reuses that
 * arithmetic — the corner expressions and the zoom expression are imported,
 * not re-derived — and changes only what feeds it and what comes out.
 *
 * Two differences, both of which the correction needed:
 *
 *   1. **The interface arrives as a frame sequence, not as a video.** A
 *      scrolled list, a row revealing, a card becoming selected and a button
 *      taking a press are all *typographic* events. `drawbox` cannot animate
 *      them and a filter cannot typeset them, so every frame of the interface
 *      is laid out and rasterised before FFmpeg is invoked. That is the same
 *      rule the notification treatment already holds — no authored string
 *      reaches the compositor — applied to the whole product interface.
 *   2. **The output is one scene of a longer cut**, so the plate is
 *      cover-framed to the delivery frame and fills it. There is deliberately
 *      no `pad`, no letterbox and no backplate anywhere in this module: a
 *      landscape card floating inside a portrait frame is exactly the defect
 *      this compositor replaces, and the grammar here cannot express it.
 */

export class StoryCompositeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryCompositeError';
  }
}

/**
 * Oversample before `zoompan`, for the reason `screen-composite.ts` gives:
 * `zoompan` samples on an integer grid, so a move across a frame-sized input
 * steps rather than glides. The factor is the one the motion-treatment
 * catalogue already uses, so a plate does not move differently depending on
 * which module drew it.
 */
const PLATE_OVERSAMPLE = 1.5;

/** Black rim on the alpha field, in canvas pixels. Two is too few after cubic resampling. */
const MASK_RIM_PX = 3;

/**
 * How far a moving source may be extended by cloning its last frame.
 *
 * A scene's window is its beat plus a transition handle at each end, and those
 * add up to the required duration with no slack. The trimmed sources arrive at
 * the provider's 24 fps, so a duration like 1.733s quantises to 41 frames —
 * 1.708s, twenty-five milliseconds short — and the segment selector then
 * refuses a scene whose picture is fine because its tail handle does not exist.
 *
 * Extending by cloning the final frame is what an edit suite does for exactly
 * this, and the cloned frames land inside a transition handle that the cut
 * blends through rather than sits on. The bound is small on purpose: this
 * closes a quantisation gap, and anything needing half a second of freeze is a
 * scene without enough footage, which is a different problem and should be
 * refused as one.
 */
const CLONE_PAD_SECONDS = 0.5;

/**
 * The filters this module is allowed to emit, checked against what it
 * compiled.
 *
 * The same discipline `post-motion.ts` holds, for the same reason: a future
 * edit reaching for `pad`, `fillborders`, `rotate` or `noise` should fail a
 * test rather than ship a black band, a warped edge or a shake into an
 * advertisement.
 */
export const STORY_COMPOSITE_ALLOWED_FILTERS: readonly string[] = [
  'fps',
  'scale',
  'crop',
  'zoompan',
  'setsar',
  'trim',
  'setpts',
  'settb',
  'format',
  'perspective',
  'split',
  'drawbox',
  'alphamerge',
  'overlay',
  'loop',
  'tpad',
  'curves',
  'eq',
  'colorchannelmixer',
];

const FILTER_NAME = /(?:^|[;,[\]])\s*([a-z][a-z0-9_]*)\s*=/g;

export function assertOnlyAllowedFilters(graph: string, label: string): void {
  const seen = new Set<string>();
  for (const match of graph.matchAll(FILTER_NAME)) {
    const name = match[1];
    if (name) seen.add(name);
  }
  const forbidden = [...seen].filter(
    (name) => !STORY_COMPOSITE_ALLOWED_FILTERS.includes(name) && !/^[xy][0-3]$/.test(name),
  );
  if (forbidden.length > 0) {
    throw new StoryCompositeError(
      `${label} compiled a graph using filter(s) outside the allow-list: ${forbidden.sort().join(', ')}`,
    );
  }
}

/**
 * A scene-wide exposure grade.
 *
 * `curves` with its endpoints pinned at `0/0` and `1/1` is the only shape this
 * accepts, and that is the whole point: true black stays true black and a
 * highlight stays where it was, while the midtones a face, a glove or a phone
 * edge live in are lifted. A `brightness` offset would raise the black floor —
 * the "grey blacks" the correction explicitly refuses — and a bare `gamma`
 * cannot be bounded at the top.
 */
export interface StoryExposureGrade {
  /** Control points strictly inside the unit square, ascending in x. */
  readonly midtonePoints: readonly { readonly x: number; readonly y: number }[];
  /** 1 leaves saturation alone. Bounded, because a grade is not a look change. */
  readonly saturation: number;
}

export function compileStoryExposureGrade(grade: StoryExposureGrade, label: string): string {
  if (grade.midtonePoints.length === 0) {
    throw new StoryCompositeError(`${label}: a grade needs at least one midtone control point`);
  }
  if (grade.saturation < 0.6 || grade.saturation > 1.4) {
    throw new StoryCompositeError(
      `${label}: saturation ${num(grade.saturation)} is outside the 0.6–1.4 band a grade may use`,
    );
  }
  let previousX = 0;
  for (const point of grade.midtonePoints) {
    if (point.x <= 0 || point.x >= 1 || point.y <= 0 || point.y >= 1) {
      throw new StoryCompositeError(
        `${label}: control point ${num(point.x)}/${num(point.y)} is not strictly inside the unit square; ` +
          'the endpoints are pinned so black stays black and white stays white',
      );
    }
    if (point.x <= previousX) {
      throw new StoryCompositeError(`${label}: control points must ascend in x`);
    }
    if (point.y < point.x) {
      throw new StoryCompositeError(
        `${label}: control point ${num(point.x)}/${num(point.y)} pulls the midtones *down*; ` +
          'this grade exists to lift them, and darkening is not what it is for',
      );
    }
    previousX = point.x;
  }
  const points = ['0/0', ...grade.midtonePoints.map((p) => `${num(p.x)}/${num(p.y)}`), '1/1'].join(
    ' ',
  );
  const steps = [`curves=all='${points}'`];
  if (grade.saturation !== 1) steps.push(`eq=saturation=${num(grade.saturation)}`);
  return steps.join(',');
}

export interface UiSceneCompositeSpec {
  readonly sceneId: string;
  /** FFmpeg input index of the still plate. */
  readonly plateInputIndex: number;
  /** FFmpeg input index of the rasterised interface frame sequence. */
  readonly uiInputIndex: number;
  readonly outputWidthPx: number;
  readonly outputHeightPx: number;
  /** The interface canvas — the calibrated screen at device resolution. */
  readonly uiCanvasWidthPx: number;
  readonly uiCanvasHeightPx: number;
  readonly frameRate: number;
  readonly durationSeconds: number;
  readonly quad: NormalisedQuad;
  readonly move: CameraMove;
  /** Applied to the plate before the interface is laid on it, never after. */
  readonly plateGrade?: StoryExposureGrade;
}

/**
 * A pan that `zoompan` would clamp is refused rather than rendered.
 *
 * Carried over from `screen-composite.ts` verbatim in intent: the framing
 * clamps at the plate edge and the corner arithmetic does not, so the
 * interface would drift off the handset in a way that reads as a calibration
 * fault rather than a framing one.
 */
function assertPanWindowInsidePlate(spec: UiSceneCompositeSpec): void {
  const minimumZoom = Math.min(spec.move.startZoom, spec.move.endZoom);
  if (minimumZoom < 1) {
    throw new StoryCompositeError(
      `scene "${spec.sceneId}" asks for zoom ${num(minimumZoom)}; below 1 the cover-framed plate no ` +
        'longer fills the frame and a border would be exposed',
    );
  }
  const halfWindow = 1 / (2 * minimumZoom);
  for (const [axis, centre] of [
    ['horizontally', spec.move.panCentreU],
    ['vertically', spec.move.panCentreV],
  ] as const) {
    if (centre - halfWindow < -1e-9 || centre + halfWindow > 1 + 1e-9) {
      const required = 1 / (2 * Math.min(centre, 1 - centre));
      throw new StoryCompositeError(
        `scene "${spec.sceneId}" pans ${axis} to ${num(centre)} at zoom ${num(minimumZoom)}, which reaches ` +
          `past the plate. Raise the zoom to at least ${num(required)} or reduce the offset.`,
      );
    }
  }
}

export interface CompiledUiScene {
  readonly graph: string;
  readonly outputLabel: string;
  readonly plateZoomExpression: string;
}

/**
 * One product-interface scene: the operator's authoritative plate, full-frame
 * and moving, with the mobile-native document warped onto the handset's
 * calibrated screen.
 */
export function compileUiSceneComposite(spec: UiSceneCompositeSpec): CompiledUiScene {
  if (spec.durationSeconds <= 0) {
    throw new StoryCompositeError(`scene "${spec.sceneId}" has a non-positive duration`);
  }
  // `perspective` maps the whole input rectangle onto the destination quad and
  // the composite crops the delivery frame out of the result, so a canvas
  // smaller than the frame in either axis would be cropped into nothing.
  if (spec.uiCanvasWidthPx < spec.outputWidthPx || spec.uiCanvasHeightPx < spec.outputHeightPx) {
    throw new StoryCompositeError(
      `scene "${spec.sceneId}": the interface canvas is ${num(spec.uiCanvasWidthPx)}×${num(spec.uiCanvasHeightPx)}, ` +
        `smaller than the ${num(spec.outputWidthPx)}×${num(spec.outputHeightPx)} delivery frame in at least one axis, ` +
        'so the warp would be cropped',
    );
  }
  assertPanWindowInsidePlate(spec);

  const tag = spec.sceneId.replace(/[^A-Za-z0-9]/g, '');
  const width = spec.outputWidthPx;
  const height = spec.outputHeightPx;
  const oversampledWidth = evenPx(width * PLATE_OVERSAMPLE);
  const oversampledHeight = evenPx(height * PLATE_OVERSAMPLE);
  const zoom = zoomExpression(spec.move);
  const grade = spec.plateGrade
    ? `,${compileStoryExposureGrade(spec.plateGrade, spec.sceneId)}`
    : '';

  // Cover-frame, then the move. `force_original_aspect_ratio=increase` with a
  // centred crop is what makes this full-frame with no band on any edge, and
  // it is why there is no `pad` in this chain.
  const plate = [
    `[${spec.plateInputIndex}:v]fps=${num(spec.frameRate)}`,
    `scale=${num(oversampledWidth)}:${num(oversampledHeight)}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${num(oversampledWidth)}:${num(oversampledHeight)}`,
    `zoompan=z='${zoom}':x='iw*${num(spec.move.panCentreU)}-(iw/zoom/2)':y='ih*${num(spec.move.panCentreV)}-(ih/zoom/2)':d=1:s=${num(width)}x${num(height)}:fps=${num(spec.frameRate)}`,
    'setsar=1',
    `trim=duration=${num(spec.durationSeconds)}`,
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    `format=gbrp${grade}[${tag}plate]`,
  ].join(',');

  const corners = perspectiveCornerExpressions(spec.quad, spec.move, width, height);
  const warp = [
    `perspective=x0='${corners.x0}':y0='${corners.y0}':x1='${corners.x1}':y1='${corners.y1}'`,
    `x2='${corners.x2}':y2='${corners.y2}':x3='${corners.x3}':y3='${corners.y3}'`,
    'sense=destination:eval=frame',
  ].join(':');

  // The interface sequence is already one image per output frame, so it is
  // re-timed rather than trimmed: `fps` here only stamps the timebase.
  const uiSegment = [
    `[${spec.uiInputIndex}:v]fps=${num(spec.frameRate)}`,
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    `format=gbrp,split=2[${tag}uiA][${tag}uiB]`,
  ].join(',');

  const warped = `[${tag}uiA]${warp}:interpolation=cubic,crop=${num(width)}:${num(height)}:0:0[${tag}uiw]`;

  // Fill white, rim black, warp with the *same* expressions. Everything the
  // picture warp clamps to outside the quad resolves to alpha 0, so the
  // interface is cut to the screen with no seam. The alpha warp is
  // deliberately not cubic: cubic overshoots at a hard edge and rings the
  // screen with partial transparency.
  const mask = [
    `[${tag}uiB]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill`,
    `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=${num(MASK_RIM_PX)}`,
    warp,
    `crop=${num(width)}:${num(height)}:0:0`,
    `format=gray[${tag}mask]`,
  ].join(',');

  const merge = `[${tag}uiw][${tag}mask]alphamerge[${tag}uirgba]`;
  const composite =
    `[${tag}plate][${tag}uirgba]overlay=x=0:y=0:format=auto:eof_action=pass,` +
    `setsar=1,format=yuv420p[${tag}out]`;

  const graph = [plate, uiSegment, warped, mask, merge, composite].join(';');
  assertOnlyAllowedFilters(graph, `scene "${spec.sceneId}"`);
  return { graph, outputLabel: `${tag}out`, plateZoomExpression: zoom };
}

export interface PlateMotionSpec {
  readonly sceneId: string;
  readonly plateInputIndex: number;
  readonly outputWidthPx: number;
  readonly outputHeightPx: number;
  readonly frameRate: number;
  readonly durationSeconds: number;
  readonly move: CameraMove;
  readonly plateGrade?: StoryExposureGrade;
}

/**
 * The plate itself, full-frame, moving deterministically, with nothing mapped
 * onto it.
 *
 * Scene 1 is what this exists for. The notification hook's authoritative plate
 * already shows a person looking at their phone; the generated take that was
 * bought for it lifted their gaze to the lens and pushed roughly 1.75× when the
 * brief asked for a few percent, and a named reviewer rejected it. The action
 * the beat needs comes from the notification arriving over the top, so the
 * picture underneath only has to move a little and stay honest.
 */
export function compilePlateMotion(spec: PlateMotionSpec): CompiledUiScene {
  if (spec.durationSeconds <= 0) {
    throw new StoryCompositeError(`scene "${spec.sceneId}" has a non-positive duration`);
  }
  assertPanWindowInsidePlate({
    ...spec,
    uiInputIndex: -1,
    uiCanvasWidthPx: spec.outputWidthPx,
    uiCanvasHeightPx: spec.outputHeightPx,
    quad: {
      topLeft: { u: 0, v: 0 },
      topRight: { u: 1, v: 0 },
      bottomLeft: { u: 0, v: 1 },
      bottomRight: { u: 1, v: 1 },
    },
  });

  const tag = spec.sceneId.replace(/[^A-Za-z0-9]/g, '');
  const width = spec.outputWidthPx;
  const height = spec.outputHeightPx;
  const oversampledWidth = evenPx(width * PLATE_OVERSAMPLE);
  const oversampledHeight = evenPx(height * PLATE_OVERSAMPLE);
  const zoom = zoomExpression(spec.move);
  const grade = spec.plateGrade
    ? `,${compileStoryExposureGrade(spec.plateGrade, spec.sceneId)}`
    : '';

  const graph = [
    `[${spec.plateInputIndex}:v]fps=${num(spec.frameRate)}`,
    `scale=${num(oversampledWidth)}:${num(oversampledHeight)}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${num(oversampledWidth)}:${num(oversampledHeight)}`,
    `zoompan=z='${zoom}':x='iw*${num(spec.move.panCentreU)}-(iw/zoom/2)':y='ih*${num(spec.move.panCentreV)}-(ih/zoom/2)':d=1:s=${num(width)}x${num(height)}:fps=${num(spec.frameRate)}`,
    'setsar=1',
    `trim=duration=${num(spec.durationSeconds)}`,
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    `format=gbrp${grade}`,
    `format=yuv420p[${tag}out]`,
  ].join(',');

  assertOnlyAllowedFilters(graph, `scene "${spec.sceneId}"`);
  return { graph, outputLabel: `${tag}out`, plateZoomExpression: zoom };
}

export interface CompanionCompositeSpec {
  readonly sceneId: string;
  /** The plate that backs the frame. */
  readonly plateInputIndex: number;
  /** The moving clip that carries the scene's action. */
  readonly clipInputIndex: number;
  readonly outputWidthPx: number;
  readonly outputHeightPx: number;
  readonly frameRate: number;
  readonly durationSeconds: number;
  /** Where the moving clip sits. It is the dominant element, not an inset. */
  readonly clipRect: {
    readonly xPx: number;
    readonly yPx: number;
    readonly widthPx: number;
    readonly heightPx: number;
  };
  readonly plateGrade?: StoryExposureGrade;
  readonly clipGrade?: StoryExposureGrade;
}

/**
 * A moving clip carried as the dominant action inside a frame the plate backs.
 *
 * Scene 2 is what this exists for: the acquired combat footage is the action,
 * the scene's own authoritative plate supplies the frame around it, and the
 * sport strips arrive over both as one composition. Compositing them into a
 * single picture is the point — five separately-animated slides is the
 * slideshow reading the correction removes.
 */
export function compileCompanionComposite(spec: CompanionCompositeSpec): CompiledUiScene {
  if (spec.durationSeconds <= 0) {
    throw new StoryCompositeError(`scene "${spec.sceneId}" has a non-positive duration`);
  }
  const { clipRect } = spec;
  if (
    clipRect.xPx < 0 ||
    clipRect.yPx < 0 ||
    clipRect.xPx + clipRect.widthPx > spec.outputWidthPx ||
    clipRect.yPx + clipRect.heightPx > spec.outputHeightPx
  ) {
    throw new StoryCompositeError(
      `scene "${spec.sceneId}": the moving clip's rectangle reaches past the delivery frame`,
    );
  }
  if (clipRect.widthPx * clipRect.heightPx < 0.35 * spec.outputWidthPx * spec.outputHeightPx) {
    throw new StoryCompositeError(
      `scene "${spec.sceneId}": the moving clip covers less than a third of the frame, so it is not ` +
        'the dominant action the scene is built around',
    );
  }

  const tag = spec.sceneId.replace(/[^A-Za-z0-9]/g, '');
  const width = spec.outputWidthPx;
  const height = spec.outputHeightPx;
  const plateGrade = spec.plateGrade
    ? `,${compileStoryExposureGrade(spec.plateGrade, spec.sceneId)}`
    : '';
  const clipGrade = spec.clipGrade
    ? `,${compileStoryExposureGrade(spec.clipGrade, spec.sceneId)}`
    : '';

  const plate = [
    `[${spec.plateInputIndex}:v]fps=${num(spec.frameRate)}`,
    `scale=${num(width)}:${num(height)}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${num(width)}:${num(height)}`,
    'setsar=1',
    `trim=duration=${num(spec.durationSeconds)}`,
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    `format=gbrp${plateGrade}[${tag}plate]`,
  ].join(',');

  const clip = [
    `[${spec.clipInputIndex}:v]fps=${num(spec.frameRate)}`,
    `scale=${num(evenPx(clipRect.widthPx))}:${num(evenPx(clipRect.heightPx))}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${num(evenPx(clipRect.widthPx))}:${num(evenPx(clipRect.heightPx))}`,
    'setsar=1',
    `tpad=stop_mode=clone:stop_duration=${num(CLONE_PAD_SECONDS)}`,
    `trim=duration=${num(spec.durationSeconds)}`,
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    `format=gbrp${clipGrade}[${tag}clip]`,
  ].join(',');

  const composite =
    `[${tag}plate][${tag}clip]overlay=x=${num(clipRect.xPx)}:y=${num(clipRect.yPx)}:format=auto:eof_action=pass,` +
    `setsar=1,format=yuv420p[${tag}out]`;

  const graph = [plate, clip, composite].join(';');
  assertOnlyAllowedFilters(graph, `scene "${spec.sceneId}"`);
  return { graph, outputLabel: `${tag}out`, plateZoomExpression: '1' };
}

export interface SheetOverlaySpec {
  readonly sceneId: string;
  /** FFmpeg input index of the base clip. */
  readonly baseInputIndex: number;
  /** FFmpeg input index of the rasterised RGBA sheet sequence, or null for a grade-only pass. */
  readonly sheetInputIndex: number | null;
  readonly outputWidthPx: number;
  readonly outputHeightPx: number;
  readonly frameRate: number;
  readonly durationSeconds: number;
  readonly grade?: StoryExposureGrade;
}

/**
 * A screen-space treatment laid over an existing moving scene.
 *
 * The sheet is a full-frame RGBA sequence produced by a real layout engine, so
 * a result panel, a confirmation, a comparison table or a feathered sweep is a
 * *design*, composited whole. Nothing here draws a rectangle: the correction
 * this replaces put an opaque red bar and a hard red outline on screen because
 * `drawbox` is the only mark a filter graph can make, and both read as debug
 * geometry rather than as art direction.
 *
 * The grade runs on the base **before** the sheet lands, so lifting a fighter
 * out of the shadows never touches the typography sitting over them.
 */
export function compileSheetOverlay(spec: SheetOverlaySpec): CompiledUiScene {
  if (spec.durationSeconds <= 0) {
    throw new StoryCompositeError(`scene "${spec.sceneId}" has a non-positive duration`);
  }
  if (spec.sheetInputIndex === null && !spec.grade) {
    throw new StoryCompositeError(
      `scene "${spec.sceneId}" asks for neither a sheet nor a grade, so the pass would do nothing`,
    );
  }
  const tag = spec.sceneId.replace(/[^A-Za-z0-9]/g, '');
  const width = spec.outputWidthPx;
  const height = spec.outputHeightPx;
  const grade = spec.grade ? `,${compileStoryExposureGrade(spec.grade, spec.sceneId)}` : '';

  const base = [
    `[${spec.baseInputIndex}:v]fps=${num(spec.frameRate)}`,
    `scale=${num(width)}:${num(height)}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${num(width)}:${num(height)}`,
    'setsar=1',
    `tpad=stop_mode=clone:stop_duration=${num(CLONE_PAD_SECONDS)}`,
    `trim=duration=${num(spec.durationSeconds)}`,
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    `format=gbrp${grade}[${tag}base]`,
  ].join(',');

  if (spec.sheetInputIndex === null) {
    const only = `[${tag}base]format=yuv420p[${tag}out]`;
    const graph = [base, only].join(';');
    assertOnlyAllowedFilters(graph, `scene "${spec.sceneId}"`);
    return { graph, outputLabel: `${tag}out`, plateZoomExpression: '1' };
  }

  const sheet = [
    `[${spec.sheetInputIndex}:v]fps=${num(spec.frameRate)}`,
    `scale=${num(width)}:${num(height)}:flags=lanczos`,
    'setsar=1',
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    `format=rgba[${tag}sheet]`,
  ].join(',');

  const composite =
    `[${tag}base][${tag}sheet]overlay=x=0:y=0:format=auto:eof_action=pass,` +
    `setsar=1,format=yuv420p[${tag}out]`;

  const graph = [base, sheet, composite].join(';');
  assertOnlyAllowedFilters(graph, `scene "${spec.sceneId}"`);
  return { graph, outputLabel: `${tag}out`, plateZoomExpression: '1' };
}
