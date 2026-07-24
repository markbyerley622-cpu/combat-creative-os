import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from '@combat/database';
import { MockStorageProvider } from '@combat/providers';
import {
  buildUploadS3Key,
  createIngestAssetActivity,
  sanitizeFilenameForKey,
  type IngestAssetInput,
} from './ingest-asset-activity';
import { CampaignNotFoundError } from './execute-specialist-agent-activity';

const MIME_ALLOWLIST = ['image/png', 'image/jpeg', 'video/mp4'];
const MAX_BYTES = 10_000;

function buildDeps(store: InMemoryCampaignStore, storage: MockStorageProvider) {
  return createIngestAssetActivity({
    storageProvider: storage,
    campaignDb: store,
    assetDb: store,
    licenseDb: store,
    maxUploadBytes: MAX_BYTES,
    mimeAllowlist: MIME_ALLOWLIST,
  });
}

function buildInput(
  campaign: ReturnType<InMemoryCampaignStore['seedCampaign']>,
  overrides: Partial<IngestAssetInput> = {},
): IngestAssetInput {
  return {
    workspaceId: campaign.workspaceId,
    campaignId: campaign.id,
    uploadId: randomUUID(),
    originalFilename: 'logo.png',
    declaredMimeType: 'image/png',
    declaredSizeBytes: 100,
    uploadedByUserId: randomUUID(),
    licensing: { licenseType: 'FULL_BUY_OUT', rightsHolder: 'Combat Reviews Inc.' },
    ...overrides,
  };
}

async function uploadFixture(storage: MockStorageProvider, input: IngestAssetInput, body: string) {
  const s3Key = buildUploadS3Key(input);
  await storage.putObject({ s3Key, body, contentType: input.declaredMimeType });
}

