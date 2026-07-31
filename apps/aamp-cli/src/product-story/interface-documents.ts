import type { CanonicalMobileViewport } from '@combat/media';

import {
  mobileDocumentCss,
  PALETTE,
  PRODUCT_MOCKUP_CLASSIFICATION,
} from '../product-motion/mobile-documents';
import type { ProductSurface, UiTimeline } from './story-contracts';

/**
 * The four product surfaces the corrected cut shows, laid out at the canonical
 * phone viewport.
 *
 * These are **`PRODUCT_MOCKUP`s, not captures**, authorised by name for
 * internal review, and every artefact says so. They share the existing
 * document system — the same palette, the same type hierarchy, the same
 * navigation, the same width-constrained blocks — because two stylesheets for
 * one product is how two products end up on screen.
 *
 * What is new here is that a document *moves*. A schedule scrolls, ranking rows
 * arrive, a prediction card becomes selected and a button takes a press. None
 * of that is expressible in a filter graph: `drawbox` cannot animate and no
 * filter can typeset. So each document exposes `window.__setTime(seconds)` and
 * the renderer steps it frame by frame, rasterising the whole interface at each
 * instant. There is no clock in the page, no transition, no animation and no
 * randomness — the same second always produces the same pixels.
 */

export const INTERFACE_DOCUMENT_VERSION = 1 as const;

export interface InterfaceDocument {
  readonly surface: ProductSurface;
  readonly title: string;
  readonly html: string;
  readonly classification: typeof PRODUCT_MOCKUP_CLASSIFICATION;
}

const EXTRA_CSS = `
  /* The scrolling body of the document, moved by transform rather than by a
     scroll position: a transform is exact at any sub-pixel offset and cannot
     be clamped by the layout, and the fixed navigation stays where a phone
     puts it. */
  .app { will-change: transform; }
  .stage { overflow: hidden; height: 100%; }
  /* Never fully transparent. "Never expose an empty display" is a rejection
     criterion, and a reveal that starts every card at zero opacity leaves the
     handset showing an ink-coloured rectangle on its opening frame — which is
     indistinguishable from an interface that failed to map. The card is
     present from the first frame and *arrives*; it does not appear from
     nothing. */
  .reveal { opacity: 0.38; transform: translateY(14px); }
  .press { transform: scale(1); }
  .pick {
    border: 2px solid ${PALETTE.hairline};
    border-radius: 14px; padding: 13px 14px; margin: 0 16px 11px;
    background: ${PALETTE.surface};
    display: flex; align-items: center; gap: 12px;
  }
  .pick .who { flex: 1 1 auto; min-width: 0; }
  .pick .who .n { font-size: 15px; font-weight: 800; }
  .pick .who .r { font-size: 11.5px; color: ${PALETTE.textMuted}; }
  .pick .tick {
    width: 26px; height: 26px; border-radius: 50%; flex: 0 0 auto;
    border: 2px solid ${PALETTE.hairline}; display: flex; align-items: center;
    justify-content: center; font-size: 13px; font-weight: 800; color: transparent;
  }
  .pick.on { border-color: ${PALETTE.accent}; background: rgba(218,3,24,.10); }
  .pick.on .tick { border-color: ${PALETTE.accent}; background: ${PALETTE.accent}; color: #fff; }
  .submit {
    margin: 14px 16px 0; border-radius: 12px; background: ${PALETTE.accent}; color: #fff;
    text-align: center; padding: 15px; font-weight: 800; font-size: 15px; letter-spacing: .03em;
  }
  .submit.down { background: #A80212; }
  .fingertip {
    position: absolute; width: 116px; height: 116px; border-radius: 50%;
    background: radial-gradient(circle, rgba(255,255,255,.30) 0%, rgba(255,255,255,.10) 46%, rgba(255,255,255,0) 70%);
    opacity: 0; pointer-events: none;
  }
  .rk-row {
    display: flex; align-items: center; gap: 11px; margin: 0 16px 9px; padding: 12px 13px;
    border-radius: 12px; background: ${PALETTE.surface}; border: 1px solid ${PALETTE.hairline};
  }
  .rk-row .pos { font-size: 15px; font-weight: 800; width: 26px; flex: 0 0 auto; color: ${PALETTE.accent};
                 font-variant-numeric: tabular-nums; }
  .rk-row .who { flex: 1 1 auto; min-width: 0; }
  .rk-row .who .name { font-size: 13.5px; font-weight: 700; overflow: hidden;
                       text-overflow: ellipsis; white-space: nowrap; }
  .rk-row .who .div { font-size: 11px; color: ${PALETTE.textMuted}; }
  .rk-row .rec { text-align: right; flex: 0 0 auto; font-size: 12.5px; font-weight: 700;
                 font-variant-numeric: tabular-nums; }
  .rk-row .rec .f { display: block; font-size: 9.5px; letter-spacing: .09em; color: ${PALETTE.textMuted}; }
  .thread {
    margin: 0 16px 10px; padding: 12px 13px; border-radius: 12px;
    background: ${PALETTE.surface}; border: 1px solid ${PALETTE.hairline};
  }
  .thread .top { display: flex; align-items: center; gap: 9px; margin-bottom: 6px; }
  .thread .av { width: 26px; height: 26px; border-radius: 50%; flex: 0 0 auto;
                background: ${PALETTE.surfaceRaised}; border: 1px solid ${PALETTE.hairline}; }
  .thread .ttl { font-size: 13px; font-weight: 700; overflow: hidden;
                 text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .thread .meta { font-size: 11px; color: ${PALETTE.textMuted}; }
`;

