import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AuthModeRefused, resolveAuthMode } from './auth-mode';

/**
 * AAMP-1 step 2 — the dashboard's two identity guarantees:
 *
 * 1. Clerk is the default and the only mode reachable in production.
 * 2. The dashboard holds no secret and no caller identity of its own.
 */

describe('resolveAuthMode', () => {
  it('defaults to clerk when nothing is configured', () => {
    expect(resolveAuthMode({})).toBe('clerk');
    expect(resolveAuthMode({ NEXT_PUBLIC_DASHBOARD_AUTH_MODE: '' })).toBe('clerk');
    expect(resolveAuthMode({ NEXT_PUBLIC_DASHBOARD_AUTH_MODE: 'clerk' })).toBe('clerk');
  });

  it('defaults to clerk in production even with a deploy env set', () => {
    expect(resolveAuthMode({ NEXT_PUBLIC_DEPLOY_ENV: 'production' })).toBe('clerk');
  });

  it('refuses the e2e mode in production', () => {
    expect(() =>
      resolveAuthMode({
        NEXT_PUBLIC_DASHBOARD_AUTH_MODE: 'e2e-fake',
        NEXT_PUBLIC_DEPLOY_ENV: 'production',
      }),
    ).toThrow(AuthModeRefused);
  });

  it('refuses an unrecognised mode rather than silently falling back', () => {
    // Falling back to `clerk` would be safe; falling back *silently* would hide
    // a typo like `e2e_fake` that the author believed had taken effect.
    expect(() => resolveAuthMode({ NEXT_PUBLIC_DASHBOARD_AUTH_MODE: 'off' })).toThrow(
      AuthModeRefused,
    );
    expect(() => resolveAuthMode({ NEXT_PUBLIC_DASHBOARD_AUTH_MODE: 'none' })).toThrow(
      AuthModeRefused,
    );
  });

  it('allows the e2e mode outside production', () => {
    expect(resolveAuthMode({ NEXT_PUBLIC_DASHBOARD_AUTH_MODE: 'e2e-fake' })).toBe('e2e-fake');
    expect(
      resolveAuthMode({
        NEXT_PUBLIC_DASHBOARD_AUTH_MODE: 'e2e-fake',
        NEXT_PUBLIC_DEPLOY_ENV: 'local',
      }),
    ).toBe('e2e-fake');
  });
});

describe('the dashboard holds no secret and no caller identity', () => {
  const SRC = join(__dirname, '..');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  // This file names the very identifiers it forbids, so it excludes itself.
  const FILES = sourceFiles(SRC).filter((file) => !file.endsWith('auth-mode.test.ts'));

  it('finds the source tree it is asserting over', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it('never references CLERK_SECRET_KEY — a secret key cannot enter a client bundle', () => {
    const offenders = FILES.filter((file) =>
      readFileSync(file, 'utf8').includes('CLERK_SECRET_KEY'),
    );

    expect(offenders).toEqual([]);
  });

  it('never sends a userId to apps/api', () => {
    const offenders = FILES.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /userId=\$\{/.test(source) || /JSON\.stringify\(\{\s*userId/.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it('never uses Clerk Organizations', () => {
    const offenders = FILES.filter((file) => {
      const source = readFileSync(file, 'utf8');
      // Tenancy is Workspace + Membership in PostgreSQL; an organisation
      // component or claim would be a second, unaudited tenancy system.
      return /OrganizationSwitcher|OrganizationProfile|OrganizationList|CreateOrganization|useOrganization|\borgId\b|\borg_id\b/.test(
        source,
      );
    });

    expect(offenders).toEqual([]);
  });

  it('routes every backend call through the api client, never a bare fetch', () => {
    const offenders = FILES.filter((file) => {
      if (file.includes('api-client')) return false;
      return /\bfetch\(/.test(readFileSync(file, 'utf8'));
    });

    expect(offenders).toEqual([]);
  });
});
