import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAssetWithProvenance, InMemoryCampaignStore } from '@combat/database';
import { MockStorageProvider } from '@combat/providers';
import { MockMediaProvider } from '@combat/media';
import {
  createGenerateMediaProxyActivity,
  SourceAssetNotFoundError,
} from './generate-media-proxy-activity';

async function seedSourceAsset(
  store: InMemoryCampaignStore,
  storage: MockStorageProvider,
  checksumBody: string,
) {
  const campaign = store.seedCampaign();
  const s3Key = `workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/uploads/${randomUUID()}/source.mp4`;
  await storage.putObject({ s3Key, body: checksumBody, contentType: 'video/mp4' });
  const { checksum } = await storage.headObject(s3Key);
  const { asset } = await createAssetWithProvenance(store, campaign.workspaceId, {
    campaignId: campaign.id,
    kind: 'UPLOADED_SOURCE',
    s3Key,
    checksum,
    mimeType: 'video/mp4',
    originalFilename: 'source.mp4',
    sizeBytes: Buffer.byteLength(checksumBody),
    ingestionStatus: 'READY',
    uploadedByUserId: randomUUID(),
  });
  return { campaign, asset };
}

describe('createGenerateMediaProxyActivity', () => {
  it('generates a thumbnail, uploads it, and creates a derived Asset with provenance to the source', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const media = new MockMediaProvider();
    const { campaign, asset: source } = await seedSourceAsset(store, storage, 'source-bytes');
    media.generateThumbnail = async (request) => {
      // Simulate ffmpeg by writing real bytes to the output path so the
      // activity's subsequent readFile succeeds.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(request.outputPath, 'thumbnail-bytes');
      return { outputPath: request.outputPath, widthPx: 640, heightPx: 360 };
    };

    const activity = createGenerateMediaProxyActivity({
      storageProvider: storage,
      mediaProvider: media,
      assetDb: store,
    });

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      sourceAssetId: source.id,
      kind: 'THUMBNAIL',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.asset.kind).toBe('THUMBNAIL');
    expect(result.asset.generatedByActivity).toBe('generateMediaProxyActivity');
    expect(result.deduped).toBe(false);

    const provenance = store.assetProvenances.find((p) => p.assetId === result.asset.id);
    expect(provenance?.derivedFromAssetIds).toEqual([source.id]);
  });

  it('is idempotent: the second identical request for the same source dedupes to the same derived asset', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const media = new MockMediaProvider();
    const { campaign, asset: source } = await seedSourceAsset(store, storage, 'source-bytes');
    media.generateProxy = async (request) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(request.outputPath, 'proxy-bytes');
      return { outputPath: request.outputPath, durationSeconds: 5, widthPx: 1280, heightPx: 720 };
    };

    const activity = createGenerateMediaProxyActivity({
      storageProvider: storage,
      mediaProvider: media,
      assetDb: store,
    });

    const input = {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      sourceAssetId: source.id,
      kind: 'PROXY' as const,
      proxy: { profile: 'PREVIEW_720P' as const },
    };
    const first = await activity(input);
    const second = await activity(input);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.asset.id).toBe(first.asset.id);
      expect(second.deduped).toBe(true);
    }
    expect(store.assets.filter((a) => a.kind === 'PROXY')).toHaveLength(1);
  });

  it('throws SourceAssetNotFoundError for a source asset outside the claimed workspace', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const media = new MockMediaProvider();
    const { asset: source } = await seedSourceAsset(store, storage, 'source-bytes');

    const activity = createGenerateMediaProxyActivity({
      storageProvider: storage,
      mediaProvider: media,
      assetDb: store,
    });

    await expect(
      activity({
        workspaceId: randomUUID(),
        campaignId: randomUUID(),
        sourceAssetId: source.id,
        kind: 'THUMBNAIL',
      }),
    ).rejects.toThrow(SourceAssetNotFoundError);
  });

  it('returns a typed failure (not a throw) when the media provider fails to generate output', async () => {
    const store = new InMemoryCampaignStore();
    const storage = new MockStorageProvider();
    const media = new MockMediaProvider();
    const { campaign, asset: source } = await seedSourceAsset(store, storage, 'source-bytes');
    media.generateThumbnail = async () => {
      throw new Error('ffmpeg thumbnail generation failed');
    };

    const activity = createGenerateMediaProxyActivity({
      storageProvider: storage,
      mediaProvider: media,
      assetDb: store,
    });

    const result = await activity({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      sourceAssetId: source.id,
      kind: 'THUMBNAIL',
    });

    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringContaining('ffmpeg thumbnail generation failed'),
    });
    expect(store.assets.filter((a) => a.kind === 'THUMBNAIL')).toHaveLength(0);
  });
});