/**
 * The per-frame driver, inlined into every document.
 *
 * Deliberately tiny and deliberately pure: it takes a time in the scene's own
 * seconds and positions the interface for that instant. It reads no clock,
 * starts no animation and holds no state between calls, so a frame can be
 * re-rendered at any point and comes back byte-identical.
 */
const DRIVER = (timeline: UiTimeline): string => `
  (function () {
    var T = ${JSON.stringify(timeline)};
    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    function ease(kind, p) {
      if (kind === 'LINEAR') return p;
      if (kind === 'EASE_OUT_CUBIC') return 1 - Math.pow(1 - p, 3);
      return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    }
    window.__setTime = function (t) {
      var app = document.querySelector('.app');
      if (app) {
        var offset = 0;
        if (T.scroll) {
          var s = T.scroll;
          var p = clamp01((t - s.startSeconds) / (s.endSeconds - s.startSeconds));
          offset = s.fromPx + (s.toPx - s.fromPx) * ease(s.easing, p);
        }
        app.style.transform = 'translateY(' + (-offset).toFixed(3) + 'px)';
      }
      var rows = document.querySelectorAll('.reveal');
      for (var i = 0; i < rows.length; i++) {
        var el = rows[i];
        var shown = 1;
        var shift = 0;
        if (T.reveal) {
          var at = T.reveal.firstAtSeconds + i * T.reveal.intervalSeconds;
          var q = clamp01((t - at) / T.reveal.settleSeconds);
          var eased = ease('EASE_OUT_CUBIC', q);
          shown = 0.38 + 0.62 * eased;
          shift = 14 * (1 - eased);
        }
        el.style.opacity = shown.toFixed(4);
        el.style.transform = 'translateY(' + shift.toFixed(3) + 'px)';
      }
      var pick = document.getElementById('pick-red');
      var submit = document.getElementById('submit');
      var tip = document.getElementById('fingertip');
      if (T.interaction && pick && submit && tip) {
        var I = T.interaction;
        pick.className = t >= I.selectedAtSeconds ? 'pick on' : 'pick';
        submit.className = t >= I.pressAtSeconds && t < I.releasedAtSeconds ? 'submit down' : 'submit';
        var onCard = t >= I.contactAtSeconds && t < I.selectedAtSeconds + 0.06;
        var onButton = t >= I.pressAtSeconds - 0.06 && t < I.releasedAtSeconds + 0.06;
        tip.style.opacity = onCard || onButton ? '1' : '0';
        var target = onButton ? submit : pick;
        var box = target.getBoundingClientRect();
        var host = document.querySelector('.app').getBoundingClientRect();
        tip.style.left = (box.left - host.left + box.width * 0.62 - 58).toFixed(2) + 'px';
        tip.style.top = (box.top - host.top + box.height * 0.5 - 58).toFixed(2) + 'px';
      }
    };
  })();`;

