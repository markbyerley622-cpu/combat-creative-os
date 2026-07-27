import type { AppCaptureScreen, CaptureRedactionReport } from './capture-contracts';

/**
 * What gets hidden before the shutter opens, and why those things.
 *
 * The rule this module implements is narrow and deliberate: **redact what
 * identifies a person, and what a person wrote.** It does not redact
 * everything that could conceivably be account-related, because a default that
 * blacks out a site's primary navigation produces screenshots nobody can use,
 * and an unusable default is one operators turn off.
 *
 * Two consequences worth stating.
 *
 * Follow-state controls are **not** redacted by default. Capture never
 * authenticates — there is no login in this milestone and no credential the
 * adapter could accept — so every capture is anonymous and follow controls
 * read at their logged-out default. Blacking them out would hide a fact about
 * the product rather than a fact about a person. A specification that wants
 * them gone can say so.
 *
 * User-written content **is** redacted on every screen except one that
 * declares `APP_DISCUSSION_SANITISED`, which is off unless a specification
 * turns it on by name.
 */

export interface RedactionTarget {
  readonly selector: string;
  readonly required: boolean;
  readonly origin: 'ACCOUNT_DEFAULT' | 'USER_CONTENT_DEFAULT' | 'SCREEN_DECLARED';
}

/**
 * Identity displays, not navigation.
 *
 * Each entry targets somewhere a name, an address, an avatar or a
 * notification count is rendered. None targets a link, a tab or a control,
 * so applying the whole list to a well-behaved page changes nothing about
 * what the product looks like.
 */
export const DEFAULT_ACCOUNT_REDACTION_SELECTORS: readonly string[] = [
  '[aria-label="Account menu"]',
  '[aria-label*="profile" i]',
  '[aria-label*="notification" i]',
  '[aria-label*="signed in" i]',
  'img[alt*="avatar" i]',
  '[class*="avatar" i]',
  '[data-testid*="avatar" i]',
  '[class*="username" i]',
  '[class*="user-name" i]',
  '[data-testid*="username" i]',
  '[data-account-name]',
];

/** Community writing. Off-limits unless the screen is explicitly the sanitised discussion one. */
export const DEFAULT_USER_CONTENT_REDACTION_SELECTORS: readonly string[] = [
  '[data-user-content]',
  '[class*="comment" i]',
  '[id*="comment" i]',
  '[data-testid*="comment" i]',
];

/**
 * The exact list of selectors a screen will have applied, in a fixed order.
 *
 * Order is defaults-then-declared and stable, so the redaction report reads
 * the same way for every screen and two runs of the same specification produce
 * byte-identical reports.
 */
export function buildRedactionTargets(screen: AppCaptureScreen): readonly RedactionTarget[] {
  const sanitisedDiscussion = screen.role === 'APP_DISCUSSION_SANITISED';
  const targets: RedactionTarget[] = [];

  for (const selector of DEFAULT_ACCOUNT_REDACTION_SELECTORS) {
    targets.push({ selector, required: false, origin: 'ACCOUNT_DEFAULT' });
  }
  if (!sanitisedDiscussion) {
    for (const selector of DEFAULT_USER_CONTENT_REDACTION_SELECTORS) {
      targets.push({ selector, required: false, origin: 'USER_CONTENT_DEFAULT' });
    }
  }
  for (const selector of screen.redactionSelectors) {
    targets.push({ selector, required: false, origin: 'SCREEN_DECLARED' });
  }
  for (const selector of screen.requiredRedactionSelectors) {
    targets.push({ selector, required: true, origin: 'SCREEN_DECLARED' });
  }
  return targets;
}

export interface RedactionSelectorOutcome {
  readonly selector: string;
  readonly matched: number;
  readonly covered: number;
}

export interface RedactionOutcome {
  readonly results: readonly RedactionSelectorOutcome[];
  readonly totalElementsRedacted: number;
}

/**
 * The function evaluated inside the page.
 *
 * Written as a self-contained expression with no imports and no closure over
 * anything in this module, because it is serialised across the CDP boundary
 * and executes in the page's own realm. It returns counts and nothing else —
 * never the text, attributes or markup of what it covered.
 *
 * Covering rather than removing is intentional. Removing a node reflows the
 * page, so the screenshot would no longer show the layout the site actually
 * produces; an opaque block at the element's own rectangle leaves geometry
 * untouched and is visibly a redaction rather than a rendering bug.
 */
