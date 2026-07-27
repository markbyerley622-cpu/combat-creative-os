import { describe, expect, it } from 'vitest';

import {
  APP_CAPTURE_ROLES,
  AppCaptureRightsError,
  AppCaptureSpecificationError,
  CAPTURE_EXIT_CODES,
  ROLES_DISABLED_BY_DEFAULT,
  expectedPixelsFor,
  parseCaptureSpecification,
  parseRightsDeclaration,
  screenIsEnabled,
} from './capture-contracts';
import { assertCaptureArtefactSafe, safeUrlParts } from './capture-safety';
import {
  DEFAULT_USER_CONTENT_REDACTION_SELECTORS,
  buildRedactionReport,
  buildRedactionTargets,
  redactionSatisfied,
} from './redaction';
import { evaluateRightsDeclaration } from './rights-declaration';

const NOW = new Date('2026-07-27T12:00:00.000Z');

function screen(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assetId: 'screen-events',
    path: '/events',
    role: 'APP_EVENT_LIST',
    viewport: 'PHONE_PORTRAIT_1080X1920',
    description: 'events list',
    readinessSelector: '#main',
    timeoutMs: 30_000,
    required: true,
    ...overrides,
  };
}

function specification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specificationVersion: 1,
    name: 'fixture',
    baseUrl: 'https://example.test',
    allowedHosts: ['example.test'],
    library: 'fixture library',
    screens: [screen()],
    ...overrides,
  };
}

function declaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    declarationVersion: 1,
    declaringEntity: 'Combat Reviews',
    declaredBy: 'A named person',
    declaredAt: '2026-07-01T00:00:00.000Z',
    approvedHost: 'example.test',
    basis: 'OWNED_UI_CAPTURE',
    uiOwnershipConfirmed: true,
    thirdPartyImagery: 'NONE_PRESENT',
    thirdPartyImageryConfirmed: true,
    approvedOutputChannels: ['TIKTOK'],
    territory: 'WORLDWIDE',
    evidenceReference: 'TICKET-1',
    ...overrides,
  };
}

describe('capture specification', () => {
  it('accepts a minimal valid specification and applies documented defaults', () => {
    const parsed = parseCaptureSpecification(specification());
    const first = parsed.screens[0]!;
    expect(first.redactionSelectors).toEqual([]);
    expect(first.requiredRedactionSelectors).toEqual([]);
    expect(first.navigation).toEqual([]);
    expect(first.settleMs).toBe(1_500);
    expect(screenIsEnabled(first)).toBe(true);
  });

  it('refuses a base URL whose host is not in the allowlist', () => {
    expect(() =>
      parseCaptureSpecification(specification({ allowedHosts: ['somewhere-else.test'] })),
    ).toThrow(AppCaptureSpecificationError);
  });

  it('refuses a base URL carrying credentials', () => {
    expect(() =>
      parseCaptureSpecification(
        specification({
          baseUrl: 'https://user:pass@example.test',
          allowedHosts: ['example.test'],
        }),
      ),
    ).toThrow(AppCaptureSpecificationError);
  });

  it('refuses a screen path that resolves to another host', () => {
    expect(() =>
      parseCaptureSpecification(
        specification({ screens: [screen({ path: 'https://elsewhere.test/events' })] }),
      ),
    ).toThrow(/not the base host/);
  });

  it('refuses a relative screen path', () => {
    expect(() =>
      parseCaptureSpecification(specification({ screens: [screen({ path: 'events' })] })),
    ).toThrow(/absolute path/);
  });

  it('refuses duplicate asset ids', () => {
    expect(() =>
      parseCaptureSpecification(specification({ screens: [screen(), screen()] })),
    ).toThrow(/duplicate assetId/);
  });

  it('refuses unknown fields, because a typo must not be silently ignored', () => {
    expect(() => parseCaptureSpecification(specification({ baseUrlTypo: 'x' }))).toThrow(
      AppCaptureSpecificationError,
    );
  });

  it('refuses a FOLLOW_LINK step with no declared destination', () => {
    expect(() =>
      parseCaptureSpecification(
        specification({
          screens: [screen({ navigation: [{ kind: 'FOLLOW_LINK', selector: 'a' }] })],
        }),
      ),
    ).toThrow(/expectPathPrefix/);
  });
});

