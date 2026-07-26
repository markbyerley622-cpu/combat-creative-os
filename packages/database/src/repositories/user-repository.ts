/**
 * The `User` aggregate — the local authorization identity a verified external
 * subject maps onto (AAMP-1 step 2, docs/adr/0006).
 *
 * `User` is **not** workspace-owned: it is the person, and a person may hold
 * memberships in several workspaces. It is therefore exempt from this package's
 * "workspaceId first argument" rule for the same reason `Workspace` is (see
 * workspace-repository.ts) — there is nothing to scope it by. Everything a
 * caller is *allowed to do* still hangs off `Membership`, which is
 * workspace-scoped and unchanged.
 *
 * Nothing here reads a role, a permission or a workspace. Identity resolution
 * and authorization are deliberately separate steps: this file answers "which
 * local user is this verified subject", and `membership-repository.ts` +
 * `@combat/domain`'s permission matrix answer "what may that user do here".
 */

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  /** The verified external subject identifier (Clerk `sub`), or null for a user that has never signed in. */
  clerkUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserDataSource {
  user: {
    findFirst(args: {
      where: { clerkUserId: string } | { email: string };
    }): Promise<UserRecord | null>;
    create(args: {
      data: { email: string; displayName: string; clerkUserId: string };
    }): Promise<UserRecord>;
    update(args: { where: { id: string }; data: { clerkUserId: string } }): Promise<UserRecord>;
  };
}

export async function findUserByClerkSubject(
  db: UserDataSource,
  clerkUserId: string,
): Promise<UserRecord | null> {
  return db.user.findFirst({ where: { clerkUserId } });
}

export interface ClerkSubjectProfile {
  readonly clerkUserId: string;
  readonly email: string;
  readonly displayName: string;
}

export type ProvisionUserResult =
  | { readonly ok: true; readonly user: UserRecord; readonly provisioned: boolean }
  /**
   * The email already belongs to a local user bound to a *different* verified
   * subject. Linking would silently hand one person's memberships to another,
   * so this refuses rather than guessing — the caller turns it into a 401.
   */
  | { readonly ok: false; readonly reason: 'EMAIL_BOUND_TO_ANOTHER_SUBJECT' };

/**
 * Resolves a verified external subject to its local `User`, creating or linking
 * one on first sign-in.
 *
 * Idempotent by construction, in three ordered steps:
 *
 * 1. **Already mapped** — a row with this `clerkUserId` is returned unchanged.
 *    Every sign-in after the first takes this path and writes nothing.
 * 2. **Pre-existing local user, first sign-in** — a row with the same email and
 *    no subject yet is *linked*. This is what lets a seeded or invited member
 *    keep the `Membership` rows (and therefore the role) they were given before
 *    they ever signed in. A row already bound to a different subject is refused.
 * 3. **Genuinely new** — a row is created. A concurrent duplicate loses the
 *    `clerkUserId` unique constraint and is resolved by re-reading the winner's
 *    row, so two simultaneous first requests converge on one user rather than
 *    one of them 500-ing. The unique index added in
 *    `20260726062308_add_user_clerk_subject` is what makes that safe on
 *    Postgres, not just in the in-memory fake.
 *
 * The profile is caller-supplied and describes the subject only. No role,
 * membership, workspace or entitlement is ever derived from it.
 */
export async function resolveUserForClerkSubject(
  db: UserDataSource,
  profile: ClerkSubjectProfile,
): Promise<ProvisionUserResult> {
  const existing = await db.user.findFirst({ where: { clerkUserId: profile.clerkUserId } });
  if (existing) return { ok: true, user: existing, provisioned: false };

  const byEmail = await db.user.findFirst({ where: { email: profile.email } });
  if (byEmail) {
    if (byEmail.clerkUserId && byEmail.clerkUserId !== profile.clerkUserId) {
      return { ok: false, reason: 'EMAIL_BOUND_TO_ANOTHER_SUBJECT' };
    }
    if (byEmail.clerkUserId === profile.clerkUserId) {
      return { ok: true, user: byEmail, provisioned: false };
    }
    const linked = await db.user.update({
      where: { id: byEmail.id },
      data: { clerkUserId: profile.clerkUserId },
    });
    return { ok: true, user: linked, provisioned: true };
  }

  try {
    const created = await db.user.create({
      data: {
        email: profile.email,
        displayName: profile.displayName,
        clerkUserId: profile.clerkUserId,
      },
    });
    return { ok: true, user: created, provisioned: true };
  } catch (error) {
    // Lost a race to a concurrent first sign-in for the same subject (or the
    // same email). The winner's row is authoritative; re-read it rather than
    // surfacing a constraint violation to the caller.
    const winner = await db.user.findFirst({ where: { clerkUserId: profile.clerkUserId } });
    if (winner) return { ok: true, user: winner, provisioned: false };
    throw error;
  }
}
