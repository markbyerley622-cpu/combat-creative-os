import { describe, expect, it } from 'vitest';
import { createLogger } from '@combat/observability';
import type { PrismaClient } from '@combat/database';
import { buildServer } from './server';

const silentLogger = createLogger({ serviceName: 'api-test', level: 'silent', pretty: false });

function fakePrisma(behavior: 'ok' | 'reject'): PrismaClient {
  return {
    $queryRaw: async () => {
      if (behavior === 'reject') {
        throw new Error('connection refused');
      }
      return [{ '?column?': 1 }];
    },
  } as unknown as PrismaClient;
}

describe('GET /health', () => {
  it('always responds ok regardless of database reachability', async () => {
    const app = buildServer({ logger: silentLogger, prisma: fakePrisma('reject') });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'api' });
  });
});

describe('GET /ready', () => {
  it('reports ok when the database is reachable', async () => {
    const app = buildServer({ logger: silentLogger, prisma: fakePrisma('ok') });
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', dependencies: { database: 'ok' } });
  });

  it('reports degraded (not a crash) when the database is unreachable', async () => {
    const app = buildServer({ logger: silentLogger, prisma: fakePrisma('reject') });
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      dependencies: { database: 'unreachable' },
    });
  });
});
