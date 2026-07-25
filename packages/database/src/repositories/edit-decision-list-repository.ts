import type { EditDecisionEntry, EditDecisionList } from '@combat/domain';

export type EditDecisionListRecord = Omit<EditDecisionList, 'entries'>;
export type EditDecisionEntryRecord = EditDecisionEntry;

/** Input for one EDL entry (ids/workspaceId/listId assigned at persist time). */
export type EditDecisionEntryInput = Omit<
  EditDecisionEntryRecord,
  'id' | 'workspaceId' | 'editDecisionListId'
>;

/**
 * M9 persistence for the rough-edit `EditDecisionList` derived from a
 * `RoughEditSpecification`'s timeline. Its existence is what the
 * `roughCutAssembled` transition fact reads, letting the campaign advance out
 * of ROUGH_CUT. Immutable + versioned per campaign.
 */
export interface EditDecisionListDataSource {
  editDecisionList: {
    create(args: {
      data: Omit<EditDecisionListRecord, 'id' | 'createdAt'>;
    }): Promise<EditDecisionListRecord>;
    findFirst(args: {
      where:
        | { id: string; workspaceId: string }
        | { campaignId: string; version: number; workspaceId: string };
    }): Promise<EditDecisionListRecord | null>;
    findMany(args: {
      where: { campaignId: string; workspaceId?: string };
    }): Promise<EditDecisionListRecord[]>;
  };
  editDecisionEntry: {
    create(args: { data: Omit<EditDecisionEntryRecord, 'id'> }): Promise<EditDecisionEntryRecord>;
    findMany(args: { where: { editDecisionListId: string } }): Promise<EditDecisionEntryRecord[]>;
  };
}

/** Idempotent per `(campaignId, version)`: a replay returns the existing list rather than inserting a duplicate. */
export async function createEditDecisionList(
  db: EditDecisionListDataSource,
  workspaceId: string,
  input: { campaignId: string; version: number; entries: readonly EditDecisionEntryInput[] },
): Promise<EditDecisionListRecord> {
  const existing = await db.editDecisionList.findFirst({
    where: { campaignId: input.campaignId, version: input.version, workspaceId },
  });
  if (existing) return existing;

  const list = await db.editDecisionList.create({
    data: { workspaceId, campaignId: input.campaignId, version: input.version },
  });
  for (const entry of input.entries) {
    // eslint-disable-next-line no-await-in-loop -- small, per-list set; sequential keeps order deterministic and only runs once per fresh list
    await db.editDecisionEntry.create({
      data: { workspaceId, editDecisionListId: list.id, ...entry },
    });
  }
  return list;
}

export async function getLatestEditDecisionList(
  db: EditDecisionListDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<EditDecisionListRecord | undefined> {
  const rows = await db.editDecisionList.findMany({ where: { campaignId, workspaceId } });
  return [...rows].sort((a, b) => b.version - a.version)[0];
}

export async function listEditDecisionEntries(
  db: EditDecisionListDataSource,
  editDecisionListId: string,
): Promise<EditDecisionEntryRecord[]> {
  const rows = await db.editDecisionEntry.findMany({ where: { editDecisionListId } });
  return [...rows].sort((a, b) => a.order - b.order);
}
