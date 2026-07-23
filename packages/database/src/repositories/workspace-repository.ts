/**
 * Workspace itself is the tenancy root (docs/architecture.md §4.4) and is
 * therefore exempt from the "workspaceId first argument" rule every other
 * repository in this package follows — there is nothing to scope it by.
 */

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceDataSource {
  workspace: {
    create(args: { data: { name: string; slug: string } }): Promise<WorkspaceRecord>;
    findUnique(args: { where: { slug: string } }): Promise<WorkspaceRecord | null>;
  };
}

export async function createWorkspace(
  db: WorkspaceDataSource,
  input: { name: string; slug: string },
): Promise<WorkspaceRecord> {
  return db.workspace.create({ data: input });
}

export async function getWorkspaceBySlug(
  db: WorkspaceDataSource,
  slug: string,
): Promise<WorkspaceRecord | null> {
  return db.workspace.findUnique({ where: { slug } });
}