describe('APP_DISCUSSION_SANITISED is disabled by default', () => {
  it('is the only role that is off by default', () => {
    expect(ROLES_DISABLED_BY_DEFAULT).toEqual(['APP_DISCUSSION_SANITISED']);
    for (const role of APP_CAPTURE_ROLES) {
      const parsed = parseCaptureSpecification(
        specification({
          screens: [
            screen({ assetId: 'a', role, requiredRedactionSelectors: ['[data-account-name]'] }),
            // A second, always-on screen so the "nothing enabled" rule does not fire.
            screen({ assetId: 'b' }),
          ],
        }),
      );
      const target = parsed.screens.find((entry) => entry.assetId === 'a')!;
      expect(screenIsEnabled(target)).toBe(role !== 'APP_DISCUSSION_SANITISED');
    }
  });

  it('runs only when a specification says enabled: true by name', () => {
    const parsed = parseCaptureSpecification(
      specification({
        screens: [
          screen({
            role: 'APP_DISCUSSION_SANITISED',
            enabled: true,
            requiredRedactionSelectors: ['[data-account-name]'],
          }),
        ],
      }),
    );
    expect(screenIsEnabled(parsed.screens[0]!)).toBe(true);
  });

  it('refuses an enabled discussion screen that enforces no redaction', () => {
    expect(() =>
      parseCaptureSpecification(
        specification({
          screens: [screen({ role: 'APP_DISCUSSION_SANITISED', enabled: true })],
        }),
      ),
    ).toThrow(/requiredRedactionSelector/);
  });

  it('refuses a specification where every screen is disabled', () => {
    expect(() =>
      parseCaptureSpecification(
        specification({
          screens: [
            screen({ role: 'APP_DISCUSSION_SANITISED', requiredRedactionSelectors: ['x'] }),
          ],
        }),
      ),
    ).toThrow(/would capture nothing/);
  });
});

describe('viewport presets', () => {
  it('lands the default preset on exactly the delivery geometry', () => {
    expect(expectedPixelsFor('PHONE_PORTRAIT_1080X1920')).toEqual({
      widthPx: 1080,
      heightPx: 1920,
    });
  });
});

describe('rights declaration', () => {
  it('without one, capture is inspection-only and nothing is output-eligible', () => {
    const decision = evaluateRightsDeclaration({
      specification: parseCaptureSpecification(specification()),
      host: 'example.test',
      now: NOW,
    });
    expect(decision.mode).toBe('INSPECTION_ONLY');
    expect(decision.eligibility).toBe('REVIEW_REQUIRED');
    expect(decision.classification).toBeNull();
    expect(decision.notice).toContain('NOT OUTPUT ELIGIBLE');
    expect(decision.notice).toContain('RIGHTS REVIEW REQUIRED');
  });

  it('projects the two bases onto the existing production rights vocabulary', () => {
    const owned = evaluateRightsDeclaration({
      declaration: parseRightsDeclaration(declaration()),
      specification: parseCaptureSpecification(specification()),
      host: 'example.test',
      now: NOW,
    });
    expect(owned.classification).toBe('OWNED');

    const licensed = evaluateRightsDeclaration({
      declaration: parseRightsDeclaration(declaration({ basis: 'LICENSED_UI_CAPTURE' })),
      specification: parseCaptureSpecification(specification()),
      host: 'example.test',
      now: NOW,
    });
    expect(licensed.classification).toBe('LICENSED_FOR_OUTPUT');
  });

  it('refuses a declaration written for another host', () => {
    expect(() =>
      evaluateRightsDeclaration({
        declaration: parseRightsDeclaration(declaration({ approvedHost: 'other.test' })),
        specification: parseCaptureSpecification(specification()),
        host: 'example.test',
        now: NOW,
      }),
    ).toThrow(AppCaptureRightsError);
  });

  it('refuses an expired declaration', () => {
    expect(() =>
      evaluateRightsDeclaration({
        declaration: parseRightsDeclaration(declaration({ expiresAt: '2026-07-01T00:00:00.000Z' })),
        specification: parseCaptureSpecification(specification()),
        host: 'example.test',
        now: NOW,
      }),
    ).toThrow(/licence term ended/);
  });

  it('refuses a declaration whose version the specification does not expect', () => {
    expect(() =>
      evaluateRightsDeclaration({
        declaration: parseRightsDeclaration(declaration({ declarationVersion: 1 })),
        specification: parseCaptureSpecification(
          specification({ expectedRightsDeclarationVersion: 2 }),
        ),
        host: 'example.test',
        now: NOW,
      }),
    ).toThrow(/version 2/);
  });

  it('refuses a declaration that does not confirm ownership', () => {
    expect(() => parseRightsDeclaration(declaration({ uiOwnershipConfirmed: false }))).toThrow(
      AppCaptureSpecificationError,
    );
  });

  it('refuses a declaration with no named person', () => {
    const withoutDeclarer = declaration();
    delete withoutDeclarer.declaredBy;
    expect(() => parseRightsDeclaration(withoutDeclarer)).toThrow(AppCaptureSpecificationError);
  });

  it('refuses the committed template, which is all TODOs', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const template = JSON.parse(
      await readFile(
        resolve(__dirname, '..', '..', 'examples', 'combat-reviews-capture-rights.template.json'),
        'utf8',
      ),
    ) as unknown;
    expect(() => parseRightsDeclaration(template)).toThrow(AppCaptureSpecificationError);
  });
});

