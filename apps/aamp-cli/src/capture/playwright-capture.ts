import { existsSync } from 'node:fs';

import type { Browser, BrowserContext, Page } from 'playwright';

import {
  screenIsEnabled,
  viewportFor,
  type AppCaptureScreen,
  type AppCaptureSpecification,
  type BlockedRequestRecord,
  type CaptureFailure,
  type CaptureFailureKind,
  type CaptureRedactionReport,
  type ViewportPresetKey,
} from './capture-contracts';
import { safeUrlParts } from './capture-safety';
import {
  DETERMINISM_STYLESHEET,
  FREEZE_PAGE_FUNCTION,
  REDACTION_PAGE_FUNCTION,
  buildRedactionReport,
  buildRedactionTargets,
  redactionSatisfied,
} from './redaction';

/**
 * The read-only browser.
 *
 * Every guarantee this milestone makes about capture lives in this file, and
 * each one is structural rather than behavioural — the difference between "the
 * code does not click submit" and "there is no path by which a submit could
 * happen".
 *
 * - **Method.** One route handler sees every request the page makes. GET and
 *   HEAD continue; everything else is aborted and counted. The public Combat
 *   Reviews site fires `POST /api/track` and a presence beacon on load, so
 *   this is not hypothetical — it fires on the very first navigation, the
 *   requests are refused, and the page still renders.
 * - **Host.** The same handler refuses any host outside the specification's
 *   allowlist, which is what makes a cross-origin document impossible rather
 *   than merely unvisited.
 * - **Interaction.** There is no click. `FOLLOW_LINK` reads an anchor's `href`,
 *   verifies it is same-origin and lands where the specification said, and
 *   navigates directly. No handler on the element ever runs.
 * - **Submission.** An init script neutralises `HTMLFormElement.submit` and
 *   cancels `submit` events in the capture phase, so a page that tries to post
 *   on load cannot, and a stray interaction could not either.
 * - **State.** A fresh context per screen, never persisted. No `userDataDir`,
 *   no `storageState`, no download acceptance, service workers blocked. TLS
 *   verification and CSP are left at their defaults and are never relaxed.
 *
 * Cleanup runs on success, failure and cancellation: the context and browser
 * are closed in a `finally`, so an aborted session leaves no browser behind.
 */

/**
 * Route segments that mark a link as a control rather than navigation.
 *
 * Matched against whole path **segments**, never as substrings. A substring
 * test refuses `/events/post-fight-analysis` because it contains "post", and a
 * deny-list that fires on ordinary content is one an operator works around.
 * `/predictions/submit` is caught because a segment *equals* `submit`.
 */
const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'predict',
  'predictions',
  'follow',
  'unfollow',
  'comment',
  'comments',
  'reply',
  'login',
  'log-in',
  'signin',
  'sign-in',
  'signup',
  'sign-up',
  'register',
  'buy',
  'purchase',
  'checkout',
  'subscribe',
  'vote',
  'upvote',
  'downvote',
  'delete',
  'remove',
  'submit',
  'logout',
  'log-out',
  'settings',
  'account',
  'admin',
]);

/**
 * Phrases in an element's accessible name that mark it as a control.
 *
 * Applied to `aria-label`/`title` only — never to an `href`, which is checked
 * by segment above. Substring matching is right here because an accessible
 * name is prose written for a human.
 */
const UNSAFE_LABEL_PATTERN =
  /(follow|unfollow|predict|comment|reply|sign in|sign up|log in|log out|logout|register|subscribe|buy|purchase|checkout|vote|delete|remove|submit|post a|account menu)/i;

