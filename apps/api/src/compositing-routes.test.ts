import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { WorkflowClient } from '@temporalio/client';
import { MockStorageProvider } from '@combat/providers';
import {
  addMembership,
  createAssetWithProvenance,
  createRoughEditSpecification,
  getOrCreateCompositionAttempt,
  getOrCreateCompositionJob,
  InMemoryCampaignStore,
  updateCompositionAttempt,
  type RoughEditSpecificationRecord,
} from '@combat/database';
import { registerCompositingRoutes } from './compositing-routes';

function buildFakeWorkflowClient() {
  const signal = vi.fn(async () => undefined);
  const workflowClient = {
    getHandle: () => ({ signal, query: async () => undefined }),
    start: async () => ({ workflowId: 'x', firstExecutionRunId: 'y' }),
  } as unknown as WorkflowClient;
  return { workflowClient, signal };
}

function specData(
  campaignId: string,
  assetId: string,
): Omit<RoughEditSpecificationRecord, 'id' | 'createdAt' | 'workspaceId'> {
  return {
    campaignId,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotSelectionSetId: randomUUID(),
    shotSelectionSetVersion: 1,
    version: 1,
    outputFormat: 'mp4',
    aspectRatio: '9:16',
    resolutionWidth: 1080,
    resolutionHeight: 1920,
    frameRate: 30,
    targetDurationFrames: 180,
    tracks: [
      {
        trackType: 'VIDEO',
        clips: [
          {
            order: 0,
            shotId: randomUUID(),
            shotIndex: 0,
            sourceAssetId: assetId,
            sourceInFrame: 0,
            sourceOutFrame: 90,
            timelineStartFrame: 0,
            durationFrames: 90,
            transitionIn: 'CUT',
          },
        ],
      },
    ],
    overlays: [{ kind: 'CTA', description: 'Sign up' }],
    pacingNotes: 'fast',
    beatStructure: [],
    continuityNotes: [],
    textSafeAreas: [],
    brandTokens: [],
    captionPlaceholder: 'captions TBD',
    musicPlaceholder: 'music TBD',
    sfxPlaceholder: 'sfx TBD',
    platform: 'INSTAGRAM_REELS',
    platformDeliveryNotes: 'reels',
    editRationale: 'hook first',
    qualityRubric: [],
    promptVersionId: randomUUID(),
    createdByAgentInvocationId: randomUUID(),
  };
}

async function seed(store: InMemoryCampaignStore, opts: { withRender?: boolean } = {}) {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const operatorId = randomUUID();
  const reviewerId = randomUUID();
  await addMembership(store, workspaceId, { userId: operatorId, role: 'PRODUCTION_OPERATOR' });
  await addMembership(store, workspaceId, { userId: reviewerId, role: 'REVIEWER' });
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'COMPOSITING' });

  if (opts.withRender) {
    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'VIDEO_CANDIDATE',
      s3Key: `c/${randomUUID()}`,
      checksum: randomUUID(),
      mimeType: 'video/mp4',
      originalFilename: 'c.mp4',
      sizeBytes: 1,
      ingestionStatus: 'READY',
    });
    const spec = await createRoughEditSpecification(
      store,
      workspaceId,
      specData(campaignId, asset.id),
    );
    const job = await getOrCreateCompositionJob(store, workspaceId, {
      campaignId,
      roughEditSpecificationId: spec.id,
      maxAttempts: 3,
    });
    const { asset: roughAsset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'ROUGH_CUT',
      s3Key: `r/${randomUUID()}`,
      checksum: randomUUID(),
      mimeType: 'video/mp4',
      originalFilename: 'rough.mp4',
      sizeBytes: 1,
      ingestionStatus: 'READY',
    });
    const { attempt } = await getOrCreateCompositionAttempt(store, workspaceId, {
      compositionJobId: job.id,
      attemptNumber: 1,
      idempotencyKey: 'k1',
      providerId: 'mock-motion-graphics',
      status: 'SUBMITTED',
      startedAt: new Date(),
    });
    await updateCompositionAttempt(store, attempt.id, {
      status: 'SUCCEEDED',
      outputAssetId: roughAsset.id,
      actualCostCents: 50,
    });
  }
  return { workspaceId, campaignId, operatorId, reviewerId };
}

function buildApp(store: InMemoryCampaignStore, workflowClient: WorkflowClient) {
  const app = Fastify();
  registerCompositingRoutes(app, {
    db: store,
    storageProvider: new MockStorageProvider(),
    workflowClient,
  });
  return app;
}

describe('compositing routes', () => {
  it('returns the rough-edit status with spec, attempts, and placeholder asset', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withRender: true });
    const app = buildApp(store, buildFakeWorkflowClient().workflowClient);
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/compositing?userId=${s.reviewerId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roughEditSpecification.version).toBe(1);
    expect(body.roughEditSpecification.clips).toHaveLength(1);
    expect(body.attempts).toHaveLength(1);
    expect(body.roughEdit.hasMedia).toBe(false);
    expect(body.roughEdit.assetId).toBeTruthy();
  });

  it('returns a null spec before compositing has produced one', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store, buildFakeWorkflowClient().workflowClient);
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/compositing?userId=${s.reviewerId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().roughEditSpecification).toBeNull();
  });

  it('never exposes the s3Key on the preview endpoint', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withRender: true });
    const app = buildApp(store, buildFakeWorkflowClient().workflowClient);
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/compositing/preview?userId=${s.reviewerId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('s3Key');
  });

  it('lets an authorized operator request cancellation, signalling the workflow', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withRender: true });
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);
    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/compositing/cancel`,
      payload: { userId: s.operatorId },
    });
    expect(res.statusCode).toBe(202);
    expect(signal).toHaveBeenCalledTimes(1);
  });

  it('rejects cancellation from a role lacking TRIGGER_GENERATION', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withRender: true });
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);
    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/compositing/cancel`,
      payload: { userId: s.reviewerId },
    });
    expect(res.statusCode).toBe(403);
    expect(signal).not.toHaveBeenCalled();
  });

  it('404s a cross-workspace campaign rather than leaking it', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withRender: true });
    const app = buildApp(store, buildFakeWorkflowClient().workflowClient);
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${randomUUID()}/campaigns/${s.campaignId}/compositing?userId=${s.reviewerId}`,
    });
    expect(res.statusCode).toBe(403);
  });
});
