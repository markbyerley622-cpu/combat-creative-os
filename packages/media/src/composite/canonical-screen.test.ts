import { describe, expect, it } from 'vitest';

import {
  assertLayoutFitsViewport,
  assertMobileViewport,
  CANONICAL_DEVICE_SCALE_FACTOR,
  CANONICAL_MOBILE_CSS_WIDTH_PX,
  CANONICAL_SCREEN_ASPECT,
  canonicalDocumentAspect,
  canonicalMobileViewport,
  CanonicalScreenError,
  devicePixelRect,
  measureMappingUniformity,
  MOBILE_BREAKPOINT_CEILING_CSS_PX,
  type ViewportBoundsMeasurement,
} from './canonical-screen';
import type { ScreenQuad } from './screen-quad';

const heroQuad: ScreenQuad = {
  topLeft: { xPx: 500, yPx: 360 },
  topRight: { xPx: 858, yPx: 338 },
  bottomLeft: { xPx: 481, yPx: 1362 },
  bottomRight: { xPx: 838, yPx: 1381 },
};

/** The tap plate: the same handset, tilted, so its quad measures much shorter. */
const tapQuad: ScreenQuad = {
  topLeft: { xPx: 512, yPx: 500 },
  topRight: { xPx: 822, yPx: 452 },
  bottomLeft: { xPx: 428, yPx: 1206 },
  bottomRight: { xPx: 738, yPx: 1240 },
};

const measurement = (
  overrides: Partial<ViewportBoundsMeasurement> = {},
): ViewportBoundsMeasurement => ({
  documentId: 'events',
  cssWidthPx: 393,
  cssHeightPx: 1122,
  scrollWidthPx: 393,
  clientWidthPx: 393,
  documentHeightCssPx: 1836,
  overflowingElements: [],
  bottomNavigationVisible: true,
  desktopNavigationPresent: false,
  ...overrides,
});

describe('the canonical CSS viewport', () => {
  it('is mobile-sized in CSS pixels', () => {
    const viewport = canonicalMobileViewport();
    expect(viewport.cssWidthPx).toBe(393);
    expect(viewport.cssWidthPx).toBeLessThanOrEqual(MOBILE_BREAKPOINT_CEILING_CSS_PX);
    expect(viewport.isMobile).toBe(true);
    expect(viewport.hasTouch).toBe(true);
    expect(viewport.orientation).toBe('portrait');
    expect(viewport.fullPage).toBe(false);
    expect(viewport.userAgent).toMatch(/iPhone|Mobile/);
  });

  it('refuses a device-pixel figure mistaken for a CSS width — the original defect', () => {
    expect(() =>
      assertMobileViewport({
        cssWidthPx: 1080,
        cssHeightPx: 1920,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
        orientation: 'portrait',
        fullPage: false,
        userAgent: 'x',
      }),
    ).toThrow(CanonicalScreenError);
    expect(() =>
      assertMobileViewport({
        cssWidthPx: 1080,
        cssHeightPx: 1920,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
        orientation: 'portrait',
        fullPage: false,
        userAgent: 'x',
      }),
    ).toThrow(/tablet or desktop breakpoint/);
  });

  it('keeps the CSS width fixed however tall the handset screen is', () => {
    for (const aspect of [2.0, CANONICAL_SCREEN_ASPECT, 2.86, 3.2]) {
      expect(canonicalMobileViewport(aspect).cssWidthPx).toBe(CANONICAL_MOBILE_CSS_WIDTH_PX);
    }
  });
});

describe('device pixels are separate from the CSS viewport', () => {
  it('multiplies without changing the CSS viewport', () => {
    const viewport = canonicalMobileViewport();
    const device = devicePixelRect(viewport);
    expect(device.widthPx).toBe(viewport.cssWidthPx * CANONICAL_DEVICE_SCALE_FACTOR);
    expect(viewport.cssWidthPx).toBe(393);
  });

  it('leaves the layout aspect untouched whatever the scale factor', () => {
    const viewport = canonicalMobileViewport();
    const aspect = canonicalDocumentAspect(viewport);
    for (const factor of [2, 4]) {
      const scaled = { ...viewport, deviceScaleFactor: factor };
      expect(canonicalDocumentAspect(scaled)).toBe(aspect);
    }
  });

  it('refuses an odd device dimension rather than nudging the CSS viewport', () => {
    // 393 × 3 = 1179, which h264 with yuv420p cannot encode.
    expect(() => devicePixelRect({ ...canonicalMobileViewport(), deviceScaleFactor: 3 })).toThrow(
      /cannot encode an odd dimension/,
    );
  });
});

describe('the document aspect is not taken from the photograph', () => {
  it('is derived from the viewport alone', () => {
    const viewport = canonicalMobileViewport(2.8559);
    expect(canonicalDocumentAspect(viewport)).toBeCloseTo(1122 / 393, 6);
  });

  it('cannot be given a quad — the conflation is not expressible', () => {
    // The signature takes a scalar, and anything quad-shaped is refused at
    // runtime as well as by the type system.
    expect(() =>
      (canonicalMobileViewport as unknown as (value: unknown) => unknown)(heroQuad),
    ).toThrow(/positive number/);
  });

  it('leaves two differently-projected quads sharing one source layout', () => {
    const viewport = canonicalMobileViewport(2.8559);
    const hero = measureMappingUniformity(viewport, heroQuad);
    const tap = measureMappingUniformity(viewport, tapQuad);
    // The two quads project very differently...
    expect(hero.projectedAspect).toBeCloseTo(2.8559, 3);
    expect(tap.projectedAspect).toBeCloseTo(2.4034, 3);
    // ...while the document they are both fed is one and the same.
    expect(hero.documentAspect).toBe(tap.documentAspect);
  });

  it('reports the implied stretch rather than correcting the layout for it', () => {
    const viewport = canonicalMobileViewport(2.8559);
    expect(measureMappingUniformity(viewport, heroQuad).uniform).toBe(true);
    expect(measureMappingUniformity(viewport, tapQuad).uniform).toBe(false);
    expect(measureMappingUniformity(viewport, tapQuad).impliedVerticalStretch).toBeLessThan(1);
  });
});

describe('assertLayoutFitsViewport', () => {
  it('accepts a document that fits', () => {
    expect(() => assertLayoutFitsViewport(measurement())).not.toThrow();
  });

  it('refuses horizontal overflow — the clipped-heading defect', () => {
    expect(() => assertLayoutFitsViewport(measurement({ scrollWidthPx: 520 }))).toThrow(
      /runs outside the phone width/,
    );
  });

  it('refuses an element whose box leaves the viewport', () => {
    expect(() =>
      assertLayoutFitsViewport(
        measurement({ overflowingElements: [{ selector: 'h1.title', leftPx: 12, rightPx: 640 }] }),
      ),
    ).toThrow(/outside the viewport/);
  });

  it('refuses a missing bottom navigation', () => {
    expect(() => assertLayoutFitsViewport(measurement({ bottomNavigationVisible: false }))).toThrow(
      /not a phone layout/,
    );
  });

  it('refuses a wide-breakpoint navigation', () => {
    expect(() => assertLayoutFitsViewport(measurement({ desktopNavigationPresent: true }))).toThrow(
      /wide breakpoint/,
    );
  });

  it('refuses a document too short to cover the screen — no padding is available', () => {
    expect(() => assertLayoutFitsViewport(measurement({ documentHeightCssPx: 800 }))).toThrow(
      /would not be fully covered/,
    );
  });
});
