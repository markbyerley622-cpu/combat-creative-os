import { evenPx, num } from '../render/filter-primitives';
import {
  perspectiveCornerExpressions,
  zoomExpression,
  type CameraMove,
  type NormalisedQuad,
} from './screen-quad';

/**
 * One shot: a photographed plate that moves, with the interface warped onto
 * the handset afterwards.
 *
 * The ordering is the point. Compositing first and moving the result would
 * scale the interface by the camera move's own zoom factor, which softens type
 * — and softened type in a product demonstration reads as a screenshot someone
 * enlarged, not as a screen. So the plate is moved first and the interface is
 * warped once, at delivery resolution, onto the corners the move has already
 * carried the screen to.
 *
 * The mask deserves a note. `perspective` transforms the whole frame; outside
 * the destination quad it samples past the source edge and clamps, which
 * smears the border pixels across everything. Warping a second, identical
 * transform over a white field with a black rim produces exactly the region
 * the first warp filled, so `alphamerge` cuts the interface to the screen with
 * no seam. Both warps must stay byte-identical in their expressions; they are
 * built from one call for that reason.
 */

export class ScreenCompositeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenCompositeError';
  }
}

/**
 * `zoompan` samples on an integer grid, so a move across a frame-sized input
 * steps rather than glides. Oversampling first puts those steps below a
 * delivery pixel. 1.5 is the factor the motion-treatment catalogue already
 * uses, kept the same here so a plate does not move differently depending on
 * which module drew it.
 */
const PLATE_OVERSAMPLE = 1.5;

/** Black rim on the alpha field, in canvas pixels. Two is too few after cubic resampling. */
const MASK_RIM_PX = 3;

export interface ShotCompositeSpec {
  readonly shotId: string;
  /** FFmpeg input index of the still plate. */
  readonly plateInputIndex: number;
  /** FFmpeg input index of the pre-rendered interface layer. */
  readonly uiInputIndex: number;
  readonly outputWidthPx: number;
  readonly outputHeightPx: number;
  /** The interface canvas, which is taller than the delivery frame. */
  readonly uiCanvasWidthPx: number;
  readonly uiCanvasHeightPx: number;
  readonly frameRate: number;
  readonly durationSeconds: number;
  /** Where this shot begins in the continuous interface timeline. */
  readonly uiStartSeconds: number;
  readonly quad: NormalisedQuad;
  readonly move: CameraMove;
}

/**
 * A pan is only expressible if the window it asks for still lands on the
 * plate.
 *
 * `zoompan` silently clamps a window that runs off the edge, and a silent
 * clamp here is the worst kind of failure this module can have: the plate
 * would be framed one way while the corner expressions — which cannot be
 * clamped, because they are arithmetic — place the screen somewhere else. The
 * interface would slide off the handset, gradually, in a way that looks like a
 * calibration error rather than a framing one. So the condition is checked and
 * refused, with the zoom that would make the requested pan legal.
 */
function assertPanWindowInsidePlate(spec: ShotCompositeSpec): void {
  const minimumZoom = Math.min(spec.move.startZoom, spec.move.endZoom);
  const halfWindow = 1 / (2 * minimumZoom);
  const checks: readonly (readonly [string, number])[] = [
    ['horizontally', spec.move.panCentreU],
    ['vertically', spec.move.panCentreV],
  ];
  for (const [axis, centre] of checks) {
    if (centre - halfWindow < -1e-9 || centre + halfWindow > 1 + 1e-9) {
      const required = 1 / (2 * Math.min(centre, 1 - centre));
      throw new ScreenCompositeError(
        `shot "${spec.shotId}" pans ${axis} to ${num(centre)} at zoom ${num(minimumZoom)}, which reaches past the ` +
          `plate. zoompan would clamp the framing while the screen corners would not, sliding the interface off the ` +
          `handset. Raise the zoom to at least ${num(required)} or reduce the offset.`,
      );
    }
  }
}

export interface CompiledShot {
  readonly graph: string;
  readonly outputLabel: string;
  readonly plateZoomExpression: string;
}

