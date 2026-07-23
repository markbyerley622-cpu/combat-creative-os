import { describe, expect, it } from 'vitest';
import { buildWorkspaceFixture, buildMembershipFixture, buildForeignWorkspaceId } from './fixtures';

describe('buildWorkspaceFixture', () => {
  it('produces a workspace with sensible defaults', () => {
    const workspace = buildWorkspaceFixture();
    expect(workspace.name).toBe('Test Workspace');
    expect(workspace.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('applies overrides', () => {
    const workspace = buildWorkspaceFixture({ name: 'Combat Reviews' });
    expect(workspace.name).toBe('Combat Reviews');
  });
});

describe('buildMembershipFixture and buildForeignWorkspaceId', () => {
  it('produces two distinct workspace ids for isolation tests', () => {
    const membership = buildMembershipFixture();
    const foreignWorkspaceId = buildForeignWorkspaceId();
    expect(foreignWorkspaceId).not.toBe(membership.workspaceId);
  });
});
