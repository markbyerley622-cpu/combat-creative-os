import Fastify from 'fastify';
import type { Logger } from '@combat/observability';
import { createPrismaClient, type PrismaClient } from '@combat/database';

export interface BuildServerOptions {
  logger: Logger;
  prisma?: PrismaClient;
}

/**
 * Server construction is separate from `listen()` so tests can exercise
 * routes via `.inject()` without binding a real port, and so callers control
 * the Prisma client's lifecycle explicitly (see src/index.ts).
 *
 * Return type is inferred rather than annotated as `FastifyInstance`: passing
 * a concrete pino `Logger` instance (via @combat/observability) specializes
 * Fastify's logger generic beyond the library's own `FastifyBaseLogger`
 * default, so an explicit bare `FastifyInstance` annotation doesn't match.
 */
export function buildServer({ logger, prisma = createPrismaClient() }: BuildServerOptions) {
  const app = Fastify({ logger });

  // Liveness: the process is up and serving requests. Does not depend on any
  // downstream system — apps/dashboard and infra probes should hit this to
  // know "is the api process alive," not "is everything it depends on up."
  app.get('/health', async () => ({
    status: 'ok' as const,
    service: 'api',
    timestamp: new Date().toISOString(),
  }));

  // Readiness: best-effort check of the database dependency, with a short
  // timeout so an unreachable Postgres degrades this endpoint's response
  // instead of hanging or crashing the process. Local dev without Docker
  // running is expected to report "degraded" here — that is correct, not a
  // bug: the api process itself is still up and answering.
  app.get('/ready', async () => {
    const database = await checkDatabase(prisma);
    const status = database === 'ok' ? 'ok' : 'degraded';
    return {
      status,
      service: 'api',
      dependencies: { database },
      timestamp: new Date().toISOString(),
    };
  });

  return app;
}

async function checkDatabase(prisma: PrismaClient): Promise<'ok' | 'unreachable'> {
  const timeout = new Promise<'unreachable'>((resolve) =>
    setTimeout(() => resolve('unreachable'), 1500),
  );
  const ping = prisma.$queryRaw`SELECT 1`
    .then((): 'ok' => 'ok')
    .catch((): 'unreachable' => 'unreachable');
  return Promise.race([ping, timeout]);
}
