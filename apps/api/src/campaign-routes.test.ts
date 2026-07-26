import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { WorkflowClient } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { InMemoryCampaignStore, addMembership } from '@combat/database';
import { registerCampaignRoutes } from './campaign-routes';
import { campaignProductionWorkflowId } from './campaign-workflow-id';
import { registerAuthentication } from './authentication';
import { bearerFor, permissiveTestAuthentication } from './test-helpers/authenticated-caller';

function briefContent(overrides: Record<string, unknown> = {}) {
  return {
    campaignName: 'Launch Q3',
    productName: 'Combat Reviews',
    productDescription: 'Review aggregator for combat sports gyms',
    objective: 'Drive trial signups',
    targetAudience: 'MMA gym owners',
    customerProblem: 'No easy way to collect reviews',
    valueProposition: 'Automated review collection',
    productFeatures: ['review widgets'],
    targetPlatforms: ['INSTAGRAM_REELS'],
    aspectRatios: ['9:16'],
    durationsSeconds: [15],
    brandVoice: 'confident',
    visualDirection: 'gritty gym footage',
    requiredMessaging: ['try it free'],
    callToAction: 'Sign up today',
    references: [],
    assetReferences: [],
    prohibitedClaims: [],
    budgetCents: 500000,
    locale: 'en-US',
    ...overrides,
  };
}

function buildFakeWorkflowClient(
  overrides: { start?: ReturnType<typeof vi.fn>; query?: ReturnType<typeof vi.fn> } = {},
) {
  const start = overrides.start ?? vi.fn().mockResolvedValue(undefined);
  const query = overrides.query ?? vi.fn().mockResolvedValue(undefined);
  const getHandle = vi.fn().mockReturnValue({ query });
  return {
    workflowClient: { start, getHandle } as unknown as WorkflowClient,
    start,
    query,
    getHandle,
  };
}

async function buildApp(
  workflowClientOverrides: Parameters<typeof buildFakeWorkflowClient>[0] = {},
) {
  const store = new InMemoryCampaignStore();
  const { workflowClient, start, query, getHandle } =
    buildFakeWorkflowClient(workflowClientOverrides);
  const app = Fastify();
  // AAMP-1 step 2: these suites exercise authorization, so the caller arrives
  // authenticated exactly as a production caller does — a verified bearer
  // token, never a request field. See test-helpers/authenticated-caller.ts.
  registerAuthentication(app, permissiveTestAuthentication().hookDeps);
  registerCampaignRoutes(app, { db: store, workflowClient });
  return { app, store, start, query, getHandle };
}

async function seedOwner(store: InMemoryCampaignStore, workspaceId: string) {
  const userId = randomUUID();
  await addMembership(store, workspaceId, { userId, role: 'OWNER_ADMIN' });
  return userId;
}

