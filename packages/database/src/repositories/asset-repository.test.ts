import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAssetWithProvenance, getAssetProvenance, traceAssetLineage } from './asset-repository';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';

describe('asset lineage — provenance is required and traceable', () => {
  it('creating an asset always creates its provenance record', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();

    const { asset, provenance } = await createAssetWithProvenance(store, workspaceId, {
      kind: 'VIDEO_CANDIDATE',
      s3Key: 'shots/shot-1/candidate-1.mp4',
      checksum: 'sha256:abc',
      mimeType: 'video/mp4',
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

    const { asset: rawCandidate } = await createAssetWithProvenance(store, workspaceId, {
      kind: 'VIDEO_CANDIDATE',
      s3Key: 'candidate.mp4',
      checksum: 'sha256:1',
      mimeType: 'video/mp4',
      createdByAgentInvocationId: randomUUID(),
    });
    const { asset: compositingOutput } = await createAssetWithProvenance(store, workspaceId, {
      kind: 'MOTION_GRAPHICS_RENDER',
      s3Key: 'composited.mp4',
      checksum: 'sha256:2',
      mimeType: 'video/mp4',
      createdByAgentInvocationId: randomUUID(),
      derivedFromAssetIds: [rawCandidate.id],
    });
    const { asset: finalMaster } = await createAssetWithProvenance(store, workspaceId, {
      kind: 'FINAL_MASTER',
      s3Key: 'final.mp4',
      checksum: 'sha256:3',
      mimeType: 'video/mp4',
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
      kind: 'DESIGN_EXPORT',
      s3Key: 'brand-logo.png',
      checksum: 'sha256:root',
      mimeType: 'image/png',
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
      { id: randomUUID(), workspaceId, assetId: idA, derivedFromAssetIds: [idB], createdAt: new Date() },
      { id: randomUUID(), workspaceId, assetId: idB, derivedFromAssetIds: [idA], createdAt: new Date() },
    );

    const lineage = await traceAssetLineage(store, workspaceId, idA);
    expect(lineage).toEqual([idB]);
  });
});
