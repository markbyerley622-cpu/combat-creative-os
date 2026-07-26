import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';
import { findUserByClerkSubject, resolveUserForClerkSubject } from './user-repository';

const PROFILE = {
  clerkUserId: 'user_2abcDEF',
  email: 'fighter@example.test',
  displayName: 'Ada Fighter',
};

describe('resolveUserForClerkSubject', () => {
  it('provisions a local user on first sign-in', async () => {
    const store = new InMemoryCampaignStore();

    const result = await resolveUserForClerkSubject(store, PROFILE);

    expect(result).toMatchObject({ ok: true, provisioned: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.user.clerkUserId).toBe(PROFILE.clerkUserId);
    expect(result.user.email).toBe(PROFILE.email);
    expect(store.users).toHaveLength(1);
  });

  it('is idempotent — repeated sign-ins return the same user and write nothing', async () => {
    const store = new InMemoryCampaignStore();

    const first = await resolveUserForClerkSubject(store, PROFILE);
    const second = await resolveUserForClerkSubject(store, PROFILE);
    const third = await resolveUserForClerkSubject(store, PROFILE);

    if (!first.ok || !second.ok || !third.ok) throw new Error('unreachable');
    expect(second.user.id).toBe(first.user.id);
    expect(third.user.id).toBe(first.user.id);
    expect(second.provisioned).toBe(false);
    expect(third.provisioned).toBe(false);
    expect(store.users).toHaveLength(1);
  });

  it('converges on one user when two first sign-ins race', async () => {
    const store = new InMemoryCampaignStore();

    const [a, b] = await Promise.all([
      resolveUserForClerkSubject(store, PROFILE),
      resolveUserForClerkSubject(store, PROFILE),
    ]);

    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.user.id).toBe(b.user.id);
    expect(store.users).toHaveLength(1);
  });

  it('links a pre-existing invited user so their memberships survive first sign-in', async () => {
    const store = new InMemoryCampaignStore();
    const seeded = store.seedUser({ email: PROFILE.email, displayName: 'Invited Earlier' });

    const result = await resolveUserForClerkSubject(store, PROFILE);

    if (!result.ok) throw new Error('unreachable');
    // The *seeded* id is what Membership rows point at — provisioning a second
    // row here would silently strip the invited member of their role.
    expect(result.user.id).toBe(seeded.id);
    expect(result.user.clerkUserId).toBe(PROFILE.clerkUserId);
    expect(result.user.displayName).toBe('Invited Earlier');
    expect(store.users).toHaveLength(1);
  });

  it('refuses to re-bind an email already held by a different verified subject', async () => {
    const store = new InMemoryCampaignStore();
    store.seedUser({ email: PROFILE.email, clerkUserId: 'user_someoneElse' });

    const result = await resolveUserForClerkSubject(store, PROFILE);

    expect(result).toEqual({ ok: false, reason: 'EMAIL_BOUND_TO_ANOTHER_SUBJECT' });
    expect(store.users).toHaveLength(1);
  });

  it('never resolves one subject to two users — the unique index is mirrored', async () => {
    const store = new InMemoryCampaignStore();
    store.seedUser({ clerkUserId: PROFILE.clerkUserId, email: 'first@example.test' });

    await expect(
      store.user.create({
        data: {
          email: 'second@example.test',
          displayName: 'Dup',
          clerkUserId: PROFILE.clerkUserId,
        },
      }),
    ).rejects.toThrow(/unique constraint violation on users \(clerkUserId\)/);
  });
});

describe('findUserByClerkSubject', () => {
  it('returns null for an unknown subject rather than any partial match', async () => {
    const store = new InMemoryCampaignStore();
    store.seedUser({ clerkUserId: PROFILE.clerkUserId });

    expect(await findUserByClerkSubject(store, 'user_unknown')).toBeNull();
  });

  it('never matches a user that has never signed in', async () => {
    const store = new InMemoryCampaignStore();
    store.seedUser({ email: PROFILE.email });

    expect(await findUserByClerkSubject(store, PROFILE.clerkUserId)).toBeNull();
  });
});