export const REDACTION_PAGE_FUNCTION = function redactInPage(
  selectors: readonly { selector: string; required: boolean }[],
): {
  results: { selector: string; matched: number; covered: number }[];
  totalElementsRedacted: number;
} {
  const FILL = '#14161D';
  const EDGE = '#2A2E39';
  const layer = document.createElement('div');
  layer.setAttribute('data-aamp-redaction-layer', '1');
  layer.style.cssText =
    'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483647';
  document.body.appendChild(layer);

  const results: { selector: string; matched: number; covered: number }[] = [];
  let totalElementsRedacted = 0;

  for (const entry of selectors) {
    let nodes: Element[] = [];
    try {
      nodes = Array.prototype.slice.call(document.querySelectorAll(entry.selector));
    } catch {
      // An invalid selector matches nothing and is reported as such; it must
      // not abort the redaction of the selectors that follow it.
      results.push({ selector: entry.selector, matched: -1, covered: 0 });
      continue;
    }
    let covered = 0;
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const block = document.createElement('div');
      block.style.cssText =
        'position:fixed;background:' +
        FILL +
        ';border:1px solid ' +
        EDGE +
        ';border-radius:4px;left:' +
        String(Math.round(rect.left)) +
        'px;top:' +
        String(Math.round(rect.top)) +
        'px;width:' +
        String(Math.round(rect.width)) +
        'px;height:' +
        String(Math.round(rect.height)) +
        'px';
      layer.appendChild(block);
      covered += 1;
    }
    totalElementsRedacted += covered;
    results.push({ selector: entry.selector, matched: nodes.length, covered });
  }

  return { results, totalElementsRedacted };
};

/**
 * CSS that makes a screenshot the same picture twice.
 *
 * Animations and transitions are zeroed rather than paused: a paused
 * animation still holds whatever frame it reached, which depends on how long
 * the page took to load. The caret is made transparent because a focused
 * input blinks, and a blink is a coin flip at shutter time.
 */
export const DETERMINISM_STYLESHEET = [
  '*,*::before,*::after{',
  'animation-duration:0s !important;animation-delay:0s !important;animation-iteration-count:1 !important;',
  'transition-duration:0s !important;transition-delay:0s !important;',
  'scroll-behavior:auto !important;caret-color:transparent !important;',
  '}',
  'html{scroll-behavior:auto !important}',
  '[data-aamp-redaction-layer]{contain:strict}',
].join('');

/**
 * Freezes anything that would otherwise still be moving.
 *
 * Media elements are rewound and paused rather than hidden, so the screen
 * still shows the player the product actually renders — at a fixed frame.
 */
export const FREEZE_PAGE_FUNCTION = function freezeInPage(): void {
  const media = Array.prototype.slice.call(
    document.querySelectorAll('video,audio'),
  ) as HTMLMediaElement[];
  for (const element of media) {
    try {
      element.pause();
      element.currentTime = 0;
      element.autoplay = false;
    } catch {
      // A media element that refuses to seek is left as it is; it cannot be
      // made more deterministic by throwing here.
    }
  }
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
};

export interface BuildRedactionReportInput {
  readonly screen: AppCaptureScreen;
  readonly targets: readonly RedactionTarget[];
  readonly outcome: RedactionOutcome;
}

/**
 * Turns raw counts into the report, and decides whether the screen passed.
 *
 * A required selector that matched nothing is the failure this exists for: it
 * means the page changed shape and the thing somebody insisted be hidden was
 * not hidden. That is reported as unsatisfied and, for a required screen,
 * fails the capture rather than producing an image nobody checked.
 */
export function buildRedactionReport(input: BuildRedactionReportInput): CaptureRedactionReport {
  const byTargetOrder = input.targets.map((target) => {
    const found = input.outcome.results.find((result) => result.selector === target.selector);
    const matched = found ? Math.max(0, found.matched) : 0;
    return {
      selector: target.selector,
      required: target.required,
      matched,
      satisfied: target.required ? matched > 0 : true,
    };
  });

  const unsatisfied = byTargetOrder
    .filter((entry) => entry.required && !entry.satisfied)
    .map((entry) => entry.selector);

  return {
    assetId: input.screen.assetId,
    role: input.screen.role,
    userContentRedactionApplied: input.screen.role !== 'APP_DISCUSSION_SANITISED',
    accountRedactionApplied: true,
    selectors: byTargetOrder,
    totalElementsRedacted: input.outcome.totalElementsRedacted,
    unsatisfiedRequiredSelectors: unsatisfied,
  };
}

export function redactionSatisfied(report: CaptureRedactionReport): boolean {
  return report.unsatisfiedRequiredSelectors.length === 0;
}
