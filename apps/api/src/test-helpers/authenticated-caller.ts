import { InMemoryCampaignStore, type UserDataSource } from '@combat/database';
import { createFakeProfileDirectory, createFakeTokenVerifier } from '@combat/auth/testing';
import type { ClerkProfileDirectory, ClerkTokenVerifier } from '@combat/auth';

/**
 * The one way `apps/api`'s tests (and its in-memory dev-fake-server) present a
 * caller identity.
 *
 * Before AAMP-1 step 2 a test "was" a user by putting a `userId` in the body.
 * Now it must hold a token the server's verifier accepts, which is the point:
 * the suite exercises the real authentication path — hook, verifier, subject
 * mapping, `Membership` lookup — instead of stepping over it.
 *
 * Deterministic and offline. The fakes come from `@combat/auth/testing`, which
 * is not reachable from any production import path, so nothing here can be
 * selected by configuration in a real process.
 */

/** `clerk_<localUserId>` — a stable, readable subject id derived from the local user. */
export function clerkSubjectFor(userId: string): string {
  return `clerk_${userId}`;
}

/** `Bearer token_<localUserId>` — the token `registerAuthenticatedCallers` taught the verifier to accept. */
export function bearerFor(userId: string): { authorization: string } {
  return { authorization: `Bearer token_${userId}` };
}

const TOKEN_PREFIX = 'token_';
const SUBJECT_PREFIX = 'clerk_';

/**
 * Authentication for the route suites whose subject is **authorization**, not
 * authentication: `token_<localUserId>` authenticates as that local user, and
 * anything else is rejected.
 *
 * Those suites create their `userId`s with `randomUUID()` per test and seed
 * `Membership` rows against them, so pre-registering every id would be pure
 * ceremony. What matters for them is that identity now arrives verified and out
 * of band — the body no longer carries it — and that the id reaching
 * `roleHasPermission` is the token's, never the request's.
 *
 * Authentication itself (rejecting malformed, unknown, expired and
 * wrong-signature tokens; first-login provisioning) is proven separately in
 * `authentication.test.ts` against the strict allowlist verifier, which is what
 * `authenticatedCallers` above builds.
 */
export function permissiveTestAuthentication(): {
  tokenVerifier: ClerkTokenVerifier;
  profileDirectory: ClerkProfileDirectory;
  userDb: UserDataSource;
  /**
   * The same three collaborators under the names `registerAuthentication` takes,
   * for suites that register the hook on a bare Fastify instance rather than
   * going through `buildServer`.
   */
  hookDeps: { verifier: ClerkTokenVerifier; directory: ClerkProfileDirectory; db: UserDataSource };
} {
  const tokenVerifier: ClerkTokenVerifier = {
    async verifySessionToken(token: string) {
      if (!token.startsWith(TOKEN_PREFIX) || token.length <= TOKEN_PREFIX.length) {
        throw new Error('fake verifier rejected token');
      }
      return { clerkUserId: `${SUBJECT_PREFIX}${token.slice(TOKEN_PREFIX.length)}` };
    },
  };

  const userDb: UserDataSource = {
    user: {
      findFirst: async ({ where }) => {
        if (!('clerkUserId' in where) || !where.clerkUserId.startsWith(SUBJECT_PREFIX)) return null;
        const id = where.clerkUserId.slice(SUBJECT_PREFIX.length);
        const now = new Date();
        return {
          id,
          email: `${id}@example.test`,
          displayName: `Test User ${id.slice(0, 8)}`,
          clerkUserId: where.clerkUserId,
          createdAt: now,
          updatedAt: now,
        };
      },
      create: async () => {
        throw new Error('permissiveTestAuthentication never provisions — every subject resolves');
      },
      update: async () => {
        throw new Error('permissiveTestAuthentication never links — every subject resolves');
      },
    },
  };

  const profileDirectory = createFakeProfileDirectory(new Map());
  return {
    tokenVerifier,
    profileDirectory,
    userDb,
    hookDeps: { verifier: tokenVerifier, directory: profileDirectory, db: userDb },
  };
}

export interface TestAuthentication {
  readonly tokenVerifier: ClerkTokenVerifier;
  readonly profileDirectory: ClerkProfileDirectory;
  readonly userDb: InMemoryCampaignStore;
}

/**
 * Seeds a local `User` per id, already bound to its Clerk subject, and builds a
 * verifier that accepts exactly those users' tokens.
 *
 * Users are seeded pre-linked rather than provisioned on demand because these
 * ids are the same ones the tests' `Membership` rows point at — the mapping
 * from subject to *that* user is precisely what authorization depends on.
 * First-login provisioning is covered separately, in `authentication.test.ts`
 * and `user-repository.test.ts`.
 *
 * `store` doubles as the `userDb`, so a test's memberships and its users live
 * in one place.
 */
export function authenticatedCallers(
  store: InMemoryCampaignStore,
  userIds: readonly string[],
): TestAuthentication {
  const tokens = new Map<string, { clerkUserId: string }>();
  const profiles = new Map<string, { email: string; displayName: string }>();

  for (const userId of userIds) {
    const clerkUserId = clerkSubjectFor(userId);
    if (!store.users.some((user) => user.id === userId)) {
      store.seedUser({
        id: userId,
        clerkUserId,
        email: `${userId}@example.test`,
        displayName: `Test User ${userId.slice(0, 8)}`,
      });
    }
    tokens.set(`token_${userId}`, { clerkUserId });
    profiles.set(clerkUserId, {
      email: `${userId}@example.test`,
      displayName: `Test User ${userId.slice(0, 8)}`,
    });
  }

  return {
    tokenVerifier: createFakeTokenVerifier({ tokens }),
    profileDirectory: createFakeProfileDirectory(profiles),
    userDb: store,
  };
}
