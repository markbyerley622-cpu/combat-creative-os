import { PrismaClient } from '@prisma/client';

export type { PrismaClient } from '@prisma/client';

/**
 * Every consumer (apps/api, apps/worker) must obtain its PrismaClient through
 * this factory rather than constructing one ad hoc, so connection lifecycle
 * (and, later, query logging/middleware) stays centralized in one place.
 */
export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}
