import { describe, expect, it } from 'vitest';

import {
  buildScreenSamplePlan,
  ScreenCalibrationError,
  verifyScreenCalibration,
  type SampledLuma,
} from './screen-calibration';
import type { ScreenQuad } from './screen-quad';

const quad: ScreenQuad = {
  topLeft: { xPx: 500, yPx: 360 },
  topRight: { xPx: 858, yPx: 338 },
  bottomLeft: { xPx: 481, yPx: 1362 },
  bottomRight: { xPx: 838, yPx: 1381 },
};

function samplesAt(interiorLuma: number[], outsideLuma = 40): SampledLuma[] {
  const plan = buildScreenSamplePlan(quad);
  let index = 0;
  return plan.map((point) => ({
    label: point.label,
    zone: point.zone,
    xPx: point.xPx,
    yPx: point.yPx,
    luma:
      point.zone === 'INTERIOR' ? (interiorLuma[index++ % interiorLuma.length] ?? 0) : outsideLuma,
  }));
}

describe('buildScreenSamplePlan', () => {
  it('samples a grid inside the quad plus one point beyond each edge', () => {
    const plan = buildScreenSamplePlan(quad);
    expect(plan.filter((p) => p.zone === 'INTERIOR')).toHaveLength(25);
    expect(plan.filter((p) => p.zone === 'OUTSIDE')).toHaveLength(4);
  });

  it('insets the interior so the rounded corners are not measured as screen', () => {
    const plan = buildScreenSamplePlan(quad);
    const interior = plan.filter((p) => p.zone === 'INTERIOR');
    for (const point of interior) {
      expect(point.xPx).toBeGreaterThan(Math.min(quad.topLeft.xPx, quad.bottomLeft.xPx));
      expect(point.yPx).toBeGreaterThan(Math.min(quad.topLeft.yPx, quad.topRight.yPx));
    }
  });

  it('puts the rim samples outside the quad on every edge', () => {
    const plan = buildScreenSamplePlan(quad);
    const top = plan.find((p) => p.label === 'outside-top');
    const bottom = plan.find((p) => p.label === 'outside-bottom');
    expect(top?.yPx).toBeLessThan(Math.min(quad.topLeft.yPx, quad.topRight.yPx));
    expect(bottom?.yPx).toBeGreaterThan(Math.max(quad.bottomLeft.yPx, quad.bottomRight.yPx));
  });
});

describe('verifyScreenCalibration', () => {
  const base = {
    screenLabel: 'plate-4-handset',
    quad,
    plateWidthPx: 941,
    plateHeightPx: 1672,
  };

  it('accepts a dark, uniform, blank screen', () => {
    const report = verifyScreenCalibration({ ...base, samples: samplesAt([14, 16, 18, 15, 17]) });
    expect(report.verdict).toBe('MAPPABLE');
    expect(report.interiorMeanLuma).toBeCloseTo(16, 0);
    expect(report.interiorSampleCount).toBe(25);
    expect(report.notice).toMatch(/not evidence that the placement is creatively correct/);
  });

  it('refuses a region that is not dark — the quad is off the screen', () => {
    expect(() => verifyScreenCalibration({ ...base, samples: samplesAt([180, 190, 175]) })).toThrow(
      ScreenCalibrationError,
    );
    expect(() => verifyScreenCalibration({ ...base, samples: samplesAt([180, 190, 175]) })).toThrow(
      /not a blank screen/,
    );
  });

  it('refuses a region that already carries an image', () => {
    // Mean stays low, but the spread gives away that there is content there.
    expect(() =>
      verifyScreenCalibration({ ...base, samples: samplesAt([0, 90, 0, 95, 0, 88]) }),
    ).toThrow(/already carries an image/);
  });

  it('refuses a quad whose corner falls outside the plate', () => {
    const offPlate: ScreenQuad = { ...quad, topRight: { xPx: 1200, yPx: 338 } };
    expect(() =>
      verifyScreenCalibration({
        ...base,
        quad: offPlate,
        samples: samplesAt([14, 16, 18]).map((s) => ({ ...s })),
      }),
    ).toThrow(ScreenCalibrationError);
  });

  it('refuses an unmappable quad before it looks at any pixel', () => {
    const tiny: ScreenQuad = {
      topLeft: { xPx: 0, yPx: 0 },
      topRight: { xPx: 40, yPx: 0 },
      bottomLeft: { xPx: 0, yPx: 120 },
      bottomRight: { xPx: 40, yPx: 120 },
    };
    expect(() => verifyScreenCalibration({ ...base, quad: tiny, samples: [] })).toThrow(
      /cannot be mapped reliably/,
    );
  });

  it('names every failure rather than only the first', () => {
    // Geometrically fine — the same screen slid off the left of the plate — so
    // the pixel and containment checks all get a chance to report.
    const offPlate: ScreenQuad = {
      topLeft: { xPx: -20, yPx: 360 },
      topRight: { xPx: 338, yPx: 338 },
      bottomLeft: { xPx: -39, yPx: 1362 },
      bottomRight: { xPx: 318, yPx: 1381 },
    };
    try {
      verifyScreenCalibration({ ...base, quad: offPlate, samples: samplesAt([200, 210]) });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenCalibrationError);
      const failures = (error as ScreenCalibrationError).failures;
      expect(failures.length).toBeGreaterThan(1);
    }
  });

  it('reports rim contrast without gating on it', () => {
    // Bezel and screen are both near-black, as they are on a real dark plate.
    const report = verifyScreenCalibration({ ...base, samples: samplesAt([12, 14], 13) });
    expect(report.rimContrast).toBeLessThan(5);
    expect(report.verdict).toBe('MAPPABLE');
  });
});
