import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvValidationError, loadApiEnv, loadWorkerEnv } from './load-env';
import { parseAuthorizedParties } from './schema';

/**
 * M14 — configuration safety.
 *
 * Three properties: production-sensitive config fails closed rather than
 * degrading to a mock; mock mode stays the default so local dev and CI need no
 * paid key; and the committed `.env.example` contains placeholders only.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');

const BASE_ENV = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/combat_creative_os?schema=public',
  // AAMP-1 step 2: apps/api refuses to start without identity config, so every
  // api-side fixture must supply one. Placeholder — not a real Clerk key.
  CLERK_SECRET_KEY: 'sk_test_not_a_real_key',
};

describe('reasoning provider config fails closed', () => {
  it('refuses to start when claude is selected without a key', () => {
    expect(() =>
      loadWorkerEnv({ ...BASE_ENV, REASONING_PROVIDER: 'claude' } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it('names the missing variable in the startup diagnostic', () => {
    try {
      loadWorkerEnv({ ...BASE_ENV, REASONING_PROVIDER: 'claude' } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as EnvValidationError).message;
      expect(message).toContain('ANTHROPIC_API_KEY');
      // The diagnostic explains the failure mode it is preventing.
      expect(message).toContain('silently falling back to the mock provider');
    }
  });

  it('refuses a blank or whitespace-only key', () => {
    expect(() =>
      loadWorkerEnv({
        ...BASE_ENV,
        REASONING_PROVIDER: 'claude',
        ANTHROPIC_API_KEY: '   ',
      } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it('starts when claude is selected with a key present', () => {
    const env = loadWorkerEnv({
      ...BASE_ENV,
      REASONING_PROVIDER: 'claude',
      ANTHROPIC_API_KEY: 'sk-test-not-a-real-key',
    } as NodeJS.ProcessEnv);

    expect(env.REASONING_PROVIDER).toBe('claude');
  });
});

describe('mock mode remains the zero-config default', () => {
  it('the worker starts with no reasoning config at all', () => {
    const env = loadWorkerEnv(BASE_ENV as NodeJS.ProcessEnv);

    expect(env.REASONING_PROVIDER).toBe('mock');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('the api needs no reasoning config — agents run in the worker', () => {
    const env = loadApiEnv(BASE_ENV as NodeJS.ProcessEnv);

    expect(env).not.toHaveProperty('REASONING_PROVIDER');
    expect(env.API_PORT).toBe(4000);
  });

  it('a malformed DATABASE_URL fails closed rather than defaulting', () => {
    expect(() => loadApiEnv({ DATABASE_URL: 'mysql://nope' } as NodeJS.ProcessEnv)).toThrow(
      EnvValidationError,
    );
  });
});

describe('clerk identity config fails closed', () => {
  /** `BASE_ENV` minus the key, so the omission is the only difference. */
  const withoutKey = (extra: Record<string, string> = {}) => {
    const { CLERK_SECRET_KEY: _omitted, ...rest } = BASE_ENV;
    return { ...rest, ...extra } as NodeJS.ProcessEnv;
  };

  it('refuses to start the api with no CLERK_SECRET_KEY', () => {
    expect(() => loadApiEnv(withoutKey())).toThrow(EnvValidationError);
  });

  it('refuses to start in production with no CLERK_SECRET_KEY', () => {
    expect(() => loadApiEnv(withoutKey({ NODE_ENV: 'production' }))).toThrow(EnvValidationError);
  });

  it('names the missing variable and the failure mode it prevents', () => {
    try {
      loadApiEnv(withoutKey());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as EnvValidationError).message;
      expect(message).toContain('CLERK_SECRET_KEY');
      expect(message).toContain('no caller authentication');
    }
  });

  it('refuses a blank or whitespace-only key', () => {
    expect(() => loadApiEnv(withoutKey({ CLERK_SECRET_KEY: '   ' }))).toThrow(EnvValidationError);
  });

  it('rejects a publishable key pasted into the secret slot', () => {
    try {
      loadApiEnv(withoutKey({ CLERK_SECRET_KEY: 'pk_test_something' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as EnvValidationError).message).toContain('publishable key');
    }
  });

  it('requires an authorized-party allowlist in production', () => {
    expect(() => loadApiEnv({ ...BASE_ENV, NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      EnvValidationError,
    );

    const env = loadApiEnv({
      ...BASE_ENV,
      NODE_ENV: 'production',
      CLERK_AUTHORIZED_PARTIES: 'https://app.example.com',
    } as NodeJS.ProcessEnv);
    expect(env.CLERK_AUTHORIZED_PARTIES).toBe('https://app.example.com');
  });

  it('does not require an authorized-party allowlist outside production', () => {
    expect(loadApiEnv(BASE_ENV as NodeJS.ProcessEnv).CLERK_SECRET_KEY).toBe(
      'sk_test_not_a_real_key',
    );
  });
});

describe('parseAuthorizedParties', () => {
  it('splits, trims and drops empties', () => {
    expect(parseAuthorizedParties('  https://a.test , https://b.test ,, ')).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
  });

  it('treats an unset value as no allowlist', () => {
    expect(parseAuthorizedParties(undefined)).toEqual([]);
    expect(parseAuthorizedParties('')).toEqual([]);
  });
});

describe('.env hygiene', () => {
  const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
  const envExample = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');

  it('gitignores .env while allowing .env.example', () => {
    const lines = gitignore.split(/\r?\n/).map((l) => l.trim());

    expect(lines).toContain('.env');
    expect(lines).toContain('.env.local');
    expect(lines).toContain('!.env.example');
  });

  it('.env.example carries no real-looking credential', () => {
    // A real Anthropic key starts `sk-ant-`; a real AWS key id starts `AKIA`.
    expect(envExample).not.toMatch(/sk-ant-/);
    expect(envExample).not.toMatch(/AKIA[0-9A-Z]{16}/);
    // The one API key it mentions must be left empty for the developer to fill.
    const anthropicLine = envExample.split(/\r?\n/).find((l) => l.startsWith('ANTHROPIC_API_KEY='));
    expect(anthropicLine).toBeDefined();
    expect(anthropicLine!.split('=')[1]?.trim() ?? '').toBe('');
  });

  it('.env.example documents that it must never contain a real secret', () => {
    expect(envExample.toLowerCase()).toContain('never contain');
  });

  it('.env.example defaults to the mock reasoning provider', () => {
    expect(envExample).toMatch(/^REASONING_PROVIDER=mock$/m);
  });
});