function pathLooksLikeControl(pathname: string): boolean {
  return pathname
    .toLowerCase()
    .split('/')
    .filter((segment) => segment.length > 0)
    .some((segment) => UNSAFE_PATH_SEGMENTS.has(segment));
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;
const NETWORK_IDLE_GRACE_MS = 8_000;
const FONTS_READY_TIMEOUT_MS = 8_000;

export interface CapturedScreenImage {
  readonly assetId: string;
  readonly screen: AppCaptureScreen;
  readonly pngBytes: Buffer;
  readonly redaction: CaptureRedactionReport;
  readonly viewport: ViewportPresetKey;
  readonly sourceHost: string;
  readonly sourcePath: string;
  readonly queryPresent: boolean;
  readonly croppedToSelector: boolean;
}

export interface CaptureRunResult {
  readonly images: readonly CapturedScreenImage[];
  readonly failures: readonly CaptureFailure[];
  readonly blockedRequests: readonly BlockedRequestRecord[];
  readonly skippedDisabled: readonly string[];
  readonly screensEnabled: number;
  readonly browserEngine: string;
  readonly browserVersion: string;
  readonly playwrightVersion: string;
}

/** The seam a test uses to run without downloading a browser. Defaults to real Chromium. */
export interface BrowserLauncher {
  launch(options: { readonly timeoutMs: number }): Promise<Browser>;
  readonly engine: string;
  readonly playwrightVersion: string;
}

export interface CaptureRunOptions {
  readonly specification: AppCaptureSpecification;
  readonly launcher?: BrowserLauncher;
  readonly signal?: AbortSignal;
  readonly launchTimeoutMs?: number;
  readonly onProgress?: (message: string) => void;
}

export class CaptureAbortedError extends Error {
  constructor() {
    super('The capture was cancelled');
    this.name = 'CaptureAbortedError';
  }
}

export class BrowserUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `No Chromium build is available to Playwright, so nothing can be captured: ${detail}\nInstall one with: npx playwright install chromium`,
    );
    this.name = 'BrowserUnavailableError';
  }
}

function playwrightVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-member-access
    return String((require('playwright/package.json') as { version: string }).version);
  } catch {
    return 'unknown';
  }
}

