import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseCaptureSpecification, type AppCaptureSpecification } from './capture-contracts';
import { startFixtureSite, type FixtureSite } from './fixture-site';
import {
  CaptureAbortedError,
  GUARD_INIT_SCRIPT,
  chromiumIsAvailable,
  runCapture,
} from './playwright-capture';

/**
 * The read-only guarantees, proven in a real browser against a local fixture.
 *
 * Nothing here touches the deployed Combat Reviews site. That is deliberate:
 * a suite whose result changes when somebody ships a release is not a test of
 * this repository. The fixture reproduces the shapes actually observed on the
 * public site — including the fact that it POSTs analytics on load — so the
 * guarantees are exercised against the same behaviour without the dependency.
 *
 * Skips loudly when no Chromium is installed, rather than passing quietly.
 */

const available = chromiumIsAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  // eslint-disable-next-line no-console -- a silently skipped browser suite is worse than a noisy one
  console.warn(
    '[capture-browser] SKIPPED: no Chromium build is available to Playwright. Install one with "npx playwright install chromium".',
  );
}

let site: FixtureSite;

beforeAll(async () => {
  if (available) site = await startFixtureSite();
}, 60_000);

afterAll(async () => {
  if (site) await site.close();
});

function spec(overrides: Partial<Record<string, unknown>> = {}): AppCaptureSpecification {
  return parseCaptureSpecification({
    specificationVersion: 1,
    name: 'fixture-capture',
    baseUrl: site.baseUrl,
    allowedHosts: ['127.0.0.1'],
    library: 'fixture',
    screens: [
      {
        assetId: 'screen-events',
        path: '/events',
        role: 'APP_EVENT_LIST',
        viewport: 'PHONE_PORTRAIT_1080X1920',
        description: 'events list',
        readinessSelector: 'section[aria-label="Recent events"]',
        timeoutMs: 20_000,
        settleMs: 200,
        required: true,
      },
    ],
    ...overrides,
  });
}

function screenSpec(screen: Record<string, unknown>): AppCaptureSpecification {
  return spec({
    screens: [
      {
        assetId: 'screen-under-test',
        viewport: 'PHONE_PORTRAIT_1080X1920',
        description: 'under test',
        timeoutMs: 15_000,
        settleMs: 200,
        required: true,
        ...screen,
      },
    ],
  });
}

