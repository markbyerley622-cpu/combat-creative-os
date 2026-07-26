import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadApiEnv, loadWorkerEnv, loadDashboardEnv } from './load-env';

const validBase = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/combat_creative_os',
  // Placeholder, never a real Clerk key — apps/api fails closed without one
  // (see config-safety.test.ts's "clerk identity config fails closed").
  CLERK_SECRET_KEY: 'sk_test_not_a_real_key',
};

describe('loadApiEnv', () => {
  it('applies defaults when optional vars are absent', () => {
    const parsed = loadApiEnv(validBase as NodeJS.ProcessEnv);
    expect(parsed.API_PORT).toBe(4000);
    expect(parsed.TEMPORAL_ADDRESS).toBe('localhost:7233');
  });

  it('throws EnvValidationError with a readable message when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _drop, ...withoutDb } = validBase;
    expect(() => loadApiEnv(withoutDb as NodeJS.ProcessEnv)).toThrow(EnvValidationError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      loadApiEnv({ ...validBase, DATABASE_URL: 'mysql://localhost/db' } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it('coerces API_PORT to a number', () => {
    const parsed = loadApiEnv({ ...validBase, API_PORT: '5555' } as NodeJS.ProcessEnv);
    expect(parsed.API_PORT).toBe(5555);
  });
});

describe('loadWorkerEnv', () => {
  it('applies MinIO defaults', () => {
    const parsed = loadWorkerEnv(validBase as NodeJS.ProcessEnv);
    expect(parsed.MINIO_BUCKET).toBe('combat-creative-assets');
    expect(parsed.MINIO_USE_SSL).toBe(false);
  });
});

describe('loadDashboardEnv', () => {
  it('does not require DATABASE_URL', () => {
    const parsed = loadDashboardEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(parsed.NEXT_PUBLIC_API_URL).toBe('http://localhost:4000');
  });
});
