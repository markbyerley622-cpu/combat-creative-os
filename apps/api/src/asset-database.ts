import type { AssetDataSource, LicenseDataSource, PrismaClient } from '@combat/database';
import { createCampaignDatabase, type CampaignDatabase } from './campaign-database';

/**
 * The M5 asset-ingestion routes' combined data-source contract — same
 * "adapt a real PrismaClient to the repository layer's narrow *DataSource
 * interfaces" pattern as campaign-database.ts, composed with it rather than
 * duplicating it.
 */
export type AssetDatabase = CampaignDatabase & AssetDataSource & LicenseDataSource;

export function createAssetDatabase(prisma: PrismaClient): AssetDatabase {
  const campaignDb = createCampaignDatabase(prisma);

  return {
    ...campaignDb,
    asset: {
      // Prisma's nullable columns (`String?`/`Json?`) round-trip as `null`;
      // the repository layer's optional-field convention (`| undefined`) is
      // bridged here, same as every other adapter in this file.
      create: async (args) => {
        const created = await prisma.asset.create({ data: args.data as never });
        return mapAsset(created);
      },
      findFirst: async (args) => {
        const found = await prisma.asset.findFirst({ where: args.where });
        return found ? mapAsset(found) : null;
      },
      findMany: async (args) => {
        const rows = await prisma.asset.findMany({ where: args.where });
        return rows.map(mapAsset);
      },
      update: async (args) => {
        const updated = await prisma.asset.update({
          where: args.where,
          data: args.data as never,
        });
        return mapAsset(updated);
      },
    },
    assetProvenance: {
      create: async (args) => {
        const created = await prisma.assetProvenance.create({ data: args.data });
        return {
          ...created,
          producedByInvocationId: created.producedByInvocationId ?? undefined,
          providerJobRef: created.providerJobRef ?? undefined,
        };
      },
      findFirst: async (args) => {
        const found = await prisma.assetProvenance.findFirst({ where: args.where });
        return found
          ? {
              ...found,
              producedByInvocationId: found.producedByInvocationId ?? undefined,
              providerJobRef: found.providerJobRef ?? undefined,
            }
          : null;
      },
    },
    licenseRecord: {
      create: async (args) => {
        const created = await prisma.licenseRecord.create({ data: args.data });
        return { ...created, expiresAt: created.expiresAt ?? undefined };
      },
      findFirst: async (args) => {
        const found = await prisma.licenseRecord.findFirst({ where: args.where });
        return found ? { ...found, expiresAt: found.expiresAt ?? undefined } : null;
      },
    },
  };
}

// `mediaMetadata` is validated (packages/domain's MediaMetadataSchema) by
// asset-repository.ts's recordMediaInspectionResult before it's ever
// written — the cast here is safe, not a bypass, matching this file's other
// Json-column casts.
function mapAsset(row: {
  mediaMetadata: unknown;
  inspectionFailureDetails: string | null;
  createdByAgentInvocationId: string | null;
  uploadedByUserId: string | null;
  generatedByActivity: string | null;
  [key: string]: unknown;
}) {
  return {
    ...row,
    mediaMetadata: row.mediaMetadata ?? undefined,
    inspectionFailureDetails: row.inspectionFailureDetails ?? undefined,
    createdByAgentInvocationId: row.createdByAgentInvocationId ?? undefined,
    uploadedByUserId: row.uploadedByUserId ?? undefined,
    generatedByActivity: row.generatedByActivity ?? undefined,
  } as never;
}
