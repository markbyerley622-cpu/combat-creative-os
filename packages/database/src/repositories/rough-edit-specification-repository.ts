import type { RoughEditSpecification } from '@combat/domain';

export type RoughEditSpecificationRecord = RoughEditSpecification;

/**
 * M9 persistence for the Edit Director's canonical rough-edit / timeline
 * specification. Immutable + versioned per campaign (a re-composition writes a
 * new version); workspace-scoped throughout.
 */
export interface RoughEditSpecificationDataSource {
  roughEditSpecification: {
    create(args: {
      data: Omit<RoughEditSpecificationRecord, 'id' | 'createdAt'>;
    }): Promise<RoughEditSpecificationRecord>;
    findFirst(args: {
      where:
        | { id: string; workspaceId: string }
        | { campaignId: string; version: number; workspaceId: string };
    }): Promise<RoughEditSpecificationRecord | null>;
    findMany(args: {
      where: { campaignId: string; workspaceId: string };
    }): Promise<RoughEditSpecificationRecord[]>;
  };
}

/** Idempotent per `(campaignId, version)`: a replayed create returns the existing immutable row rather than inserting a duplicate. */
export async function createRoughEditSpecification(
  db: RoughEditSpecificationDataSource,
  workspaceId: string,
  input: Omit<RoughEditSpecificationRecord, 'id' | 'createdAt' | 'workspaceId'>,
): Promise<RoughEditSpecificationRecord> {
  const existing = await db.roughEditSpecification.findFirst({
    where: { campaignId: input.campaignId, version: input.version, workspaceId },
  });
  if (existing) return existing;
  return db.roughEditSpecification.create({ data: { workspaceId, ...input } });
}

export async function getRoughEditSpecification(
  db: RoughEditSpecificationDataSource,
  workspaceId: string,
  id: string,
): Promise<RoughEditSpecificationRecord | null> {
  return db.roughEditSpecification.findFirst({ where: { id, workspaceId } });
}

export async function getLatestRoughEditSpecification(
  db: RoughEditSpecificationDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<RoughEditSpecificationRecord | undefined> {
  const rows = await db.roughEditSpecification.findMany({ where: { campaignId, workspaceId } });
  return [...rows].sort((a, b) => b.version - a.version)[0];
}