/** The real launcher. Kept behind the seam so no test needs a browser to run. */
export function chromiumLauncher(): BrowserLauncher {
  return {
    engine: 'chromium',
    playwrightVersion: playwrightVersion(),
    async launch(options) {
      // Required lazily: importing Playwright costs real time, and a run that
      // fails specification validation should never pay it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { chromium } = require('playwright') as typeof import('playwright');
      try {
        return await chromium.launch({ headless: true, timeout: options.timeoutMs });
      } catch (error) {
        throw new BrowserUnavailableError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/**
 * Whether a Chromium build is actually present, so tests can skip loudly.
 *
 * Synchronous deliberately: the suites that need it decide at module scope
 * whether to run, and this package compiles to CommonJS, where a top-level
 * `await` is not available.
 */
export function chromiumIsAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('playwright') as typeof import('playwright');
    const path = chromium.executablePath();
    return path ? existsSync(path) : false;
  } catch {
    return false;
  }
}

function failure(kind: CaptureFailureKind, assetId: string, detail: string): CaptureFailure {
  return { kind, assetId, detail };
}

/**
 * Resolves a screen's declared path against the base URL.
 *
 * Uses `URL` rather than string joining so a path containing `..`, a protocol
 * or an authority is normalised before the host check rather than after it.
 */
export function resolveScreenUrl(specification: AppCaptureSpecification, path: string): URL {
  return new URL(path, specification.baseUrl);
}

/**
 * The counter behind `blockedRequests`.
 *
 * Aggregated by `(method, host, path, reason)` because a single-page app fires
 * the same analytics beacon dozens of times, and a report with sixty identical
 * lines is one nobody reads to the end.
 */
class BlockedRequestLedger {
  private readonly entries = new Map<string, BlockedRequestRecord>();

  record(method: string, url: string, reason: BlockedRequestRecord['reason']): void {
    const { host, path } = safeUrlParts(url);
    const key = `${method} ${host} ${path} ${reason}`;
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.set(key, { ...existing, count: existing.count + 1 });
      return;
    }
    this.entries.set(key, { method, host, path, reason, count: 1 });
  }

  /** Sorted, so two runs of the same specification produce identical reports. */
  toArray(): readonly BlockedRequestRecord[] {
    return [...this.entries.values()].sort(
      (left, right) =>
        left.host.localeCompare(right.host) ||
        left.path.localeCompare(right.path) ||
        left.method.localeCompare(right.method) ||
        left.reason.localeCompare(right.reason),
    );
  }
}

/**
 * Installed before any page script runs.
 *
 * Two things a page can do entirely on its own that this milestone forbids:
 * submit a form, and open a window. Both are removed at the prototype level in
 * the page's realm, so neither depends on the adapter avoiding an interaction.
 */
export const GUARD_INIT_SCRIPT = `(() => {
  const cancel = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  window.addEventListener('submit', cancel, true);
  try {
    HTMLFormElement.prototype.submit = function () { /* refused by AAMP read-only capture */ };
    HTMLFormElement.prototype.requestSubmit = function () { /* refused by AAMP read-only capture */ };
  } catch { /* a frozen prototype is already safe */ }
  try {
    window.open = function () { return null; };
  } catch { /* nothing to do */ }
  try {
    navigator.sendBeacon = function () { return false; };
  } catch { /* nothing to do */ }
})();`;

async function newIsolatedContext(
  browser: Browser,
  specification: AppCaptureSpecification,
  viewport: ViewportPresetKey,
  ledger: BlockedRequestLedger,
): Promise<BrowserContext> {
  const preset = viewportFor(viewport);
  const allowed = new Set(specification.allowedHosts.map((host) => host.toLowerCase()));

  const context = await browser.newContext({
    viewport: { width: preset.widthCssPx, height: preset.heightCssPx },
    deviceScaleFactor: preset.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
    forcedColors: 'none',
    colorScheme: 'dark',
    acceptDownloads: false,
    serviceWorkers: 'block',
    javaScriptEnabled: true,
    // TLS verification and CSP are left at Playwright's defaults on purpose.
    // Nothing here may relax either.
  });

  await context.addInitScript(GUARD_INIT_SCRIPT);

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method().toUpperCase();

    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        // data: and blob: are inline page content, not network egress.
        await route.continue();
        return;
      }
      host = parsed.hostname.toLowerCase();
    } catch {
      ledger.record(method, url, 'HOST_NOT_ALLOWED');
      await route.abort('blockedbyclient');
      return;
    }

    if (!allowed.has(host)) {
      ledger.record(method, url, 'HOST_NOT_ALLOWED');
      await route.abort('blockedbyclient');
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      ledger.record(method, url, 'NON_READ_METHOD');
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  // A popup is a page this session never asked for. Closing it immediately is
  // both the refusal and the record of it.
  //
  // The `page` event fires for *every* new page in the context, including the
  // one this adapter opens with `newPage()`. `opener()` is what tells them
  // apart: a page the browser created on a page's behalf has one, and a page
  // we created does not. Without this check the adapter closes its own page
  // and every navigation dies with `ERR_ABORTED`.
  context.on('page', (page) => {
    void page
      .opener()
      .then((opener) => {
        if (!opener) return;
        ledger.record('GET', page.url() || 'about:blank', 'POPUP');
        return page.close().catch(() => undefined);
      })
      .catch(() => undefined);
  });

  return context;
}

