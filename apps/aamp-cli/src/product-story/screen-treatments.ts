import { PALETTE } from '../product-motion/mobile-documents';
import type { ScreenTreatment, StoryRect } from './story-contracts';

/**
 * The screen-space treatments, laid out as documents.
 *
 * Every one of these replaces a mark a filter graph was making. The prediction
 * scene had a hard red rectangle over it; the discussion scene had an opaque
 * red bar crossing it; the submission scene flashed the whole frame red; the
 * result scene reserved a region on the right and left it empty. All four were
 * `drawbox`, because `drawbox` is the only mark a filter can make — and all
 * four read as diagnostics rather than as art direction.
 *
 * What replaces them is design: real type at delivery resolution, real corner
 * radii, real feathering, composited as one assembled sheet. The copy is
 * authored and passed in; nothing here invents a claim, and no number appears
 * that the plan did not supply.
 */

export const SCREEN_TREATMENT_VERSION = 1 as const;

export interface TreatmentCopy {
  readonly headline?: string;
  readonly supporting?: string;
  readonly rankFrom?: string;
  readonly rankTo?: string;
  readonly rows?: readonly string[];
  readonly strips?: readonly string[];
  readonly leftName?: string;
  readonly leftRecord?: string;
  readonly leftForm?: string;
  readonly rightName?: string;
  readonly rightRecord?: string;
  readonly rightForm?: string;
  readonly ctaHeadline?: string;
  readonly ctaAction?: string;
  readonly markDataUri?: string;
}

export interface TreatmentTiming {
  /** Seconds from the start of the scene clip. */
  readonly enterAtSeconds: number;
  readonly settleSeconds: number;
  /** When the second half of a two-part treatment happens (rank change, sweep). */
  readonly eventAtSeconds: number;
  readonly durationSeconds: number;
}

export interface ScreenTreatmentRequest {
  readonly treatment: ScreenTreatment;
  readonly frameWidthPx: number;
  readonly frameHeightPx: number;
  readonly region: StoryRect | null;
  readonly copy: TreatmentCopy;
  readonly timing: TreatmentTiming;
  readonly accentHex: string;
}

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    font-family: "Bahnschrift Condensed", "Bahnschrift", -apple-system, BlinkMacSystemFont,
                 "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: ${PALETTE.text};
    -webkit-font-smoothing: antialiased;
  }
  .layer { position: absolute; inset: 0; }
  .glass {
    position: absolute;
    background: rgba(10,10,14,.80);
    border: 1px solid rgba(255,255,255,.10);
    border-radius: 30px;
    box-shadow: 0 26px 70px rgba(0,0,0,.62);
    overflow: hidden;
  }
  .kicker {
    font-size: 26px; letter-spacing: .22em; text-transform: uppercase; font-weight: 700;
  }
  .headline {
    font-size: 74px; line-height: .97; font-weight: 800; letter-spacing: -.01em;
    text-transform: uppercase;
  }
  .supporting { font-size: 30px; color: rgba(244,244,247,.72); line-height: 1.28; }
  .rule { height: 5px; border-radius: 3px; }
  .num { font-variant-numeric: tabular-nums; font-weight: 800; letter-spacing: -.02em; }
