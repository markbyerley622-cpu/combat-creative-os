import { num } from '../render/filter-primitives';
import {
  assertMappableQuad,
  ScreenQuadError,
  type QuadGeometry,
  type QuadMappabilityLimits,
  type QuadPoint,
  type ScreenQuad,
} from './screen-quad';

/**
 * Proving that a declared screen quad is really a screen.
 *
 * The corner coordinates are an operator declaration, and a declaration is not
 * evidence — the same position that lands on the glass of one plate lands on a
 * fighter's shoulder in the next. So the quad is checked against the plate's
 * own pixels before anything is composited: the region it names has to be
 * dark, and it has to be *uniform*. Those two together are what distinguishes
 * an unlit handset screen from the background, from the phone's body, and from
 * a screen that already has an interface on it — and compositing onto the last
 * of those would double-expose two interfaces over each other.
 *
 * The verification is a pure function over sampled luma so it can be tested
 * without a plate, an FFmpeg build or a filesystem. Taking the samples is I/O
 * and lives with the caller.
 */

export class ScreenCalibrationError extends Error {
  constructor(
    public readonly screenLabel: string,
    public readonly failures: readonly string[],
  ) {
    super(
      `screen "${screenLabel}" failed calibration and cannot be composited:\n${failures
        .map((failure) => `  - ${failure}`)
        .join('\n')}`,
    );
    this.name = 'ScreenCalibrationError';
  }
}

export const SAMPLE_ZONES = ['INTERIOR', 'OUTSIDE'] as const;
export type SampleZone = (typeof SAMPLE_ZONES)[number];

export interface ScreenSamplePoint {
  readonly label: string;
  readonly zone: SampleZone;
  readonly xPx: number;
  readonly yPx: number;
}

/** Bilinear position inside the quad; `(0,0)` is the top-left corner. */
function interpolate(quad: ScreenQuad, u: number, v: number): QuadPoint {
  const topX = quad.topLeft.xPx + (quad.topRight.xPx - quad.topLeft.xPx) * u;
  const topY = quad.topLeft.yPx + (quad.topRight.yPx - quad.topLeft.yPx) * u;
  const bottomX = quad.bottomLeft.xPx + (quad.bottomRight.xPx - quad.bottomLeft.xPx) * u;
  const bottomY = quad.bottomLeft.yPx + (quad.bottomRight.yPx - quad.bottomLeft.yPx) * u;
  return { xPx: topX + (bottomX - topX) * v, yPx: topY + (bottomY - topY) * v };
}

export interface SamplePlanOptions {
  /** Grid resolution across the interior. 5 gives 25 interior samples. */
  readonly gridSteps: number;
  /**
   * Fraction of the quad inset before interior sampling begins. The rounded
   * corners of a real handset mean the mathematical corner sits on the bezel,
   * so sampling right to the edge measures the phone rather than the screen.
   */
  readonly interiorInset: number;
  /** How far outside each edge the rim samples sit, as a fraction of the quad. */
  readonly outsideOffset: number;
}

export const DEFAULT_SAMPLE_PLAN: SamplePlanOptions = {
  gridSteps: 5,
  interiorInset: 0.08,
  outsideOffset: 0.06,
};

export function buildScreenSamplePlan(
  quad: ScreenQuad,
  options: SamplePlanOptions = DEFAULT_SAMPLE_PLAN,
): readonly ScreenSamplePoint[] {
  const points: ScreenSamplePoint[] = [];
  const lo = options.interiorInset;
  const hi = 1 - options.interiorInset;

  for (let row = 0; row < options.gridSteps; row += 1) {
    for (let column = 0; column < options.gridSteps; column += 1) {
      const u = lo + ((hi - lo) * column) / Math.max(1, options.gridSteps - 1);
      const v = lo + ((hi - lo) * row) / Math.max(1, options.gridSteps - 1);
      const point = interpolate(quad, u, v);
      points.push({
        label: `interior-${row}-${column}`,
        zone: 'INTERIOR',
        xPx: point.xPx,
        yPx: point.yPx,
      });
    }
  }

  // Rim samples sit just beyond each edge midpoint. They are measured and
  // reported rather than gated: on a black-glass handset photographed against a
  // black set the bezel and the screen genuinely are close in luma, and a
  // contrast floor there would refuse the very plates this module exists for.
  const offset = options.outsideOffset;
  const rim: readonly (readonly [string, number, number])[] = [
    ['outside-top', 0.5, -offset],
    ['outside-bottom', 0.5, 1 + offset],
    ['outside-left', -offset, 0.5],
    ['outside-right', 1 + offset, 0.5],
  ];
  for (const [label, u, v] of rim) {
    const point = interpolate(quad, u, v);
    points.push({ label, zone: 'OUTSIDE', xPx: point.xPx, yPx: point.yPx });
  }

  return points;
}

export interface SampledLuma {
  readonly label: string;
  readonly zone: SampleZone;
  readonly xPx: number;
  readonly yPx: number;
  /** 0–255. */
  readonly luma: number;
}

