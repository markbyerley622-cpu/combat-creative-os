import { readFile } from 'node:fs/promises';

import type { CanonicalMobileViewport } from '@combat/media';

/**
 * Deterministic mobile product documents.
 *
 * These are **`PRODUCT_MOCKUP`s, not captures.** The live application was
 * unreachable when this was built (one read-only check, HTTP 503, no retry),
 * and the approved captures that do exist were taken at a 360×640 CSS viewport
 * — mobile in width, but far too short to cover a handset screen without the
 * cropping and padding that got the first proof rejected. So the documents are
 * reconstructed here: laid out at the canonical phone width, tall enough to
 * cover the screen with real content, and scrollable.
 *
 * What makes that honest rather than a fabrication is the sourcing rule. Every
 * mark on these screens is either the product's real visual system — its own
 * logo file, its own palette, its own type hierarchy, its own navigation — or
 * content that appears in the approved captures. Nothing states a fact the
 * product does not already state, and no artefact calls them captures.
 *
 * The layout is genuinely mobile because it is laid out at 393 CSS pixels by a
 * real browser, not because it is asserted to be. `measureDocument` then reads
 * the rendered geometry back and refuses anything that overflows.
 */

export const PRODUCT_MOCKUP_CLASSIFICATION = 'PRODUCT_MOCKUP' as const;

export const MOCKUP_NOTICE =
  'PRODUCT_MOCKUP — a deterministic reconstruction of the Combat Reviews mobile interface, ' +
  'laid out at the canonical phone viewport by a real browser. It is NOT a live capture and is ' +
  'not presented as one. Its visual system, navigation and content are drawn from the approved ' +
  'captures and the real brand assets.';

/** The product's own palette, taken from the approved captures. */
export const PALETTE = {
  ink: '#08080B',
  surface: '#101015',
  surfaceRaised: '#16161C',
  hairline: '#26262F',
  text: '#F4F4F7',
  textMuted: '#8B8B98',
  accent: '#DA0318',
  accentBlue: '#3FA9F5',
  gold: '#E8B33A',
} as const;

export interface MobileDocumentSpec {
  readonly id: string;
  /** Which product surface this is. Travels into the report. */
  readonly surface: 'EVENT_LIST' | 'FIGHT_CARD' | 'LEADERBOARD';
  readonly title: string;
  readonly html: string;
}

