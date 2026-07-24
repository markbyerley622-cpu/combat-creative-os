import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAssetWithProvenance, InMemoryCampaignStore } from '@combat/database';
import { MockStorageProvider } from '@combat/providers';
import { MockMediaProvider } from '@combat/media';
import { AssetNotFoundError, createInspectMediaActivity } from './inspect-media-activity';

async function seedUploadedAsset(
  store: InMemoryCampaignStore,
  storage: MockStorageProvider,
  body: string,
) {
  const campaign = store.seedCampaign();
  const s3Key = `workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/uploads/${randomUUID()}/video.mp4`;
  await storage.putObject({ s3Key, body, contentType: 'video/mp4' });
  const { asset } = await createAssetWithProvenance(store, campaign.workspaceId, {
    campaignId: campaign.id,
    kind: 'UPLOADED_SOURCE',
    s3Key,
    checksum: 'irrelevant-for-this-test',
    mimeType: 'video/mp4',
    originalFilename: 'video.mp4',
    sizeBytes: Buffer.byteLength(body),
    ingestionStatus: 'PENDING',
    uploadedByUserId: randomUUID(),
  });
  return { campaign, asset };
}

describe('createInspectMediaActivity', () => {
  it('probes the asset and persists mediaMetadata with ingestionStatus READY on success', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const media = new MockMediaProvider();
    const { campaign, asset } = await seedUploadedAsset(store, storage, 'video-bytes');

    // MockMediaProvider is normally keyed by exact filePath, but this
    // activity generates that path internally (a temp file) — override
    // `probe` directly instead of trying to predict the temp path.
    media.probe = async () => ({
      mediaType: 'VIDEO',
      durationSeconds: 5,
      widthPx: 1280,
      heightPx: 720,
      frameRate: 30,
      videoCodec: 'h264',
      hasAudio: true,
      audioCodec: 'aac',
    });

    const activity = createInspectMediaActivity({
      storageProvider: storage,
      mediaProvider: media,
      assetDb: store,
    });

    const result = await activity({
      workspaceId: campaign.workspaceId,
      assetId: asset.id,
      declaredMediaType: 'VIDEO',
      maxBytes: 10_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mediaMetadata.mediaType).toBe('VIDEO');
    }
    const stored = store.assets.find((a) => a.id === asset.id)!;
    expect(stored.ingestionStatus).toBe('READY');
    expect(stored.mediaMetadata).toMatchObject({ mediaType: 'VIDEO', videoCodec: 'h264' });
  });

  it('persists ingestionStatus FAILED with details when the media provider rejects (corrupt media)', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const media = new MockMediaProvider();
    const { campaign, asset } = await seedUploadedAsset(store, storage, 'corrupt-bytes');
    media.probe = async () => {
      throw new Error('Corrupt or unreadable media: no video or audio stream found');
    };

    const activity = createInspectMediaActivity({
      storageProvider: storage,
      mediaProvider: media,
      assetDb: store,
    });

    const result = await activity({
      workspaceId: campaign.workspaceId,
      assetId: asset.id,
      declaredMediaType: 'VIDEO',
      maxBytes: 10_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain('Corrupt or unreadable media');
    }
    const stored = store.assets.find((a) => a.id === asset.id)!;
    expect(stored.ingestionStatus).toBe('FAILED');
    expect(stored.inspectionFailureDetails).toContain('Corrupt or unreadable media');
  });

  it('persists FAILED on a declared/detected media type mismatch', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const media = new MockMediaProvider();
    const { campaign, asset } = await seedUploadedAsset(store, storage, 'actually-an-image');
    media.probe = async () => {
      throw new Error('Declared media type VIDEO does not match detected type IMAGE');
    };

    const activity = createInspectMediaActivity({
      storageProvider: storage,
      mediaProvider: media,
      assetDb: store,
    });

    const result = await activity({
      workspaceId: campaign.workspaceId,
      assetId: asset.id,
      declaredMediaType: 'VIDEO',
      maxBytes: 10_000,
    });

    expect(result.ok).toBe(false);
    const stored = store.assets.find((a) => a.id === asset.id)!;
    expect(stored.ingestionStatus).toBe('FAILED');
    expect(stored.inspectionFailureDetails).toContain('does not match detected type');
  });

  it('throws AssetNotFoundError for an asset outside the claimed workspace (workspace isolation)', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const media = new MockMediaProvider();
    const { asset } = await seedUploadedAsset(store, storage, 'video-bytes');

    const activity = createInspectMediaActivity({
      storageProvider: storage,
      mediaProvider: media,
      assetDb: store,
    });

    await expect(
      activity({
        workspaceId: randomUUID(),
        assetId: asset.id,
        declaredMediaType: 'VIDEO',
        maxBytes: 10_000,
      }),
    ).rejects.toThrow(AssetNotFoundError);
  });
});
