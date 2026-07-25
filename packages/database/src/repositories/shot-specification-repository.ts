import type { ShotSpecification } from '@combat/domain';

export type ShotSpecificationRecord = ShotSpecification;

/**
 * `workspaceId` optional on the `findMany` where clause for the same
 * structural-compatibility reason as `creative-concept-repository.ts` —
 * `TransitionFactsDataSource['shotSpecification']` queries by `shotId` alone.
 */
export interface ShotSpecificationDataSource {
  shotSpecification: {
    create(args: {
      data: Omit<ShotSpecificationRecord, 'id' | 'createdAt'>;
    }): Promise<ShotSpecificationRecord>;
    findFirst(args: {
      where: { id: string; workspaceId: string };
    }): Promise<ShotSpecificationRecord | null>;
    findMany(args: {
      where: { shotId: string; workspaceId?: string };
    }): Promise<ShotSpecificationRecord[]>;
  };
}

/**
 * Idempotent create: a `(shotId, version)` pair is immutable once written —
 * an Activity retry that already persisted this exact version returns the
 * existing row instead of re-inserting (violates the Prisma
 * `@@unique([shotId, version])` constraint otherwise).
 */
export async function createShotSpecification(
  db: ShotSpecificationDataSource,
  workspaceId: string,
  input: Omit<ShotSpecificationRecord, 'id' | 'createdAt' | 'workspaceId'>,
): Promise<ShotSpecificationRecord> {
  const existing = await db.shotSpecification.findMany({
    where: { shotId: input.shotId, workspaceId },
  });
  const match = existing.find((s) => s.version === input.version);
  if (match) return match;
  return db.shotSpecification.create({ data: { workspaceId, ...input } });
}

export async function getShotSpecification(
  db: ShotSpecificationDataSource,
  workspaceId: string,
  shotSpecificationId: string,
): Promise<ShotSpecificationRecord | null> {
  return db.shotSpecification.findFirst({ where: { id: shotSpecificationId, workspaceId } });
}

export async function listShotSpecificationsForShot(
  db: ShotSpecificationDataSource,
  workspaceId: string,
  shotId: string,
): Promise<ShotSpecificationRecord[]> {
  return db.shotSpecification.findMany({ where: { shotId, workspaceId } });
}

/** The specification a new generation dispatch or revision should act on — the highest `version` for this shot. */
export async function getLatestShotSpecification(
  db: ShotSpecificationDataSource,
  workspaceId: string,
  shotId: string,
): Promise<ShotSpecificationRecord | undefined> {
  const specs = await listShotSpecificationsForShot(db, workspaceId, shotId);
  return [...specs].sort((a, b) => b.version - a.version)[0];
}
