import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAssetWithProvenance } from './asset-repository';
import { createLicenseRecord, getLicenseRecord } from './license-repository';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';

describe('license-repository', () => {
  it('creates and retrieves a license record scoped to workspace + asset', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId: randomUUID(),
      kind: 'UPLOADED_SOURCE',
      s3Key: 'uploads/a.png',
      checksum: 'sha256:x',
      mimeType: 'image/png',
      originalFilename: 'a.png',
      sizeBytes: 100,
      uploadedByUserId: randomUUID(),
    });

    const license = await createLicenseRecord(store, workspaceId, {
      assetId: asset.id,
      licenseType: 'FULL_BUY_OUT',
      rightsHolder: 'Combat Reviews Inc.',
      restrictions: ['no third-party resale'],
    });

    const reloaded = await getLicenseRecord(store, workspaceId, asset.id);
    expect(reloaded?.id).toBe(license.id);
    expect(reloaded?.rightsHolder).toBe('Combat Reviews Inc.');
  });

  it('defaults restrictions to an empty array when omitted', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const license = await createLicenseRecord(store, workspaceId, {
      assetId: randomUUID(),
      licenseType: 'ROYALTY_FREE',
      rightsHolder: 'Stock Provider',
    });
    expect(license.restrictions).toEqual([]);
  });

  it('returns null for an asset with no license, or under the wrong workspace', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId: randomUUID(),
      kind: 'UPLOADED_SOURCE',
      s3Key: 'uploads/b.png',
      checksum: 'sha256:y',
      mimeType: 'image/png',
      originalFilename: 'b.png',
      sizeBytes: 100,
      uploadedByUserId: randomUUID(),
    });

    expect(await getLicenseRecord(store, workspaceId, asset.id)).toBeNull();

    await createLicenseRecord(store, workspaceId, {
      assetId: asset.id,
      licenseType: 'LIMITED_USAGE',
      rightsHolder: 'X',
    });
    expect(await getLicenseRecord(store, randomUUID(), asset.id)).toBeNull();
  });
});
