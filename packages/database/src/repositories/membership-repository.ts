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
    findMany(args: { where: { workspaceId: string } }): Promise<MembershipRecord[]>;
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