export interface ScreenCalibrationLimits {
  /** Mean interior luma above this is a lit screen, not a blank one. */
  readonly maxInteriorMeanLuma: number;
  /** Interior spread above this means the region already carries an image. */
  readonly maxInteriorStdDev: number;
  /** Every corner must sit this far inside the plate. */
  readonly minCornerMarginPx: number;
}

export const DEFAULT_CALIBRATION_LIMITS: ScreenCalibrationLimits = {
  maxInteriorMeanLuma: 72,
  maxInteriorStdDev: 26,
  minCornerMarginPx: -2,
};

export interface ScreenCalibrationReport {
  readonly screenLabel: string;
  readonly geometry: QuadGeometry;
  readonly interiorMeanLuma: number;
  readonly interiorStdDev: number;
  readonly interiorMinLuma: number;
  readonly interiorMaxLuma: number;
  readonly outsideMeanLuma: number;
  /** Interior against rim. Reported for the record; never a gate. See the plan above. */
  readonly rimContrast: number;
  readonly interiorSampleCount: number;
  readonly verdict: 'MAPPABLE';
  readonly notice: string;
}

const CALIBRATION_NOTICE =
  'This verifies that the declared region is a blank, dark, uniform screen and that the ' +
  'quadrilateral is geometrically mappable. It is not evidence that the placement is ' +
  'creatively correct — a person must still look at the composited frames.';

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function stdDevOf(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = meanOf(values);
  const variance = meanOf(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

/**
 * The gate. Every failure names the measurement and the limit it crossed,
 * because a refusal an operator cannot argue with is one they work around.
 */
export function verifyScreenCalibration(options: {
  readonly screenLabel: string;
  readonly quad: ScreenQuad;
  readonly plateWidthPx: number;
  readonly plateHeightPx: number;
  readonly samples: readonly SampledLuma[];
  readonly limits?: ScreenCalibrationLimits;
  readonly quadLimits?: QuadMappabilityLimits;
}): ScreenCalibrationReport {
  const limits = options.limits ?? DEFAULT_CALIBRATION_LIMITS;
  const failures: string[] = [];

  let geometry: QuadGeometry;
  try {
    geometry = assertMappableQuad(options.quad, options.screenLabel, options.quadLimits);
  } catch (error) {
    if (error instanceof ScreenQuadError) {
      throw new ScreenCalibrationError(options.screenLabel, [error.message]);
    }
    throw error;
  }

  const corners: readonly (readonly [string, QuadPoint])[] = [
    ['topLeft', options.quad.topLeft],
    ['topRight', options.quad.topRight],
    ['bottomLeft', options.quad.bottomLeft],
    ['bottomRight', options.quad.bottomRight],
  ];
  for (const [name, corner] of corners) {
    const margin = Math.min(
      corner.xPx,
      corner.yPx,
      options.plateWidthPx - corner.xPx,
      options.plateHeightPx - corner.yPx,
    );
    if (margin < limits.minCornerMarginPx) {
      failures.push(
        `corner ${name} sits ${num(margin)}px from the plate edge, outside the ${num(limits.minCornerMarginPx)}px margin`,
      );
    }
  }

  const interior = options.samples.filter((sample) => sample.zone === 'INTERIOR');
  const outside = options.samples.filter((sample) => sample.zone === 'OUTSIDE');
  if (interior.length < 9) {
    failures.push(`only ${interior.length} interior samples were taken; at least 9 are required`);
  }

  const interiorValues = interior.map((sample) => sample.luma);
  const interiorMeanLuma = meanOf(interiorValues);
  const interiorStdDev = stdDevOf(interiorValues);
  const outsideMeanLuma = meanOf(outside.map((sample) => sample.luma));

  if (interiorMeanLuma > limits.maxInteriorMeanLuma) {
    failures.push(
      `mean interior luma is ${num(interiorMeanLuma)}, above the ${num(limits.maxInteriorMeanLuma)} ceiling — the region is not a blank screen`,
    );
  }
  if (interiorStdDev > limits.maxInteriorStdDev) {
    failures.push(
      `interior luma spread is ${num(interiorStdDev)}, above the ${num(limits.maxInteriorStdDev)} ceiling — the region already carries an image`,
    );
  }

  if (failures.length > 0) {
    throw new ScreenCalibrationError(options.screenLabel, failures);
  }

  return {
    screenLabel: options.screenLabel,
    geometry,
    interiorMeanLuma,
    interiorStdDev,
    interiorMinLuma: interiorValues.length === 0 ? 0 : Math.min(...interiorValues),
    interiorMaxLuma: interiorValues.length === 0 ? 0 : Math.max(...interiorValues),
    outsideMeanLuma,
    rimContrast: Math.abs(outsideMeanLuma - interiorMeanLuma),
    interiorSampleCount: interior.length,
    verdict: 'MAPPABLE',
    notice: CALIBRATION_NOTICE,
  };
}