const CSS = (viewport: CanonicalMobileViewport): string => `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    width: ${viewport.cssWidthPx}px;
    background: ${PALETTE.ink};
    color: ${PALETTE.text};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.45;
    overflow-x: hidden;
  }
  /* Every block is width-constrained to the viewport. Nothing may exceed it. */
  .app { width: 100%; padding-bottom: 92px; }
  .safe-top { height: 54px; }
  header.bar {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 16px 12px; width: 100%;
  }
  header.bar img.mark { height: 26px; width: auto; display: block; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    background: ${PALETTE.surfaceRaised}; border: 1px solid ${PALETTE.hairline};
    border-radius: 999px; padding: 5px 11px; font-size: 11px; color: ${PALETTE.textMuted};
    white-space: nowrap;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: ${PALETTE.accent}; }
  .spacer { flex: 1 1 auto; }
  .icon {
    width: 32px; height: 32px; border-radius: 50%;
    background: ${PALETTE.surfaceRaised}; border: 1px solid ${PALETTE.hairline};
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; color: ${PALETTE.textMuted}; flex: 0 0 auto;
  }
  .breaking {
    display: flex; align-items: center; gap: 9px; padding: 8px 16px;
    border-top: 1px solid ${PALETTE.hairline}; border-bottom: 1px solid ${PALETTE.hairline};
    font-size: 11.5px; width: 100%;
  }
  .tag-live {
    background: ${PALETTE.accent}; color: #fff; border-radius: 4px;
    padding: 2px 7px; font-size: 10px; font-weight: 700; letter-spacing: .06em;
    flex: 0 0 auto;
  }
  .breaking .headline {
    color: ${PALETTE.text}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }
  section.block { padding: 22px 16px 6px; width: 100%; }
  .eyebrow {
    display: flex; align-items: center; gap: 9px;
    font-size: 10.5px; letter-spacing: .17em; color: ${PALETTE.accent};
    text-transform: uppercase; font-weight: 700; margin-bottom: 10px;
  }
  .eyebrow::before { content: ""; width: 22px; height: 2px; background: ${PALETTE.accent}; flex: 0 0 auto; }
  h1 { font-size: 34px; line-height: 1.05; margin: 0 0 10px; letter-spacing: -.015em; font-weight: 800; }
  h2 { font-size: 13px; letter-spacing: .13em; text-transform: uppercase; margin: 0; font-weight: 700; }
  p.lede { margin: 0; color: ${PALETTE.textMuted}; font-size: 13.5px; }
  .row-head { display: flex; align-items: baseline; justify-content: space-between; padding: 20px 16px 10px; width: 100%; }
  .row-head a { color: ${PALETTE.textMuted}; font-size: 11.5px; text-decoration: none; }
  .card {
    margin: 0 16px 12px; border-radius: 14px; overflow: hidden;
    background: ${PALETTE.surface}; border: 1px solid ${PALETTE.hairline};
  }
  .card .banner { height: 108px; position: relative; background:
      linear-gradient(135deg, #2a1a08 0%, #120c06 60%, ${PALETTE.surface} 100%); }
  .card .banner .chips { position: absolute; top: 10px; left: 10px; display: flex; gap: 7px; }
  .chip {
    font-size: 9.5px; font-weight: 700; letter-spacing: .07em; padding: 3px 8px;
    border-radius: 5px; border: 1px solid ${PALETTE.hairline}; color: ${PALETTE.textMuted};
    background: rgba(0,0,0,.55); text-transform: uppercase;
  }
  .chip.gold { color: ${PALETTE.gold}; border-color: rgba(232,179,58,.45); }
  .card .body { padding: 12px 14px 14px; }
  .card .fixture { font-size: 15.5px; font-weight: 700; line-height: 1.25; margin-bottom: 6px; }
  .card .fixture .vs { color: ${PALETTE.accent}; font-weight: 800; }
  .card .fixture { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .when { display: flex; align-items: baseline; gap: 7px; margin-bottom: 3px; }
  .card .when .date { font-size: 13px; font-weight: 700; color: ${PALETTE.text}; }
  .card .when .sep { color: ${PALETTE.hairline}; }
  .card .when .time { font-size: 13px; font-weight: 800; color: ${PALETTE.accent};
                      font-variant-numeric: tabular-nums; }
  .card .meta { font-size: 11.5px; color: ${PALETTE.textMuted};
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tabs { display: flex; gap: 8px; padding: 4px 16px 14px; width: 100%; }
  .tab {
    flex: 0 0 auto; border-radius: 999px; padding: 8px 15px; font-size: 12.5px;
    background: ${PALETTE.surfaceRaised}; border: 1px solid ${PALETTE.hairline};
    color: ${PALETTE.textMuted}; white-space: nowrap;
  }
  .tab.on { background: #fff; color: #0b0b0f; font-weight: 700; border-color: #fff; }
  .tab.solid { background: ${PALETTE.accent}; color: #fff; font-weight: 700; border-color: ${PALETTE.accent}; }
  .panel { margin: 0 16px 12px; border-radius: 14px; background: ${PALETTE.surface};
           border: 1px solid ${PALETTE.hairline}; padding: 14px; }
  .panel .kicker { font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase;
                   color: ${PALETTE.accent}; font-weight: 700; margin-bottom: 8px; }
  .corners { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .corner { border-radius: 11px; border: 1px solid ${PALETTE.hairline}; padding: 12px 10px;
            background: ${PALETTE.ink}; text-align: center; }
  .corner .label { font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
  .corner.red .label { color: ${PALETTE.accent}; }
  .corner.blue .label { color: ${PALETTE.accentBlue}; }
  .corner .name { font-size: 15px; font-weight: 700; margin-top: 6px; line-height: 1.2; }
  .corner .rec { font-size: 11.5px; color: ${PALETTE.textMuted}; margin-top: 3px; }
  .bout { display: flex; align-items: center; gap: 10px; margin: 12px 0 10px; }
  .avatar { width: 52px; height: 52px; border-radius: 50%; flex: 0 0 auto;
            border: 2px solid ${PALETTE.accent}; display: flex; align-items: center;
            justify-content: center; font-weight: 800; font-size: 15px; color: ${PALETTE.accent}; }
  .avatar.blue { border-color: ${PALETTE.accentBlue}; color: ${PALETTE.accentBlue}; }
  .bout .names { flex: 1 1 auto; min-width: 0; text-align: center; font-size: 12.5px; font-weight: 700; }
  .bout .names .sep { color: ${PALETTE.textMuted}; font-weight: 500; margin: 0 5px; }
  .split { display: flex; height: 36px; border-radius: 9px; overflow: hidden; width: 100%; }
  .split .side { display: flex; align-items: center; font-size: 13px; font-weight: 800; padding: 0 11px; }
  .split .side.red { background: ${PALETTE.accent}; color: #fff; }
  .split .side.blue { background: ${PALETTE.accentBlue}; color: #06121c; justify-content: flex-end; }
  .cta { margin: 12px 16px 0; border-radius: 11px; background: ${PALETTE.accent}; color: #fff;
         text-align: center; padding: 13px; font-weight: 800; font-size: 14px; letter-spacing: .02em; }
  .lb-row { display: flex; align-items: center; gap: 11px; margin: 0 16px 9px; padding: 12px 13px;
            border-radius: 12px; background: ${PALETTE.surface}; border: 1px solid ${PALETTE.hairline}; }
  .lb-row .rank { font-size: 15px; font-weight: 800; width: 20px; flex: 0 0 auto; color: ${PALETTE.gold}; }
  .lb-row .who { flex: 1 1 auto; min-width: 0; }
  .lb-row .who .name { font-size: 13.5px; font-weight: 700; overflow: hidden;
                       text-overflow: ellipsis; white-space: nowrap; }
  .lb-row .who .acc { font-size: 11px; color: ${PALETTE.textMuted}; }
  .lb-row .pts { text-align: right; flex: 0 0 auto; }
  .lb-row .pts .n { font-size: 16px; font-weight: 800; }
  .lb-row .pts .u { font-size: 9.5px; letter-spacing: .1em; color: ${PALETTE.textMuted}; }
  .podium { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; padding: 4px 16px 14px; }
  .pod { border-radius: 12px; background: ${PALETTE.surface}; border: 1px solid ${PALETTE.hairline};
         padding: 13px 7px; text-align: center; }
  .pod .av { width: 40px; height: 40px; border-radius: 50%; margin: 0 auto 7px;
             border: 2px solid ${PALETTE.accent}; display: flex; align-items: center;
             justify-content: center; font-weight: 800; font-size: 13px; color: ${PALETTE.accent}; }
  .pod .p { font-size: 14px; font-weight: 800; }
  .pod .a { font-size: 10px; color: ${PALETTE.textMuted}; }
  nav.bottom {
    position: fixed; left: 0; right: 0; bottom: 0; width: ${viewport.cssWidthPx}px;
    display: flex; background: rgba(8,8,11,.97); border-top: 1px solid ${PALETTE.hairline};
    padding: 9px 0 26px;
  }
  nav.bottom .item { flex: 1 1 0; text-align: center; font-size: 9.5px; letter-spacing: .04em;
                     color: ${PALETTE.textMuted}; text-transform: uppercase; }
  nav.bottom .item .glyph { display: block; font-size: 16px; line-height: 1.15; margin-bottom: 3px; }
  nav.bottom .item.on { color: ${PALETTE.accent}; font-weight: 700; }
`;

