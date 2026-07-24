import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createAssetWithProvenance,
  findAssetByChecksum,
  getAssetProvenance,
  recordMediaInspectionResult,
  traceAssetLineage,
} from './asset-repository';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';

describe('asset lineage — provenance is required and traceable', () => {
  it('creating an asset always creates its provenance record', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();

    const { asset, provenance } = await createAssetWithProvenance(store, workspaceId, {
      campaignId: randomUUID(),
      kind: 'VIDEO_CANDIDATE',
      s3Key: 'shots/shot-1/candidate-1.mp4',
      checksum: 'sha256:abc',
      mimeType: 'video/mp4',
      originalFilename: 'candidate-1.mp4',
      sizeBytes: 1024,
      createdByAgentInvocationId: randomUUID(),
    });

    expect(provenance.assetId).toBe(asset.id);
    const reloaded = await getAssetProvenance(store, workspaceId, asset.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.derivedFromAssetIds).toEqual([]);
  });

  it('traces a multi-hop lineage from a final master back through its rough-cut, compositing, and generation ancestors', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();

    const campaignId = randomUUID();
    const { asset: rawCandidate } = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'VIDEO_CANDIDATE',
      s3Key: 'candidate.mp4',
      checksum: 'sha256:1',
      mimeType: 'video/mp4',
      originalFilename: 'candidate.mp4',
      sizeBytes: 1024,
      createdByAgentInvocationId: randomUUID(),
    });
    const { asset: compositingOutput } = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'MOTION_GRAPHICS_RENDER',
      s3Key: 'composited.mp4',
      checksum: 'sha256:2',
      mimeType: 'video/mp4',
      originalFilename: 'composited.mp4',
      sizeBytes: 2048,
      createdByAgentInvocationId: randomUUID(),
      derivedFromAssetIds: [rawCandidate.id],
    });
    const { asset: finalMaster } = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'FINAL_MASTER',
      s3Key: 'final.mp4',
      checksum: 'sha256:3',
      mimeType: 'video/mp4',
      originalFilename: 'final.mp4',
      sizeBytes: 4096,
      createdByAgentInvocationId: randomUUID(),
      derivedFromAssetIds: [compositingOutput.id],
    });

    const lineage = await traceAssetLineage(store, workspaceId, finalMaster.id);

    expect(lineage).toEqual(expect.arrayContaining([compositingOutput.id, rawCandidate.id]));
    expect(lineage).toHaveLength(2);
  });

  it('a root asset with no ancestry has an empty lineage', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();

    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId: randomUUID(),
      kind: 'DESIGN_EXPORT',
      s3Key: 'brand-logo.png',
      checksum: 'sha256:root',
      mimeType: 'image/png',
      originalFilename: 'brand-logo.png',
      sizeBytes: 512,
      uploadedByUserId: randomUUID(),
    });

    const lineage = await traceAssetLineage(store, workspaceId, asset.id);
    expect(lineage).toEqual([]);
  });

  it('does not infinite-loop if a provenance cycle is ever introduced by a bug', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const idA = randomUUID();
    const idB = randomUUID();

    store.assetProvenances.push(
      {
        id: randomUUID(),
        workspaceId,
        assetId: idA,
        derivedFromAssetIds: [idB],
        createdAt: new Date(),
      },
      {
        id: randomUUID(),
        workspaceId,
        assetId: idB,
        derivedFromAssetIds: [idA],
        createdAt: new Date(),
      },
    );

    const lineage = await traceAssetLineage(store, workspaceId, idA);
    expect(lineage).toEqual([idB]);
  });
});

describe('findAssetByChecksum — workspace-wide dedup lookup', () => {
  it('finds an existing asset by (workspaceId, checksum, kind), ignoring campaign', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId: randomUUID(),
      kind: 'UPLOADED_SOURCE',
      s3Key: 'uploads/a.png',
      checksum: 'sha256:dedup',
      mimeType: 'image/png',
      originalFilename: 'a.png',
      sizeBytes: 100,
      uploadedByUserId: randomUUID(),
    });

    // A different campaign in the same workspace, same checksum/kind, still resolves to the same asset.
    const found = await findAssetByChecksum(store, workspaceId, 'sha256:dedup', 'UPLOADED_SOURCE');
    expect(found?.id).toBe(asset.id);
  });

  it('returns undefined when no asset matches', async () => {
    const store = new InMemoryCampaignStore();
    const found = await findAssetByChecksum(store, randomUUID(), 'sha256:none', 'UPLOADED_SOURCE');
    expect(found).toBeUndefined();
  });

  it('does not match across workspaces', async () => {
    const store = new InMemoryCampaignStore();
    await createAssetWithProvenance(store, randomUUID(), {
      campaignId: randomUUID(),
      kind: 'UPLOADED_SOURCE',
      s3Key: 'uploads/a.png',
      checksum: 'sha256:cross-workspace',
      mimeType: 'image/png',
      originalFilename: 'a.png',
      sizeBytes: 100,
      uploadedByUserId: randomUUID(),
    });

    const found = await findAssetByChecksum(
      store,
      randomUUID(),
      'sha256:cross-workspace',
      'UPLOADED_SOURCE',
    );
    expect(found).toBeUndefined();
  });
});

describe('recordMediaInspectionResult', () => {
  it('transitions an asset to READY with mediaMetadata on success', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId: randomUUID(),
      kind: 'UPLOADED_SOURCE',
      s3Key: 'uploads/a.mp4',
      checksum: 'sha256:v',
      mimeType: 'video/mp4',
      originalFilename: 'a.mp4',
      sizeBytes: 100,
      uploadedByUserId: randomUUID(),
    });
    expect(asset.ingestionStatus).toBe('PENDING');

    const updated = await recordMediaInspectionResult(store, asset.id, {
      ok: true,
      mediaMetadata: {
        mediaType: 'VIDEO',
        durationSeconds: 5,
        widthPx: 100,
        heightPx: 100,
        frameRate: 30,
        videoCodec: 'h264',
        hasAudio: false,
      },
    });

    expect(updated.ingestionStatus).toBe('READY');
    expect(updated.mediaMetadata).toMatchObject({ mediaType: 'VIDEO', videoCodec: 'h264' });
  });

  it('transitions an asset to FAILED with inspectionFailureDetails on failure', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId: randomUUID(),
      kind: 'UPLOADED_SOURCE',
      s3Key: 'uploads/a.mp4',
      checksum: 'sha256:v2',
      mimeType: 'video/mp4',
      originalFilename: 'a.mp4',
      sizeBytes: 100,
      uploadedByUserId: randomUUID(),
    });

    const updated = await recordMediaInspectionResult(store, asset.id, {
      ok: false,
      failureDetails: 'Corrupt or unreadable media: no video or audio stream found',
    });

    expect(updated.ingestionStatus).toBe('FAILED');
    expect(updated.inspectionFailureDetails).toContain('Corrupt or unreadable media');
  });
});
