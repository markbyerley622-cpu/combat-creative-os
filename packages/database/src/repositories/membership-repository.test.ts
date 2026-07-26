import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addMembership,
  getMembership,
  listMembershipsForWorkspace,
  listWorkspacesForUser,
  type MembershipDataSource,
  type MembershipRecord,
} from './membership-repository';

/**
 * A minimal in-memory stand-in for PrismaClient's `membership` delegate that
 * actually performs the same filtering a real Postgres query would, so these
 * tests exercise real cross-workspace filtering behavior rather than just
 * asserting a mock was called with the right arguments.
 */
function createFakeDataSource(seed: MembershipRecord[] = []): MembershipDataSource {
  const rows = [...seed];
  return {
    membership: {
      async findFirst({ where }) {
        return rows.find((r) => r.id === where.id && r.workspaceId === where.workspaceId) ?? null;
      },
      async findMany({ where }) {
        // Two disjoint scopings, matching the data source's union: by workspace
        // (every membership-based authorization check) and by user (tenancy
        // discovery for the verified caller — see `listWorkspacesForUser`).
        return 'workspaceId' in where
          ? rows.filter((r) => r.workspaceId === where.workspaceId)
          : rows.filter((r) => r.userId === where.userId);
      },
      async create({ data }) {
        const record: MembershipRecord = { id: randomUUID(), createdAt: new Date(), ...data };
        rows.push(record);
        return record;
      },
    },
  };
}

describe('membership repository — workspace isolation', () => {
  it('returns a membership when the workspaceId matches', async () => {
    const workspaceId = randomUUID();
    const seeded: MembershipRecord = {
      id: randomUUID(),
      workspaceId,
      userId: randomUUID(),
      role: 'OWNER_ADMIN',
      createdAt: new Date(),
    };
    const db = createFakeDataSource([seeded]);

    const result = await getMembership(db, workspaceId, seeded.id);
    expect(result?.id).toBe(seeded.id);
  });

  it('returns null when the same membership id is queried under a foreign workspaceId', async () => {
    const homeWorkspaceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const seeded: MembershipRecord = {
      id: randomUUID(),
      workspaceId: homeWorkspaceId,
      userId: randomUUID(),
      role: 'OWNER_ADMIN',
      createdAt: new Date(),
    };
    const db = createFakeDataSource([seeded]);

    const result = await getMembership(db, foreignWorkspaceId, seeded.id);
    expect(result).toBeNull();
  });

  it('never returns rows from another workspace in a list query', async () => {
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const db = createFakeDataSource([
      {
        id: randomUUID(),
        workspaceId: workspaceA,
        userId: randomUUID(),
        role: 'ANALYST',
        createdAt: new Date(),
      },
      {
        id: randomUUID(),
        workspaceId: workspaceB,
        userId: randomUUID(),
        role: 'REVIEWER',
        createdAt: new Date(),
      },
    ]);

    const resultsForA = await listMembershipsForWorkspace(db, workspaceA);
    expect(resultsForA).toHaveLength(1);
    expect(resultsForA.every((r) => r.workspaceId === workspaceA)).toBe(true);
  });

  it('lists only the requesting user’s own workspaces', async () => {
    const caller = randomUUID();
    const other = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const foreign = randomUUID();
    const db = createFakeDataSource([
      {
        id: randomUUID(),
        workspaceId: workspaceA,
        userId: caller,
        role: 'OWNER_ADMIN',
        createdAt: new Date(),
      },
      {
        id: randomUUID(),
        workspaceId: workspaceB,
        userId: caller,
        role: 'ANALYST',
        createdAt: new Date(),
      },
      {
        id: randomUUID(),
        workspaceId: foreign,
        userId: other,
        role: 'OWNER_ADMIN',
        createdAt: new Date(),
      },
    ]);

    const result = await listWorkspacesForUser(db, caller);

    expect(result).toEqual([
      { workspaceId: workspaceA, role: 'OWNER_ADMIN' },
      { workspaceId: workspaceB, role: 'ANALYST' },
    ]);
    // The workspace the caller is not a member of is not disclosed at all.
    expect(result.some((r) => r.workspaceId === foreign)).toBe(false);
  });

  it('addMembership always writes the workspaceId passed by the caller, not one embedded in input', async () => {
    const workspaceId = randomUUID();
    const db = createFakeDataSource();

    const created = await addMembership(db, workspaceId, {
      userId: randomUUID(),
      role: 'REVIEWER',
    });
    expect(created.workspaceId).toBe(workspaceId);
  });
});
