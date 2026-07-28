/**
 * The prohibited-claim gate.
 *
 * The storyboard is a drawing, and a drawing is allowed to say "12 FIGHT
 * EVENTS THIS WEEKEND" and "IRON CLASH 28" because its job is to show what the
 * frame should feel like. An advertisement is not allowed to say either,
 * because a rendered frame reads as a statement of fact. The storyboard itself
 * knows this — every panel carries `factualClaimsRequiringValidation` — and
 * this module is where that list stops being a note and becomes a refusal.
 *
 * Three properties worth stating, because each one is a decision:
 *
 * - **It refuses, it never rewrites.** A claim that cannot be verified is a
 *   claim the author has to replace with one that can. Silently deleting "12"
 *   and rendering "FIGHT EVENTS THIS WEEKEND" would be application code
 *   editing the advertisement's copy, which is exactly what the launch and
 *   finishing milestones forbid.
 * - **It walks authored strings, never pixels.** A real product capture shows
 *   real fighters on a real card; that is the product being honest about
 *   itself, and it is not this gate's business. What the gate governs is copy
 *   *this repository* puts on screen.
 * - **The vocabulary is closed and every entry names its reason.** A refusal
 *   an author cannot argue with is one they work around, so each pattern
 *   carries the claim it is protecting against and what to do instead.
 */

export interface ProhibitedClaimRule {
  readonly code: string;
  readonly pattern: RegExp;
  /** What the pattern is protecting against, in one line. */
  readonly why: string;
  /** What an author should write instead. */
  readonly remedy: string;
}

/**
 * Derived from the storyboard's own `factualClaimsRequiringValidation` and
 * `prohibitedOutputElements` entries, plus the two generic identity classes
 * (handles and email addresses) that must never appear in any artefact.
 */
export const PROHIBITED_CLAIM_RULES: readonly ProhibitedClaimRule[] = [
  {
    code: 'UNVERIFIED_EVENT_COUNT',
    pattern: /\b\d+\s+(?:fight\s+)?events?\b/i,
    why: 'a specific event count is a live-data claim, and no verified feed backs it here',
    remedy: 'state coverage without a number, e.g. "every card that matters"',
  },
  {
    code: 'FICTIONAL_EVENT',
    pattern: /\biron\s*clash\b/i,
    why: 'Iron Clash is a storyboard placeholder promotion and does not exist',
    remedy: 'use a real event from a live capture, or no event name at all',
  },
  {
    code: 'FICTIONAL_FIGHTER',
    pattern: /\b(?:j\.?\s*novak|r\.?\s*alvarez|alvarez\s+by\s+ko)\b/i,
    why: 'the storyboard fighter identities and the result they imply are invented',
    remedy: 'never name a fighter in authored copy; let a real capture show real bouts',
  },
  {
    code: 'FABRICATED_VOTE_COUNT',
    pattern: /\b\d{1,3}(?:,\d{3})+\s*votes?\b|\b\d+(?:\.\d+)?k\s+(?:votes?|comments?)\b/i,
    why: 'a vote or comment total presented as community data must come from the product',
    remedy: 'let the real leaderboard or fight-card capture carry its own numbers',
  },
  {
    code: 'FABRICATED_SPLIT',
    pattern: /\b\d{1,3}\s*%\s*[/\-–]\s*\d{1,3}\s*%/,
    why: 'a prediction split written as copy is a fabricated community statistic',
    remedy: 'show the real split inside a real capture instead of typesetting one',
  },
  {
    code: 'FABRICATED_COUNTDOWN',
    pattern: /\bpredictions?\s+close\s+in\b|\b\d{2}:\d{2}:\d{2}\b/i,
    why: 'a countdown implies a live deadline this cut cannot know',
    remedy: 'drop the countdown; urgency comes from the edit, not from an invented clock',
  },
  {
    code: 'UNVERIFIED_STORE_LISTING',
    pattern: /\bdownload\s+free\b|\bapp\s*store\b|\bgoogle\s*play\b|\bget\s+it\s+on\b/i,
    why: 'a store badge or a free-download promise requires a live public listing',
    remedy: 'use the verified web call to action, "OPEN COMBAT REVIEWS"',
  },
  {
    code: 'FICTIONAL_HANDLE',
    pattern: /\b(?:fightfan88|strikerx|groundgame|mma_life)\b|(?:^|\s)@[a-z0-9_]{2,}/i,
    why: 'the storyboard discussion handles are invented, and no real handle may be shown',
    remedy: 'show no identity at all; the discussion mockup carries none by construction',
  },
  {
    code: 'PERSONAL_IDENTIFIER',
    pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    why: 'an email address is personal data and must never reach an artefact',
    remedy: 'remove it',
  },
  {
    code: 'FICTIONAL_SCHEDULE',
    pattern:
      /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i,
    why: 'a specific date presented on screen is a scheduling claim this cut cannot verify',
    remedy: 'let a real capture show real dates',
  },
  {
    code: 'UNVERIFIED_PERFORMANCE_CLAIM',
    pattern: /\b(?:#1|number\s+one|the\s+best|most\s+popular|fastest\s+growing|millions\s+of)\b/i,
    why: 'a superlative or scale claim needs evidence nobody has supplied',
    remedy: 'describe what the product does instead of how it ranks',
  },
];

export interface ProhibitedClaimFinding {
  readonly code: string;
  /** Where the string came from, e.g. `beats[2].caption.text`. */
  readonly field: string;
  readonly matched: string;
  readonly why: string;
  readonly remedy: string;
}

export class ProhibitedClaimError extends Error {
  constructor(public readonly findings: readonly ProhibitedClaimFinding[]) {
    super(
      `Authored copy makes ${findings.length} claim(s) this cut cannot support:\n${findings
        .map(
          (finding) =>
            `  - ${finding.code} at ${finding.field}: "${finding.matched}" — ${finding.why}. Instead: ${finding.remedy}.`,
        )
        .join('\n')}`,
    );
    this.name = 'ProhibitedClaimError';
  }
}

/** One authored string and where it came from. */
export interface AuthoredString {
  readonly field: string;
  readonly value: string;
}

export function findProhibitedClaims(
  strings: readonly AuthoredString[],
): readonly ProhibitedClaimFinding[] {
  const findings: ProhibitedClaimFinding[] = [];
  for (const { field, value } of strings) {
    for (const rule of PROHIBITED_CLAIM_RULES) {
      const match = rule.pattern.exec(value);
      if (!match) continue;
      findings.push({
        code: rule.code,
        field,
        matched: match[0].trim(),
        why: rule.why,
        remedy: rule.remedy,
      });
    }
  }
  return findings;
}

export function assertNoProhibitedClaims(strings: readonly AuthoredString[]): void {
  const findings = findProhibitedClaims(strings);
  if (findings.length > 0) throw new ProhibitedClaimError(findings);
}

/**
 * The truthful call to action this milestone renders.
 *
 * Stated here as data rather than left in a plan file so a test can assert the
 * corrected wording survives, and so the substitution the storyboard needed —
 * "DOWNLOAD FREE" plus two store badges, for a product with no verified public
 * listing — is recorded in one place with its reason.
 */
export const CORRECTED_CTA = {
  headline: 'NEVER MISS FIGHT NIGHT.',
  action: 'OPEN COMBAT REVIEWS',
  supporting: 'Every combat sport. One place.',
  replaces: [
    '"DOWNLOAD FREE" — needs a real, free, publicly downloadable application',
    'App Store badge — needs a live public listing',
    'Google Play badge — needs a live public listing',
  ],
} as const;
