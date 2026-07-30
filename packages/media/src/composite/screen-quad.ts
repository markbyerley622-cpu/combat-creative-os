import { z } from 'zod';

import { num } from '../render/filter-primitives';

/**
 * The calibrated phone-screen quadrilateral, and the camera transform that
 * carries it into output space.
 *
 * Compositing an interface onto a photographed handset is a mapping problem
 * with one hard constraint: **the type must not warp**. That rules out the
 * obvious approach of laying a screenshot over the plate and scaling both
 * together, which softens every glyph by the camera move's own zoom factor.
 * Instead the plate moves first, the four screen corners are carried through
 * the *same* move analytically, and the interface is warped once, at delivery
 * resolution, onto where the screen actually is on that frame.
 *
 * The analytic step is what makes this safe. A push-in expressed as `zoompan`
 * is a similarity transform, so a plate point at normalised `(qx, qy)` lands at
 * `W*(0.5 + Z*(qx-cx))`, `H*(0.5 + Z*(qy-cy))` for zoom `Z` about pan centre
 * `(cx, cy)`. The corner expressions and the plate's own move are therefore two
 * readings of one formula rather than two implementations that agree until the
 * first fix. If they ever disagreed the interface would slide off the handset,
 * which is the single most visible failure this module can produce.
 */

export class ScreenQuadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenQuadError';
  }
}

const PointSchema = z
  .object({
    xPx: z.number().finite(),
    yPx: z.number().finite(),
  })
  .strict();

/**
 * Corner order is fixed and named rather than positional. A quad supplied
 * with its bottom pair swapped is still a valid four-sided figure, so the
 * geometry checks cannot catch it — but the composite comes out mirrored, and
 * naming the corners is what stops that being expressible in the first place.
 */
export const ScreenQuadSchema = z
  .object({
    topLeft: PointSchema,
    topRight: PointSchema,
    bottomLeft: PointSchema,
    bottomRight: PointSchema,
  })
  .strict();
export type ScreenQuad = z.infer<typeof ScreenQuadSchema>;
export type QuadPoint = z.infer<typeof PointSchema>;

export interface QuadGeometry {
  readonly topWidthPx: number;
  readonly bottomWidthPx: number;
  readonly leftHeightPx: number;
  readonly rightHeightPx: number;
  readonly areaPx: number;
  /** Mean height over mean width. A portrait handset screen is well above 1. */
  readonly aspectRatio: number;
  readonly convex: boolean;
  /** Smallest interior angle, in degrees. A near-degenerate corner sits near 0. */
  readonly minInteriorAngleDeg: number;
}

const distance = (a: QuadPoint, b: QuadPoint): number => Math.hypot(b.xPx - a.xPx, b.yPx - a.yPx);

type QuadRing = readonly [QuadPoint, QuadPoint, QuadPoint, QuadPoint];

/** Winding order for the shoelace/convexity walk: a closed ring, not the named struct. */
function ring(quad: ScreenQuad): QuadRing {
  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
}

/**
 * The ring's consecutive triples, materialised rather than indexed modulo the
 * length. Under `noUncheckedIndexedAccess` a computed index is `T | undefined`,
 * and a geometry routine littered with non-null assertions is one where a real
 * off-by-one would look exactly like the noise.
 */
function triples(points: QuadRing): readonly (readonly [QuadPoint, QuadPoint, QuadPoint])[] {
  const [p0, p1, p2, p3] = points;
  return [
    [p3, p0, p1],
    [p0, p1, p2],
    [p1, p2, p3],
    [p2, p3, p0],
  ];
}

function cross(a: QuadPoint, b: QuadPoint, c: QuadPoint): number {
  return (b.xPx - a.xPx) * (c.yPx - b.yPx) - (b.yPx - a.yPx) * (c.xPx - b.xPx);
}

function interiorAngleDeg(previous: QuadPoint, current: QuadPoint, next: QuadPoint): number {
  const ax = previous.xPx - current.xPx;
  const ay = previous.yPx - current.yPx;
  const bx = next.xPx - current.xPx;
  const by = next.yPx - current.yPx;
  const magnitude = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (magnitude === 0) return 0;
  const cosine = Math.min(1, Math.max(-1, (ax * bx + ay * by) / magnitude));
  return (Math.acos(cosine) * 180) / Math.PI;
}

