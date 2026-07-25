import type { AssetIngestionStatus, AssetKind, MediaMetadata } from '@combat/domain';

export interface AssetRecord {
  id: string;
  workspaceId: string;
  campaignId: string;
  kind: AssetKind;
  s3Key: string;
  checksum: string;
  mimeType: string;
  originalFilename: string;
  sizeBytes: number;
  ingestionStatus: AssetIngestionStatus;
  mediaMetadata?: MediaMetadata;
  inspectionFailureDetails?: string;
  createdByAgentInvocationId?: string;
  uploadedByUserId?: string;
  generatedByActivity?: string;
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
        campaignId: string;
        kind: AssetKind;
        s3Key: string;
        checksum: string;
        mimeType: string;
        originalFilename: string;
        sizeBytes: number;
        ingestionStatus: AssetIngestionStatus;
        createdByAgentInvocationId?: string;
        uploadedByUserId?: string;
        generatedByActivity?: string;
      };
    }): Promise<AssetRecord>;
    findFirst(args: { where: { id: string; workspaceId: string } }): Promise<AssetRecord | null>;
    /** `workspaceId` optional on the where clause for the same structural-compatibility reason as other M4/M5 repositories that widen an existing narrow query shape — see creative-concept-repository.ts's doc comment for the pattern this follows. */
    findMany(
      args:
        | { where: { workspaceId: string; checksum: string; kind: AssetKind } }
        | { where: { workspaceId: string; campaignId: string; kind?: AssetKind } },
    ): Promise<AssetRecord[]>;
    update(args: {
      where: { id: string };
      data: {
        ingestionStatus: AssetIngestionStatus;
        mediaMetadata?: MediaMetadata;
        inspectionFailureDetails?: string;
      };
    }): Promise<AssetRecord>;
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
    findFirst(args: {
      where: { assetId: string; workspaceId: string };
    }): Promise<AssetProvenanceRecord | null>;
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
    campaignId: string;
    kind: AssetKind;
    s3Key: string;
    checksum: string;
    mimeType: string;
    originalFilename: string;
    sizeBytes: number;
    ingestionStatus?: AssetIngestionStatus;
    createdByAgentInvocationId?: string;
    uploadedByUserId?: string;
    generatedByActivity?: string;
    derivedFromAssetIds?: string[];
    producedByInvocationId?: string;
    providerJobRef?: string;
  },
): Promise<{ asset: AssetRecord; provenance: AssetProvenanceRecord }> {
  const asset = await db.asset.create({
    data: {
      workspaceId,
      campaignId: input.campaignId,
      kind: input.kind,
      s3Key: input.s3Key,
      checksum: input.checksum,
      mimeType: input.mimeType,
      originalFilename: input.originalFilename,
      sizeBytes: input.sizeBytes,
      ingestionStatus: input.ingestionStatus ?? 'PENDING',
      createdByAgentInvocationId: input.createdByAgentInvocationId,
      uploadedByUserId: input.uploadedByUserId,
      generatedByActivity: input.generatedByActivity,
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

/**
 * "Detects duplicate uploads using workspace, checksum and asset type" —
 * the ingestion service's dedup lookup. Deliberately workspace-wide, not
 * campaign-scoped: the same file uploaded to two campaigns in the same
 * workspace resolves to the same Asset row (see the Prisma schema's
 * `@@unique([workspaceId, checksum, kind])` on Asset).
 */
export async function findAssetByChecksum(
  db: AssetDataSource,
  workspaceId: string,
  checksum: string,
  kind: AssetKind,
): Promise<AssetRecord | undefined> {
  const matches = await db.asset.findMany({ where: { workspaceId, checksum, kind } });
  return matches[0];
}

/** All assets collected for a campaign, optionally narrowed to one `AssetKind` — the reference-asset pool a shot-generation dispatch can draw from. */
export async function listAssetsForCampaign(
  db: AssetDataSource,
  workspaceId: string,
  campaignId: string,
  kind?: AssetKind,
): Promise<AssetRecord[]> {
  return db.asset.findMany({ where: { workspaceId, campaignId, kind } });
}

/**
 * Transitions an Asset's ingestion status after `inspectMediaActivity` runs
 * — the one place an Asset row is ever mutated after creation (its content
 * fields — s3Key/checksum/kind — stay immutable; only this status
 * transitions, the same pattern Shot.status/GenerationCandidate.status
 * already establish elsewhere in this schema).
 */
export async function recordMediaInspectionResult(
  db: AssetDataSource,
  assetId: string,
  result: { ok: true; mediaMetadata: MediaMetadata } | { ok: false; failureDetails: string },
): Promise<AssetRecord> {
  return db.asset.update({
    where: { id: assetId },
    data: result.ok
      ? { ingestionStatus: 'READY', mediaMetadata: result.mediaMetadata }
      : { ingestionStatus: 'FAILED', inspectionFailureDetails: result.failureDetails },
  });
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

    const provenance = await db.assetProvenance.findFirst({
      where: { assetId: currentId, workspaceId },
    });
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
