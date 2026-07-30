import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium, type Browser } from 'playwright';

import { StoryboardVideoError } from '../storyboard-video/failures';
import type { NotificationBrief } from './acceptance-brief';
import type { CardRect, DeliveryFrame, NotificationState } from './notification-timeline';

/**
 * The notification as a laid-out document, rasterised to transparent pixels.
 *
 * The previous treatment drew the card with `drawbox` and dropped the headline
 * on top as a subtitle. That is two mechanisms which have to agree about where
 * the type sits, and they only ever agree by hand: the constant that kept the
 * headline clear of the mark existed because they had once disagreed. Here the
 * mark, the header, the timestamp, the headline, the supporting line, the
 * surface, the corner radius, the shadow and the accent are one document. A
 * layout engine decides where everything goes, once, and the result is a single
 * sheet of pixels that the compositor can only place — not rearrange.
 *
 * Three properties follow from that and are worth stating plainly:
 *
 * - **No authored string reaches FFmpeg at all.** Not as filter grammar, and
 *   not as a subtitle file referenced from a filter argument either. The copy
 *   becomes pixels in this module and the compositor never sees it. That is
 *   strictly stronger than the rule it replaces.
 * - **Every state is a complete card.** There is no frame on which the surface
 *   exists and its contents do not, so a blank rectangle is not something the
 *   treatment can expose — the entrance scales an assembled card, it does not
 *   assemble one in stages.
 * - **Type is rasterised at the size it is seen at.** Each entrance step is
 *   rendered with its own CSS transform, so the layout engine anti-aliases at
 *   the final scale rather than resampling a master and softening the type.
 *
 * The browser is offline and default-deny: content is set from a string, the
 * mark is inlined from its own bytes as a data URI, and a route handler aborts
 * anything else. A surface that silently depended on a web font would render
 * one way here and another way on a machine without it.
 */

export const NOTIFICATION_SURFACE_ASSET_FILENAME = 'notification-surface.png';

/**
 * How bright the accent's glow is relative to the bar itself.
 *
 * Treatment grammar rather than creative copy, so it lives with the treatment
 * version. Held low deliberately: the bar carries the accent and the glow only
 * seats it against the surface. At the first version's 0.75 the glow was doing
 * the work and read as a wash.
 */
export const ACCENT_GLOW_OPACITY_FACTOR = 0.5;

