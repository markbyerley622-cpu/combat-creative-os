import { num } from '../render/filter-primitives';
import { measureQuadGeometry, type ScreenQuad } from './screen-quad';

/**
 * The canonical mobile screen: one coordinate system for every product
 * document, defined before any photograph is consulted.
 *
 * This module exists because of a specific defect. The first proof sized its
 * interface canvas from the *photographed* handset — a quadrilateral measuring
 * about 2.86:1 — and then made real captures fit it by scaling them up and
 * cropping horizontally. The result clipped headings and cards at the right
 * edge, left black bands where content ran out, and read as a desktop
 * dashboard squeezed into a phone.
 *
 * Three coordinate systems were being conflated, and they are kept apart here:
 *
 * 1. **CSS viewport** — what the application lays out against. Its *width*
 *    decides which breakpoint renders, and nothing else does. A layout is
 *    mobile because it was laid out at a mobile width, full stop.
 * 2. **Device pixels** — the CSS viewport times the device scale factor. This
 *    is a rendering fidelity choice and has no effect on layout whatsoever.
 * 3. **The projected quadrilateral** — where the screen appears in a
 *    photograph. This is the *output* of a camera, and it may never be an
 *    input to how the interface is laid out.
 *
 * `canonicalMobileViewport` cannot see a quad: it takes no such parameter, so
 * the conflation is not expressible rather than merely discouraged.
 */

export class CanonicalScreenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalScreenError';
  }
}

/**
 * Widest CSS viewport that still renders a phone layout.
 *
 * Tailwind's `sm` breakpoint — the first one that starts laying out for a
 * larger device — is 640px, and every common framework puts its first
 * non-phone breakpoint at or above 600px. 480 leaves headroom under all of
 * them while still admitting the widest phones in portrait.
 */
export const MOBILE_BREAKPOINT_CEILING_CSS_PX = 480;

/** The reference handset this project designs against: iPhone 14/15 Pro class. */
export const CANONICAL_MOBILE_CSS_WIDTH_PX = 393;
export const CANONICAL_MOBILE_CSS_HEIGHT_PX = 852;
/**
 * Four, not three, and the reason is the encoder rather than the eye.
 *
 * h264 with `yuv420p` cannot encode an odd width, and 393 CSS pixels at a
 * scale factor of 3 is 1179 — odd. The alternatives were all worse: changing
 * the CSS width would move the breakpoint the whole correction is built on,
 * and padding to an even width would put a fabricated column inside the
 * screen. A higher scale factor is a pure fidelity change that cannot affect
 * layout at all, because layout has already happened in CSS pixels by the time
 * it applies.
 */
export const CANONICAL_DEVICE_SCALE_FACTOR = 4;

/** 852 / 393. The proportion a real handset screen has. */
export const CANONICAL_SCREEN_ASPECT =
  CANONICAL_MOBILE_CSS_HEIGHT_PX / CANONICAL_MOBILE_CSS_WIDTH_PX;

export interface CanonicalMobileViewport {
  readonly cssWidthPx: number;
  readonly cssHeightPx: number;
  readonly deviceScaleFactor: number;
  readonly isMobile: true;
  readonly hasTouch: true;
  readonly orientation: 'portrait';
  /** Screenshots are of the viewport, never of the whole scrollable document. */
  readonly fullPage: false;
  readonly userAgent: string;
}

/** A real handset user agent, so a server that branches on it serves the phone build. */
export const CANONICAL_MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/**
 * The canonical viewport.
 *
 * `screenAspect` adjusts only the **height**. The width — the thing that
 * decides the breakpoint, the type scale, the safe areas and the bottom
 * navigation geometry — is fixed at the canonical value for every document, on
 * every plate, always.
 *
 * Allowing the height to follow the handset is not the defect this module
 * guards against; it is what a taller phone genuinely does. A device with more
 * vertical room runs the same mobile layout and simply shows more of it, and
 * matching it is what lets the whole rectangle map onto the screen without
 * stretching, cropping or padding — all three of which are forbidden. The
 * canonical reference height is reported alongside it so any deviation is
 * visible rather than assumed.
 */
export function canonicalMobileViewport(
  screenAspect: number = CANONICAL_SCREEN_ASPECT,
): CanonicalMobileViewport {
  if (!Number.isFinite(screenAspect) || screenAspect <= 0) {
    throw new CanonicalScreenError(`screen aspect must be a positive number, got ${screenAspect}`);
  }
  const viewport: CanonicalMobileViewport = {
    cssWidthPx: CANONICAL_MOBILE_CSS_WIDTH_PX,
    cssHeightPx: Math.round(CANONICAL_MOBILE_CSS_WIDTH_PX * screenAspect),
    deviceScaleFactor: CANONICAL_DEVICE_SCALE_FACTOR,
    isMobile: true,
    hasTouch: true,
    orientation: 'portrait',
    fullPage: false,
    userAgent: CANONICAL_MOBILE_USER_AGENT,
  };
  assertMobileViewport(viewport);
  return viewport;
}

/**
 * Refuses a viewport that would render anything but a phone layout.
 *
 * The first proof's interface was prepared at 1080 pixels wide. Treating a
 * device-pixel figure as a CSS width is the whole bug in one number, and it is
 * exactly what this refuses.
 */
