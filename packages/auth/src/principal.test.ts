import { describe, expect, it, vi } from 'vitest';
import { InMemoryCampaignStore } from '@combat/database';
import {
  extractBearerToken,
  resolvePrincipal,
  type ClerkProfileDirectory,
  type ClerkTokenVerifier,
  type PrincipalResolverDeps,
} from './principal';
import { createFakeProfileDirectory, createFakeTokenVerifier } from './testing';

const SUBJECT = 'user_2abcDEF';
const TOKEN = 'valid.session.token';
const PROFILE = { email: 'fighter@example.test', displayName: 'Ada Fighter' };

function buildDeps(
  store: InMemoryCampaignStore,
  overrides: Partial<PrincipalResolverDeps> = {},
): PrincipalResolverDeps {
  return {
    verifier: createFakeTokenVerifier({ tokens: new Map([[TOKEN, { clerkUserId: SUBJECT }]]) }),
    directory: createFakeProfileDirectory(new Map([[SUBJECT, PROFILE]])),
    db: store,
    ...overrides,
  };
}

describe('extractBearerToken', () => {
  it('accepts a well-formed bearer header, case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def')).toBe('abc.def');
    expect(extractBearerToken('bearer abc.def')).toBe('abc.def');
    expect(extractBearerToken('  Bearer   abc.def  ')).toBe('abc.def');
  });

  it('rejects anything that is not exactly one bearer token', () => {
    for (const header of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      'Basic abc.def',
      'abc.def',
      'Bearer abc def',
    ]) {
      expect(extractBearerToken(header)).toBeNull();
    }
  });
});

describe('resolvePrincipal', () => {
  it('rejects a request with no token before touching the verifier or the database', async () => {
    const store = new InMemoryCampaignStore();
    const verifier: ClerkTokenVerifier = { verifySessionToken: vi.fn() };

    const result = await resolvePrincipal(buildDeps(store, { verifier }), null);

    expect(result).toEqual({ ok: false, reason: 'NO_TOKEN' });
    expect(verifier.verifySessionToken).not.toHaveBeenCalled();
    expect(store.users).toHaveLength(0);
  });

  it('rejects a token the verifier refuses, and provisions nothing', async () => {
    const store = new InMemoryCampaignStore();

    for (const bad of ['not-a-jwt', 'a.b.c', `${TOKEN}-tampered`, '']) {
      const result = await resolvePrincipal(buildDeps(store), bad || null);
      expect(result.ok).toBe(false);
    }
    expect(store.users).toHaveLength(0);
  });

  it('rejects a verified token carrying an empty subject', async () => {
    const store = new InMemoryCampaignStore();
    const verifier: ClerkTokenVerifier = {
      verifySessionToken: async () => ({ clerkUserId: '' }),
    };

    const result = await resolvePrincipal(buildDeps(store, { verifier }), TOKEN);

    expect(result).toEqual({ ok: false, reason: 'INVALID_TOKEN' });
  });

  it('resolves a verified subject to its existing local user', async () => {
    const store = new InMemoryCampaignStore();
    const seeded = store.seedUser({ clerkUserId: SUBJECT, email: PROFILE.email });

    const result = await resolvePrincipal(buildDeps(store), TOKEN);

    expect(result).toEqual({
      ok: true,
      principal: { userId: seeded.id, clerkUserId: SUBJECT, email: PROFILE.email },
    });
  });

  it('makes no identity-provider profile call once the subject is mapped', async () => {
    const store = new InMemoryCampaignStore();
    store.seedUser({ clerkUserId: SUBJECT, email: PROFILE.email });
    const directory: ClerkProfileDirectory = { fetchProfile: vi.fn() };

    await resolvePrincipal(buildDeps(store, { directory }), TOKEN);

    expect(directory.fetchProfile).not.toHaveBeenCalled();
  });

  it('provisions on first sign-in and is idempotent thereafter', async () => {
    const store = new InMemoryCampaignStore();

    const first = await resolvePrincipal(buildDeps(store), TOKEN);
    const second = await resolvePrincipal(buildDeps(store), TOKEN);

    if (!first.ok || !second.ok) throw new Error('expected both to authenticate');
    expect(second.principal).toEqual(first.principal);
    expect(store.users).toHaveLength(1);
  });

  it('fails closed when the subject has no resolvable profile', async () => {
    const store = new InMemoryCampaignStore();
    const directory = createFakeProfileDirectory(new Map());

    const result = await resolvePrincipal(buildDeps(store, { directory }), TOKEN);

    expect(result).toEqual({ ok: false, reason: 'NO_LOCAL_USER' });
    expect(store.users).toHaveLength(0);
  });

  it('refuses a subject whose email already belongs to another subject', async () => {
    const store = new InMemoryCampaignStore();
    store.seedUser({ email: PROFILE.email, clerkUserId: 'user_someoneElse' });

    const result = await resolvePrincipal(buildDeps(store), TOKEN);

    expect(result).toEqual({ ok: false, reason: 'NO_LOCAL_USER' });
  });

  it('carries no workspace, role or organisation on the principal', async () => {
    const store = new InMemoryCampaignStore();
    store.seedUser({ clerkUserId: SUBJECT, email: PROFILE.email });

    const result = await resolvePrincipal(buildDeps(store), TOKEN);

    if (!result.ok) throw new Error('expected authentication to succeed');
    // Authorization reads PostgreSQL, never a token claim — so the principal
    // deliberately has no field an authorization check could shortcut through.
    expect(Object.keys(result.principal).sort()).toEqual(['clerkUserId', 'email', 'userId']);
  });
});