export function compileShotComposite(spec: ShotCompositeSpec): CompiledShot {
  if (spec.durationSeconds <= 0) {
    throw new ScreenCompositeError(`shot "${spec.shotId}" has a non-positive duration`);
  }
  if (spec.uiCanvasHeightPx < spec.outputHeightPx) {
    throw new ScreenCompositeError(
      `shot "${spec.shotId}": the interface canvas (${num(spec.uiCanvasHeightPx)}px) is shorter than ` +
        `the delivery frame (${num(spec.outputHeightPx)}px), so the warp would be cropped`,
    );
  }

  assertPanWindowInsidePlate(spec);

  const tag = spec.shotId.replace(/[^A-Za-z0-9]/g, '');
  const width = spec.outputWidthPx;
  const height = spec.outputHeightPx;
  const oversampledWidth = evenPx(width * PLATE_OVERSAMPLE);
  const oversampledHeight = evenPx(height * PLATE_OVERSAMPLE);
  const zoom = zoomExpression(spec.move);

  // The plate: cover-frame, then the move. `zoompan`'s window is placed about
  // the pan centre, which is the same centre the corner expressions subtract —
  // one formula, read twice.
  const plate = [
    `[${spec.plateInputIndex}:v]fps=${num(spec.frameRate)}`,
    `scale=${num(oversampledWidth)}:${num(oversampledHeight)}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${num(oversampledWidth)}:${num(oversampledHeight)}`,
    `zoompan=z='${zoom}':x='iw*${num(spec.move.panCentreU)}-(iw/zoom/2)':y='ih*${num(spec.move.panCentreV)}-(ih/zoom/2)':d=1:s=${num(width)}x${num(height)}:fps=${num(spec.frameRate)}`,
    'setsar=1',
    `trim=duration=${num(spec.durationSeconds)}`,
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    `format=gbrp[${tag}plate]`,
  ].join(',');

  const corners = perspectiveCornerExpressions(spec.quad, spec.move, width, height);
  const warp = [
    `perspective=x0='${corners.x0}':y0='${corners.y0}':x1='${corners.x1}':y1='${corners.y1}'`,
    `x2='${corners.x2}':y2='${corners.y2}':x3='${corners.x3}':y3='${corners.y3}'`,
    'sense=destination:eval=frame',
  ].join(':');

  const uiSegment = [
    `[${spec.uiInputIndex}:v]fps=${num(spec.frameRate)}`,
    `trim=start=${num(spec.uiStartSeconds)}:duration=${num(spec.durationSeconds)}`,
    'setpts=PTS-STARTPTS',
    'settb=AVTB',
    `format=gbrp,split=2[${tag}uiA][${tag}uiB]`,
  ].join(',');

  const warped = `[${tag}uiA]${warp}:interpolation=cubic,crop=${num(width)}:${num(height)}:0:0[${tag}uiw]`;

  // Fill white, then rim black. Cheaper than `geq` by an order of magnitude at
  // this frame size, and exact: the rim is what the warp clamps to outside the
  // quad, so everything beyond the screen resolves to alpha 0.
  //
  // The alpha warp is deliberately *not* cubic. Cubic interpolation overshoots
  // at a hard edge, which on an alpha field means a halo of partial
  // transparency ringing the screen — the picture warp wants the smoother
  // resample, the cut-out wants the harder one. Everything before
  // `sense=` is identical between the two.
  const mask = [
    `[${tag}uiB]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill`,
    `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=${num(MASK_RIM_PX)}`,
    `${warp}`,
    `crop=${num(width)}:${num(height)}:0:0`,
    `format=gray[${tag}mask]`,
  ].join(',');

  const merge = `[${tag}uiw][${tag}mask]alphamerge[${tag}uirgba]`;
  const composite =
    `[${tag}plate][${tag}uirgba]overlay=x=0:y=0:format=auto:eof_action=pass,` +
    `setsar=1,format=yuv420p[${tag}out]`;

  return {
    graph: [plate, uiSegment, warped, mask, merge, composite].join(';'),
    outputLabel: `${tag}out`,
    plateZoomExpression: zoom,
  };
}

/**
 * Shots are compiled and encoded one at a time, then joined by the concat
 * demuxer with the streams copied.
 *
 * Compiling all of them into a single `filter_complex` is the obvious thing to
 * do and it does not work: every shot's plate is a looped still, so FFmpeg
 * generates frames for shots two and three while the concat is still asking
 * for shot one, and the buffered frames grow without bound. Measured here at
 * a gigabyte and a half of resident memory for a five-second cut, at about a
 * tenth of the CPU actually doing useful work.
 *
 * Encoding each shot separately also means a cut is a genuine cut — there is
 * no `xfade` anywhere in this module, because the choreography that replaces
 * dissolves (matching the handset's screen position across the cut, landing
 * the cut on the tap) depends on the boundary frame being untouched.
 */
export function concatDemuxerList(shotPaths: readonly string[]): string {
  if (shotPaths.length === 0) {
    throw new ScreenCompositeError('a sequence needs at least one shot');
  }
  // Single quotes are the demuxer's own escaping; a path containing one would
  // break the list, so it is refused rather than mangled.
  for (const path of shotPaths) {
    if (path.includes("'")) {
      throw new ScreenCompositeError(
        `shot path ${path} contains a quote the concat list cannot carry`,
      );
    }
  }
  return `${shotPaths.map((path) => `file '${path.replace(/\\/g, '/')}'`).join('\n')}\n`;
}
