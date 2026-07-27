import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A deterministic stand-in for the public Combat Reviews site.
 *
 * CI must never depend on a deployed application: a suite whose result changes
 * when somebody ships a release is not a test of this repository. So every
 * browser-side property the adapter claims — method blocking, host blocking,
 * readiness, redaction, popups, downloads, form submission — is proven against
 * these pages instead.
 *
 * The markup mirrors the anchors actually observed on the public site
 * (`#main`, `#card`, `#card-talk`, `section[aria-label="Recent events"]`,
 * `[aria-label="Account menu"]`) so a specification written against the
 * fixture and one written against the live site differ only in `baseUrl`.
 *
 * Everything is fixed: no clock, no randomness, no external asset, no
 * webfont. Two runs produce identical bytes, which is what makes the
 * deterministic-screenshot test meaningful.
 */

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#05070a; color:#e9edf2; font-family: Arial, Helvetica, sans-serif; }
  header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #1b2029; background:#080b11; }
  .brand { font-weight:bold; letter-spacing:.06em; color:#ff3b30; }
  .account { width:34px; height:34px; border-radius:50%; background:#232a35; }
  main { padding:12px; }
  h1 { font-size:20px; margin:6px 0 12px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.16em; color:#9aa5b4; margin:16px 0 8px; }
  article { border:1px solid #1b2029; border-radius:10px; padding:10px; margin-bottom:8px; background:#0b0f16; }
  .row { display:flex; justify-content:space-between; align-items:center; }
  .pill { font-size:11px; padding:3px 8px; border-radius:99px; background:#161c26; color:#9aa5b4; }
  .bar { height:8px; border-radius:4px; background:#161c26; margin-top:6px; }
  .bar > span { display:block; height:8px; border-radius:4px; background:#ff3b30; }
  footer { padding:12px; color:#5c6675; font-size:11px; border-top:1px solid #1b2029; }
  .comment { border-left:3px solid #ff3b30; padding:6px 10px; margin-bottom:8px; background:#0b0f16; }
  .who { font-size:11px; color:#9aa5b4; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${STYLE}</style></head>
<body>
<header>
  <span class="brand">COMBAT REVIEWS</span>
  <span class="account" aria-label="Account menu" data-account-name="fixture-operator"></span>
</header>
${body}
<footer>Fixture site — deterministic content, no live data.</footer>
<script>
  // The fixture behaves like the real deployment: it posts analytics on load
  // and opens a presence channel. Both must be refused by the adapter, and the
  // page must still render when they are.
  fetch('/api/track', { method: 'POST', body: '{}' }).catch(function () {});
  fetch('/api/events/fixture/room', { method: 'PUT', body: '{}' }).catch(function () {});
  navigator.sendBeacon && navigator.sendBeacon('/api/beacon', '{}');
</script>
</body></html>`;
}

const EVENTS_PAGE = page(
  'Events',
  `<main id="main">
  <h1>This weekend</h1>
  <section aria-label="Recent events">
    ${[
      ['ONE Friday Fights 164', 'Fri 20:00', 'MUAY THAI'],
      ['BKFC Fight Night Newcastle', 'Sat 19:00', 'BARE KNUCKLE'],
      ['ADCC Romania Open 2026', 'Sat 10:00', 'GRAPPLING'],
      ['Boxing — 02 Aug 2026', 'Sun 22:00', 'BOXING'],
    ]
      .map(
        ([name, when, kind]) => `<article>
      <div class="row"><strong>${name}</strong><span class="pill">${kind}</span></div>
      <div class="who">${when}</div>
      <button aria-label="Not following ${name}" class="pill">Follow</button>
    </article>`,
      )
      .join('')}
  </section>
  <p><a href="/events/fixture-card">Open the fixture card</a></p>
  <p><a href="/download/report.pdf" download>Download the card (must be refused)</a></p>
  <p><a href="https://elsewhere.invalid/offsite" id="offsite">Off-site link (must be refused)</a></p>
  <p><a href="/events/fixture-card" target="_blank" id="popup-link">Open in new window</a></p>
  <p><a href="/predictions/submit" id="control-link">Submit a prediction (a control, not navigation)</a></p>
  <!-- A subresource on a host the allowlist does not contain. The route
       handler must abort it before DNS is ever consulted. -->
  <img src="https://elsewhere.invalid/pixel.png" alt="" width="1" height="1">
</main>`,
);

const EVENT_DETAIL_PAGE = page(
  'Fixture card',
  `<main id="main">
  <h1>ONE Friday Fights 164</h1>
  <h2>Fight card</h2>
  <section id="card">
    ${[
      ['Nabil Anane', 'Suakim', 'MAIN'],
      ['Islay Bomogao', 'Yodudon', 'CO-MAIN'],
      ['Aliff Sor', 'Sam-A', 'FEATURE'],
    ]
      .map(
        ([a, b, slot]) => `<article>
      <div class="row"><strong>${a}</strong><span class="pill">${slot}</span></div>
      <div class="row"><strong>${b}</strong><span class="who">vs</span></div>
    </article>`,
      )
      .join('')}
  </section>
  <h2>Card talk</h2>
  <section id="card-talk">
    <div class="comment"><div class="who">posted by a community member</div><p>This is user-written content that must never reach an advertisement unless the screen is explicitly sanitised.</p></div>
    <div class="comment"><div class="who">posted by a community member</div><p>Second opinion, also user-written, also redacted by default.</p></div>
  </section>
  <h2>Sign in</h2>
  <form id="fixture-form" method="post" action="/api/comment">
    <input name="comment" value="">
    <button type="submit" id="submit-comment">Post comment</button>
  </form>
  <script>
    // A deliberately hostile page: it tries to submit its own form on load,
    // three ways. If any succeeds the browser navigates to /api/comment, the
    // readiness selector disappears and the capture fails — so a passing
    // capture of this page is itself the proof that submission was blocked.
    (function () {
      var form = document.getElementById('fixture-form');
      try { form.submit(); } catch (e) {}
      try { form.requestSubmit(); } catch (e) {}
      try { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch (e) {}
    })();
  </script>
</main>`,
);

const PREDICTIONS_PAGE = page(
  'Leaderboard',
  `<main id="main">
  <h1>Leaderboard</h1>
  <h2>Community picks</h2>
  ${[
    ['Anane by decision', 62],
    ['Suakim by KO', 24],
    ['Draw', 14],
  ]
    .map(
      ([label, pct]) => `<article>
    <div class="row"><strong>${label}</strong><span class="pill">${String(pct)}%</span></div>
    <div class="bar"><span style="width:${String(pct)}%"></span></div>
  </article>`,
    )
    .join('')}
</main>`,
);

const USER_CONTENT_PAGE = page(
  'Forums',
  `<main id="main">
  <h1>Forums</h1>
  <section id="card-talk">
    <div class="comment" data-user-content>
      <div class="who" data-account-name="someone">a community member</div>
      <p>User-written thread body. Redacted unless the screen declares APP_DISCUSSION_SANITISED.</p>
    </div>
  </section>
</main>`,
);

const ROUTES: Readonly<Record<string, string>> = {
  '/events': EVENTS_PAGE,
  '/events/fixture-card': EVENT_DETAIL_PAGE,
  '/leaderboard': PREDICTIONS_PAGE,
  '/forums': USER_CONTENT_PAGE,
};

export interface FixtureSite {
  readonly baseUrl: string;
  readonly host: string;
  readonly port: number;
  /** Methods the server actually received, so a test can prove none was a mutation. */
  readonly receivedMethods: readonly string[];
  close(): Promise<void>;
}

/**
 * Starts the fixture site on an ephemeral port.
 *
 * The server records every method it receives. That is the independent half of
 * the mutation-blocking proof: the adapter says it aborted the POST, and the
 * server confirms it never arrived.
 */
export async function startFixtureSite(): Promise<FixtureSite> {
  const received: string[] = [];

  const server: Server = createServer((request, response) => {
    received.push(`${request.method ?? 'GET'} ${(request.url ?? '/').split('?')[0] ?? '/'}`);
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const method = (request.method ?? 'GET').toUpperCase();

    if (path === '/download/report.pdf') {
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="report.pdf"',
      });
      response.end('%PDF-1.4 fixture');
      return;
    }
    if (path.startsWith('/api/')) {
      response.writeHead(method === 'GET' ? 200 : 204, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    const body = ROUTES[path];
    if (!body) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page('Not found', '<main id="main"><h1>Not found</h1></main>'));
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    host: '127.0.0.1',
    port: address.port,
    get receivedMethods() {
      return [...received];
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
