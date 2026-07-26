/**
 * Deterministic identity fakes — the mock half of the provider-adapter rule,
 * applied to authentication.
 *
 * These make no network call, hold no credential and depend on no external
 * service, so `pnpm test` and the Playwright suite prove the *authentication
 * path itself* (401s, subject mapping, provisioning idempotency) rather than
 * skipping over it.
 *
 * They are exported from `@combat/auth/testing`, deliberately not from the
 * package root: nothing on the production import path can reach them, so no
 * environment variable, config flag or deployment mistake can select a fake
 * verifier in a real process. Selecting one requires editing code that imports
 * this module — today only `apps/api`'s test suites and its in-memory
 * dev-fake-server do.
 */

import type {
  ClerkProfileDirectory,
  ClerkSubjectProfile,
  ClerkTokenVerifier,
  VerifiedClerkSubject,
} from './principal';

/** Thrown for every token the fake refuses, mirroring how the real adapter signals failure. */
export class FakeTokenRejected extends Error {
  constructor(reason: string) {
    super(`fake verifier rejected token: ${reason}`);
    this.name = 'FakeTokenRejected';
  }
}

export interface FakeTokenVerifierOptions {
  /**
   * Tokens the fake accepts, mapped to the subject they resolve to. Any token
   * not listed here is rejected — the fake is an allowlist, so a test cannot
   * accidentally authenticate with a token it never registered.
   */
  readonly tokens: ReadonlyMap<string, VerifiedClerkSubject>;
}

/**
 * A verifier that accepts exactly the tokens it was given and rejects
 * everything else — including the malformed, expired-looking and
 * wrong-signature shapes the API's 401 tests send.
 */
export function createFakeTokenVerifier(options: FakeTokenVerifierOptions): ClerkTokenVerifier {
  return {
    async verifySessionToken(token: string): Promise<VerifiedClerkSubject> {
      const subject = options.tokens.get(token);
      if (!subject) throw new FakeTokenRejected('unknown token');
      return subject;
    },
  };
}

/** A directory backed by a fixed map; an unknown subject throws, as a real 404 from Clerk would. */
export function createFakeProfileDirectory(
  profiles: ReadonlyMap<string, ClerkSubjectProfile>,
): ClerkProfileDirectory {
  return {
    async fetchProfile(clerkUserId: string): Promise<ClerkSubjectProfile> {
      const profile = profiles.get(clerkUserId);
      if (!profile) throw new Error(`fake directory has no profile for ${clerkUserId}`);
      return profile;
    },
  };
}
