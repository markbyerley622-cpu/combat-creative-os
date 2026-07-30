import { join } from 'node:path';

import {
  assertLayoutFitsViewport,
  devicePixelRect,
  type CanonicalMobileViewport,
  type ViewportBoundsMeasurement,
} from '@combat/media';
import { chromium, type Browser } from 'playwright';

import type { MobileDocumentSpec } from './mobile-documents';
import { ProductMotionError } from './product-motion-contracts';

/**
 * Rendering the product documents at the canonical phone viewport, and reading
 * the geometry back.
 *
 * The layout is mobile because a real browser laid it out at 393 CSS pixels —
 * not because anything here asserts that it is. Everything after the render is
 * measurement: `scrollWidth` against `clientWidth`, every element's bounding
 * box against the viewport, the bottom navigation's presence, and the absence
 * of any wide-breakpoint navigation. A document that fails is refused by name.
 *
 * The browser is launched with no network access of any kind: content is set
 * from a string, the brand mark is inlined as a data URI, and a route handler
 * aborts every request that is not the document itself. A layout that silently
 * depended on a font or a stylesheet from the internet would render one way
 * here and another way on a machine without it.
 *
 * **The bottom navigation is captured separately and composited as a fixed
 * layer.** It is `position: fixed` on a phone, so it must not scroll with the
 * document — and a full-page screenshot bakes a fixed element in at whatever
 * position it occupied when the capture started, which would drag the
 * navigation up the screen as the content scrolls.
 */

export interface RenderedDocument {
  readonly id: string;
  readonly surface: string;
  /** The scrollable content, at device resolution. Taller than the screen. */
  readonly documentPath: string;
  readonly documentWidthPx: number;
  readonly documentHeightPx: number;
  /** The fixed bottom navigation, at device resolution. */
  readonly navigationPath: string;
  readonly navigationWidthPx: number;
  readonly navigationHeightPx: number;
  readonly measurement: ViewportBoundsMeasurement;
}

/** Selectors that only ever exist in a wide-breakpoint layout. */
const DESKTOP_NAVIGATION_SELECTORS = [
  'nav.desktop',
  '[data-desktop-nav]',
  'header nav ul li:nth-child(5)',
];

export async function renderMobileDocuments(options: {
  readonly viewport: CanonicalMobileViewport;
  readonly documents: readonly MobileDocumentSpec[];
  readonly outputDirectory: string;
}): Promise<readonly RenderedDocument[]> {
  const device = devicePixelRect(options.viewport);
  let browser: Browser | undefined;
  const rendered: RenderedDocument[] = [];

  try {
    browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
    const context = await browser.newContext({
      viewport: { width: options.viewport.cssWidthPx, height: options.viewport.cssHeightPx },
      deviceScaleFactor: options.viewport.deviceScaleFactor,
      isMobile: options.viewport.isMobile,
      hasTouch: options.viewport.hasTouch,
      userAgent: options.viewport.userAgent,
      javaScriptEnabled: true,
      offline: true,
    });

    // Default-deny. Only the synthetic document itself may load.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url === 'about:blank') {
        void route.continue();
        return;
      }
      void route.abort();
    });

    for (const specification of options.documents) {
      const page = await context.newPage();
      await page.setContent(specification.html, { waitUntil: 'load' });

      const measurement = await page.evaluate(
        ({ id, desktopSelectors }) => {
          const root = document.documentElement;
          const clientWidth = root.clientWidth;
          const overflowing: { selector: string; leftPx: number; rightPx: number }[] = [];
          const describe = (element: Element): string => {
            const tag = element.tagName.toLowerCase();
            const identifier = element.id ? `#${element.id}` : '';
            const cls =
              typeof element.className === 'string' && element.className.length > 0
                ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
                : '';
            return `${tag}${identifier}${cls}`;
          };
          for (const element of Array.from(document.body.querySelectorAll('*'))) {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            // Half a pixel of tolerance: sub-pixel layout rounding is not overflow.
            if (rect.left < -0.5 || rect.right > clientWidth + 0.5) {
              overflowing.push({
                selector: describe(element),
                leftPx: Math.round(rect.left * 100) / 100,
                rightPx: Math.round(rect.right * 100) / 100,
              });
            }
          }
          const nav = document.querySelector('[data-testid="bottom-nav"]');
          const navRect = nav ? nav.getBoundingClientRect() : null;
          return {
            documentId: id,
            cssWidthPx: clientWidth,
            cssHeightPx: root.clientHeight,
            scrollWidthPx: root.scrollWidth,
            clientWidthPx: clientWidth,
            documentHeightCssPx: document.body.scrollHeight,
            overflowingElements: overflowing,
            bottomNavigationVisible:
              navRect !== null && navRect.height > 0 && navRect.bottom <= root.clientHeight + 1,
            desktopNavigationPresent: desktopSelectors.some(
              (selector) => document.querySelector(selector) !== null,
            ),
          };
        },
        { id: specification.id, desktopSelectors: DESKTOP_NAVIGATION_SELECTORS },
      );

      assertLayoutFitsViewport(measurement);

      // The navigation, on its own, at the width it occupies on screen.
      const navigationHandle = page.locator('[data-testid="bottom-nav"]');
      const navigationPath = join(options.outputDirectory, `nav-${specification.id}.png`);
      await navigationHandle.screenshot({ path: navigationPath });
      const navigationBox = await navigationHandle.boundingBox();
      if (!navigationBox) {
        throw new ProductMotionError(
          'INVALID_PLAN',
          `document "${specification.id}" has no measurable bottom navigation`,
        );
      }

      // The scrollable content, without the fixed navigation baked into it.
      await page.evaluate(() => {
        const nav = document.querySelector('[data-testid="bottom-nav"]');
        if (nav instanceof HTMLElement) nav.style.display = 'none';
      });
      const documentPath = join(options.outputDirectory, `document-${specification.id}.png`);
      await page.screenshot({ path: documentPath, fullPage: true });

      const documentHeightPx = Math.round(
        measurement.documentHeightCssPx * options.viewport.deviceScaleFactor,
      );
      if (documentHeightPx < device.heightPx) {
        throw new ProductMotionError(
          'INVALID_PLAN',
          `document "${specification.id}" renders ${documentHeightPx}px tall but the screen is ` +
            `${device.heightPx}px; it would not cover the screen and may not be padded`,
        );
      }

      rendered.push({
        id: specification.id,
        surface: specification.surface,
        documentPath,
        documentWidthPx: device.widthPx,
        documentHeightPx,
        navigationPath,
        navigationWidthPx: Math.round(navigationBox.width * options.viewport.deviceScaleFactor),
        navigationHeightPx: Math.round(navigationBox.height * options.viewport.deviceScaleFactor),
        measurement,
      });

      await page.close();
    }
  } finally {
    await browser?.close();
  }

  return rendered;
}