export interface RenderedSurfaceState {
  readonly stateId: string;
  readonly fileName: string;
  readonly absolutePath: string;
  readonly checksumSha256: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface RenderedNotificationSurfaces {
  readonly directory: string;
  readonly states: readonly RenderedSurfaceState[];
  /** The resting card on its own — the transparent notification asset. */
  readonly assetPath: string;
  readonly assetChecksumSha256: string;
  readonly assetRect: CardRect;
  readonly markChecksumSha256: string;
  readonly renderer: string;
  readonly displayFontFamily: string;
  readonly uiFontFamily: string;
  /** Measured, not assumed: the renderer actually resolved these families. */
  readonly fontsResolved: readonly { readonly family: string; readonly resolved: boolean }[];
}

export interface RenderNotificationSurfacesOptions {
  readonly brief: NotificationBrief;
  readonly frame: DeliveryFrame;
  readonly states: readonly NotificationState[];
  /** The resting card plus its shadow — what the standalone asset covers. */
  readonly assetRect: CardRect;
  readonly logoPath: string;
  readonly outputDirectory: string;
  readonly onProgress?: (message: string) => void;
}

export async function renderNotificationSurfaces(
  options: RenderNotificationSurfacesOptions,
): Promise<RenderedNotificationSurfaces> {
  const markBytes = await readFile(options.logoPath).catch(() => null);
  if (!markBytes || markBytes.byteLength === 0) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `the Combat Reviews mark at ${options.logoPath} could not be read. The card is never drawn with a substitute mark, and this pipeline never redraws one.`,
    );
  }
  const markChecksumSha256 = createHash('sha256').update(markBytes).digest('hex');
  const markDataUri = `data:image/png;base64,${markBytes.toString('base64')}`;

  await mkdir(options.outputDirectory, { recursive: true });

  let browser: Browser | undefined;
  const rendered: RenderedSurfaceState[] = [];
  let fontsResolved: readonly { family: string; resolved: boolean }[] = [];
  let assetChecksumSha256 = '';
  const assetPath = join(options.outputDirectory, NOTIFICATION_SURFACE_ASSET_FILENAME);

  try {
    browser = await chromium.launch({
      // sRGB so the surface colour is the colour the brief names, and grayscale
      // text anti-aliasing so the rasterisation does not depend on a subpixel
      // layout that differs between displays.
      args: ['--force-color-profile=srgb', '--disable-lcd-text'],
    });
    const context = await browser.newContext({
      viewport: { width: options.frame.widthPx, height: options.frame.heightPx },
      deviceScaleFactor: 1,
      // Scripting is on solely so the font probe below can measure. The surface
      // documents themselves contain no script: they are a stylesheet, one
      // inlined image and text, set from a string with every request denied.
      javaScriptEnabled: true,
      offline: true,
    });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url === 'about:blank') {
        void route.continue();
        return;
      }
      void route.abort();
    });

    const page = await context.newPage();

    // --- the type is the type that was asked for, or the run refuses ---------
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
    );
    fontsResolved = await measureFontsResolved(page, [
      options.brief.displayFontFamily,
      options.brief.uiFontFamily,
    ]);
    const unresolved = fontsResolved.filter((entry) => !entry.resolved).map((e) => e.family);
    if (unresolved.length > 0) {
      throw new StoryboardVideoError(
        'FINAL_RENDER_FAILURE',
        `this renderer cannot resolve ${unresolved.map((f) => `"${f}"`).join(' or ')}, so the card would be set in a substitute face. A display face that silently falls back renders perfectly and is the generic typography this art direction exists to avoid, so the run refuses instead. Install the face, or name one this machine has in the brief.`,
      );
    }

    for (const state of options.states) {
      const html = buildNotificationSurfaceHtml({
        brief: options.brief,
        frame: options.frame,
        state,
        markDataUri,
      });
      // eslint-disable-next-line no-await-in-loop -- ordered so a failure names its state
      await page.setContent(html, { waitUntil: 'load' });
      const absolutePath = join(options.outputDirectory, state.fileName);
      // eslint-disable-next-line no-await-in-loop -- one state at a time
      await page.screenshot({ path: absolutePath, omitBackground: true });
      // eslint-disable-next-line no-await-in-loop -- one state at a time
      const bytes = await readFile(absolutePath);
      rendered.push({
        stateId: state.id,
        fileName: state.fileName,
        absolutePath,
        checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        widthPx: options.frame.widthPx,
        heightPx: options.frame.heightPx,
      });
      options.onProgress?.(`rendered notification surface state ${state.id}`);
    }

    // The standalone asset: the resting card and its shadow, cropped out of the
    // same document the composite plays, so the deliverable a designer opens is
    // the thing that was rendered rather than a second drawing of it.
    const resting = options.states[options.states.length - 1];
    if (!resting) {
      throw new StoryboardVideoError(
        'FINAL_RENDER_FAILURE',
        'the notification timeline produced no states, so there is nothing to render',
      );
    }
    await page.setContent(
      buildNotificationSurfaceHtml({
        brief: options.brief,
        frame: options.frame,
        state: resting,
        markDataUri,
      }),
      { waitUntil: 'load' },
    );
    await page.screenshot({
      path: assetPath,
      omitBackground: true,
      clip: {
        x: options.assetRect.xPx,
        y: options.assetRect.yPx,
        width: options.assetRect.widthPx,
        height: options.assetRect.heightPx,
      },
    });
    assetChecksumSha256 = createHash('sha256')
      .update(await readFile(assetPath))
      .digest('hex');
  } finally {
    await browser?.close();
  }

  return {
    directory: options.outputDirectory,
    states: rendered,
    assetPath,
    assetChecksumSha256,
    assetRect: options.assetRect,
    markChecksumSha256,
    renderer: 'chromium (playwright), offline, transparent background, deviceScaleFactor 1',
    displayFontFamily: options.brief.displayFontFamily,
    uiFontFamily: options.brief.uiFontFamily,
    fontsResolved,
  };
}

/**
 * Whether the renderer actually resolved a family, measured by width.
 *
 * `document.fonts.check` answers about loadable web fonts and is unreliable
 * about installed system ones, so this compares the string's width in
 * `"<family>", monospace` against its width in `monospace` alone. If the family
 * did not resolve the two are identical to the pixel, and a difference is proof
 * that something other than the fallback drew the glyphs.
 *
 * It exists because the failure it catches is invisible: a display face that
 * silently falls back renders perfectly, passes every other check in this
 * repository, and is exactly the generic typography the art direction rejected.
 */
