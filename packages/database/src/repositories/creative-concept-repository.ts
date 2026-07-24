import type { CreativeConcept } from '@combat/domain';

export type CreativeConceptRecord = CreativeConcept;

/**
 * `workspaceId` on the `where` clause is optional so this interface stays
 * structurally compatible with `TransitionFactsDataSource['creativeConcept']`
 * (packages/database/src/repositories/transition-facts.ts), which queries by
 * `campaignId` alone — a real `PrismaClient`/this package's in-memory fake
 * satisfies both call shapes from one implementation. Callers in this file
 * always pass it; the narrower fact-derivation call site does not.
 */
export interface CreativeConceptDataSource {
  creativeConcept: {
    create(args: {
      data: Omit<CreativeConceptRecord, 'id' | 'createdAt'>;
    }): Promise<CreativeConceptRecord>;
    findMany(args: {
      where: { campaignId: string; workspaceId?: string };
    }): Promise<CreativeConceptRecord[]>;
  };
}

/** Idempotent create: returns the existing `(campaignId, version)` row instead of re-inserting on an Activity retry. */
export async function createCreativeConcept(
  db: CreativeConceptDataSource,
  workspaceId: string,
  input: Omit<CreativeConceptRecord, 'id' | 'createdAt' | 'workspaceId'>,
): Promise<CreativeConceptRecord> {
  const existing = await db.creativeConcept.findMany({
    where: { campaignId: input.campaignId, workspaceId },
  });
  const match = existing.find((c) => c.version === input.version);
  if (match) return match;
  return db.creativeConcept.create({ data: { workspaceId, ...input } });
}

export async function listCreativeConcepts(
  db: CreativeConceptDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<CreativeConceptRecord[]> {
  return db.creativeConcept.findMany({ where: { campaignId, workspaceId } });
}

export async function getLatestCreativeConcept(
  db: CreativeConceptDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<CreativeConceptRecord | undefined> {
  const concepts = await listCreativeConcepts(db, workspaceId, campaignId);
  return [...concepts].sort((a, b) => b.version - a.version)[0];
}