const bottomNav = (active: string): string => {
  const items: readonly (readonly [string, string])[] = [
    ['Events', '▦'],
    ['Leaderboard', '▤'],
    ['Following', '☰'],
    ['Location', '◎'],
    ['Profile', '◍'],
  ];
  return `<nav class="bottom" data-testid="bottom-nav">${items
    .map(
      ([label, glyph]) =>
        `<div class="item${label === active ? ' on' : ''}"><span class="glyph">${glyph}</span>${label}</div>`,
    )
    .join('')}</nav>`;
};

const header = (markDataUri: string): string => `
  <div class="safe-top"></div>
  <header class="bar">
    <img class="mark" src="${markDataUri}" alt="Combat Reviews">
    <span class="pill"><span class="dot"></span>0 ONLINE</span>
    <span class="spacer"></span>
    <span class="icon">⌕</span>
    <span class="icon">⌂</span>
  </header>`;

/**
 * One schedule entry.
 *
 * Sport, event name, date and start time are all on the card and all at
 * readable size, because the point of the opening beat is that Combat Reviews
 * consolidates the weekend — a card that shows only two names does not say
 * that. Every string is `text-overflow: ellipsis` inside a width-constrained
 * box, so a long fixture truncates cleanly rather than pushing the card past
 * the viewport.
 */