`;

/**
 * The per-frame driver.
 *
 * Same contract as the interface documents: pure, clock-free, and it positions
 * the whole sheet for one instant. An entrance is one monotonic eased rise —
 * it never overshoots its resting position, because a panel that flew past
 * where it stops and came back is a bounce however small, and a bounce is the
 * template effect this treatment refuses.
 */
const driver = (timing: TreatmentTiming): string => `
  (function () {
    var T = ${JSON.stringify(timing)};
    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
    window.__setTime = function (t) {
      var enter = easeOut(clamp01((t - T.enterAtSeconds) / T.settleSeconds));
      var event = clamp01((t - T.eventAtSeconds) / T.settleSeconds);
      var eased = easeOut(event);
      document.documentElement.style.setProperty('--enter', enter.toFixed(4));
      document.documentElement.style.setProperty('--enterShift', (26 * (1 - enter)).toFixed(3) + 'px');
      document.documentElement.style.setProperty('--event', eased.toFixed(4));
      var sweep = document.getElementById('sweep');
      if (sweep) {
        /* One crossing, then gone. The band is a feathered gradient with a
           soft mask, never a filled rectangle: an opaque bar reads as debug
           geometry, which is precisely what it was. */
        var p = clamp01((t - T.eventAtSeconds) / Math.max(0.0001, T.durationSeconds - T.eventAtSeconds));
        sweep.style.transform = 'translateX(' + (-40 + 180 * p).toFixed(2) + '%) skewX(-14deg)';
        sweep.style.opacity = (p <= 0 || p >= 1 ? 0 : Math.sin(Math.PI * p) * 0.5).toFixed(4);
      }
      var leaving = document.getElementById('rank-from');
      var arriving = document.getElementById('rank-to');
      if (leaving && arriving) {
        leaving.style.opacity = (1 - eased).toFixed(4);
        leaving.style.transform = 'translateY(' + (-44 * eased).toFixed(2) + 'px)';
        arriving.style.opacity = eased.toFixed(4);
        arriving.style.transform = 'translateY(' + (40 * (1 - eased)).toFixed(2) + 'px)';
      }
      var strips = document.querySelectorAll('.strip');
      for (var i = 0; i < strips.length; i++) {
        /* One coordinated reveal, not five independent slides: every strip is
           driven off the same entrance, offset by a fraction of the settle. */
        var q = easeOut(clamp01((t - T.enterAtSeconds - i * 0.055) / T.settleSeconds));
        strips[i].style.opacity = q.toFixed(4);
        strips[i].style.transform = 'translateY(' + (30 * (1 - q)).toFixed(2) + 'px)';
      }
    };
  })();`;

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const page = (request: ScreenTreatmentRequest, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}` +
  `body{width:${request.frameWidthPx}px;height:${request.frameHeightPx}px;position:relative;}` +
  `</style></head><body>${body}<script>${driver(request.timing)}</script></body></html>`;

function regionOrThrow(request: ScreenTreatmentRequest): StoryRect {
  if (!request.region) {
    throw new Error(
      `treatment ${request.treatment} needs a region: it fills a reserved part of the frame, and a ` +
        'reserved region left empty is a rejection criterion',
    );
  }
  return request.region;
}

/**
 * Builds one treatment sheet's document.
 *
 * The vocabulary is closed and every member is implemented, so there is no
 * branch here that renders nothing.
 */
