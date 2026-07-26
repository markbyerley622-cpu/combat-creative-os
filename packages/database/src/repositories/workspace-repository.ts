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

/**
 * Provisioning needs a wider delegate than `WorkspaceDataSource` exposes: it
 * looks a workspace up **by id** and supplies that id on create, because the
 * tenancy root is the one row an operator names rather than discovers. Kept as
 * a separate interface so `WorkspaceDataSource` — and everything that already
 * implements it — is unchanged.
 */
export interface WorkspaceProvisioningDataSource {
  workspace: {
    create(args: { data: { id?: string; name: string; slug: string } }): Promise<WorkspaceRecord>;
    findFirst(args: { where: Record<string, unknown> }): Promise<WorkspaceRecord | null>;
  };
}

export class WorkspaceProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceProvisioningError';
  }
}

/**
 * Creates the tenancy root if it is absent, and otherwise returns what is
 * already there.
 *
 * Every reference, benchmark profile and campaign row carries a `workspaceId`
 * with a foreign key onto this table, so until it exists nothing else can be
 * written — and before this function there was no path to it outside a
 * hand-written `INSERT`. Idempotent on purpose: a bootstrap step an operator is
 * afraid to run twice is a bootstrap step that gets run from a shell history
 * instead of a runbook.
 *
 * A slug clash with a *different* id is refused rather than silently adopted.
 * Two workspaces answering to one slug is a tenancy defect, and quietly
 * returning the wrong one would attach a reference library to the wrong tenant.
 */
export async function ensureWorkspace(
  db: WorkspaceProvisioningDataSource,
  input: { id: string; name: string; slug: string },
): Promise<{ workspace: WorkspaceRecord; created: boolean }> {
  const existing = await db.workspace.findFirst({ where: { id: input.id } });
  if (existing) return { workspace: existing, created: false };

  const bySlug = await db.workspace.findFirst({ where: { slug: input.slug } });
  if (bySlug) {
    throw new WorkspaceProvisioningError(
      `slug "${input.slug}" already belongs to workspace ${bySlug.id}; choose another slug or use that id`,
    );
  }

  return {
    workspace: await db.workspace.create({
      data: { id: input.id, name: input.name, slug: input.slug },
    }),
    created: true,
  };
}
