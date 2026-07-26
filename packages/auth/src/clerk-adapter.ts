/**
 * The real `@clerk/backend` adapter — the only file in the repository that
 * talks to Clerk.
 *
 * Everything else depends on the `ClerkTokenVerifier` / `ClerkProfileDirectory`
 * interfaces in principal.ts, which is what lets the whole test suite run with
 * deterministic fakes, no credentials and no network (CLAUDE.md's
 * provider-adapter rule, applied to identity: a real adapter ships alongside a
 * working deterministic mock, never instead of one).
 *
 * The secret key is passed in by the composition root from `@combat/config`'s
 * validated env schema. This file never reads `process.env`, never logs the key
 * and never returns it — the same rule provider credentials already follow.
 */

import { createClerkClient, verifyToken, type ClerkClient } from '@clerk/backend';
import type {
  ClerkProfileDirectory,
  ClerkSubjectProfile,
  ClerkTokenVerifier,
  VerifiedClerkSubject,
} from './principal';

export interface ClerkAdapterConfig {
  readonly secretKey: string;
  /**
   * Origins whose tokens this API accepts (`azp` claim). Supplying it is what
   * stops a token minted for a different front-end from being replayed here;
   * an empty list means "do not check", which is only appropriate locally.
   */
  readonly authorizedParties?: readonly string[];
}

/**
 * Verifies a session token offline against Clerk's JWKS (fetched and cached by
 * `@clerk/backend`). Signature, expiry (`exp`), not-before (`nbf`) and
 * authorized party are all enforced by `verifyToken`; anything it rejects
 * throws, which `resolvePrincipal` turns into a 401.
 */
export function createClerkTokenVerifier(config: ClerkAdapterConfig): ClerkTokenVerifier {
  return {
    async verifySessionToken(token: string): Promise<VerifiedClerkSubject> {
      const payload = await verifyToken(token, {
        secretKey: config.secretKey,
        ...(config.authorizedParties && config.authorizedParties.length > 0
          ? { authorizedParties: [...config.authorizedParties] }
          : {}),
      });
      if (!payload.sub) {
        throw new Error('verified token carried no subject claim');
      }
      return { clerkUserId: payload.sub, sessionId: payload.sid };
    },
  };
}

/**
 * Reads a subject's email and name from Clerk's Backend API. Called only on a
 * subject's first sign-in (see `resolvePrincipal`), so this is not on the
 * per-request path.
 */
export function createClerkProfileDirectory(
  config: ClerkAdapterConfig,
  client: ClerkClient = createClerkClient({ secretKey: config.secretKey }),
): ClerkProfileDirectory {
  return {
    async fetchProfile(clerkUserId: string): Promise<ClerkSubjectProfile> {
      const user = await client.users.getUser(clerkUserId);
      const email =
        user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId)
          ?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
      if (!email) {
        throw new Error(`clerk subject ${clerkUserId} has no email address`);
      }
      const displayName =
        [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username || email;
      return { email, displayName };
    },
  };
}
