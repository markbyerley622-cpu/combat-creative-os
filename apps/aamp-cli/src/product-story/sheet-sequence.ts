import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium, type Browser } from 'playwright';

import { ProductStoryError } from './story-contracts';

/**
 * Rasterising a moving design, one frame at a time.
 *
 * Everything this cut lays over a picture — a product interface that scrolls, a
 * result panel where one rank leaves and another settles, a confirmation, a
 * comparison table, a feathered sweep — is *typography and layout in motion*.
 * A filter graph can do neither: `drawbox` is the only mark it can make and it
 * cannot animate, which is exactly why the cut being corrected carried a hard
 * red rectangle and an opaque red bar. So the design is laid out by a real
 * engine and becomes pixels before FFmpeg is invoked, and no authored string
 * ever reaches the compositor.
 *
 * The sequence is deterministic by construction. The page holds no clock, no
 * CSS animation and no randomness; it exposes `window.__setTime(seconds)` and
 * this renderer calls it once per frame at exact frame times. Two runs of the
 * same plan produce the same frames.
 *
 * The browser is launched offline with a default-deny route handler, so a
 * layout that silently depended on a font or a stylesheet from the internet
 * would fail here rather than render differently on another machine.
 */

export interface SheetSequenceRequest {
  readonly id: string;
  readonly html: string;
  readonly widthPx: number;
  readonly heightPx: number;
  /**
   * The CSS viewport the page is laid out at, and the fidelity multiplier that
   * turns it into `widthPx`×`heightPx`.
   *
   * Separate from the device size on purpose, and this is the whole of the
   * mobile-native correction restated: the **CSS width decides which
   * breakpoint renders** and nothing else does, while device pixels are a
   * rendering-fidelity multiplication that cannot affect layout. Handing a
   * 1572px device width to the browser as a viewport lays the product out at a
   * desktop breakpoint and leaves the phone-width body in the corner of a black
   * field — which is exactly what it did before this existed.
   *
   * Absent, the page is laid out at the device size with no multiplier, which
   * is correct for a screen-space sheet authored directly in output pixels.
   */
  readonly cssWidthPx?: number;
  readonly cssHeightPx?: number;
  readonly deviceScaleFactor?: number;
  readonly frameCount: number;
  readonly frameRate: number;
  /** Where in the sequence's own timeline the first frame sits. */
  readonly startSeconds: number;
  /** RGBA with a transparent background — a screen-space overlay sheet. */
  readonly transparent: boolean;
  readonly outputDirectory: string;
}

export interface RenderedSheetSequence {
  readonly id: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly frameCount: number;
  readonly frameRate: number;
  /** An FFmpeg `-i` pattern: `frame-%05d.png` inside the sequence directory. */
  readonly patternPath: string;
  readonly directory: string;
}

/**
 * Renders every requested sequence in one browser.
 *
 * One launch for the whole run, because a Chromium start is by far the most
 * expensive part of this and the sequences are independent of each other.
 */
export async function renderSheetSequences(
  requests: readonly SheetSequenceRequest[],
  onProgress?: (message: string) => void,
): Promise<readonly RenderedSheetSequence[]> {
  if (requests.length === 0) return [];
  let browser: Browser | undefined;
  const rendered: RenderedSheetSequence[] = [];

  try {
    browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });

    for (const request of requests) {
      if (request.frameCount <= 0) {
        throw new ProductStoryError(
          'COMPOSITE_FAILED',
          `sequence "${request.id}" asks for ${request.frameCount} frames`,
        );
      }
      const directory = join(request.outputDirectory, request.id);
      // eslint-disable-next-line no-await-in-loop -- sequences render in order so progress is legible
      await mkdir(directory, { recursive: true });

      // eslint-disable-next-line no-await-in-loop -- one context per sequence, deliberately serial
      const scale = request.deviceScaleFactor ?? 1;
      const cssWidth = request.cssWidthPx ?? request.widthPx;
      const cssHeight = request.cssHeightPx ?? request.heightPx;
      if (Math.round(cssWidth * scale) !== request.widthPx) {
        throw new ProductStoryError(
          'COMPOSITE_FAILED',
          `sequence "${request.id}" declares a ${cssWidth}px CSS viewport at ${scale}x, which is ` +
            `${Math.round(cssWidth * scale)} device pixels, not the ${request.widthPx} it asks for`,
        );
      }
      const context = await browser.newContext({
        viewport: { width: cssWidth, height: cssHeight },
        deviceScaleFactor: scale,
        isMobile: scale > 1,
        hasTouch: scale > 1,
        javaScriptEnabled: true,
        offline: true,
      });
      // Default-deny. Only the synthetic document itself may load.
      // eslint-disable-next-line no-await-in-loop -- see above
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith('data:') || url === 'about:blank') {
          void route.continue();
          return;
        }
        void route.abort();
      });

      // eslint-disable-next-line no-await-in-loop -- see above
      const page = await context.newPage();
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.setContent(request.html, { waitUntil: 'load' });

      // eslint-disable-next-line no-await-in-loop -- see above
      const driverPresent = await page.evaluate(
        () => typeof (window as unknown as { __setTime?: unknown }).__setTime === 'function',
      );
      if (!driverPresent) {
        throw new ProductStoryError(
          'COMPOSITE_FAILED',
          `sequence "${request.id}" has no window.__setTime driver, so its frames could not be ` +
            'positioned. A document that cannot be stepped would render the same instant for the ' +
            'whole scene, which is the slideshow this correction removes.',
        );
      }

      for (let index = 0; index < request.frameCount; index += 1) {
        const seconds = request.startSeconds + index / request.frameRate;
        // eslint-disable-next-line no-await-in-loop -- frames are rendered in order, by design
        await page.evaluate(
          (t) => (window as unknown as { __setTime: (t: number) => void }).__setTime(t),
          seconds,
        );
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.screenshot({
          path: join(directory, `frame-${String(index + 1).padStart(5, '0')}.png`),
          omitBackground: request.transparent,
          animations: 'disabled',
          caret: 'hide',
        });
      }

      // eslint-disable-next-line no-await-in-loop -- see above
      await context.close();
      onProgress?.(
        `rasterised ${request.frameCount} frame(s) of "${request.id}" at ${request.widthPx}×${request.heightPx}`,
      );

      rendered.push({
        id: request.id,
        widthPx: request.widthPx,
        heightPx: request.heightPx,
        frameCount: request.frameCount,
        frameRate: request.frameRate,
        patternPath: join(directory, 'frame-%05d.png'),
        directory,
      });
    }
  } finally {
    await browser?.close();
  }

  return rendered;
}