export function measureQuadGeometry(quad: ScreenQuad): QuadGeometry {
  const points = ring(quad);
  const [p0, p1, p2, p3] = points;
  const edges: readonly (readonly [QuadPoint, QuadPoint])[] = [
    [p0, p1],
    [p1, p2],
    [p2, p3],
    [p3, p0],
  ];
  const twiceArea = edges.reduce((total, [a, b]) => total + (a.xPx * b.yPx - b.xPx * a.yPx), 0);

  const walked = triples(points);
  const crosses = walked.map(([a, b, c]) => cross(a, b, c));
  const positive = crosses.filter((value) => value > 0).length;
  const negative = crosses.filter((value) => value < 0).length;

  const topWidthPx = distance(quad.topLeft, quad.topRight);
  const bottomWidthPx = distance(quad.bottomLeft, quad.bottomRight);
  const leftHeightPx = distance(quad.topLeft, quad.bottomLeft);
  const rightHeightPx = distance(quad.topRight, quad.bottomRight);

  return {
    topWidthPx,
    bottomWidthPx,
    leftHeightPx,
    rightHeightPx,
    areaPx: Math.abs(twiceArea) / 2,
    aspectRatio: (leftHeightPx + rightHeightPx) / (topWidthPx + bottomWidthPx),
    convex: positive === crosses.length || negative === crosses.length,
    minInteriorAngleDeg: Math.min(
      ...walked.map(([previous, current, next]) => interiorAngleDeg(previous, current, next)),
    ),
  };
}

export interface QuadMappabilityLimits {
  /** Below this the warp is sampling so few pixels that type cannot survive it. */
  readonly minAreaPx: number;
  readonly minAspectRatio: number;
  readonly maxAspectRatio: number;
  /** A corner sharper than this is a near-degenerate quad the homography smears. */
  readonly minInteriorAngleDeg: number;
  /** Opposite edges this different in length are a mis-ordered or mis-read quad. */
  readonly maxOppositeEdgeRatio: number;
}

export const DEFAULT_QUAD_LIMITS: QuadMappabilityLimits = {
  minAreaPx: 40_000,
  minAspectRatio: 1.4,
  maxAspectRatio: 3.6,
  minInteriorAngleDeg: 55,
  maxOppositeEdgeRatio: 1.45,
};

/**
 * Refuses a screen that cannot be mapped reliably, naming which property
 * failed.
 *
 * This is deliberately a refusal and never a repair. The tempting fallback —
 * drop the perspective and lay the screenshot over the whole frame — produces
 * a file that passes every technical gate while showing an interface that is
 * not on the handset, and a reviewer scrubbing a 5-second cut will not
 * necessarily catch it. A named failure costs an operator a minute; a silent
 * substitution costs the proof its meaning.
 */