suite('read-only browser capture', () => {
  it('captures a screen and blocks every mutation the page attempts', async () => {
    const result = await runCapture({ specification: spec() });

    expect(result.failures).toEqual([]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.pngBytes.length).toBeGreaterThan(2_048);

    // The fixture posts analytics and opens a presence channel on load, the
    // way the real deployment does. Both must have been aborted.
    const methods = result.blockedRequests.map((entry) => entry.method);
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(
      result.blockedRequests.every(
        (entry) => entry.reason === 'NON_READ_METHOD' || entry.reason === 'HOST_NOT_ALLOWED',
      ),
    ).toBe(true);

    // The independent half of the proof: the server confirms nothing but
    // reads ever arrived.
    const received = site.receivedMethods;
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((entry) => entry.startsWith('GET '))).toBe(true);
  }, 90_000);

  it('blocks a subresource on a host outside the allowlist', async () => {
    const result = await runCapture({ specification: spec() });
    const offsite = result.blockedRequests.find((entry) => entry.reason === 'HOST_NOT_ALLOWED');
    expect(offsite).toBeDefined();
    expect(offsite!.host).toBe('elsewhere.invalid');
  }, 90_000);

  it('never records a query string in a blocked-request report', async () => {
    const result = await runCapture({ specification: spec() });
    for (const entry of result.blockedRequests) {
      expect(entry.path).not.toContain('?');
    }
  }, 90_000);

  it('refuses a screen whose readiness selector never appears', async () => {
    const result = await runCapture({
      specification: screenSpec({
        path: '/events',
        role: 'APP_EVENT_LIST',
        readinessSelector: '#never-present',
        timeoutMs: 3_000,
      }),
    });
    expect(result.images).toHaveLength(0);
    expect(result.failures[0]!.kind).toBe('READINESS_FAILURE');
  }, 90_000);

  it('refuses a navigation target that is a control rather than a link', async () => {
    const result = await runCapture({
      specification: screenSpec({
        path: '/events',
        role: 'APP_EVENT_LIST',
        readinessSelector: '#main',
        navigation: [
          { kind: 'FOLLOW_LINK', selector: '#control-link', expectPathPrefix: '/predictions' },
        ],
      }),
    });
    expect(result.failures[0]!.kind).toBe('MUTATION_ATTEMPTED');
  }, 90_000);

  it('refuses a navigation target that is not an anchor', async () => {
    const result = await runCapture({
      specification: screenSpec({
        path: '/events',
        role: 'APP_EVENT_LIST',
        readinessSelector: '#main',
        navigation: [{ kind: 'FOLLOW_LINK', selector: 'button', expectPathPrefix: '/events' }],
      }),
    });
    expect(result.failures[0]!.kind).toBe('MUTATION_ATTEMPTED');
    expect(result.failures[0]!.detail).toContain('not an anchor');
  }, 90_000);

  it('refuses to follow a link that leaves the allowed host', async () => {
    const result = await runCapture({
      specification: screenSpec({
        path: '/events',
        role: 'APP_EVENT_LIST',
        readinessSelector: '#main',
        navigation: [{ kind: 'FOLLOW_LINK', selector: '#offsite', expectPathPrefix: '/offsite' }],
      }),
    });
    expect(result.failures[0]!.kind).toBe('DISALLOWED_HOST');
  }, 90_000);

  it('follows a genuine link by navigating to its href, never by clicking', async () => {
    const result = await runCapture({
      specification: screenSpec({
        path: '/events',
        role: 'APP_FIGHT_CARD',
        readinessSelector: '#card',
        navigation: [
          {
            kind: 'FOLLOW_LINK',
            selector: 'a[href="/events/fixture-card"]',
            expectPathPrefix: '/events/',
          },
        ],
      }),
    });
    expect(result.failures).toEqual([]);
    expect(result.images[0]!.sourcePath).toBe('/events/fixture-card');
  }, 90_000);

  it('survives a page that tries to submit its own form three ways', async () => {
    // The fixture card page calls submit(), requestSubmit() and dispatches a
    // submit event on load. If any had worked the browser would have left the
    // page and #card would be gone, so a successful capture is the proof.
    const result = await runCapture({
      specification: screenSpec({
        path: '/events/fixture-card',
        role: 'APP_FIGHT_CARD',
        readinessSelector: '#card',
      }),
    });
    expect(result.failures).toEqual([]);
    expect(result.images[0]!.sourcePath).toBe('/events/fixture-card');
    expect(site.receivedMethods.some((entry) => entry.startsWith('POST'))).toBe(false);
  }, 90_000);

  it('redacts user-written content and account identity by default', async () => {
    const result = await runCapture({
      specification: screenSpec({
        path: '/forums',
        role: 'APP_EVENT_LIST',
        readinessSelector: '#card-talk',
      }),
    });
    expect(result.failures).toEqual([]);
    const redaction = result.images[0]!.redaction;
    expect(redaction.userContentRedactionApplied).toBe(true);
    expect(redaction.totalElementsRedacted).toBeGreaterThan(0);
    // `[data-user-content]` and `[data-account-name]` are both on that page.
    expect(
      redaction.selectors.filter((entry) => entry.matched > 0).map((entry) => entry.selector),
    ).toEqual(expect.arrayContaining(['[data-user-content]', '[data-account-name]']));
  }, 90_000);

  it('fails a screen whose required redaction selector matched nothing', async () => {
    const result = await runCapture({
      specification: screenSpec({
        path: '/events',
        role: 'APP_EVENT_LIST',
        readinessSelector: '#main',
        requiredRedactionSelectors: ['.this-selector-is-not-on-the-page'],
      }),
    });
    expect(result.images).toHaveLength(0);
    expect(result.failures[0]!.kind).toBe('REDACTION_FAILURE');
  }, 90_000);

  it('produces byte-identical screenshots on two runs of the same screen', async () => {
    const first = await runCapture({ specification: spec() });
    const second = await runCapture({ specification: spec() });
    const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
    expect(digest(first.images[0]!.pngBytes)).toBe(digest(second.images[0]!.pngBytes));
  }, 120_000);

  it('skips a disabled discussion screen and names it', async () => {
    const result = await runCapture({
      specification: spec({
        screens: [
          {
            assetId: 'screen-events',
            path: '/events',
            role: 'APP_EVENT_LIST',
            viewport: 'PHONE_PORTRAIT_1080X1920',
            description: 'events list',
            readinessSelector: '#main',
            timeoutMs: 15_000,
            settleMs: 200,
            required: true,
          },
          {
            assetId: 'screen-talk',
            path: '/forums',
            role: 'APP_DISCUSSION_SANITISED',
            viewport: 'PHONE_PORTRAIT_1080X1920',
            description: 'community writing, off by default',
            readinessSelector: '#card-talk',
            requiredRedactionSelectors: ['[data-account-name]'],
            timeoutMs: 15_000,
            settleMs: 200,
            required: false,
          },
        ],
      }),
    });
    expect(result.skippedDisabled).toEqual(['screen-talk']);
    expect(result.screensEnabled).toBe(1);
    expect(result.images.map((image) => image.assetId)).toEqual(['screen-events']);
  }, 90_000);

  it('cancels cleanly, closing the browser', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCapture({ specification: spec(), signal: controller.signal }),
    ).rejects.toBeInstanceOf(CaptureAbortedError);
  }, 90_000);

  it('refuses a download rather than accepting one', async () => {
    const result = await runCapture({
      specification: screenSpec({
        path: '/download/report.pdf',
        role: 'APP_EVENT_LIST',
        readinessSelector: '#main',
        timeoutMs: 8_000,
      }),
    });
    // The navigation cannot produce a document, so the screen fails — and the
    // attempt is recorded rather than silently written to disk.
    expect(result.images).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(['NAVIGATION_FAILURE', 'READINESS_FAILURE']).toContain(result.failures[0]!.kind);
  }, 90_000);
});

suite('the page guard script', () => {
  it('neutralises window.open, form submission and sendBeacon in the page realm', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('playwright') as typeof import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addInitScript(GUARD_INIT_SCRIPT);
      const page = await context.newPage();
      await page.goto(`${site.baseUrl}/events/fixture-card`, { waitUntil: 'domcontentloaded' });

      const verdict = await page.evaluate(() => {
        const form = document.getElementById('fixture-form') as HTMLFormElement;
        const before = window.location.pathname;
        form.submit();
        form.requestSubmit();
        const event = new Event('submit', { bubbles: true, cancelable: true });
        const notPrevented = form.dispatchEvent(event);
        return {
          openedWindow: window.open('/events', '_blank') === null ? 'null' : 'a window',
          beacon: navigator.sendBeacon('/api/beacon', '{}'),
          stayedPut: window.location.pathname === before,
          submitEventPrevented: !notPrevented,
        };
      });

      expect(verdict.openedWindow).toBe('null');
      expect(verdict.beacon).toBe(false);
      expect(verdict.stayedPut).toBe(true);
      expect(verdict.submitEventPrevented).toBe(true);
      await context.close();
    } finally {
      await browser.close();
    }
  }, 90_000);
});