describe('createIngestAssetActivity', () => {
  it('ingests a newly-uploaded asset with provenance and license', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const campaign = store.seedCampaign();
    const input = buildInput(campaign);
    await uploadFixture(storage, input, 'file-bytes');
    const activity = buildDeps(store, storage);

    const result = await activity(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.deduped).toBe(false);
    expect(result.asset.kind).toBe('UPLOADED_SOURCE');
    expect(result.asset.originalFilename).toBe('logo.png');
    expect(result.asset.ingestionStatus).toBe('PENDING');
    expect(store.licenses).toHaveLength(1);
    expect(store.licenses[0]!.rightsHolder).toBe('Combat Reviews Inc.');
    expect(store.assetProvenances).toHaveLength(1);
  });

  it('is idempotent: confirming the same upload twice returns the same asset (deduped)', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const campaign = store.seedCampaign();
    const input = buildInput(campaign);
    await uploadFixture(storage, input, 'file-bytes');
    const activity = buildDeps(store, storage);

    const first = await activity(input);
    const second = await activity(input);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.asset.id).toBe(first.asset.id);
      expect(second.deduped).toBe(true);
    }
    expect(store.assets).toHaveLength(1);
    expect(store.licenses).toHaveLength(1);
  });

  it('detects a duplicate upload by checksum across a different campaign in the same workspace', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const workspaceId = randomUUID();
    const campaignA = store.seedCampaign({ workspaceId });
    const campaignB = store.seedCampaign({ workspaceId });
    const activity = buildDeps(store, storage);

    const inputA = buildInput(campaignA);
    await uploadFixture(storage, inputA, 'same-bytes');
    const resultA = await activity(inputA);

    const inputB = buildInput(campaignB, { originalFilename: 'logo-copy.png' });
    await uploadFixture(storage, inputB, 'same-bytes');
    const resultB = await activity(inputB);

    expect(resultA.ok && resultB.ok).toBe(true);
    if (resultA.ok && resultB.ok) {
      expect(resultB.asset.id).toBe(resultA.asset.id);
      expect(resultB.deduped).toBe(true);
    }
    expect(store.assets).toHaveLength(1);
  });

  it('rejects an unsupported MIME type before ever touching storage', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const campaign = store.seedCampaign();
    const activity = buildDeps(store, storage);

    const result = await activity(
      buildInput(campaign, { declaredMimeType: 'application/x-msdownload' }),
    );

    expect(result).toMatchObject({ ok: false, reason: 'UNSUPPORTED_MIME_TYPE' });
    expect(store.assets).toHaveLength(0);
  });

  it('rejects a declared size over the configured limit before ever touching storage', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const campaign = store.seedCampaign();
    const activity = buildDeps(store, storage);

    const result = await activity(buildInput(campaign, { declaredSizeBytes: MAX_BYTES + 1 }));

    expect(result).toMatchObject({ ok: false, reason: 'FILE_TOO_LARGE' });
  });

  it('rejects an actually-uploaded object that exceeds the limit even if declared size lied', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const campaign = store.seedCampaign();
    const input = buildInput(campaign, { declaredSizeBytes: 10 });
    await uploadFixture(storage, input, 'x'.repeat(MAX_BYTES + 1));
    const activity = buildDeps(store, storage);

    const result = await activity(input);

    expect(result).toMatchObject({ ok: false, reason: 'FILE_TOO_LARGE' });
  });

  it('rejects ingestion without a licensing declaration', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const campaign = store.seedCampaign();
    const activity = buildDeps(store, storage);

    const result = await activity(
      buildInput(campaign, { licensing: { licenseType: 'FULL_BUY_OUT', rightsHolder: '' } }),
    );

    expect(result).toMatchObject({ ok: false, reason: 'MISSING_LICENSING' });
  });

  it('returns UPLOAD_NOT_FOUND when confirm-upload is called before the object actually exists in storage', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const campaign = store.seedCampaign();
    const activity = buildDeps(store, storage);

    const result = await activity(buildInput(campaign));

    expect(result).toMatchObject({ ok: false, reason: 'UPLOAD_NOT_FOUND' });
  });

  it('throws CampaignNotFoundError for a campaign outside the claimed workspace (workspace isolation)', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const campaign = store.seedCampaign();
    const activity = buildDeps(store, storage);

    await expect(activity(buildInput(campaign, { workspaceId: randomUUID() }))).rejects.toThrow(
      CampaignNotFoundError,
    );
  });

  it('never trusts a client-supplied s3Key: the key is always derived server-side from workspace/campaign/uploadId/filename', () => {
    const key = buildUploadS3Key({
      workspaceId: 'ws-1',
      campaignId: 'camp-1',
      uploadId: 'upload-1',
      originalFilename: 'my file.png',
    });
    expect(key).toBe('workspaces/ws-1/campaigns/camp-1/uploads/upload-1/my_file.png');
  });

  it('sanitizes unsafe filenames — strips path traversal and shell-hostile characters', () => {
    expect(sanitizeFilenameForKey('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilenameForKey('..\\..\\windows\\system32\\evil.exe')).toBe('evil.exe');
    expect(sanitizeFilenameForKey('a"; rm -rf / #.png')).not.toContain(';');
    expect(sanitizeFilenameForKey('a"; rm -rf / #.png')).not.toContain('/');
    expect(sanitizeFilenameForKey('')).toBe('file');
    expect(sanitizeFilenameForKey('...')).toBe('file');
  });

  it('a malicious uploadId/filename cannot be used to write outside the derived key prefix', () => {
    const key = buildUploadS3Key({
      workspaceId: 'ws-1',
      campaignId: 'camp-1',
      uploadId: 'upload-1',
      originalFilename: '../../../etc/passwd',
    });
    expect(key).toBe('workspaces/ws-1/campaigns/camp-1/uploads/upload-1/passwd');
    expect(key.startsWith('workspaces/ws-1/campaigns/camp-1/uploads/upload-1/')).toBe(true);
  });
});
