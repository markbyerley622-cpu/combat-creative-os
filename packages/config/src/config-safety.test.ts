import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvValidationError, loadApiEnv, loadWorkerEnv } from './load-env';

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