async function measureFontsResolved(
  page: import('playwright').Page,
  families: readonly string[],
): Promise<readonly { family: string; resolved: boolean }[]> {
  return page.evaluate((names) => {
    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;left:-9999px;top:0;visibility:hidden;font-size:120px;white-space:nowrap;font-weight:700';
    probe.textContent = 'FIGHTS THIS WEEKEND 0123';
    document.body.appendChild(probe);
    const widthOf = (stack: string): number => {
      probe.style.fontFamily = stack;
      return probe.getBoundingClientRect().width;
    };
    const sentinel = widthOf('monospace');
    const out = names.map((family) => ({
      family,
      resolved: Math.abs(widthOf(`"${family}", monospace`) - sentinel) > 0.5,
    }));
    probe.remove();
    return out;
  }, families as string[]);
}

export interface NotificationSurfaceHtmlInput {
  readonly brief: NotificationBrief;
  readonly frame: DeliveryFrame;
  readonly state: NotificationState;
  readonly markDataUri: string;
}

/**
 * One state's document.
 *
 * The card is laid out once at its resting geometry and the state is applied as
 * a CSS transform about its own centre. That is what keeps the entrance a
 * transform of a finished card rather than a re-layout: re-laying-out at each
 * scale would leave the type at a fixed size inside a shrinking box, which is
 * the tell of a scaled screenshot rather than an interface.
 *
 * Not one string in here is a creative decision. Every colour, size, distance
 * and word comes from the brief; what this function owns is the arrangement.
 */