export function assertMobileViewport(viewport: CanonicalMobileViewport): void {
  const failures: string[] = [];
  if (viewport.cssWidthPx > MOBILE_BREAKPOINT_CEILING_CSS_PX) {
    failures.push(
      `CSS viewport width is ${num(viewport.cssWidthPx)}px, above the ${num(MOBILE_BREAKPOINT_CEILING_CSS_PX)}px ` +
        'phone ceiling — a viewport this wide activates a tablet or desktop breakpoint',
    );
  }
  if (viewport.cssHeightPx <= viewport.cssWidthPx) {
    failures.push('the viewport is not portrait');
  }
  if (viewport.deviceScaleFactor < 2) {
    failures.push(
      `device scale factor ${num(viewport.deviceScaleFactor)} is below 2; type would be rendered ` +
        'at a fidelity no current handset uses',
    );
  }
  if (failures.length > 0) {
    throw new CanonicalScreenError(
      `the canonical viewport is not a phone viewport:\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    );
  }
}

export interface DeviceRect {
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * CSS viewport → device pixels. A rendering-fidelity multiplication and
 * nothing more: it cannot change which breakpoint rendered, because the layout
 * has already happened by the time it applies.
 */
export function devicePixelRect(viewport: CanonicalMobileViewport): DeviceRect {
  const widthPx = Math.round(viewport.cssWidthPx * viewport.deviceScaleFactor);
  const heightPx = Math.round(viewport.cssHeightPx * viewport.deviceScaleFactor);
  // Refused rather than rounded. Nudging the width to make the encoder happy
  // would put the document and the screen a pixel out of register, and the
  // only ways to close that gap again are the ones this whole correction
  // exists to remove.
  if (widthPx % 2 !== 0 || heightPx % 2 !== 0) {
    throw new CanonicalScreenError(
      `the canonical screen is ${num(widthPx)}×${num(heightPx)} device pixels, and h264 with yuv420p ` +
        'cannot encode an odd dimension. Choose a device scale factor that makes both even — the CSS ' +
        'viewport may not be changed to compensate, because its width decides the breakpoint.',
    );
  }
  return { widthPx, heightPx };
}

/** The document's own proportion. Derived from the viewport, never from a photograph. */
export function canonicalDocumentAspect(viewport: CanonicalMobileViewport): number {
  return viewport.cssHeightPx / viewport.cssWidthPx;
}

export interface MappingUniformity {
  readonly documentAspect: number;
  readonly projectedAspect: number;
  /**
   * How much the homography scales vertically relative to horizontally. 1 is a
   * uniform mapping; 1.3 means every glyph comes out a third taller than it was
   * drawn.
   */
  readonly impliedVerticalStretch: number;
  readonly uniform: boolean;
}

/**
 * Measures what the mapping will actually do to the interface.
 *
 * This deliberately runs *after* the document has been sized, and its result
 * is reported rather than fed back — the quad may never size the document.
 * What it is for is telling the truth about a plate: a handset whose screen is
 * drawn more elongated than a real device cannot carry a correctly-proportioned
 * mobile layout at full coverage, and an operator should be told that in
 * numbers rather than discover it in the frames.
 */
export function measureMappingUniformity(
  viewport: CanonicalMobileViewport,
  quad: ScreenQuad,
  toleranceRatio = 0.04,
): MappingUniformity {
  const documentAspect = canonicalDocumentAspect(viewport);
  const projectedAspect = measureQuadGeometry(quad).aspectRatio;
  const impliedVerticalStretch = projectedAspect / documentAspect;
  return {
    documentAspect,
    projectedAspect,
    impliedVerticalStretch,
    uniform: Math.abs(impliedVerticalStretch - 1) <= toleranceRatio,
  };
}

export interface ViewportBoundsMeasurement {
  readonly documentId: string;
  readonly cssWidthPx: number;
  readonly cssHeightPx: number;
  readonly scrollWidthPx: number;
  readonly clientWidthPx: number;
  readonly documentHeightCssPx: number;
  readonly overflowingElements: readonly {
    readonly selector: string;
    readonly leftPx: number;
    readonly rightPx: number;
  }[];
  readonly bottomNavigationVisible: boolean;
  readonly desktopNavigationPresent: boolean;
}

/**
 * The layout gate: every one of these is a way the first proof failed.
 *
 * Horizontal overflow is the check that matters most. A document whose
 * `scrollWidth` exceeds its `clientWidth` has content the viewport cannot show,
 * and on a phone that is invariably a desktop layout that did not reflow.
 */
export function assertLayoutFitsViewport(measurement: ViewportBoundsMeasurement): void {
  const failures: string[] = [];

  if (measurement.scrollWidthPx > measurement.clientWidthPx) {
    failures.push(
      `document scrollWidth ${num(measurement.scrollWidthPx)}px exceeds clientWidth ` +
        `${num(measurement.clientWidthPx)}px — content runs outside the phone width`,
    );
  }
  if (measurement.overflowingElements.length > 0) {
    failures.push(
      `${measurement.overflowingElements.length} element(s) sit outside the viewport: ` +
        measurement.overflowingElements
          .slice(0, 6)
          .map((e) => `${e.selector} [${num(e.leftPx)}..${num(e.rightPx)}]`)
          .join(', '),
    );
  }
  if (!measurement.bottomNavigationVisible) {
    failures.push('the bottom navigation is not visible — this is not a phone layout');
  }
  if (measurement.desktopNavigationPresent) {
    failures.push('a desktop navigation element rendered — the layout took a wide breakpoint');
  }
  if (measurement.documentHeightCssPx < measurement.cssHeightPx) {
    failures.push(
      `document is ${num(measurement.documentHeightCssPx)}px tall but the viewport is ` +
        `${num(measurement.cssHeightPx)}px — the screen would not be fully covered`,
    );
  }

  if (failures.length > 0) {
    throw new CanonicalScreenError(
      `document "${measurement.documentId}" does not fit the phone viewport:\n${failures
        .map((f) => `  - ${f}`)
        .join('\n')}`,
    );
  }
}
