import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  addMembership,
  createLearningRecord,
  InMemoryCampaignStore,
  type CreateLearningRecordInput,
} from '@combat/database';
import type { RoleName } from '@combat/domain';
import { registerPerformanceRoutes } from './performance-routes';
import { registerAuthentication } from './authentication';
import { bearerFor, permissiveTestAuthentication } from './test-helpers/authenticated-caller';

/** A closed window relative to any realistic test clock. */
const WINDOW = {
  periodStart: '2026-07-18T00:00:00.000Z',
  periodEnd: '2026-07-25T00:00:00.000Z',
};

function observation(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'TIKTOK',
    externalPostId: 'post-1',
    durationSeconds: 15,
    ...WINDOW,
    raw: { impressions: 30_000, clicks: 1_500, conversions: 90, spendCents: 60_000 },
    ...overrides,
  };
}

function learningInput(
  sourceCampaignId: string,
  overrides: Partial<CreateLearningRecordInput> = {},
): CreateLearningRecordInput {
  return {
    learningKey: 'short-hook-holds-attention',
    insight: 'The 15s TikTok cut held a 5% click-through rate.',
    scope: 'STRATEGY',
    applicability: { platforms: ['TIKTOK'], durationsSeconds: [15], tags: ['hook'] },
    confidence: 'MEDIUM',
    evidence: [
      {
        performanceObservationId: randomUUID(),
        campaignId: sourceCampaignId,
        platform: 'TIKTOK',
        impressions: 60_000,
      },
    ],
    totalImpressions: 60_000,
    sourceCampaignId,
    createdByAgentInvocationId: randomUUID(),
    promptVersionId: randomUUID(),
    ...overrides,
  };
}

async function seed(store: InMemoryCampaignStore, role: RoleName = 'OWNER_ADMIN') {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const memberId = randomUUID();
  await addMembership(store, workspaceId, { userId: memberId, role });
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'DISTRIBUTED' });
  return { workspaceId, campaignId, memberId };
}

function buildApp(store: InMemoryCampaignStore) {
  const app = Fastify();
  // AAMP-1 step 2: these suites exercise authorization, so the caller arrives
  // authenticated exactly as a production caller does — a verified bearer
  // token, never a request field. See test-helpers/authenticated-caller.ts.
  registerAuthentication(app, permissiveTestAuthentication().hookDeps);
  registerPerformanceRoutes(app, { db: store });
  return app;
}

function ingestUrl(s: { workspaceId: string; campaignId: string }) {
  return `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/performance/observations`;
}
function historyUrl(s: { workspaceId: string; campaignId: string }) {
  return `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/performance`;
}