const shell = (
  viewport: CanonicalMobileViewport,
  title: string,
  body: string,
  active: string,
  timeline: UiTimeline,
): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
  `<title>${title}</title><style>${mobileDocumentCss(viewport)}${EXTRA_CSS}` +
  `html,body{height:${viewport.cssHeightPx}px;overflow:hidden;}` +
  `.app{position:relative;}</style></head><body>` +
  `<div class="app">${body}</div>${bottomNav(active)}` +
  `<script>${DRIVER(timeline)}</script></body></html>`;

const bottomNav = (active: string): string => {
  const items: readonly (readonly [string, string])[] = [
    ['Events', '▦'],
    ['Rankings', '▤'],
    ['Predict', '◆'],
    ['Talk', '◍'],
    ['Profile', '◎'],
  ];
  return `<nav class="bottom" data-testid="bottom-nav">${items
    .map(
      ([label, glyph]) =>
        `<div class="item${label === active ? ' on' : ''}"><span class="glyph">${glyph}</span>${label}</div>`,
    )
    .join('')}</nav>`;
};

const header = (markDataUri: string, pill: string): string => `
  <div class="safe-top"></div>
  <header class="bar">
    <img class="mark" src="${markDataUri}" alt="Combat Reviews">
    <span class="pill"><span class="dot"></span>${pill}</span>
    <span class="spacer"></span>
    <span class="icon">⌕</span>
    <span class="icon">⌂</span>
  </header>`;

/**
 * A schedule entry.
 *
 * Compact on purpose: sport, both names, the date and the start time, on one
 * card, at readable size. The rejected cut's event screen carried large empty
 * image placeholders, which spend a card's whole height saying nothing — the
 * banner here is a thin sport-coloured rule instead, so six cards fit where
 * two did.
 */
const eventCard = (options: {
  readonly sport: string;
  readonly left: string;
  readonly right: string;
  readonly date: string;
  readonly time: string;
  readonly venue: string;
}): string => `
  <article class="card reveal" style="margin-bottom:10px">
    <div style="height:3px;background:${PALETTE.accent}"></div>
    <div class="body" style="padding:11px 13px 12px">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">
        <span class="chip gold">${options.sport}</span>
        <span class="chip">⧗ Predictions open</span>
      </div>
      <div class="fixture" style="font-size:14.5px">${options.left} <span class="vs">vs</span> ${options.right}</div>
      <div class="when">
        <span class="date">${options.date}</span>
        <span class="sep">·</span>
        <span class="time">${options.time}</span>
      </div>
      <div class="meta">${options.venue}</div>
    </div>
  </article>`;

const rankingRow = (
  position: number,
  name: string,
  division: string,
  record: string,
  form: string,
): string => `
  <div class="rk-row reveal">
    <div class="pos">${position}</div>
    <div class="who"><div class="name">${name}</div><div class="div">${division}</div></div>
    <div class="rec">${record}<span class="f">${form}</span></div>
  </div>`;

/**
 * The four documents.
 *
 * Every name, division, record and fixture here is the same invented roster the
 * existing approved mockups already use. Nothing states a result, a ranking or
 * a count as fact, and no artefact calls any of it a capture.
 */
