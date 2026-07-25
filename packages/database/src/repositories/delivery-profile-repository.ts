import type { DeliveryProfile, DeliveryProfileContent } from '@combat/domain';

export type DeliveryProfileRecord = DeliveryProfile;

/**
 * M12 persistence for the named, versioned delivery profile a campaign's
 * variants are cut against. Immutable: `getOrCreateDeliveryProfile` is
 * idempotent per `(workspaceId, key, version)` and there is deliberately no
 * `update` — a changed requirement is a new version row, so a
 * `VariantSpecification` that pinned version N keeps meaning what it meant.
 */
export interface DeliveryProfileDataSource {
  deliveryProfile: {
    create(args: {
      data: Omit<DeliveryProfileRecord, 'id' | 'createdAt'>;
    }): Promise<DeliveryProfileRecord>;
    findFirst(args: {
      where:
        { id: string; workspaceId: string } | { key: string; version: number; workspaceId: string };
    }): Promise<DeliveryProfileRecord | null>;
    findMany(args: {
      where: { workspaceId: string; key?: string };
    }): Promise<DeliveryProfileRecord[]>;
  };
}

export async function getOrCreateDeliveryProfile(
  db: DeliveryProfileDataSource,
  workspaceId: string,
  content: DeliveryProfileContent,
): Promise<{ profile: DeliveryProfileRecord; alreadyExisted: boolean }> {
  const existing = await db.deliveryProfile.findFirst({
    where: { key: content.key, version: content.version, workspaceId },
  });
  if (existing) return { profile: existing, alreadyExisted: true };
  const profile = await db.deliveryProfile.create({ data: { workspaceId, ...content } });
  return { profile, alreadyExisted: false };
}

export async function getDeliveryProfileById(
  db: DeliveryProfileDataSource,
  workspaceId: string,
  id: string,
): Promise<DeliveryProfileRecord | undefined> {
  return (await db.deliveryProfile.findFirst({ where: { id, workspaceId } })) ?? undefined;
}

/** The highest persisted version of `key` — what a fresh VARIANT_GENERATION visit cuts against. */
export async function getLatestDeliveryProfile(
  db: DeliveryProfileDataSource,
  workspaceId: string,
  key: string,
): Promise<DeliveryProfileRecord | undefined> {
  const rows = await db.deliveryProfile.findMany({ where: { workspaceId, key } });
  return [...rows].sort((a, b) => b.version - a.version)[0];
}

export async function listDeliveryProfiles(
  db: DeliveryProfileDataSource,
  workspaceId: string,
): Promise<DeliveryProfileRecord[]> {
  const rows = await db.deliveryProfile.findMany({ where: { workspaceId } });
  return [...rows].sort((a, b) => a.key.localeCompare(b.key) || b.version - a.version);
}