function attachPageGuards(page: Page, ledger: BlockedRequestLedger): void {
  page.on('download', (download) => {
    ledger.record('GET', download.url(), 'DOWNLOAD');
    void download.cancel().catch(() => undefined);
  });
  page.on('dialog', (dialog) => {
    void dialog.dismiss().catch(() => undefined);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CaptureAbortedError();
}

/**
 * Everything that happens to one screen, in order.
 *
 * Ordered so that nothing irreversible follows something unverified: the host
 * is checked before the page is trusted, readiness before measurement,
 * redaction before the shutter, and the required-redaction verdict before the
 * image is allowed to exist as a return value.
 */
async function captureOneScreen(
  browser: Browser,
  specification: AppCaptureSpecification,
  screen: AppCaptureScreen,
  ledger: BlockedRequestLedger,
  signal: AbortSignal | undefined,
): Promise<CapturedScreenImage> {
  const target = resolveScreenUrl(specification, screen.path);
  const allowed = new Set(specification.allowedHosts.map((host) => host.toLowerCase()));
  if (!allowed.has(target.hostname.toLowerCase())) {
    throw failureError('DISALLOWED_HOST', `${target.hostname} is not in allowedHosts`);
  }

  const context = await newIsolatedContext(browser, specification, screen.viewport, ledger);
  try {
    const page = await context.newPage();
    attachPageGuards(page, ledger);
    page.setDefaultTimeout(screen.timeoutMs);
    page.setDefaultNavigationTimeout(screen.timeoutMs);

    throwIfAborted(signal);
    try {
      await page.goto(target.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: screen.timeoutMs,
      });
    } catch (error) {
      throw failureError(
        'NAVIGATION_FAILURE',
        `could not open ${target.pathname}: ${message(error)}`,
      );
    }

    await runNavigationSteps(page, screen, allowed);

    // The document that actually loaded, not the one that was requested — a
    // redirect is the ordinary way a capture ends up somewhere else.
    const landed = new URL(page.url());
    if (!allowed.has(landed.hostname.toLowerCase())) {
      throw failureError(
        'DISALLOWED_HOST',
        `navigation ended on ${landed.hostname}, which is not in allowedHosts`,
      );
    }

    try {
      await page.waitForSelector(screen.readinessSelector, {
        state: 'attached',
        timeout: screen.timeoutMs,
      });
    } catch (error) {
      throw failureError(
        'READINESS_FAILURE',
        `readiness selector "${screen.readinessSelector}" never appeared: ${message(error)}`,
      );
    }

    // Best-effort quiet: a site whose analytics posts are being refused may
    // never reach a strict network idle, and that is not a capture failure.
    await page
      .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_GRACE_MS })
      .catch(() => undefined);
    // Fonts settle after layout, and a screenshot taken mid-swap shows the
    // fallback face. Best-effort: a page with no webfonts reports loaded
    // immediately, and one that never finishes is not worth failing over.
    await page
      .waitForFunction(() => document.fonts.status === 'loaded', undefined, {
        timeout: FONTS_READY_TIMEOUT_MS,
      })
      .catch(() => undefined);

    await page.addStyleTag({ content: DETERMINISM_STYLESHEET }).catch(() => undefined);
    await page.evaluate(FREEZE_PAGE_FUNCTION).catch(() => undefined);
    if (screen.settleMs > 0) await page.waitForTimeout(screen.settleMs);

    throwIfAborted(signal);

    const targets = buildRedactionTargets(screen);
    let outcome;
    try {
      outcome = await page.evaluate(
        REDACTION_PAGE_FUNCTION,
        targets.map((entry) => ({ selector: entry.selector, required: entry.required })),
      );
    } catch (error) {
      throw failureError('REDACTION_FAILURE', `redaction could not run: ${message(error)}`);
    }

    const redaction = buildRedactionReport({ screen, targets, outcome });
    if (!redactionSatisfied(redaction)) {
      throw failureError(
        'REDACTION_FAILURE',
        `required redaction selectors matched nothing: ${redaction.unsatisfiedRequiredSelectors.join(', ')}. The page has changed shape and something that must be hidden was not.`,
      );
    }

    throwIfAborted(signal);

    let pngBytes: Buffer;
    try {
      if (screen.cropSelector) {
        const locator = page.locator(screen.cropSelector).first();
        await locator.waitFor({ state: 'attached', timeout: screen.timeoutMs });
        await locator.scrollIntoViewIfNeeded({ timeout: screen.timeoutMs });
        // The redaction layer is position:fixed against the viewport, so a
        // crop taken after a scroll must re-run it against the new offsets.
        await page.evaluate(clearRedactionLayer).catch(() => undefined);
        const rerun = await page.evaluate(
          REDACTION_PAGE_FUNCTION,
          targets.map((entry) => ({ selector: entry.selector, required: entry.required })),
        );
        const rerunReport = buildRedactionReport({ screen, targets, outcome: rerun });
        if (!redactionSatisfied(rerunReport)) {
          throw failureError(
            'REDACTION_FAILURE',
            `after scrolling to the crop region, required redaction selectors matched nothing: ${rerunReport.unsatisfiedRequiredSelectors.join(', ')}`,
          );
        }
        pngBytes = await locator.screenshot({
          type: 'png',
          animations: 'disabled',
          caret: 'hide',
          timeout: screen.timeoutMs,
        });
      } else {
        pngBytes = await page.screenshot({
          type: 'png',
          fullPage: false,
          animations: 'disabled',
          caret: 'hide',
          timeout: screen.timeoutMs,
        });
      }
    } catch (error) {
      // A redaction verdict raised inside the crop path keeps its own kind:
      // relabelling it "screenshot failed" would send an operator to look at
      // the encoder instead of at the selector that stopped matching.
      if (error instanceof ScreenFailure) throw error;
      throw failureError('SCREENSHOT_FAILURE', `screenshot failed: ${message(error)}`);
    }

    const parts = safeUrlParts(page.url());
    return {
      assetId: screen.assetId,
      screen,
      pngBytes,
      redaction,
      viewport: screen.viewport,
      sourceHost: parts.host,
      sourcePath: parts.path,
      queryPresent: parts.queryPresent,
      croppedToSelector: screen.cropSelector !== undefined,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Removes a previous redaction pass, so a re-run after scrolling does not double-paint. */
const clearRedactionLayer = function clearLayer(): void {
  const layers = document.querySelectorAll('[data-aamp-redaction-layer]');
  for (const layer of Array.prototype.slice.call(layers) as Element[]) layer.remove();
};

/**
 * Safe navigation, and only safe navigation.
 *
 * `FOLLOW_LINK` never dispatches a click. It reads the anchor's `href`,
 * proves it is same-origin and starts with the path the specification
 * declared, checks the element is an anchor rather than a button, refuses
 * anything whose destination or accessible name looks like a control, and
 * then navigates directly. A click would run the page's own handlers; a
 * `goto` cannot.
 */
async function runNavigationSteps(
  page: Page,
  screen: AppCaptureScreen,
  allowed: ReadonlySet<string>,
): Promise<void> {
  for (const step of screen.navigation) {
    if (step.kind === 'SCROLL_TO') {
      try {
        await page
          .locator(step.selector)
          .first()
          .scrollIntoViewIfNeeded({ timeout: screen.timeoutMs });
      } catch (error) {
        throw failureError(
          'NAVIGATION_FAILURE',
          `could not scroll to "${step.selector}": ${message(error)}`,
        );
      }
      continue;
    }

    const locator = page.locator(step.selector).first();
    let descriptor: { tag: string; href: string | null; label: string } | null;
    try {
      await locator.waitFor({ state: 'attached', timeout: screen.timeoutMs });
      descriptor = await locator.evaluate((node: Element) => ({
        tag: node.tagName.toLowerCase(),
        href: node.getAttribute('href'),
        // The accessible name only, bounded — never the element's text, and
        // never the href, which is checked by path segment instead.
        label: (node.getAttribute('aria-label') ?? node.getAttribute('title') ?? '').slice(0, 120),
      }));
    } catch (error) {
      throw failureError(
        'NAVIGATION_FAILURE',
        `navigation target "${step.selector}" was not found: ${message(error)}`,
      );
    }

    if (!descriptor || descriptor.tag !== 'a' || !descriptor.href) {
      throw failureError(
        'MUTATION_ATTEMPTED',
        `navigation target "${step.selector}" is a <${descriptor?.tag ?? 'unknown'}>, not an anchor with an href. Only link navigation is permitted; anything else could be a control.`,
      );
    }

    let resolved: URL;
    try {
      resolved = new URL(descriptor.href, page.url());
    } catch {
      throw failureError(
        'NAVIGATION_FAILURE',
        `navigation target "${step.selector}" has an unreadable href`,
      );
    }

    if (!allowed.has(resolved.hostname.toLowerCase())) {
      throw failureError(
        'DISALLOWED_HOST',
        `"${step.selector}" points at ${resolved.hostname}, which is not in allowedHosts`,
      );
    }
    if (!resolved.pathname.startsWith(step.expectPathPrefix ?? '/')) {
      throw failureError(
        'NAVIGATION_FAILURE',
        `"${step.selector}" points at ${resolved.pathname}, which does not start with the declared ${step.expectPathPrefix ?? '/'}`,
      );
    }
    if (pathLooksLikeControl(resolved.pathname)) {
      throw failureError(
        'MUTATION_ATTEMPTED',
        `"${step.selector}" resolves to ${resolved.pathname}, whose route reads as a control rather than navigation, so it is refused`,
      );
    }
    if (descriptor.label.length > 0 && UNSAFE_LABEL_PATTERN.test(descriptor.label)) {
      throw failureError(
        'MUTATION_ATTEMPTED',
        `"${step.selector}" is labelled as a control rather than navigation, so it is refused`,
      );
    }

    try {
      await page.goto(resolved.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: screen.timeoutMs,
      });
    } catch (error) {
      throw failureError(
        'NAVIGATION_FAILURE',
        `could not follow "${step.selector}" to ${resolved.pathname}: ${message(error)}`,
      );
    }
  }
}

class ScreenFailure extends Error {
  constructor(
    public readonly kind: CaptureFailureKind,
    detail: string,
  ) {
    super(detail);
    this.name = 'ScreenFailure';
  }
}

function failureError(kind: CaptureFailureKind, detail: string): ScreenFailure {
  return new ScreenFailure(kind, detail);
}

function message(error: unknown): string {
  // Playwright errors carry a long call log; only the first line is diagnostic
  // and the remainder can echo page content.
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.slice(0, 300) ?? 'unknown error';
}

/**
 * Runs a whole specification.
 *
 * A disabled screen is skipped and named. A failing optional screen is
 * recorded and the session continues; a failing required screen is recorded
 * and stops the session, because a library that is missing something somebody
 * marked required is a library to fix rather than one to half-produce.
 */
export async function runCapture(options: CaptureRunOptions): Promise<CaptureRunResult> {
  const { specification, signal } = options;
  const launcher = options.launcher ?? chromiumLauncher();
  const ledger = new BlockedRequestLedger();
  const images: CapturedScreenImage[] = [];
  const failures: CaptureFailure[] = [];
  const skippedDisabled: string[] = [];

  const enabled = specification.screens.filter((screen) => {
    if (screenIsEnabled(screen)) return true;
    skippedDisabled.push(screen.assetId);
    return false;
  });

  let browser: Browser | undefined;
  try {
    browser = await launcher.launch({
      timeoutMs: options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    });

    for (const screen of enabled) {
      throwIfAborted(signal);
      options.onProgress?.(`capturing ${screen.assetId} (${screen.role})`);
      try {
        images.push(await captureOneScreen(browser, specification, screen, ledger, signal));
      } catch (error) {
        if (error instanceof CaptureAbortedError) throw error;
        const kind: CaptureFailureKind =
          error instanceof ScreenFailure ? error.kind : 'SCREENSHOT_FAILURE';
        failures.push(failure(kind, screen.assetId, message(error)));
        if (screen.required) break;
      }
    }

    return {
      images,
      failures,
      blockedRequests: ledger.toArray(),
      skippedDisabled,
      screensEnabled: enabled.length,
      browserEngine: launcher.engine,
      browserVersion: browser.version(),
      playwrightVersion: launcher.playwrightVersion,
    };
  } finally {
    // Success, failure and cancellation alike. A browser left running is a
    // process leak that outlives the CLI.
    if (browser) await browser.close().catch(() => undefined);
  }
}