export function buildInterfaceDocument(options: {
  readonly surface: ProductSurface;
  readonly viewport: CanonicalMobileViewport;
  readonly markDataUri: string;
  readonly timeline: UiTimeline;
}): InterfaceDocument {
  const { surface, viewport, markDataUri, timeline } = options;

  if (surface === 'EVENTS_AND_SCHEDULE') {
    const body = `
      ${header(markDataUri, 'THIS WEEKEND')}
      <section class="block" style="padding:10px 16px 2px">
        <div class="eyebrow">This weekend</div>
        <h1 style="font-size:26px;margin-bottom:3px">Fight schedule</h1>
        <p class="lede" style="font-size:12.5px">Every card, every promotion, one place.</p>
      </section>
      <div class="tabs" style="padding-top:12px">
        <span class="tab on">All sports</span>
        <span class="tab">Boxing</span>
        <span class="tab">MMA</span>
        <span class="tab">Muay Thai</span>
      </div>
      ${eventCard({ sport: 'Boxing', left: 'Richardson Hitchins', right: 'Ricardo Salinas', date: 'Sat 26 Jul', time: '20:00 BST', venue: 'Ironhaven Arena · full card' })}
      ${eventCard({ sport: 'MMA', left: 'Tim Tszyu', right: 'Errol Spence', date: 'Sat 26 Jul', time: '22:30 BST', venue: 'Coastal Clash 9 · full card' })}
      ${eventCard({ sport: 'Boxing', left: 'Edgar Berlanga', right: 'Steven Butler', date: 'Sun 27 Jul', time: '01:00 BST', venue: 'Valor Fight Night · full card' })}
      ${eventCard({ sport: 'Kickboxing', left: 'Isaac Park', right: 'Diego Alvarez', date: 'Sun 27 Jul', time: '03:15 BST', venue: 'Ironhaven 14 · full card' })}
      ${eventCard({ sport: 'Muay Thai', left: 'Kai Morozov', right: 'Jordan Elias', date: 'Sun 27 Jul', time: '11:00 BST', venue: 'Coastal Clash 9 · full card' })}
      ${eventCard({ sport: 'Boxing', left: 'Reese Lang', right: 'Isaac Park', date: 'Sun 27 Jul', time: '18:45 BST', venue: 'Valor Fight Night · full card' })}
      ${eventCard({ sport: 'MMA', left: 'Diego Alvarez', right: 'Kai Morozov', date: 'Mon 28 Jul', time: '02:00 BST', venue: 'Ironhaven Arena · full card' })}
      ${eventCard({ sport: 'Boxing', left: 'Jordan Elias', right: 'Reese Lang', date: 'Mon 28 Jul', time: '19:30 BST', venue: 'Ironhaven Arena · full card' })}`;
    return {
      surface,
      title: 'Events and schedule',
      html: shell(viewport, 'Events', body, 'Events', timeline),
      classification: PRODUCT_MOCKUP_CLASSIFICATION,
    };
  }

  if (surface === 'FIGHTER_RANKINGS') {
    const body = `
      ${header(markDataUri, 'RANKINGS')}
      <section class="block" style="padding:10px 16px 2px">
        <div class="eyebrow">Compete &amp; climb</div>
        <h1 style="font-size:26px;margin-bottom:3px">Rankings</h1>
        <p class="lede" style="font-size:12.5px">Divisional order, form and records in one view.</p>
      </section>
      <div class="tabs" style="padding-top:12px">
        <span class="tab solid">Super middleweight</span>
        <span class="tab">Welterweight</span>
        <span class="tab">Lightweight</span>
      </div>
      ${rankingRow(1, 'Edgar Berlanga', 'Super middleweight', '22–0', 'W W W W W')}
      ${rankingRow(2, 'Steven Butler', 'Super middleweight', '20–2', 'W W L W W')}
      ${rankingRow(3, 'Richardson Hitchins', 'Super middleweight', '19–1', 'W W W L W')}
      ${rankingRow(4, 'Ricardo Salinas', 'Super middleweight', '17–3', 'W L W W W')}
      ${rankingRow(5, 'Tim Tszyu', 'Super middleweight', '16–2', 'W W W W L')}
      ${rankingRow(6, 'Isaac Park', 'Super middleweight', '15–4', 'L W W W W')}
      ${rankingRow(7, 'Diego Alvarez', 'Super middleweight', '14–3', 'W W L W L')}
      ${rankingRow(8, 'Kai Morozov', 'Super middleweight', '13–5', 'W L W L W')}
      <div class="row-head"><h2>How rankings work</h2></div>
      <div class="panel">
        <div style="font-size:12.5px;color:${PALETTE.textMuted}">
          Divisional order reflects results recorded in Combat Reviews. Form shows the five most
          recent settled bouts, most recent first.
        </div>
      </div>`;
    return {
      surface,
      title: 'Fighter rankings',
      html: shell(viewport, 'Rankings', body, 'Rankings', timeline),
      classification: PRODUCT_MOCKUP_CLASSIFICATION,
    };
  }

  if (surface === 'PREDICTION') {
    const body = `
      ${header(markDataUri, 'PREDICTIONS OPEN')}
      <section class="block" style="padding:10px 16px 2px">
        <div class="eyebrow">Main event · 12 rds</div>
        <h1 style="font-size:24px;margin-bottom:3px">Who takes it?</h1>
        <p class="lede" style="font-size:12.5px">Free to play. Predictions lock at the first bell.</p>
      </section>
      <div style="height:14px"></div>
      <div class="pick" id="pick-red">
        <div class="avatar">RH</div>
        <div class="who"><div class="n">Richardson Hitchins</div><div class="r">19–1 · red corner</div></div>
        <div class="tick">✓</div>
      </div>
      <div class="pick" id="pick-blue">
        <div class="avatar blue">RS</div>
        <div class="who"><div class="n">Ricardo Salinas</div><div class="r">17–3 · blue corner</div></div>
        <div class="tick">✓</div>
      </div>
      <div class="submit" id="submit">SUBMIT PREDICTION</div>
      <div class="panel" style="margin-top:16px">
        <div class="kicker">Community split</div>
        <div class="split">
          <div class="side red" style="width:64%">64%</div>
          <div class="side blue" style="width:36%">36%</div>
        </div>
      </div>
      <div class="panel">
        <div style="font-size:12.5px;color:${PALETTE.textMuted}">
          Points are awarded for correct results only. Skill, not betting.
        </div>
      </div>
      <div class="fingertip" id="fingertip"></div>`;
    return {
      surface,
      title: 'Prediction',
      html: shell(viewport, 'Predict', body, 'Predict', timeline),
      classification: PRODUCT_MOCKUP_CLASSIFICATION,
    };
  }

  const body = `
    ${header(markDataUri, 'CARD TALK')}
    <section class="block" style="padding:10px 16px 2px">
      <div class="eyebrow">Card talk</div>
      <h1 style="font-size:26px;margin-bottom:3px">Join the debate</h1>
      <p class="lede" style="font-size:12.5px">Every card has a room. Go and argue about it.</p>
    </section>
    <div class="tabs" style="padding-top:12px">
      <span class="tab on">Main event</span>
      <span class="tab">Co-main</span>
      <span class="tab">Undercard</span>
    </div>
    ${[
      ['Hitchins by decision — nobody is stopping him', '48 replies · active now'],
      ['Salinas has the better body work', '31 replies · 12 min'],
      ['Round 7 is where this gets decided', '27 replies · 24 min'],
      ['Berlanga vs Butler is the better fight', '19 replies · 41 min'],
      ['Predictions locked — see you at the bell', '12 replies · 1 hr'],
    ]
      .map(
        ([title, meta]) => `
    <div class="thread reveal">
      <div class="top"><div class="av"></div><div class="ttl">${title}</div></div>
      <div class="meta">${meta}</div>
    </div>`,
      )
      .join('')}`;
  return {
    surface: 'DISCUSSION',
    title: 'Discussion',
    html: shell(viewport, 'Card talk', body, 'Talk', timeline),
    classification: PRODUCT_MOCKUP_CLASSIFICATION,
  };
}
