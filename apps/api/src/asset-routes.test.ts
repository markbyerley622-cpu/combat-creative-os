import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { InMemoryCampaignStore, addMembership } from '@combat/database';
import { MockStorageProvider } from '@combat/providers';
import { registerAssetRoutes, type AssetRouteLimits } from './asset-routes';
import { registerAuthentication } from './authentication';
import { bearerFor, permissiveTestAuthentication } from './test-helpers/authenticated-caller';

const LIMITS: AssetRouteLimits = {
  maxUploadBytes: 1000,
  uploadUrlExpirySeconds: 900,
  downloadUrlExpirySeconds: 3600,
};

function buildApp() {
  const store = new InMemoryCampaignStore();
  const storage = new MockStorageProvider();
  const app = Fastify();
  // AAMP-1 step 2: these suites exercise authorization, so the caller arrives
  // authenticated exactly as a production caller does — a verified bearer
  // token, never a request field. See test-helpers/authenticated-caller.ts.
  registerAuthentication(app, permissiveTestAuthentication().hookDeps);
  registerAssetRoutes(app, { db: store, storageProvider: storage, limits: LIMITS });
  return { app, store, storage };
}

async function seedOwner(store: InMemoryCampaignStore, workspaceId: string) {
  const userId = randomUUID();
  await addMembership(store, workspaceId, { userId, role: 'OWNER_ADMIN' });
  return userId;
}

function licensing(overrides: Record<string, unknown> = {}) {
  return { licenseType: 'FULL_BUY_OUT', rightsHolder: 'Combat Reviews Inc.', ...overrides };
}

/** Drives request-upload -> real bytes into the mock storage, exactly as a real client would, without confirming yet. */
async function requestAndUpload(
  app: ReturnType<typeof Fastify>,
  storage: MockStorageProvider,
  params: {
    workspaceId: string;
    campaignId: string;
    userId: string;
    filename?: string;
    body?: string;
  },
) {
  const filename = params.filename ?? 'logo.png';
  const body = params.body ?? 'file-bytes';
  const requestUpload = await app.inject({
    method: 'POST',
    url: `/workspaces/${params.workspaceId}/campaigns/${params.campaignId}/assets/request-upload`,
    headers: bearerFor(params.userId),
    payload: {
      originalFilename: filename,
      mimeType: 'image/png',
      sizeBytes: Buffer.byteLength(body),
      licensing: licensing(),
    },
  });
  expect(requestUpload.statusCode).toBe(201);
  const { uploadId, uploadUrl } = requestUpload.json();

  // Simulate the client's direct-to-storage PUT using the deterministic key
  // embedded in the presigned URL — never told to the client as a bare field.
  const s3Key = decodeURIComponent(new URL(uploadUrl).pathname.slice(1));
  await storage.putObject({ s3Key, body, contentType: 'image/png' });

  return { uploadId, filename, body };
}

function confirmUploadPayload(fixture: { uploadId: string; filename: string; body: string }) {
  return {
    uploadId: fixture.uploadId,
    originalFilename: fixture.filename,
    mimeType: 'image/png',
    sizeBytes: Buffer.byteLength(fixture.body),
    licensing: licensing(),
  };
}

/** Full request-upload -> upload -> confirm-upload round trip. */
async function uploadAndConfirm(
  app: ReturnType<typeof Fastify>,
  storage: MockStorageProvider,
  params: {
    workspaceId: string;
    campaignId: string;
    userId: string;
    filename?: string;
    body?: string;
  },
) {
  const fixture = await requestAndUpload(app, storage, params);
  return app.inject({
    method: 'POST',
    url: `/workspaces/${params.workspaceId}/campaigns/${params.campaignId}/assets/confirm-upload`,
    headers: bearerFor(params.userId),
    payload: confirmUploadPayload(fixture),
  });
}

