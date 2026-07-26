/**
 * Workspace-scoped repository layer.
 *
 * Rule (see CLAUDE.md "Architecture boundaries" / docs/architecture.md §4.4):
 * every read/write in this file takes `workspaceId` as its first argument and
 * folds it into the Prisma `where` clause. There is no function here that can
 * look up a membership by id alone — that is the mechanism that makes
 * cross-workspace access a repository-layer bug class unit tests can cover
 * exhaustively, rather than something every call site must remember to check.
 *
 * The data-source parameter is typed narrowly (not as the full generated
 * PrismaClient) so tests can inject an in-memory fake without depending on a
 * live Postgres instance — see membership-repository.test.ts.
 */

export interface MembershipRecord {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  createdAt: Date;
}

export interface MembershipDataSource {
  membership: {
    findFirst(args: {
      where: { id: string; workspaceId: string };
    }): Promise<MembershipRecord | null>;
    findMany(args: {
      where: { workspaceId: string } | { userId: string };
    }): Promise<MembershipRecord[]>;
    create(args: {
      data: { workspaceId: string; userId: string; role: string };
    }): Promise<MembershipRecord>;
  };
}

export async function listMembershipsForWorkspace(
  db: MembershipDataSource,
  workspaceId: string,
): Promise<MembershipRecord[]> {
  return db.membership.findMany({ where: { workspaceId } });
}

/**
 * The one query in this file that is not workspace-scoped, and the only one
 * that may be: "which workspaces does this user belong to" is the *tenancy
 * discovery* question, asked before a workspace is known.
 *
 * It is safe precisely because it is scoped by the caller's own verified
 * `userId` (AAMP-1 step 2) rather than by a workspace: it can only ever return
 * the caller's own memberships, so it discloses nothing about workspaces they
 * are not in and cannot be used to enumerate tenants. Every subsequent
 * operation still goes through a workspace-scoped function — this replaces the
 * workspace id a human used to type into the dashboard's development identity
 * picker, not the scoping that guards each request.
 */
export async function listWorkspacesForUser(
  db: MembershipDataSource,
  userId: string,
): Promise<{ workspaceId: string; role: string }[]> {
  const memberships = await db.membership.findMany({ where: { userId } });
  return memberships.map((membership) => ({
    workspaceId: membership.workspaceId,
    role: membership.role,
  }));
}

export async function getMembership(
  db: MembershipDataSource,
  workspaceId: string,
  membershipId: string,
): Promise<MembershipRecord | null> {
  return db.membership.findFirst({ where: { id: membershipId, workspaceId } });
}

export async function addMembership(
  db: MembershipDataSource,
  workspaceId: string,
  input: { userId: string; role: string },
): Promise<MembershipRecord> {
  return db.membership.create({
    data: { workspaceId, userId: input.userId, role: input.role },
  });
}
