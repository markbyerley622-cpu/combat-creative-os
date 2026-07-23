import { randomUUID } from 'node:crypto';

/**
 * Deliberately duck-typed rather than importing @combat/domain's Zod-inferred
 * types: packages/testing is a leaf package other packages depend on for test
 * helpers, and must not depend back on packages that could plausibly depend on
 * it, to keep the workspace dependency graph acyclic (see CLAUDE.md
 * "Architecture boundaries").
 */
export interface WorkspaceFixture {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export function buildWorkspaceFixture(overrides: Partial<WorkspaceFixture> = {}): WorkspaceFixture {
  const now = new Date();
  return {
    id: randomUUID(),
    name: 'Test Workspace',
    slug: 'test-workspace',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export interface MembershipFixture {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  createdAt: Date;
}

export function buildMembershipFixture(
  overrides: Partial<MembershipFixture> = {},
): MembershipFixture {
  return {
    id: randomUUID(),
    workspaceId: randomUUID(),
    userId: randomUUID(),
    role: 'OWNER_ADMIN',
    createdAt: new Date(),
    ...overrides,
  };
}

/** A second, distinct workspace id — useful for cross-workspace isolation tests. */
export function buildForeignWorkspaceId(): string {
  return randomUUID();
}
