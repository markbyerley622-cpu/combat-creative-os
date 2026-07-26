import type { PrismaClient, UserDataSource } from '@combat/database';

/**
 * Adapts a real `PrismaClient` to `UserDataSource` — the same narrow-interface
 * bridge every other `*-database.ts` in this directory performs (see
 * `approval-database.ts` for the rationale), here for the `users` table the
 * AAMP-1 step 2 authentication hook reads and provisions through.
 *
 * The `findFirst` union is widened deliberately: `UserDataSource` allows a
 * lookup by verified subject *or* by email, which is exactly the two-step
 * first-sign-in resolution `resolveUserForClerkSubject` performs.
 */
export function createUserDatabase(prisma: PrismaClient): UserDataSource {
  return {
    user: {
      findFirst: (args) => prisma.user.findFirst(args),
      create: (args) => prisma.user.create(args),
      update: (args) => prisma.user.update(args),
    },
  };
}
