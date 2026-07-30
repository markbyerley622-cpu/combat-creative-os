import { describe, expect, it } from 'vitest';

import {
  assertMappableQuad,
  measureQuadGeometry,
  normaliseQuadForCover,
  perspectiveCornerExpressions,
  quadAtZoom,
  ScreenQuadError,
  zoomExpression,
  type CameraMove,
  type ScreenQuad,
} from './screen-quad';

const rectangle = (x: number, y: number, w: number, h: number): ScreenQuad => ({
  topLeft: { xPx: x, yPx: y },
  topRight: { xPx: x + w, yPx: y },
  bottomLeft: { xPx: x, yPx: y + h },
  bottomRight: { xPx: x + w, yPx: y + h },
});

describe('measureQuadGeometry', () => {
  it('measures a plain rectangle', () => {
    const geometry = measureQuadGeometry(rectangle(100, 200, 300, 800));
    expect(geometry.topWidthPx).toBe(300);
    expect(geometry.bottomWidthPx).toBe(300);
    expect(geometry.leftHeightPx).toBe(800);
    expect(geometry.areaPx).toBe(240_000);
    expect(geometry.aspectRatio).toBeCloseTo(800 / 300, 6);
    expect(geometry.convex).toBe(true);
    expect(geometry.minInteriorAngleDeg).toBeCloseTo(90, 6);
  });

  it('detects a bow-tie produced by swapping the bottom corners', () => {
    const quad = rectangle(0, 0, 300, 800);
    const swapped: ScreenQuad = {
      ...quad,
      bottomLeft: quad.bottomRight,
      bottomRight: quad.bottomLeft,
    };
    expect(measureQuadGeometry(swapped).convex).toBe(false);
  });
});

describe('assertMappableQuad', () => {
  it('accepts a plausible handset screen', () => {
    expect(() => assertMappableQuad(rectangle(0, 0, 360, 1000), 'screen')).not.toThrow();
  });

  it('refuses a non-convex quad rather than mapping it', () => {
    const quad = rectangle(0, 0, 360, 1000);
    const swapped: ScreenQuad = {
      ...quad,
      bottomLeft: quad.bottomRight,
      bottomRight: quad.bottomLeft,
    };
    expect(() => assertMappableQuad(swapped, 'screen')).toThrow(ScreenQuadError);
    expect(() => assertMappableQuad(swapped, 'screen')).toThrow(/convex/);
  });

  it('refuses a screen too small to carry type', () => {
    expect(() => assertMappableQuad(rectangle(0, 0, 40, 120), 'screen')).toThrow(/area/);
  });

  it('refuses an aspect ratio outside the handset range', () => {
    expect(() => assertMappableQuad(rectangle(0, 0, 400, 420), 'screen')).toThrow(/aspect ratio/);
    expect(() => assertMappableQuad(rectangle(0, 0, 200, 900), 'screen')).toThrow(/aspect ratio/);
  });

  it('refuses opposite edges that disagree, which is how a mis-read corner shows up', () => {
    const skewed: ScreenQuad = {
      topLeft: { xPx: 0, yPx: 0 },
      topRight: { xPx: 400, yPx: 0 },
      bottomLeft: { xPx: 90, yPx: 1000 },
      bottomRight: { xPx: 310, yPx: 1000 },
    };
    expect(() => assertMappableQuad(skewed, 'screen')).toThrow(/opposite edges/);
  });

  it('names the screen it refused', () => {
    expect(() => assertMappableQuad(rectangle(0, 0, 40, 120), 'plate-4-handset')).toThrow(
      /plate-4-handset/,
    );
  });
});

describe('normaliseQuadForCover', () => {
  it('accounts for the band a cover crop removes', () => {
    // Source is wider than the delivery aspect, so cover crops left and right.
    const normalised = normaliseQuadForCover(rectangle(0, 0, 100, 100), {
      sourceWidthPx: 200,
      sourceHeightPx: 100,
      outputWidthPx: 100,
      outputHeightPx: 100,
    });
    // scale = max(100/200, 100/100) = 1; cropX = (200-100)/2 = 50.
    expect(normalised.topLeft.u).toBeCloseTo(-0.5, 6);
    expect(normalised.topRight.u).toBeCloseTo(0.5, 6);
    expect(normalised.topLeft.v).toBeCloseTo(0, 6);
    expect(normalised.bottomLeft.v).toBeCloseTo(1, 6);
  });

  it('maps a centred quad to the centre whatever the source aspect', () => {
    const normalised = normaliseQuadForCover(rectangle(400, 700, 100, 200), {
      sourceWidthPx: 900,
      sourceHeightPx: 1600,
      outputWidthPx: 1080,
      outputHeightPx: 1920,
    });
    const centreU = (normalised.topLeft.u + normalised.topRight.u) / 2;
    expect(centreU).toBeCloseTo(450 / 900, 6);
  });
});

describe('camera transform', () => {
  const move: CameraMove = {
    startZoom: 1,
    endZoom: 1.2,
    panCentreU: 0.5,
    panCentreV: 0.5,
    frames: 101,
  };

  it('drives progress from the output frame index so the move lands on its end point', () => {
    expect(zoomExpression(move)).toBe('1+0.2*on/100');
  });

  it('collapses to a constant for a locked-off shot', () => {
    expect(zoomExpression({ ...move, endZoom: 1 })).toBe('1');
  });

  it('interpolates the delivery size as a literal, never the filter W/H', () => {
    const quad = normaliseQuadForCover(rectangle(0, 0, 360, 1000), {
      sourceWidthPx: 1080,
      sourceHeightPx: 1920,
      outputWidthPx: 1080,
      outputHeightPx: 1920,
    });
    const corners = perspectiveCornerExpressions(quad, move, 1080, 1920);
    expect(corners.x0).toContain('1080*');
    expect(corners.y0).toContain('1920*');
    expect(corners.x0).not.toMatch(/\bW\b/);
    expect(corners.y0).not.toMatch(/\bH\b/);
  });

  it('agrees with the closed-form projection used by the reports', () => {
    const quad = normaliseQuadForCover(rectangle(340, 460, 400, 1000), {
      sourceWidthPx: 1080,
      sourceHeightPx: 1920,
      outputWidthPx: 1080,
      outputHeightPx: 1920,
    });
    const atOne = quadAtZoom(quad, move, 1, 1080, 1920);
    // At zoom 1 with a centred pan the quad is exactly where it was measured.
    expect(atOne.topLeft.xPx).toBeCloseTo(340, 4);
    expect(atOne.topLeft.yPx).toBeCloseTo(460, 4);
    expect(atOne.bottomRight.xPx).toBeCloseTo(740, 4);

    // A zoom about the frame centre pushes a point away from that centre.
    const atZoom = quadAtZoom(quad, move, 1.2, 1080, 1920);
    expect(atZoom.topLeft.xPx).toBeCloseTo(540 + 1.2 * (340 - 540), 4);
    expect(atZoom.topLeft.yPx).toBeCloseTo(960 + 1.2 * (460 - 960), 4);
  });
});