describe('artefact safety', () => {
  it('rejects an email address wherever it appears', () => {
    expect(() => assertCaptureArtefactSafe({ note: 'contact fan@example.com' })).toThrow(
      /email address/,
    );
  });

  it('rejects bearer tokens, JWTs and credential query strings', () => {
    expect(() => assertCaptureArtefactSafe({ a: 'Bearer abcdef1234567890' })).toThrow(
      /bearer token/,
    );
    expect(() =>
      assertCaptureArtefactSafe({ a: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.x' }),
    ).toThrow(/JSON web token/);
    expect(() => assertCaptureArtefactSafe({ a: '/events?session=abcdef1234567890' })).toThrow(
      /credential in a query string/,
    );
  });

  it('rejects forbidden keys at any depth, including a raw DOM dump', () => {
    expect(() => assertCaptureArtefactSafe({ deep: { cookie: 'x' } })).toThrow(/forbidden field/);
    expect(() => assertCaptureArtefactSafe({ screens: [{ outerHTML: '<div/>' }] })).toThrow(
      /forbidden field/,
    );
    expect(() => assertCaptureArtefactSafe({ commentText: 'anything' })).toThrow(/forbidden field/);
  });

  it('reports every violation rather than the first', () => {
    try {
      assertCaptureArtefactSafe({ cookie: 'a', token: 'b' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('cookie');
      expect((error as Error).message).toContain('token');
    }
  });

  it('drops a query string entirely rather than filtering it', () => {
    expect(safeUrlParts('https://example.test/events?session=secret&utm=x')).toEqual({
      host: 'example.test',
      path: '/events',
      queryPresent: true,
    });
  });
});

describe('redaction targets', () => {
  const base = parseCaptureSpecification(specification()).screens[0]!;

  it('applies user-content defaults to an ordinary screen', () => {
    const targets = buildRedactionTargets(base);
    for (const selector of DEFAULT_USER_CONTENT_REDACTION_SELECTORS) {
      expect(targets.some((target) => target.selector === selector)).toBe(true);
    }
  });

  it('does not apply user-content defaults to the sanitised discussion screen', () => {
    const discussion = parseCaptureSpecification(
      specification({
        screens: [
          screen({
            role: 'APP_DISCUSSION_SANITISED',
            enabled: true,
            requiredRedactionSelectors: ['[data-account-name]'],
          }),
        ],
      }),
    ).screens[0]!;
    const targets = buildRedactionTargets(discussion);
    for (const selector of DEFAULT_USER_CONTENT_REDACTION_SELECTORS) {
      expect(targets.some((target) => target.selector === selector)).toBe(false);
    }
    // Account identity is still redacted there — that is what "sanitised" means.
    expect(targets.some((target) => target.selector === '[data-account-name]')).toBe(true);
    expect(targets.filter((target) => target.required)).toHaveLength(1);
  });

  it('fails a screen whose required selector matched nothing', () => {
    const withRequired = parseCaptureSpecification(
      specification({ screens: [screen({ requiredRedactionSelectors: ['.absent'] })] }),
    ).screens[0]!;
    const targets = buildRedactionTargets(withRequired);
    const report = buildRedactionReport({
      screen: withRequired,
      targets,
      outcome: {
        results: [{ selector: '.absent', matched: 0, covered: 0 }],
        totalElementsRedacted: 0,
      },
    });
    expect(redactionSatisfied(report)).toBe(false);
    expect(report.unsatisfiedRequiredSelectors).toEqual(['.absent']);
  });

  it('passes when the required selector matched, and never records what it covered', () => {
    const withRequired = parseCaptureSpecification(
      specification({ screens: [screen({ requiredRedactionSelectors: ['.present'] })] }),
    ).screens[0]!;
    const targets = buildRedactionTargets(withRequired);
    const report = buildRedactionReport({
      screen: withRequired,
      targets,
      outcome: {
        results: [{ selector: '.present', matched: 3, covered: 3 }],
        totalElementsRedacted: 3,
      },
    });
    expect(redactionSatisfied(report)).toBe(true);
    expect(report.totalElementsRedacted).toBe(3);
    expect(JSON.stringify(report)).not.toContain('textContent');
    assertCaptureArtefactSafe(report, 'redaction report');
  });
});

describe('exit codes', () => {
  it('gives every failure kind its own non-zero code', () => {
    const codes = Object.entries(CAPTURE_EXIT_CODES).filter(([kind]) => kind !== 'SUCCESS');
    expect(CAPTURE_EXIT_CODES.SUCCESS).toBe(0);
    expect(new Set(codes.map(([, code]) => code)).size).toBe(codes.length);
    for (const [, code] of codes) expect(code).toBeGreaterThan(0);
  });
});