describe('performance routes — fixture/manual ingestion', () => {
  it('ingests a fixture batch and normalizes it', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store);

    const res = await app.inject({
      method: 'POST',
      url: ingestUrl(s),
      headers: bearerFor(s.memberId),
      payload: {
        source: 'FIXTURE',
        fixtureRef: 'fixtures/tiktok-week-30.json',
        observations: [observation(), observation({ externalPostId: 'post-2' })],
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ingested: 2, deduplicated: 0 });
    expect(store.performanceObservationRecords).toHaveLength(2);
    expect(store.performanceObservationRecords[0]!.normalized.clickThroughRate).toBeCloseTo(0.05);
  });

  it('is idempotent: re-posting the same batch ingests nothing new', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store);
    const payload = {
      source: 'MANUAL_ENTRY',
      observations: [observation()],
    };

    const inject = {
      method: 'POST' as const,
      url: ingestUrl(s),
      headers: bearerFor(s.memberId),
      payload,
    };
    await app.inject(inject);
    const second = await app.inject(inject);

    expect(second.json()).toMatchObject({ ingested: 0, deduplicated: 1 });
    expect(store.performanceObservationRecords).toHaveLength(1);
  });

  it('422s invalid metrics with the specific violations', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store);

    const res = await app.inject({
      method: 'POST',
      url: ingestUrl(s),
      headers: bearerFor(s.memberId),
      payload: {
        source: 'MANUAL_ENTRY',
        observations: [
          observation({ raw: { impressions: 100, clicks: 9_999, conversions: 0, spendCents: 0 } }),
        ],
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('INVALID_METRICS');
    expect(JSON.stringify(res.json().violations)).toContain('CLICKS_EXCEED_IMPRESSIONS');
  });

  it('422s a reporting window that has not closed', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store);

    const res = await app.inject({
      method: 'POST',
      url: ingestUrl(s),
      headers: bearerFor(s.memberId),
      payload: {
        source: 'MANUAL_ENTRY',
        observations: [
          observation({
            periodStart: '2099-01-01T00:00:00.000Z',
            periodEnd: '2099-02-01T00:00:00.000Z',
          }),
        ],
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('OPEN_WINDOW');
  });

  it('rejects a source that is not a fixture or manual entry (no platform connector exists)', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store);

    const res = await app.inject({
      method: 'POST',
      url: ingestUrl(s),
      headers: bearerFor(s.memberId),
      payload: {
        source: 'TIKTOK_ADS_API',
        observations: [observation()],
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('performance routes — RBAC and cross-workspace rejection', () => {
  it.each([
    ['OWNER_ADMIN', 202],
    ['CREATIVE_DIRECTOR', 202],
    ['PRODUCTION_OPERATOR', 403],
    ['ANALYST', 403],
    ['REVIEWER', 403],
  ] as const)('role %s gets %i from ingestion', async (role, expected) => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, role);
    const app = buildApp(store);

    const res = await app.inject({
      method: 'POST',
      url: ingestUrl(s),
      headers: bearerFor(s.memberId),
      payload: { source: 'FIXTURE', observations: [observation()] },
    });

    expect(res.statusCode).toBe(expected);
    if (expected === 403) expect(store.performanceObservationRecords).toHaveLength(0);
  });

  // Every role in the §2.2 matrix holds VIEW_REPORTING, so performance history
  // is readable workspace-wide — writing it is the gated action.
  it.each([
    ['ANALYST', 200],
    ['OWNER_ADMIN', 200],
    ['PRODUCTION_OPERATOR', 200],
    ['REVIEWER', 200],
  ] as const)('role %s gets %i reading performance history', async (role, expected) => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, role);
    const app = buildApp(store);

    const res = await app.inject({
      method: 'GET',
      url: historyUrl(s),
      headers: bearerFor(s.memberId),
    });

    expect(res.statusCode).toBe(expected);
  });

  it('403s a non-member on every endpoint', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store);
    const stranger = randomUUID();

    expect(
      (await app.inject({ method: 'GET', url: historyUrl(s), headers: bearerFor(stranger) }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: ingestUrl(s),
          headers: bearerFor(stranger),
          payload: { source: 'FIXTURE', observations: [observation()] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/workspaces/${s.workspaceId}/learnings`,
          headers: bearerFor(stranger),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('rejects a cross-workspace read rather than leaking the campaign', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store);

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${randomUUID()}/campaigns/${s.campaignId}/performance`,
      headers: bearerFor(s.memberId),
    });

    expect(res.statusCode).toBe(403);
  });

  it('never returns another workspace observations in a campaign history', async () => {
    const store = new InMemoryCampaignStore();
    const a = await seed(store);
    const b = await seed(store);
    const app = buildApp(store);

    await app.inject({
      method: 'POST',
      url: ingestUrl(a),
      headers: bearerFor(a.memberId),
      payload: { source: 'FIXTURE', observations: [observation()] },
    });

    const res = await app.inject({
      method: 'GET',
      url: historyUrl(b),
      headers: bearerFor(b.memberId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().observations).toHaveLength(0);
  });
});

describe('performance routes — learning records', () => {
  it('returns learnings with evidence, applicability and confidence', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    await createLearningRecord(store, s.workspaceId, learningInput(s.campaignId));
    const app = buildApp(store);

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${s.workspaceId}/learnings`,
      headers: bearerFor(s.memberId),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.learnings).toHaveLength(1);
    expect(body.learnings[0]).toMatchObject({
      learningKey: 'short-hook-holds-attention',
      scope: 'STRATEGY',
      confidence: 'MEDIUM',
      status: 'PROPOSED',
      totalImpressions: 60_000,
    });
    expect(body.learnings[0].evidence).toHaveLength(1);
    expect(body.learnings[0].applicability).toMatchObject({
      platforms: ['TIKTOK'],
      durationsSeconds: [15],
    });
    expect(body.caller.canReview).toBe(true);
  });

  it('never lists another workspace learnings', async () => {
    const store = new InMemoryCampaignStore();
    const a = await seed(store);
    const b = await seed(store);
    await createLearningRecord(store, a.workspaceId, learningInput(a.campaignId));
    const app = buildApp(store);

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${b.workspaceId}/learnings`,
      headers: bearerFor(b.memberId),
    });

    expect(res.json().learnings).toHaveLength(0);
  });

  it.each([
    ['OWNER_ADMIN', 200],
    ['CREATIVE_DIRECTOR', 200],
    ['ANALYST', 403],
    ['REVIEWER', 403],
  ] as const)('role %s gets %i approving a learning', async (role, expected) => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, role);
    const { record } = await createLearningRecord(
      store,
      s.workspaceId,
      learningInput(s.campaignId),
    );
    const app = buildApp(store);

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/learnings/${record.id}/review`,
      headers: bearerFor(s.memberId),
      payload: { decision: 'APPROVED' },
    });

    expect(res.statusCode).toBe(expected);
    const reloaded = store.learningRecordRecords.find((l) => l.id === record.id);
    expect(reloaded!.status).toBe(expected === 200 ? 'APPROVED' : 'PROPOSED');
  });

  it('404s a review targeting another workspace learning', async () => {
    const store = new InMemoryCampaignStore();
    const a = await seed(store);
    const b = await seed(store);
    const { record } = await createLearningRecord(
      store,
      a.workspaceId,
      learningInput(a.campaignId),
    );
    const app = buildApp(store);

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${b.workspaceId}/learnings/${record.id}/review`,
      headers: bearerFor(b.memberId),
      payload: { decision: 'APPROVED' },
    });

    expect(res.statusCode).toBe(404);
    expect(store.learningRecordRecords[0]!.status).toBe('PROPOSED');
  });
});

describe('performance routes — no production-state surface (M13 scope)', () => {
  it('exposes no endpoint that could advance a stage, approve a gate or export', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store);

    for (const path of ['advance', 'approve', 'export', 'publish']) {
      // eslint-disable-next-line no-await-in-loop -- four fixed probes
      const res = await app.inject({
        method: 'POST',
        url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/performance/${path}`,
        headers: bearerFor(s.memberId),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('ingestion never mutates the campaign', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store);
    const before = { ...store.campaigns[0]! };

    await app.inject({
      method: 'POST',
      url: ingestUrl(s),
      headers: bearerFor(s.memberId),
      payload: { source: 'FIXTURE', observations: [observation()] },
    });

    expect(store.campaigns[0]!.currentStage).toBe(before.currentStage);
    expect(store.campaigns[0]!.version).toBe(before.version);
    expect(store.audits).toHaveLength(0);
    expect(store.approvals).toHaveLength(0);
  });
});
