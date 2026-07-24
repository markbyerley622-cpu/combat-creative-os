import type { LicenseType } from '@combat/domain';

/** 0..1 on Asset by design — intermediate/generated assets (proxies, thumbnails) don't need one; only `UPLOADED_SOURCE` assets require one at ingestion time. */
export interface LicenseRecord {
  id: string;
  workspaceId: string;
  assetId: string;
  licenseType: LicenseType;
  rightsHolder: string;
  restrictions: string[];
  expiresAt?: Date;
  createdAt: Date;
}

export interface LicenseDataSource {
  licenseRecord: {
    create(args: {
      data: {
        workspaceId: string;
        assetId: string;
        licenseType: LicenseType;
        rightsHolder: string;
        restrictions: string[];
        expiresAt?: Date;
      };
    }): Promise<LicenseRecord>;
    findFirst(args: {
      where: { assetId: string; workspaceId: string };
    }): Promise<LicenseRecord | null>;
  };
}

export async function createLicenseRecord(
  db: LicenseDataSource,
  workspaceId: string,
  input: {
    assetId: string;
    licenseType: LicenseType;
    rightsHolder: string;
    restrictions?: string[];
    expiresAt?: Date;
  },
): Promise<LicenseRecord> {
  return db.licenseRecord.create({
    data: {
      workspaceId,
      assetId: input.assetId,
      licenseType: input.licenseType,
      rightsHolder: input.rightsHolder,
      restrictions: input.restrictions ?? [],
      expiresAt: input.expiresAt,
    },
  });
}

export async function getLicenseRecord(
  db: LicenseDataSource,
  workspaceId: string,
  assetId: string,
): Promise<LicenseRecord | null> {
  return db.licenseRecord.findFirst({ where: { assetId, workspaceId } });
}