export function buildScreenTreatment(request: ScreenTreatmentRequest): string {
  const accent = request.accentHex;
  const copy = request.copy;

  switch (request.treatment) {
    case 'SPORT_STRIP_REVEAL': {
      // Scene 2. The moving combat clip stays the dominant central action; the
      // strips arrive around it as one composition rather than as five slides.
      const strips = copy.strips ?? [];
      const bandHeight = Math.round(request.frameHeightPx * 0.062);
      return page(
        request,
        `<div class="layer">
          <div style="position:absolute;left:0;right:0;top:${Math.round(request.frameHeightPx * 0.115)}px;
                      display:flex;flex-direction:column;gap:${Math.round(bandHeight * 0.22)}px">
            ${strips
              .slice(0, 3)
              .map(
                (label, index) => `
              <div class="strip" style="display:flex;align-items:center;gap:22px;
                          padding-left:${index % 2 === 0 ? 64 : 132}px">
                <div class="rule" style="width:${74 + index * 26}px;background:${accent}"></div>
                <div class="kicker" style="font-size:30px;color:rgba(244,244,247,.94)">${escapeHtml(label)}</div>
              </div>`,
              )
              .join('')}
          </div>
          <div style="position:absolute;left:0;right:0;bottom:${Math.round(request.frameHeightPx * 0.135)}px;
                      display:flex;flex-direction:column;gap:${Math.round(bandHeight * 0.22)}px;align-items:flex-end">
            ${strips
              .slice(3)
              .map(
                (label, index) => `
              <div class="strip" style="display:flex;align-items:center;gap:22px;flex-direction:row-reverse;
                          padding-right:${index % 2 === 0 ? 64 : 132}px">
                <div class="rule" style="width:${74 + index * 26}px;background:${accent}"></div>
                <div class="kicker" style="font-size:30px;color:rgba(244,244,247,.94)">${escapeHtml(label)}</div>
              </div>`,
              )
              .join('')}
          </div>
        </div>`,
      );
    }

    case 'FIGHTER_COMPARISON_PANEL': {
      // Scene 5. Independent of the generated footage underneath it: the
      // graphics are laid out here at delivery resolution and never resampled
      // from the clip.
      const region = regionOrThrow(request);
      return page(
        request,
        `<div class="glass" style="left:${region.xPx}px;top:${region.yPx}px;width:${region.widthPx}px;
                    height:${region.heightPx}px;opacity:var(--enter,0);
                    transform:translateY(var(--enterShift,26px))">
          <div style="padding:46px 48px 42px;height:100%;display:flex;flex-direction:column">
            <div class="kicker" style="color:${accent};font-size:24px">${escapeHtml(copy.supporting ?? '')}</div>
            <div style="display:flex;align-items:stretch;gap:26px;margin-top:32px;flex:1 1 auto">
              <div style="flex:1 1 0;min-width:0">
                <div style="font-size:38px;font-weight:800;line-height:1.05">${escapeHtml(copy.leftName ?? '')}</div>
                <div class="num" style="font-size:56px;color:${accent};margin-top:12px">${escapeHtml(copy.leftRecord ?? '')}</div>
                <div style="font-size:24px;letter-spacing:.30em;color:rgba(244,244,247,.62);margin-top:10px">${escapeHtml(copy.leftForm ?? '')}</div>
              </div>
              <div style="width:2px;background:rgba(255,255,255,.14)"></div>
              <div style="flex:1 1 0;min-width:0;text-align:right">
                <div style="font-size:38px;font-weight:800;line-height:1.05">${escapeHtml(copy.rightName ?? '')}</div>
                <div class="num" style="font-size:56px;color:${PALETTE.accentBlue};margin-top:12px">${escapeHtml(copy.rightRecord ?? '')}</div>
                <div style="font-size:24px;letter-spacing:.30em;color:rgba(244,244,247,.62);margin-top:10px">${escapeHtml(copy.rightForm ?? '')}</div>
              </div>
            </div>
            <div class="headline" style="font-size:56px;margin-top:34px">${escapeHtml(copy.headline ?? '')}</div>
          </div>
        </div>`,
      );
    }

    case 'SUBMISSION_CONFIRMATION': {
      // Scene 7. One restrained red response — a bar and a rule, not a
      // full-frame flash. The flash it replaces blew the whole picture out for
      // two-tenths of a second and told a viewer nothing.
      const region = regionOrThrow(request);
      return page(
        request,
        `<div class="layer">
          <div class="glass" style="left:${region.xPx}px;top:${region.yPx}px;width:${region.widthPx}px;
                      height:${region.heightPx}px;border-radius:26px;opacity:var(--enter,0);
                      transform:translateY(var(--enterShift,26px))">
            <div style="position:absolute;left:0;top:0;bottom:0;width:12px;background:${accent}"></div>
            <div style="padding:34px 42px 34px 58px">
              <div class="kicker" style="color:${accent};font-size:24px">${escapeHtml(copy.supporting ?? '')}</div>
              <div class="headline" style="font-size:66px;margin-top:14px">${escapeHtml(copy.headline ?? '')}</div>
            </div>
          </div>
        </div>`,
      );
    }

    case 'PREDICTOR_RANK_RESULT': {
      // Scene 8. The reserved right-hand region, filled. #27 leaves upward and
      // #18 settles into its place, which is the movement the beat is about.
      const region = regionOrThrow(request);
      return page(
        request,
        `<div class="glass" style="left:${region.xPx}px;top:${region.yPx}px;width:${region.widthPx}px;
                    height:${region.heightPx}px;opacity:var(--enter,0);
                    transform:translateY(var(--enterShift,26px))">
          <div style="padding:44px 40px;height:100%;display:flex;flex-direction:column;justify-content:space-between">
            <div>
              <div class="rule" style="width:96px;background:${accent}"></div>
              <div class="headline" style="font-size:52px;margin-top:22px">${escapeHtml(copy.headline ?? '')}</div>
            </div>
            <div>
              <div class="kicker" style="font-size:22px;color:rgba(244,244,247,.66)">${escapeHtml(copy.supporting ?? '')}</div>
              <div style="position:relative;height:170px;margin-top:8px;overflow:hidden">
                <div id="rank-from" class="num" style="position:absolute;left:0;top:24px;font-size:132px;
                            color:rgba(244,244,247,.42)">${escapeHtml(copy.rankFrom ?? '')}</div>
                <div id="rank-to" class="num" style="position:absolute;left:0;top:24px;font-size:132px;
                            color:${accent}">${escapeHtml(copy.rankTo ?? '')}</div>
              </div>
            </div>
          </div>
        </div>`,
      );
    }

    case 'DISCUSSION_GLASS_PANEL': {
      // Scene 9. The panel fills the authored clean region, and the sweep is a
      // feathered, masked gradient that crosses once and disappears — never the
      // opaque bar it replaces.
      const region = regionOrThrow(request);
      const rows = copy.rows ?? [];
      return page(
        request,
        `<div class="layer" style="overflow:hidden">
          <div id="sweep" style="position:absolute;left:0;top:0;width:46%;height:100%;opacity:0;
                      background:linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.34) 46%,
                                 rgba(255,255,255,.34) 54%, rgba(255,255,255,0) 100%);
                      -webkit-mask-image:linear-gradient(90deg, transparent 0%, black 30%, black 70%, transparent 100%);
                      mask-image:linear-gradient(90deg, transparent 0%, black 30%, black 70%, transparent 100%);
                      filter:blur(26px)"></div>
          <div class="glass" style="left:${region.xPx}px;top:${region.yPx}px;width:${region.widthPx}px;
                      height:${region.heightPx}px;opacity:var(--enter,0);
                      transform:translateY(var(--enterShift,26px))">
            <div style="padding:40px 42px;height:100%;display:flex;flex-direction:column">
              <div class="rule" style="width:96px;background:${accent}"></div>
              <div class="headline" style="font-size:58px;margin-top:20px">${escapeHtml(copy.headline ?? '')}</div>
              <div style="margin-top:30px;display:flex;flex-direction:column;gap:18px">
                ${rows
                  .map(
                    (row) => `
                  <div class="strip" style="display:flex;align-items:center;gap:18px">
                    <div style="width:44px;height:44px;border-radius:50%;flex:0 0 auto;
                                background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.14)"></div>
                    <div class="supporting" style="font-size:26px;overflow:hidden;text-overflow:ellipsis;
                                white-space:nowrap;min-width:0">${escapeHtml(row)}</div>
                  </div>`,
                  )
                  .join('')}
              </div>
            </div>
          </div>
        </div>`,
      );
    }

    case 'CTA_BRAND_LOCKUP': {
      // Scene 10. The real mark, rendered separately from the interface and
      // from the typography, illuminated once as it settles.
      const region = regionOrThrow(request);
      const mark = copy.markDataUri
        ? `<img src="${copy.markDataUri}" alt="" style="height:96px;width:auto;display:block">`
        : '';
      return page(
        request,
        `<div class="layer">
          <div style="position:absolute;left:${region.xPx}px;top:${region.yPx}px;width:${region.widthPx}px;
                      opacity:var(--enter,0);transform:translateY(var(--enterShift,26px))">
            ${mark}
            <div class="rule" style="width:${Math.round(120 + 220 * 1)}px;background:${accent};margin-top:34px;
                        opacity:calc(0.35 + 0.65 * var(--event, 0))"></div>
            <div class="headline" style="font-size:78px;margin-top:26px">${escapeHtml(copy.ctaHeadline ?? '')}</div>
            <div class="kicker" style="font-size:30px;margin-top:26px;color:${accent}">${escapeHtml(copy.ctaAction ?? '')}</div>
            <div class="supporting" style="font-size:28px;margin-top:18px">${escapeHtml(copy.supporting ?? '')}</div>
          </div>
        </div>`,
      );
    }

    default: {
      const unreachable: never = request.treatment;
      throw new Error(`unknown screen treatment "${String(unreachable)}"`);
    }
  }
}