export function buildNotificationSurfaceHtml(input: NotificationSurfaceHtmlInput): string {
  const { brief, frame, state } = input;
  const card = {
    widthPx: Math.round(frame.widthPx * brief.widthFraction),
    heightPx: brief.cardHeightPx,
  };
  const left = Math.round((frame.widthPx - card.widthPx) / 2);
  const top = Math.round(brief.cardCentreYPx - card.heightPx / 2);

  const accentIsBottom = brief.accentEdge === 'BOTTOM';
  const accent = rgba(brief.accentColorHex, state.accentOpacity);
  const accentGlow = rgba(brief.accentColorHex, state.accentOpacity * ACCENT_GLOW_OPACITY_FACTOR);
  const surface = rgba(brief.surfaceColorHex, brief.surfaceOpacity);
  // The same surface, a shade lighter at the top: a flat fill reads as a
  // sticker, and a very small vertical lift is what makes it read as glass.
  const surfaceTop = rgba(brief.surfaceColorHex, Math.min(1, brief.surfaceOpacity + 0.04));

  const style = `
html, body { margin: 0; padding: 0; background: transparent; }
body { width: ${frame.widthPx}px; height: ${frame.heightPx}px; overflow: hidden; }
.stage {
  position: absolute; left: ${left}px; top: ${top}px;
  width: ${card.widthPx}px; height: ${card.heightPx}px;
  transform: translateY(${round3(state.riseRemainingPx)}px) scale(${round6(state.scale)});
  transform-origin: 50% 50%;
}
.card {
  position: absolute; inset: 0;
  border-radius: ${brief.cornerRadiusPx}px;
  background: linear-gradient(180deg, ${surfaceTop} 0%, ${surface} 62%, ${surface} 100%);
  box-shadow: 0 ${brief.shadowOffsetYPx}px ${brief.shadowBlurPx}px rgba(0, 0, 0, ${round3(brief.shadowOpacity)}),
              inset 0 1px 0 rgba(255, 255, 255, 0.55);
  overflow: hidden;
  box-sizing: border-box;
  padding: 0 ${brief.horizontalPaddingPx}px;
  display: flex; flex-direction: column; justify-content: center;
  font-family: ${cssFontStack(brief.uiFontFamily)};
  -webkit-font-smoothing: antialiased;
}
.header { display: flex; align-items: center; gap: ${Math.round(brief.markHeightPx * 0.32)}px; }
/* The tile is a snug rounded rectangle around the mark, not a square chip with
   the mark floating in it. The mark's own background is opaque white and the
   surface is translucent, so some tile is unavoidable — without it the mark
   sits in a brighter rectangle that reads as a compositing seam. Sizing it from
   the mark's height and its real aspect keeps the padding even and stops the
   mark reading as timid inside its own container. */
.mark {
  height: ${Math.round(brief.markHeightPx * 1.3)}px;
  border-radius: ${Math.round(brief.markHeightPx * 0.28)}px;
  padding: 0 ${Math.round(brief.markHeightPx * 0.17)}px;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  display: flex; align-items: center; justify-content: center;
  flex: none;
}
.mark img { height: ${brief.markHeightPx}px; width: auto; display: block; }
.brand {
  font-family: ${cssFontStack(brief.displayFontFamily)};
  font-size: ${brief.headerFontSizePx}px; font-weight: 700;
  letter-spacing: ${round3(brief.headerLetterSpacingEm)}em; color: ${brief.headerColorHex};
  white-space: nowrap;
}
.spacer { flex: 1 1 auto; }
.stamp {
  font-size: ${Math.round(brief.headerFontSizePx * 0.86)}px; font-weight: 600;
  letter-spacing: ${round3(brief.headerLetterSpacingEm)}em; color: ${brief.supportingColorHex};
  white-space: nowrap;
}
.headline {
  font-family: ${cssFontStack(brief.displayFontFamily)};
  margin-top: ${Math.round(brief.cardHeightPx * 0.05)}px;
  font-size: ${brief.headlineFontSizePx}px; font-weight: 700;
  letter-spacing: ${round3(brief.headlineLetterSpacingEm)}em;
  line-height: ${round3(brief.headlineLineHeight)};
  color: ${brief.headlineColorHex}; white-space: nowrap;
}
.support {
  margin-top: ${Math.round(brief.cardHeightPx * 0.03)}px;
  font-size: ${brief.supportingFontSizePx}px; font-weight: 400;
  letter-spacing: ${round3(brief.supportingLetterSpacingEm)}em;
  color: ${brief.supportingColorHex}; white-space: nowrap;
}
.accent {
  position: absolute;
  ${
    accentIsBottom
      ? `left: 0; right: 0; bottom: 0; height: ${brief.accentThicknessPx}px;`
      : `left: 0; top: 0; bottom: 0; width: ${brief.accentThicknessPx}px;`
  }
  background: ${accent};
  /* The glow spills inward, where the card's own overflow keeps it: an accent
     that bled outside the rounded corner would be a halo around the card
     rather than light coming off its edge.

     No offset — the glow is centred on the bar rather than thrown away from it.
     An offset glow reaches roughly offset plus blur into the card, which is how
     the first version put a pink wash behind the supporting line; centred, it
     reaches only the declared glow blur, which is the distance the brief bounds. */
  box-shadow: 0 0 ${brief.accentGlowBlurPx}px ${accentGlow};
}
`.trim();

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(brief.headline)}</title>`,
    `<style>${style}</style>`,
    '</head><body>',
    '<div class="stage"><div class="card">',
    '<div class="header">',
    `<span class="mark"><img src="${input.markDataUri}" alt=""></span>`,
    `<span class="brand">${escapeHtml(brief.headerLabel)}</span>`,
    '<span class="spacer"></span>',
    `<span class="stamp">${escapeHtml(brief.timestampLabel)}</span>`,
    '</div>',
    `<div class="headline">${escapeHtml(brief.headline)}</div>`,
    `<div class="support">${escapeHtml(brief.supportingLine)}</div>`,
    '<div class="accent"></div>',
    '</div></div>',
    '</body></html>',
  ].join('\n');
}

/**
 * The brief names one family; the stack keeps a generic behind it.
 *
 * Quotes, semicolons and braces are stripped rather than escaped: a font name
 * is a name, and anything that could close a declaration and open another has
 * no business being one.
 */
export function cssFontStack(fontFamily: string): string {
  const cleaned = fontFamily.replace(/["'`;{}<>()\\]/g, '').trim();
  if (cleaned.length === 0) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      'the brief names a font family that is empty once it is made safe for a stylesheet',
    );
  }
  return `"${cleaned}", sans-serif`;
}

/** `#rrggbb` plus an alpha, as a CSS colour. Validated by the brief schema. */
export function rgba(hex: string, alpha: number): string {
  const cleaned = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `"${hex}" is not a #rrggbb colour and may not reach a stylesheet`,
    );
  }
  const red = Number.parseInt(cleaned.slice(0, 2), 16);
  const green = Number.parseInt(cleaned.slice(2, 4), 16);
  const blue = Number.parseInt(cleaned.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${round3(Math.min(1, Math.max(0, alpha)))})`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}
