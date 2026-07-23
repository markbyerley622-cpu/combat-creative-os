import type { AssetKind } from '@combat/domain';

export interface AssetRecord {
  id: string;
  workspaceId: string;
  kind: AssetKind;
  s3Key: string;
  checksum: string;
  mimeType: string;
  createdByAgentInvocationId?: string;
  uploadedByUserId?: string;
  createdAt: Date;
}

export interface AssetProvenanceRecord {
  id: string;
  workspaceId: string;
  assetId: string;
  derivedFromAssetIds: string[];
  producedByInvocationId?: string;
  providerJobRef?: string;
  createdAt: Date;
}

export interface AssetDataSource {
  asset: {
    create(args: {
      data: {
        workspaceId: string;
        kind: AssetKind;
        s3Key: string;
        checksum: string;
        mimeType: string;
        createdByAgentInvocationId?: string;
        uploadedByUserId?: string;
      };
    }): Promise<AssetRecord>;
    findFirst(args: { where: { id: string; workspaceId: string } }): Promise<AssetRecord | null>;
  };
  assetProvenance: {
    create(args: {
      data: {
        workspaceId: string;
        assetId: string;
        derivedFromAssetIds: string[];
        producedByInvocationId?: string;
        providerJobRef?: string;
      };
    }): Promise<AssetProvenanceRecord>;
    findFirst(args: { where: { assetId: string; workspaceId: string } }): Promise<AssetProvenanceRecord | null>;
  };
}

/**
 * Creates an Asset together with its (mandatory) provenance record in one
 * call — architecture.md: every Asset has a required ProvenanceRecord, so
 * there is no code path in this repository that creates an Asset without one.
 */
export async function createAssetWithProvenance(
  db: AssetDataSource,
  workspaceId: string,
  input: {
    kind: AssetKind;
    s3Key: string;
    checksum: string;
    mimeType: string;
    createdByAgentInvocationId?: string;
    uploadedByUserId?: string;
    derivedFromAssetIds?: string[];
    producedByInvocationId?: string;
    providerJobRef?: string;
  },
): Promise<{ asset: AssetRecord; provenance: AssetProvenanceRecord }> {
  const asset = await db.asset.create({
    data: {
      workspaceId,
      kind: input.kind,
      s3Key: input.s3Key,
      checksum: input.checksum,
      mimeType: input.mimeType,
      createdByAgentInvocationId: input.createdByAgentInvocationId,
      uploadedByUserId: input.uploadedByUserId,
    },
  });
  const provenance = await db.assetProvenance.create({
    data: {
      workspaceId,
      assetId: asset.id,
      derivedFromAssetIds: input.derivedFromAssetIds ?? [],
      producedByInvocationId: input.producedByInvocationId,
      providerJobRef: input.providerJobRef,
    },
  });
  return { asset, provenance };
}

export async function getAsset(
  db: AssetDataSource,
  workspaceId: string,
  assetId: string,
): Promise<AssetRecord | null> {
  return db.asset.findFirst({ where: { id: assetId, workspaceId } });
}

export async function getAssetProvenance(
  db: AssetDataSource,
  workspaceId: string,
  assetId: string,
): Promise<AssetProvenanceRecord | null> {
  return db.assetProvenance.findFirst({ where: { assetId, workspaceId } });
}

/**
 * Walks the provenance graph backwards from `assetId` to its full ancestry —
 * every asset it was (transitively) derived from. Cycles are guarded against
 * defensively (provenance is meant to be a DAG, never a cycle, but a
 * traversal function should not infinite-loop if that invariant is ever
 * violated by a bug elsewhere).
 */
export async function traceAssetLineage(
  db: AssetDataSource,
  workspaceId: string,
  assetId: string,
): Promise<string[]> {
  const visited = new Set<string>();
  const queue: string[] = [assetId];
  const lineage: string[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (currentId === undefined || visited.has(currentId)) continue;
    visited.add(currentId);

    const provenance = await db.assetProvenance.findFirst({ where: { assetId: currentId, workspaceId } });
    if (!provenance) continue;

    for (const ancestorId of provenance.derivedFromAssetIds) {
      if (!visited.has(ancestorId)) {
        lineage.push(ancestorId);
        queue.push(ancestorId);
      }
    }
  }

  return lineage;
}