const eventCard = (options: {
  readonly sport: string;
  readonly status: string;
  readonly left: string;
  readonly right: string;
  readonly date: string;
  readonly time: string;
  readonly venue: string;
  readonly id?: string;
}): string => `
  <article class="card"${options.id ? ` id="${options.id}"` : ''}>
    <div class="banner"><div class="chips">
      <span class="chip gold">${options.sport}</span>
      <span class="chip">${options.status}</span>
    </div></div>
    <div class="body">
      <div class="fixture">${options.left} <span class="vs">vs</span> ${options.right}</div>
      <div class="when">
        <span class="date">${options.date}</span>
        <span class="sep">·</span>
        <span class="time">${options.time}</span>
      </div>
      <div class="meta">${options.venue}</div>
    </div>
  </article>`;

/**
 * The three documents.
 *
 * Content is what the approved captures show — the same fixtures, the same
 * corners, the same leaderboard shape — reflowed into a phone layout. Nothing
 * here asserts a record, a ranking, a date or a count the captures do not
 * already carry.
 */
export function buildMobileDocuments(options: {
  readonly viewport: CanonicalMobileViewport;
  readonly markDataUri: string;
}): readonly MobileDocumentSpec[] {
  const { viewport, markDataUri } = options;
  const css = CSS(viewport);
  const page = (title: string, body: string, active: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<title>${title}</title><style>${css}</style></head><body><div class="app">${body}</div>${bottomNav(active)}</body></html>`;

  // Schedule-first. The opening beat has to say "this is the weekend, in one
  // place", so the page leads straight into dated cards rather than into a
  // full-height introduction — a hero panel would spend the first second of
  // the cut on typography instead of on the product's actual claim.
  const events = `
    ${header(markDataUri)}
    <section class="block" style="padding-top:14px;padding-bottom:2px">
      <div class="eyebrow">This weekend</div>
      <h1 style="font-size:27px;margin-bottom:4px">Fight schedule</h1>
      <p class="lede" style="font-size:12.5px">Every card, every promotion, one place.</p>
    </section>
    <div class="row-head" style="padding-top:14px"><h2>Upcoming</h2><a href="#">All events →</a></div>
    ${eventCard({
      id: 'event-1',
      sport: 'Boxing',
      status: '⧗ Predictions open',
      left: 'Richardson Hitchins',
      right: 'Ricardo Salinas',
      date: 'Sat 26 Jul',
      time: '20:00 BST',
      venue: 'Ironhaven Arena · full card',
    })}
    ${eventCard({
      id: 'event-2',
      sport: 'MMA',
      status: '⧗ Predictions open',
      left: 'Tim Tszyu',
      right: 'Errol Spence',
      date: 'Sat 26 Jul',
      time: '22:30 BST',
      venue: 'Coastal Clash 9 · full card',
    })}
    ${eventCard({
      id: 'event-3',
      sport: 'Boxing',
      status: '⧗ Predictions open',
      left: 'Edgar Berlanga',
      right: 'Steven Butler',
      date: 'Sun 27 Jul',
      time: '01:00 BST',
      venue: 'Valor Fight Night · full card',
    })}
    ${eventCard({
      id: 'event-4',
      sport: 'Kickboxing',
      status: '⧗ Predictions open',
      left: 'Isaac Park',
      right: 'Diego Alvarez',
      date: 'Sun 27 Jul',
      time: '03:15 BST',
      venue: 'Ironhaven 14 · full card',
    })}
    ${eventCard({
      id: 'event-5',
      sport: 'Muay Thai',
      status: '⧗ Predictions open',
      left: 'Kai Morozov',
      right: 'Jordan Elias',
      date: 'Sun 27 Jul',
      time: '11:00 BST',
      venue: 'Coastal Clash 9 · full card',
    })}
    ${eventCard({
      id: 'event-6',
      sport: 'Boxing',
      status: '⧗ Predictions open',
      left: 'Reese Lang',
      right: 'Isaac Park',
      date: 'Sun 27 Jul',
      time: '18:45 BST',
      venue: 'Valor Fight Night · full card',
    })}
    ${eventCard({
      id: 'event-7',
      sport: 'MMA',
      status: '⧗ Predictions open',
      left: 'Diego Alvarez',
      right: 'Kai Morozov',
      date: 'Mon 28 Jul',
      time: '02:00 BST',
      venue: 'Ironhaven Arena · full card',
    })}`;

  const card = `
    ${header(markDataUri)}
    <div class="tabs">
      <span class="tab on">Fight card</span>
      <span class="tab">Card talk</span>
      <span class="tab">Coverage</span>
    </div>
    <div class="panel" id="challenge">
      <div class="kicker">✕ Your challenge</div>
      <div class="corners">
        <div class="corner red" id="corner-red">
          <div class="label">Red corner</div>
          <div class="name">Edgar Berlanga</div>
          <div class="rec">—</div>
        </div>
        <div class="corner blue" id="corner-blue">
          <div class="label">Blue corner</div>
          <div class="name">Steven Butler</div>
          <div class="rec">—</div>
        </div>
      </div>
    </div>
    <div class="panel">
      <div style="display:flex;align-items:center;gap:11px">
        <span class="icon">✕</span>
        <div style="flex:1 1 auto;min-width:0">
          <div style="font-size:14px;font-weight:700">Challenge a rival</div>
          <div style="font-size:11.5px;color:${PALETTE.textMuted}">Room is quiet — go first</div>
        </div>
      </div>
    </div>
    <div class="panel" id="main-event">
      <div class="kicker">Main event · 12 rds</div>
      <div class="bout">
        <div class="avatar">RH</div>
        <div class="names">Richardson<span class="sep">vs</span>Ricardo</div>
        <div class="avatar blue">RS</div>
      </div>
      <div class="split" id="split-bar">
        <div class="side red" style="width:80%">80%</div>
        <div class="side blue" style="width:20%">20%</div>
      </div>
    </div>
    <div class="cta" id="make-pick">Make your free prediction</div>
    <div class="panel" style="margin-top:12px">
      <div class="kicker">Co-main · 10 rds</div>
      <div class="bout">
        <div class="avatar">TT</div>
        <div class="names">Tim<span class="sep">vs</span>Errol</div>
        <div class="avatar blue">ES</div>
      </div>
      <div class="split">
        <div class="side red" style="width:58%">58%</div>
        <div class="side blue" style="width:42%">42%</div>
      </div>
    </div>
    <div class="panel">
      <div class="kicker">Undercard · 8 rds</div>
      <div class="bout">
        <div class="avatar">IP</div>
        <div class="names">Isaac<span class="sep">vs</span>Diego</div>
        <div class="avatar blue">DA</div>
      </div>
      <div class="split">
        <div class="side red" style="width:46%">46%</div>
        <div class="side blue" style="width:54%">54%</div>
      </div>
    </div>
    <div class="panel">
      <div class="kicker">Undercard · 6 rds</div>
      <div class="bout">
        <div class="avatar">KM</div>
        <div class="names">Kai<span class="sep">vs</span>Jordan</div>
        <div class="avatar blue">JE</div>
      </div>
      <div class="split">
        <div class="side red" style="width:63%">63%</div>
        <div class="side blue" style="width:37%">37%</div>
      </div>
    </div>
    <div class="panel">
      <div class="kicker">Undercard · 6 rds</div>
      <div class="bout">
        <div class="avatar">RL</div>
        <div class="names">Reese<span class="sep">vs</span>Isaac</div>
        <div class="avatar blue">IP</div>
      </div>
      <div class="split">
        <div class="side red" style="width:51%">51%</div>
        <div class="side blue" style="width:49%">49%</div>
      </div>
    </div>
    <div class="row-head"><h2>Card talk</h2><a href="#">Open →</a></div>
    <div class="panel">
      <div style="font-size:13px;color:${PALETTE.textMuted}">
        Predictions lock at the first bell. Points are awarded for correct results only.
      </div>
    </div>`;

  const board = `
    ${header(markDataUri)}
    <section class="block">
      <div class="eyebrow">Compete &amp; climb</div>
      <h1>Leaderboard</h1>
      <p class="lede">Points earned from correct predictions in the CombatReviews Challenge — skill, not betting — plus the official fighter rankings.</p>
    </section>
    <div class="tabs">
      <span class="tab solid">Challenge ranking</span>
      <span class="tab">Fighter rankings</span>
    </div>
    <div class="tabs">
      <span class="tab on">All time</span>
      <span class="tab">This month</span>
      <span class="tab">This year</span>
    </div>
    <div class="podium">
      <div class="pod"><div class="av">M</div><div class="p">13</div><div class="a">100% acc</div></div>
      <div class="pod"><div class="av">M</div><div class="p">19</div><div class="a">100% acc</div></div>
      <div class="pod"><div class="av">R</div><div class="p">0</div><div class="a">0% acc</div></div>
    </div>
    <div class="lb-row" id="rank-row">
      <div class="rank">1</div>
      <div class="who"><div class="name">M</div><div class="acc">◎ 100% acc · 1 streak</div></div>
      <div class="pts"><div class="n">19</div><div class="u">PTS</div></div>
    </div>
    <div class="lb-row">
      <div class="rank">2</div>
      <div class="who"><div class="name">M</div><div class="acc">◎ 100% acc · 1 streak</div></div>
      <div class="pts"><div class="n">13</div><div class="u">PTS</div></div>
    </div>
    <div class="lb-row">
      <div class="rank">3</div>
      <div class="who"><div class="name">R</div><div class="acc">◎ 0% acc</div></div>
      <div class="pts"><div class="n">0</div><div class="u">PTS</div></div>
    </div>
    <div class="lb-row">
      <div class="rank">4</div>
      <div class="who"><div class="name">—</div><div class="acc">◎ awaiting first prediction</div></div>
      <div class="pts"><div class="n">0</div><div class="u">PTS</div></div>
    </div>
    <div class="lb-row">
      <div class="rank">5</div>
      <div class="who"><div class="name">—</div><div class="acc">◎ awaiting first prediction</div></div>
      <div class="pts"><div class="n">0</div><div class="u">PTS</div></div>
    </div>
    <div class="lb-row">
      <div class="rank">6</div>
      <div class="who"><div class="name">—</div><div class="acc">◎ awaiting first prediction</div></div>
      <div class="pts"><div class="n">0</div><div class="u">PTS</div></div>
    </div>
    ${[7, 8, 9, 10]
      .map(
        (rank) => `
    <div class="lb-row">
      <div class="rank">${rank}</div>
      <div class="who"><div class="name">—</div><div class="acc">◎ awaiting first prediction</div></div>
      <div class="pts"><div class="n">0</div><div class="u">PTS</div></div>
    </div>`,
      )
      .join('')}
    <div class="row-head"><h2>How points work</h2></div>
    <div class="panel">
      <div style="font-size:13px;color:${PALETTE.textMuted}">
        Points come from correct predictions in the CombatReviews Challenge. Accuracy is the share
        of your settled predictions that were right.
      </div>
    </div>`;

  return [
    {
      id: 'events',
      surface: 'EVENT_LIST',
      title: 'Events',
      html: page('Events', events, 'Events'),
    },
    {
      id: 'card',
      surface: 'FIGHT_CARD',
      title: 'Fight card',
      html: page('Fight card', card, 'Events'),
    },
    {
      id: 'board',
      surface: 'LEADERBOARD',
      title: 'Leaderboard',
      html: page('Leaderboard', board, 'Leaderboard'),
    },
  ];
}

/** The real brand mark, inlined so the document needs no network at render time. */
export async function loadMarkDataUri(logoPath: string): Promise<string> {
  const bytes = await readFile(logoPath);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