export function assertMappableQuad(
  quad: ScreenQuad,
  label: string,
  limits: QuadMappabilityLimits = DEFAULT_QUAD_LIMITS,
): QuadGeometry {
  const geometry = measureQuadGeometry(quad);
  const failures: string[] = [];

  if (!geometry.convex) {
    failures.push('the four corners do not form a convex quadrilateral');
  }
  if (geometry.areaPx < limits.minAreaPx) {
    failures.push(
      `screen area is ${num(geometry.areaPx)}px², below the ${num(limits.minAreaPx)}px² floor`,
    );
  }
  if (geometry.aspectRatio < limits.minAspectRatio) {
    failures.push(
      `aspect ratio ${num(geometry.aspectRatio)} is below the ${num(limits.minAspectRatio)} floor`,
    );
  }
  if (geometry.aspectRatio > limits.maxAspectRatio) {
    failures.push(
      `aspect ratio ${num(geometry.aspectRatio)} is above the ${num(limits.maxAspectRatio)} ceiling`,
    );
  }
  if (geometry.minInteriorAngleDeg < limits.minInteriorAngleDeg) {
    failures.push(
      `sharpest corner is ${num(geometry.minInteriorAngleDeg)}°, below the ${num(limits.minInteriorAngleDeg)}° floor`,
    );
  }

  const widthRatio =
    Math.max(geometry.topWidthPx, geometry.bottomWidthPx) /
    Math.max(1e-6, Math.min(geometry.topWidthPx, geometry.bottomWidthPx));
  const heightRatio =
    Math.max(geometry.leftHeightPx, geometry.rightHeightPx) /
    Math.max(1e-6, Math.min(geometry.leftHeightPx, geometry.rightHeightPx));
  if (widthRatio > limits.maxOppositeEdgeRatio || heightRatio > limits.maxOppositeEdgeRatio) {
    failures.push(
      `opposite edges differ by ${num(Math.max(widthRatio, heightRatio))}×, above the ${num(limits.maxOppositeEdgeRatio)}× ceiling`,
    );
  }

  if (failures.length > 0) {
    throw new ScreenQuadError(
      `screen "${label}" cannot be mapped reliably:\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    );
  }
  return geometry;
}

/** Normalised plate coordinates: the quad expressed as fractions of the cover-framed plate. */
export interface NormalisedQuad {
  readonly topLeft: { readonly u: number; readonly v: number };
  readonly topRight: { readonly u: number; readonly v: number };
  readonly bottomLeft: { readonly u: number; readonly v: number };
  readonly bottomRight: { readonly u: number; readonly v: number };
}

export interface CoverFraming {
  readonly sourceWidthPx: number;
  readonly sourceHeightPx: number;
  readonly outputWidthPx: number;
  readonly outputHeightPx: number;
}

/**
 * Carries a quad measured on the original plate into the cover-framed space
 * the camera move operates in.
 *
 * `COVER` scales the plate until it fills the output and crops the overflow
 * centrally, so a plate whose aspect differs from the delivery aspect loses a
 * band off one pair of edges. Ignoring that band is a sub-pixel error on these
 * plates and a visible one on the next set, which is why it is computed rather
 * than assumed away.
 */
export function normaliseQuadForCover(quad: ScreenQuad, framing: CoverFraming): NormalisedQuad {
  const scale = Math.max(
    framing.outputWidthPx / framing.sourceWidthPx,
    framing.outputHeightPx / framing.sourceHeightPx,
  );
  const scaledWidth = framing.sourceWidthPx * scale;
  const scaledHeight = framing.sourceHeightPx * scale;
  const cropX = (scaledWidth - framing.outputWidthPx) / 2;
  const cropY = (scaledHeight - framing.outputHeightPx) / 2;

  const project = (point: QuadPoint): { u: number; v: number } => ({
    u: (point.xPx * scale - cropX) / framing.outputWidthPx,
    v: (point.yPx * scale - cropY) / framing.outputHeightPx,
  });

  return {
    topLeft: project(quad.topLeft),
    topRight: project(quad.topRight),
    bottomLeft: project(quad.bottomLeft),
    bottomRight: project(quad.bottomRight),
  };
}

export interface CameraMove {
  /** Zoom at the first frame of the shot; 1 is the cover-framed plate. */
  readonly startZoom: number;
  /** Zoom at the last frame. Equal to `startZoom` for a locked-off shot. */
  readonly endZoom: number;
  /** The plate point held at frame centre, in normalised cover-framed coordinates. */
  readonly panCentreU: number;
  readonly panCentreV: number;
  readonly frames: number;
}

/**
 * The zoom expression, shared by the plate's `zoompan` and the quad's corner
 * expressions so the two can never drift apart.
 *
 * Progress is driven by `on` — the output frame index — rather than by
 * accumulating onto the previous zoom, for the reason the motion-treatment
 * catalogue already found: accumulation lands near the intended end point
 * instead of on it, and "near" over a three-shot sequence is a handset that
 * jumps at every cut.
 */
export function zoomExpression(move: CameraMove): string {
  const lastFrame = Math.max(1, move.frames - 1);
  if (move.startZoom === move.endZoom) return num(move.startZoom);
  const delta = move.endZoom - move.startZoom;
  return `${num(move.startZoom)}+${num(delta)}*on/${num(lastFrame)}`;
}

export interface PerspectiveCornerExpressions {
  readonly x0: string;
  readonly y0: string;
  readonly x1: string;
  readonly y1: string;
  readonly x2: string;
  readonly y2: string;
  readonly x3: string;
  readonly y3: string;
}

/**
 * The four corners as FFmpeg expressions in output space, evaluated per frame.
 *
 * `perspective`'s expression vocabulary has no `t`, only frame counters, which
 * is why the whole module is written against `on` rather than seconds. The
 * corner order — top-left, top-right, bottom-left, bottom-right — is the
 * filter's own, and is the one place the named struct becomes positional.
 *
 * The delivery size is interpolated as a literal rather than taken from the
 * filter's own `W`/`H`. Those constants are the *input* frame's dimensions,
 * and the interface canvas this warp runs on is deliberately taller than the
 * delivery frame — so `H` would silently be the wrong number and every screen
 * would sit too low by a third of the frame.
 */
export function perspectiveCornerExpressions(
  quad: NormalisedQuad,
  move: CameraMove,
  outputWidthPx: number,
  outputHeightPx: number,
): PerspectiveCornerExpressions {
  const zoom = `(${zoomExpression(move)})`;
  const x = (u: number): string =>
    `${num(outputWidthPx)}*(0.5+${zoom}*(${num(u - move.panCentreU)}))`;
  const y = (v: number): string =>
    `${num(outputHeightPx)}*(0.5+${zoom}*(${num(v - move.panCentreV)}))`;
  return {
    x0: x(quad.topLeft.u),
    y0: y(quad.topLeft.v),
    x1: x(quad.topRight.u),
    y1: y(quad.topRight.v),
    x2: x(quad.bottomLeft.u),
    y2: y(quad.bottomLeft.v),
    x3: x(quad.bottomRight.u),
    y3: y(quad.bottomRight.v),
  };
}

/** The quad's position in output pixels at one instant — used by the reports and the gallery. */
export function quadAtZoom(
  quad: NormalisedQuad,
  move: CameraMove,
  zoom: number,
  outputWidthPx: number,
  outputHeightPx: number,
): ScreenQuad {
  const project = (corner: { u: number; v: number }): QuadPoint => ({
    xPx: outputWidthPx * (0.5 + zoom * (corner.u - move.panCentreU)),
    yPx: outputHeightPx * (0.5 + zoom * (corner.v - move.panCentreV)),
  });
  return {
    topLeft: project(quad.topLeft),
    topRight: project(quad.topRight),
    bottomLeft: project(quad.bottomLeft),
    bottomRight: project(quad.bottomRight),
  };
}
