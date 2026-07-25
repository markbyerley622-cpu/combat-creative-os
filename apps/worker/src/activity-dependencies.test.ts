import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from '@combat/config';
import type { PrismaClient } from '@combat/database';
import { createLogger } from '@combat/observability';
import { createWorkerActivities, REQUIRED_WORKER_ACTIVITY_NAMES } from '@combat/workflows';
import { createActivityDependencies, resolveReasoningProvider } from './activity-dependencies';

/**
 * Post-M14 audit finding C-1, at the composition root.
 *
 * `worker-activities.test.ts` proves the registration object covers the
 * workflow contracts. This proves the *production* dependency wiring in
 * `apps/worker` produces that same complete object — the step that was missing
 * entirely, and the reason a Worker that registered nothing usable could ship.
 * No Temporal server, no Postgres and no provider credential is involved.
 */

const silentLogger = createLogger({ serviceName: 'worker-test', level: 'silent', pretty: false });

const BASE_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
} as const;

/** A PrismaClient stand-in: the wiring never issues a query, it only holds the handle. */
function fakePrisma(): PrismaClient {
  return { $disconnect: async () => undefined } as unknown as PrismaClient;
}

describe('createActivityDependencies', () => {
  it('produces dependencies that register every required activity', async () => {
    const env = loadWorkerEnv(BASE_ENV as unknown as NodeJS.ProcessEnv);
    const { deps } = await createActivityDependencies({
      env,
      logger: silentLogger,
      prisma: fakePrisma(),
    });

    const registered = Object.keys(createWorkerActivities(deps)).sort();

    expect(registered).toEqual([...REQUIRED_WORKER_ACTIVITY_NAMES].sort());
  });

  it('defaults to the deterministic mocks for generation and rendering', async () => {
    const env = loadWorkerEnv(BASE_ENV as unknown as NodeJS.ProcessEnv);
    const { deps } = await createActivityDependencies({
      env,
      logger: silentLogger,
      prisma: fakePrisma(),
    });

    // No real Veo/Runway/ComfyUI/aerender adapter exists, and CLAUDE.md
    // forbids connecting one without an explicit, separate decision.
    expect(deps.videoGenerationProvider.name).toBe('mock-video-generation');
    expect(deps.motionGraphicsProvider.name).toBe('mock-motion-graphics');
  });

  it('uses the mock reasoning provider unless claude is explicitly configured', async () => {
    const provider = await resolveReasoningProvider(
      loadWorkerEnv(BASE_ENV as unknown as NodeJS.ProcessEnv),
    );

    expect(provider.name).toBe('mock-reasoning');
  });

  it('refuses to start when claude is selected without a key, rather than degrading to the mock', () => {
    expect(() =>
      loadWorkerEnv({ ...BASE_ENV, REASONING_PROVIDER: 'claude' } as NodeJS.ProcessEnv),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});