describe('POST /workspaces/:workspaceId/campaigns', () => {
  it('creates a campaign for an authorized caller', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns`,
      headers: bearerFor(userId),
      payload: { name: 'Q3 Launch' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().campaign.name).toBe('Q3 Launch');
  });

  it('rejects a caller without MANAGE_CAMPAIGNS (REVIEWER)', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = randomUUID();
    await addMembership(store, workspaceId, { userId, role: 'REVIEWER' });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns`,
      headers: bearerFor(userId),
      payload: { name: 'Q3 Launch' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('is idempotent by idempotencyKey: a duplicate request returns the original campaign, not a second one', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const idempotencyKey = 'client-req-1';

    const first = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns`,
      headers: bearerFor(userId),
      payload: { name: 'Q3 Launch', idempotencyKey },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns`,
      headers: bearerFor(userId),
      payload: { name: 'Q3 Launch (retry)', idempotencyKey },
    });

    expect(first.json().campaign.id).toBe(second.json().campaign.id);
    expect(store.campaigns).toHaveLength(1);
  });

  it('400s on an invalid body', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns`,
      headers: bearerFor(userId),
      payload: { name: '' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('brief draft/submit', () => {
  it('saves incrementing draft versions and then submits an accepted final version', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'DRAFT' });

    const draft = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/brief/draft`,
      headers: bearerFor(userId),
      payload: { content: { campaignName: 'Launch Q3' } },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().brief.version).toBe(1);
    expect(draft.json().brief.acceptedAt).toBeNull();

    const submit = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/brief/submit`,
      headers: bearerFor(userId),
      payload: { content: briefContent() },
    });
    expect(submit.statusCode).toBe(201);
    expect(submit.json().brief.version).toBe(2);
    expect(submit.json().brief.acceptedAt).not.toBeNull();
  });

  it('rejects an incomplete submit body (strict schema, unlike draft)', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'DRAFT' });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/brief/submit`,
      headers: bearerFor(userId),
      payload: { content: { campaignName: 'Launch Q3' } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a second submit once the campaign has left DRAFT (duplicate submission prevention)', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'STRATEGY_REVIEW' });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/brief/submit`,
      headers: bearerFor(userId),
      payload: { content: briefContent() },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('ALREADY_SUBMITTED');
  });

  it('404s a brief action against a campaign in the wrong workspace', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ currentStage: 'DRAFT' }); // different workspaceId

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/brief/draft`,
      headers: bearerFor(userId),
      payload: { content: {} },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST .../workflow/start', () => {
  it('starts the workflow with the deterministic workflow ID once a brief is accepted', async () => {
    const { app, store, start } = await buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'DRAFT' });
    await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/brief/submit`,
      headers: bearerFor(userId),
      payload: { content: briefContent() },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/workflow/start`,
      headers: bearerFor(userId),
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().workflowId).toBe(campaignProductionWorkflowId(campaign.id));
    expect(response.json().alreadyRunning).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      workflowId: campaignProductionWorkflowId(campaign.id),
      args: [expect.objectContaining({ workspaceId, campaignId: campaign.id })],
    });
  });

  it('rejects starting the workflow before any brief has been submitted', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'DRAFT' });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/workflow/start`,
      headers: bearerFor(userId),
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('BRIEF_NOT_SUBMITTED');
  });

  it('duplicate-start protection: a WorkflowExecutionAlreadyStartedError is treated as success, not an error', async () => {
    const start = vi
      .fn()
      .mockRejectedValue(
        new WorkflowExecutionAlreadyStartedError('already started', 'wf-1', 'run-1'),
      );
    const { app, store } = await buildApp({ start });
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'DRAFT' });
    await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/brief/submit`,
      headers: bearerFor(userId),
      payload: { content: briefContent() },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/workflow/start`,
      headers: bearerFor(userId),
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().alreadyRunning).toBe(true);
  });
});

describe('strategy/concept/script retrieval', () => {
  it('returns null placeholders before any agent has produced output', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'STRATEGY_REVIEW' });

    const strategy = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/strategy`,
      headers: bearerFor(userId),
    });
    const concept = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/concept`,
      headers: bearerFor(userId),
    });
    const script = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/script`,
      headers: bearerFor(userId),
    });

    expect(strategy.json().strategy).toBeNull();
    expect(concept.json().concept).toBeNull();
    expect(script.json().script).toBeNull();
    expect(script.json().shots).toEqual([]);
  });

  it('allows any workspace member (not just MANAGE_CAMPAIGNS holders) to read', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const userId = randomUUID();
    await addMembership(store, workspaceId, { userId, role: 'ANALYST' });
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'STRATEGY_REVIEW' });

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/strategy`,
      headers: bearerFor(userId),
    });
    expect(response.statusCode).toBe(200);
  });

  it('403s a non-member', async () => {
    const { app, store } = await buildApp();
    const workspaceId = randomUUID();
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'STRATEGY_REVIEW' });

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/strategy`,
      headers: bearerFor(randomUUID()),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET .../approvals/concept/state', () => {
  it('reflects the live workflow pending-gate query when reachable', async () => {
    const query = vi.fn().mockImplementation((def: { name: string }) => {
      if (def.name === 'getStatus') return Promise.resolve('AWAITING_APPROVAL');
      if (def.name === 'getPendingGate') return Promise.resolve('CONCEPT');
      if (def.name === 'getRevisionCount') return Promise.resolve(0);
      return Promise.resolve(undefined);
    });
    const { app, store } = await buildApp({ query });
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'CONCEPT_REVIEW' });

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/approvals/concept/state`,
      headers: bearerFor(userId),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().isPending).toBe(true);
    expect(response.json().currentStage).toBe('CONCEPT_REVIEW');
  });

  it('degrades gracefully (isPending: false) when the workflow cannot be reached', async () => {
    const query = vi.fn().mockRejectedValue(new Error('not found'));
    const { app, store } = await buildApp({ query });
    const workspaceId = randomUUID();
    const userId = await seedOwner(store, workspaceId);
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'DRAFT' });

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/approvals/concept/state`,
      headers: bearerFor(userId),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().isPending).toBe(false);
  });
});