describe('POST .../assets/request-upload', () => {
  it('issues a presigned upload URL and never returns a bare s3Key field', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/request-upload`,
      headers: bearerFor(userId),
      payload: {
        originalFilename: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        licensing: licensing(),
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toHaveProperty('uploadId');
    expect(body).toHaveProperty('uploadUrl');
    expect(body).not.toHaveProperty('s3Key');
  });

  it('rejects an unsupported MIME type', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/request-upload`,
      headers: bearerFor(userId),
      payload: {
        originalFilename: 'evil.exe',
        mimeType: 'application/x-msdownload',
        sizeBytes: 100,
        licensing: licensing(),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('UNSUPPORTED_MIME_TYPE');
  });

  it('rejects a declared size over the configured limit', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/request-upload`,
      headers: bearerFor(userId),
      payload: {
        originalFilename: 'huge.png',
        mimeType: 'image/png',
        sizeBytes: LIMITS.maxUploadBytes + 1,
        licensing: licensing(),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('FILE_TOO_LARGE');
  });

  it('rejects a caller without MANAGE_ASSETS (ANALYST)', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const userId = randomUUID();
    await addMembership(store, workspaceId, { userId, role: 'ANALYST' });
    const campaign = store.seedCampaign({ workspaceId });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/request-upload`,
      headers: bearerFor(userId),
      payload: {
        originalFilename: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        licensing: licensing(),
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('404s a campaign in the wrong workspace', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign(); // different workspace

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/request-upload`,
      headers: bearerFor(userId),
      payload: {
        originalFilename: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        licensing: licensing(),
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('403s a non-member entirely', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const campaign = store.seedCampaign({ workspaceId });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/request-upload`,
      headers: bearerFor(randomUUID()),
      payload: {
        originalFilename: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        licensing: licensing(),
      },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('POST .../assets/confirm-upload', () => {
  it('ingests successfully end to end (request-upload -> real bytes -> confirm-upload)', async () => {
    const { app, store, storage } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });

    const response = await uploadAndConfirm(app, storage, {
      workspaceId,
      campaignId: campaign.id,
      userId,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.asset.originalFilename).toBe('logo.png');
    expect(body.asset).not.toHaveProperty('s3Key');
    expect(body.deduped).toBe(false);
  });

  it('is idempotent: confirming the same uploadId twice (a client retry) returns the same asset, deduped', async () => {
    const { app, store, storage } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });
    const fixture = await requestAndUpload(app, storage, {
      workspaceId,
      campaignId: campaign.id,
      userId,
    });

    const confirmUrl = `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/confirm-upload`;
    const first = await app.inject({
      method: 'POST',
      url: confirmUrl,
      headers: bearerFor(userId),
      payload: confirmUploadPayload(fixture),
    });
    const second = await app.inject({
      method: 'POST',
      url: confirmUrl,
      headers: bearerFor(userId),
      payload: confirmUploadPayload(fixture),
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().deduped).toBe(false);
    expect(second.json().deduped).toBe(true);
    expect(second.json().asset.id).toBe(first.json().asset.id);
    expect(store.assets).toHaveLength(1);
  });

  it('rejects confirm-upload without a matching uploaded object (never trusts a client-forged key)', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/confirm-upload`,
      headers: bearerFor(userId),
      payload: {
        uploadId: randomUUID(),
        originalFilename: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        licensing: licensing(),
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('UPLOAD_NOT_FOUND');
  });

  it('rejects confirm-upload without a licensing declaration', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/confirm-upload`,
      headers: bearerFor(userId),
      payload: {
        uploadId: randomUUID(),
        originalFilename: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('INVALID_BODY');
  });
});

describe('GET .../assets/:assetId', () => {
  it('returns metadata without the internal s3Key, and allows any workspace member to read', async () => {
    const { app, store, storage } = buildApp();
    const workspaceId = randomUUID();
    const ownerId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });
    const confirmResponse = await uploadAndConfirm(app, storage, {
      workspaceId,
      campaignId: campaign.id,
      userId: ownerId,
    });
    const assetId = confirmResponse.json().asset.id;

    const readerId = randomUUID();
    await addMembership(store, workspaceId, { userId: readerId, role: 'ANALYST' });

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/${assetId}`,
      headers: bearerFor(readerId),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.asset).not.toHaveProperty('s3Key');
    expect(body.license.rightsHolder).toBe('Combat Reviews Inc.');
  });

  it('404s an asset id that exists but belongs to a different campaign', async () => {
    const { app, store, storage } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaignA = store.seedCampaign({ workspaceId });
    const campaignB = store.seedCampaign({ workspaceId });
    const confirmResponse = await uploadAndConfirm(app, storage, {
      workspaceId,
      campaignId: campaignA.id,
      userId,
    });
    const assetId = confirmResponse.json().asset.id;

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaignB.id}/assets/${assetId}`,
      headers: bearerFor(userId),
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s (not leaking existence) for an asset under the wrong workspace', async () => {
    const { app, store, storage } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });
    const confirmResponse = await uploadAndConfirm(app, storage, {
      workspaceId,
      campaignId: campaign.id,
      userId,
    });
    const assetId = confirmResponse.json().asset.id;

    const otherWorkspaceId = randomUUID();
    const otherUserId = await seedOwner(store, otherWorkspaceId);

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${otherWorkspaceId}/campaigns/${campaign.id}/assets/${assetId}`,
      headers: bearerFor(otherUserId),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('GET .../assets/:assetId/download-url', () => {
  it('returns a time-limited signed URL with an expiry in the future', async () => {
    const { app, store, storage } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });
    const confirmResponse = await uploadAndConfirm(app, storage, {
      workspaceId,
      campaignId: campaign.id,
      userId,
    });
    const assetId = confirmResponse.json().asset.id;

    const before = Date.now();
    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/${assetId}/download-url`,
      headers: bearerFor(userId),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.url).toContain('https://mock-storage.local/');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(before);
    const urlExpires = Number(new URL(body.url).searchParams.get('expires'));
    expect(urlExpires).toBeGreaterThan(before);
  });

  it('403s a non-member requesting a download URL', async () => {
    const { app, store, storage } = buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId });
    const confirmResponse = await uploadAndConfirm(app, storage, {
      workspaceId,
      campaignId: campaign.id,
      userId,
    });
    const assetId = confirmResponse.json().asset.id;

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/assets/${assetId}/download-url`,
      headers: bearerFor(randomUUID()),
    });

    expect(response.statusCode).toBe(403);
  });
});
