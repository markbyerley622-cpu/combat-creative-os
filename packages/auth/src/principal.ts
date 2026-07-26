/**
 * The verified caller identity, and the boundary that produces it.
 *
 * AAMP-1 step 2 (docs/adr/0006). Before this package existed, `apps/api` took
 * the caller's `userId` from the request body or query string — RBAC was real,
 * but *identity* was whatever the client claimed. Everything in this file
 * exists to make one statement true: a `VerifiedPrincipal` can only be
 * constructed from a cryptographically verified session token.
 *
 * Two rules shape the design and are load-bearing:
 *
 * 1. **The identity provider proves who, PostgreSQL decides what.** The only
 *    thing taken from a verified token is the subject identifier. Role,
 *    workspace membership and permissions are never read from a token claim —
 *    they are resolved from `Membership` rows through the existing repository
 *    boundary, exactly as they were before. A compromised or over-permissive
 *    IdP configuration therefore cannot grant authority inside this system.
 * 2. **No organisation/tenant concept crosses this boundary.** Clerk
 *    Organizations are disabled; `VerifiedPrincipal` deliberately has no
 *    workspace field, so no route can accidentally take its tenant scope from
 *    the token instead of from the path plus a `Membership` lookup.
 */

import type { UserDataSource } from '@combat/database';
import { findUserByClerkSubject, resolveUserForClerkSubject } from '@combat/database';

/** What a verified session token yields. Deliberately the subject and nothing else. */
export interface VerifiedClerkSubject {
  /** The token's `sub` claim — Clerk's stable user identifier. */
  readonly clerkUserId: string;
  /** The `sid` claim, carried for audit/log correlation only; never authorizing. */
  readonly sessionId?: string;
}

/**
 * Verifies a bearer session token. Implementations must reject an expired,
 * malformed, wrongly-signed or wrongly-audienced token by *rejecting*, never by
 * returning a subject — every caller treats a rejection as 401.
 */
export interface ClerkTokenVerifier {
  verifySessionToken(token: string): Promise<VerifiedClerkSubject>;
}

/** The subject's profile, read only to populate a newly provisioned local `User` row. */
export interface ClerkSubjectProfile {
  readonly email: string;
  readonly displayName: string;
}

/**
 * Looks up a subject's profile. Consulted **only** when no local `User` is
 * mapped to the subject yet, so steady-state request handling makes no call
 * here at all.
 */
export interface ClerkProfileDirectory {
  fetchProfile(clerkUserId: string): Promise<ClerkSubjectProfile>;
}

/**
 * The authenticated caller. `userId` is the **local PostgreSQL `User.id`** —
 * the same identifier `Membership.userId` and every existing authorization
 * check already use, which is why authorization keeps its exact prior shape.
 */
export interface VerifiedPrincipal {
  readonly userId: string;
  readonly clerkUserId: string;
  readonly email: string;
}

export type PrincipalFailureReason =
  /** No bearer token was presented. */
  | 'NO_TOKEN'
  /** The token did not verify: malformed, expired, bad signature, wrong party. */
  | 'INVALID_TOKEN'
  /** The token verified, but no local user could be resolved or safely provisioned. */
  | 'NO_LOCAL_USER';

export type PrincipalResult =
  | { readonly ok: true; readonly principal: VerifiedPrincipal }
  | { readonly ok: false; readonly reason: PrincipalFailureReason };

export interface PrincipalResolverDeps {
  readonly verifier: ClerkTokenVerifier;
  readonly directory: ClerkProfileDirectory;
  readonly db: UserDataSource;
}

/**
 * Extracts a bearer token from an `Authorization` header value.
 *
 * Returns `null` for anything that is not exactly one `Bearer <token>` — a
 * missing header, a different scheme, or an empty token. Being strict here is
 * what keeps "unauthenticated" and "bad credentials" from blurring together.
 */
export function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(headerValue.trim());
  return match ? match[1]! : null;
}

/**
 * The whole authentication path, in order: verify the token, then map its
 * subject onto a local user.
 *
 * Failure is a value, not an exception, so the transport layer (the Fastify
 * preHandler) can answer 401 uniformly without distinguishing *why* to the
 * caller — an invalid token and an unprovisionable user look identical from
 * outside, so neither can be probed.
 */
export async function resolvePrincipal(
  deps: PrincipalResolverDeps,
  token: string | null,
): Promise<PrincipalResult> {
  if (!token) return { ok: false, reason: 'NO_TOKEN' };

  let subject: VerifiedClerkSubject;
  try {
    subject = await deps.verifier.verifySessionToken(token);
  } catch {
    return { ok: false, reason: 'INVALID_TOKEN' };
  }
  if (!subject.clerkUserId) return { ok: false, reason: 'INVALID_TOKEN' };

  // Steady state: the subject is already mapped, so this is one indexed read
  // and no call to the identity provider at all.
  const mapped = await findUserByClerkSubject(deps.db, subject.clerkUserId);
  if (mapped) {
    return {
      ok: true,
      principal: { userId: mapped.id, clerkUserId: subject.clerkUserId, email: mapped.email },
    };
  }

  // First sign-in only: the profile is needed because `User.email` and
  // `User.displayName` are required columns and the session token carries
  // neither by default.
  let profile: ClerkSubjectProfile;
  try {
    profile = await deps.directory.fetchProfile(subject.clerkUserId);
  } catch {
    return { ok: false, reason: 'NO_LOCAL_USER' };
  }

  const resolved = await resolveUserForClerkSubject(deps.db, {
    clerkUserId: subject.clerkUserId,
    email: profile.email,
    displayName: profile.displayName,
  });
  if (!resolved.ok) return { ok: false, reason: 'NO_LOCAL_USER' };

  return {
    ok: true,
    principal: {
      userId: resolved.user.id,
      clerkUserId: subject.clerkUserId,
      email: resolved.user.email,
    },
  };
}
