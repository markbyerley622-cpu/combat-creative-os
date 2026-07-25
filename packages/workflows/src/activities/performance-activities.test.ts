import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QueuedReasoningProvider } from '@combat/agent-runtime';
import { AGENT_REGISTRY } from '@combat/agents';
import {
  InMemoryCampaignStore,
  listLearningRecords,
  listPerformanceObservationsForCampaign,
  loadLearningContext,
  reviewLearningRecord,
} from '@combat/database';
import { createExecuteSpecialistAgentActivity } from './execute-specialist-agent-activity';
import { createIngestPerformanceObservationsActivity } from './ingest-performance-observations-activity';
import { createRunPerformanceAnalystActivity } from './run-performance-analyst-activity';

/** Fixed clock so every test is deterministic and never wall-clock dependent. */
const NOW = new Date('2026-07-26T00:00:00Z');
const WINDOW = {
  periodStart: '2026-07-18T00:00:00.000Z',
  periodEnd: '2026-07-25T00:00:00.000Z',
};

/**
 * A deterministic performance fixture: two closed TikTok windows at 30k
 * impressions each. Chosen so the derived confidence lands exactly on MEDIUM
 * (2 observations ≥ 5,000 impressions), which is what the assertions pin.
 */
function fixtureObservations() {
  return [
    {
      platform: 'TIKTOK' as const,
      externalPostId: 'post-1',
      durationSeconds: 15,
      ...WINDOW,
      raw: { impressions: 30_000, clicks: 1_500, conversions: 90, spendCents: 60_000 },
    },
    {
      platform: 'TIKTOK' as const,
      externalPostId: 'post-2',
      durationSeconds: 15,
      ...WINDOW,
      raw: { impressions: 30_000, clicks: 1_200, conversions: 60, spendCents: 60_000 },
    },
  ];
}

function seedCampaign(store: InMemoryCampaignStore) {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  // Analysis runs after the campaign has finished producing.
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'DISTRIBUTED' });
  return { workspaceId, campaignId };
}

function buildIngest(store: InMemoryCampaignStore) {
  return createIngestPerformanceObservationsActivity({
    campaignDb: store,
    performanceDb: store,
  });
}

function buildAnalyst(store: InMemoryCampaignStore, results: Record<string, unknown>[]) {
  const executeSpecialistAgentActivity = createExecuteSpecialistAgentActivity({
    agentRegistry: AGENT_REGISTRY,
    reasoningProvider: new QueuedReasoningProvider(results.map((result) => ({ result }))),
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
  });
  return createRunPerformanceAnalystActivity({
    executeSpecialistAgentActivity,
    agentRegistry: AGENT_REGISTRY,
    campaignDb: store,
    performanceDb: store,
    learningDb: store,
    promptDb: store,
  });
}

function analystResult(evidenceObservationIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    learnings: [
      {
        learningKey: 'short-hook-holds-attention',
        insight: 'The 15s TikTok cut held a 5% click-through rate across 30000 impressions.',
        appliesTo: 'strategy',
        tags: ['hook'],
        platforms: ['TIKTOK'],
        durationsSeconds: [15],
        evidenceObservationIds,
        ...overrides,
      },
    ],
  };
}

describe('ingestPerformanceObservationsActivity — deterministic fixture/manual input', () => {
  it('ingests a fixture batch and normalizes every entry', async () => {
    const store = new InMemoryCampaignStore();
    const s = seedCampaign(store);
    const ingest = buildIngest(store);

    const result = await ingest({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      source: 'FIXTURE',
      observations: fixtureObservations(),
      fixtureRef: 'fixtures/tiktok-week-30.json',
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, ingested: 2, deduplicated: 0 });
    const stored = await listPerformanceObservationsForCampaign(store, s.workspaceId, s.campaignId);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.normalized.clickThroughRate).toBeDefined();
    expect(stored[0]!.source).toBe('FIXTURE');
    expect(stored[0]!.fixtureRef).toBe('fixtures/tiktok-week-30.json');
  });

  it('is idempotent: re-running the same fixture ingests nothing new', async () => {
    const store = new InMemoryCampaignStore();
    const s = seedCampaign(store);
    const ingest = buildIngest(store);
    const input = {
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      source: 'FIXTURE' as const,
      observations: fixtureObservations(),
      now: NOW,
    };

    await ingest(input);
    const second = await ingest(input);

    expect(second).toMatchObject({ ok: true, ingested: 0, deduplicated: 2 });
    expect(store.performanceObservationRecords).toHaveLength(2);
  });

  it('refuses the whole batch on an invalid metric rather than partially applying it', async () => {
    const store = new InMemoryCampaignStore();
    const s = seedCampaign(store);
    const ingest = buildIngest(store);

    const result = await ingest({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      source: 'MANUAL_ENTRY',
      observations: [
        ...fixtureObservations(),
        {
          platform: 'TIKTOK',
          externalPostId: 'post-bad',
          ...WINDOW,
          raw: { impressions: 100, clicks: 9_999, conversions: 0, spendCents: 0 },
        },
      ],
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'INVALID_METRICS',
      externalPostId: 'post-bad',
    });
  });

  it('refuses a reporting window that has not closed', async () => {
    const store = new InMemoryCampaignStore();
    const s = seedCampaign(store);
    const ingest = buildIngest(store);

    const result = await ingest({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      source: 'MANUAL_ENTRY',
      observations: [
        {
          platform: 'TIKTOK',
          externalPostId: 'post-open',
          periodStart: '2026-07-25T00:00:00.000Z',
          periodEnd: '2026-08-01T00:00:00.000Z',
          raw: { impressions: 10, clicks: 1, conversions: 0, spendCents: 10 },
        },
      ],
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, reason: 'OPEN_WINDOW' });
    expect(store.performanceObservationRecords).toHaveLength(0);
  });

  it('never ingests into another workspace campaign', async () => {
    const store = new InMemoryCampaignStore();
    const s = seedCampaign(store);
    const ingest = buildIngest(store);

    const result = await ingest({
      workspaceId: randomUUID(),
      campaignId: s.campaignId,
      source: 'FIXTURE',
      observations: fixtureObservations(),
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, reason: 'CAMPAIGN_NOT_FOUND' });
    expect(store.performanceObservationRecords).toHaveLength(0);
  });
});

describe('runPerformanceAnalystActivity — structured output with real evidence', () => {
  async function seedIngested(store: InMemoryCampaignStore) {
    const s = seedCampaign(store);
    const ingest = buildIngest(store);
    const ingested = await ingest({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      source: 'FIXTURE',
      observations: fixtureObservations(),
      now: NOW,
    });
    if (!ingested.ok) throw new Error('fixture ingestion failed');
    return { ...s, observationIds: ingested.observations.map((o) => o.observationId) };
  }

  it('persists a PROPOSED learning whose confidence is derived from the cited evidence', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedIngested(store);
    const analyst = buildAnalyst(store, [analystResult(s.observationIds)]);

    const result = await analyst({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'perf-run-1',
      windowKey: '2026-W30',
      minObservations: 1,
      analysisAttempt: 1,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observationsAnalyzed).toBe(2);
    expect(result.learnings).toHaveLength(1);
    // Two 30k observations -> exactly MEDIUM, derived not asserted.
    expect(result.learnings[0]!.confidence).toBe('MEDIUM');
    expect(result.learnings[0]!.evidenceCount).toBe(2);

    const [record] = await listLearningRecords(store, s.workspaceId);
    expect(record!.status).toBe('PROPOSED');
    expect(record!.scope).toBe('STRATEGY');
    expect(record!.totalImpressions).toBe(60_000);
    expect(record!.applicability).toMatchObject({ platforms: ['TIKTOK'], durationsSeconds: [15] });
    expect(record!.evidence.map((e) => e.performanceObservationId).sort()).toEqual(
      [...s.observationIds].sort(),
    );
    expect(record!.createdByAgentInvocationId).toBeDefined();
    expect(record!.promptVersionId).toBeDefined();
  });

  it('caps a thin sample at LOW confidence however emphatic the insight', async () => {
    const store = new InMemoryCampaignStore();
    const s = seedCampaign(store);
    const ingest = buildIngest(store);
    const ingested = await ingest({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      source: 'MANUAL_ENTRY',
      observations: [
        {
          platform: 'TIKTOK',
          externalPostId: 'post-thin',
          durationSeconds: 15,
          ...WINDOW,
          raw: { impressions: 90, clicks: 9, conversions: 1, spendCents: 300 },
        },
      ],
      now: NOW,
    });
    if (!ingested.ok) throw new Error('ingestion failed');
    const analyst = buildAnalyst(store, [
      analystResult([ingested.observations[0]!.observationId], {
        insight: 'This creative decisively outperforms everything else ever made.',
      }),
    ]);

    const result = await analyst({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'perf-run-1',
      windowKey: '2026-W30',
      minObservations: 1,
      analysisAttempt: 1,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.learnings[0]!.confidence).toBe('LOW');
  });

  it('rejects an insight citing evidence that was never supplied', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedIngested(store);
    const analyst = buildAnalyst(store, [analystResult([randomUUID()])]);

    const result = await analyst({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'perf-run-1',
      windowKey: '2026-W30',
      minObservations: 1,
      analysisAttempt: 1,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, reason: 'UNSUPPORTED_EVIDENCE' });
    expect(store.learningRecordRecords).toHaveLength(0);
  });

  it('skips analysis when there is not enough completed data', async () => {
    const store = new InMemoryCampaignStore();
    const s = seedCampaign(store);
    const analyst = buildAnalyst(store, [analystResult([randomUUID()])]);

    const result = await analyst({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'perf-run-1',
      windowKey: '2026-W30',
      minObservations: 2,
      analysisAttempt: 1,
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'INSUFFICIENT_OBSERVATIONS',
      observationsAvailable: 0,
    });
  });

  it('analyses only closed windows, ignoring data whose window has not elapsed', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedIngested(store);
    // An observation stored directly with a future window (bypassing ingest).
    store.performanceObservationRecords.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      subject: {
        platform: 'TIKTOK',
        externalPostId: 'post-future',
        campaignId: s.campaignId,
      },
      source: 'MANUAL_ENTRY',
      periodStart: new Date('2026-07-26T00:00:00Z'),
      periodEnd: new Date('2026-08-02T00:00:00Z'),
      raw: { impressions: 1_000, clicks: 10, conversions: 1, spendCents: 100 },
      normalized: { impressions: 1_000, clicks: 10, conversions: 1, spendCents: 100 },
      idempotencyKey: 'future',
      createdAt: NOW,
    });
    const analyst = buildAnalyst(store, [analystResult(s.observationIds)]);

    const result = await analyst({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'perf-run-1',
      windowKey: '2026-W30',
      minObservations: 1,
      analysisAttempt: 1,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The open window was excluded entirely.
    expect(result.observationsAnalyzed).toBe(2);
  });

  it('is idempotent under retry — a replay writes no second learning version', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedIngested(store);
    const analyst = buildAnalyst(store, [
      analystResult(s.observationIds),
      analystResult(s.observationIds),
    ]);
    const input = {
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'perf-run-1',
      windowKey: '2026-W30',
      minObservations: 1,
      analysisAttempt: 1,
      now: NOW,
    };

    await analyst(input);
    await analyst(input);

    expect(store.learningRecordRecords).toHaveLength(1);
  });

  it('never reads another workspace campaign', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedIngested(store);
    const analyst = buildAnalyst(store, [analystResult(s.observationIds)]);

    const result = await analyst({
      workspaceId: randomUUID(),
      campaignId: s.campaignId,
      workflowRunId: 'perf-run-1',
      windowKey: '2026-W30',
      minObservations: 1,
      analysisAttempt: 1,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, reason: 'CAMPAIGN_NOT_FOUND' });
    expect(store.learningRecordRecords).toHaveLength(0);
  });

  it('returns AGENT_FAILED on an unusable agent output', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedIngested(store);
    const analyst = buildAnalyst(store, [{ learnings: [] }]);

    const result = await analyst({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'perf-run-1',
      windowKey: '2026-W30',
      minObservations: 1,
      analysisAttempt: 1,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, reason: 'AGENT_FAILED' });
  });
});

describe('performance analysis never touches production state', () => {
  it('leaves the campaign stage, approvals, assets and variants untouched', async () => {
    const store = new InMemoryCampaignStore();
    const s = seedCampaign(store);
    const ingest = buildIngest(store);
    const ingested = await ingest({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      source: 'FIXTURE',
      observations: fixtureObservations(),
      now: NOW,
    });
    if (!ingested.ok) throw new Error('ingestion failed');

    const before = {
      stage: store.campaigns[0]!.currentStage,
      version: store.campaigns[0]!.version,
      approvals: store.approvals.length,
      assets: store.assets.length,
      variants: store.creativeVariantRecords.length,
      audits: store.audits.length,
      specs: store.variantSpecificationRecords.length,
    };

    const analyst = buildAnalyst(store, [
      analystResult(ingested.observations.map((o) => o.observationId)),
    ]);
    await analyst({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'perf-run-1',
      windowKey: '2026-W30',
      minObservations: 1,
      analysisAttempt: 1,
      now: NOW,
    });

    expect(store.campaigns[0]!.currentStage).toBe(before.stage);
    expect(store.campaigns[0]!.version).toBe(before.version);
    expect(store.approvals).toHaveLength(before.approvals);
    expect(store.assets).toHaveLength(before.assets);
    expect(store.creativeVariantRecords).toHaveLength(before.variants);
    // No stage transition was even attempted.
    expect(store.audits).toHaveLength(before.audits);
    expect(store.variantSpecificationRecords).toHaveLength(before.specs);
    // The only new rows are learnings.
    expect(store.learningRecordRecords).toHaveLength(1);
  });

  it('a learning is not injectable until a human approves it', async () => {
    const store = new InMemoryCampaignStore();
    const s = seedCampaign(store);
    const ingest = buildIngest(store);
    const ingested = await ingest({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      source: 'FIXTURE',
      observations: fixtureObservations(),
      now: NOW,
    });
    if (!ingested.ok) throw new Error('ingestion failed');
    const analyst = buildAnalyst(store, [
      analystResult(ingested.observations.map((o) => o.observationId)),
    ]);
    await analyst({
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      workflowRunId: 'perf-run-1',
      windowKey: '2026-W30',
      minObservations: 1,
      analysisAttempt: 1,
      now: NOW,
    });

    const request = {
      scope: 'STRATEGY' as const,
      targetPlatforms: ['TIKTOK'] as const,
      targetDurationsSeconds: [15] as const,
    };
    expect(await loadLearningContext(store, s.workspaceId, request)).toHaveLength(0);

    const [record] = await listLearningRecords(store, s.workspaceId);
    await reviewLearningRecord(store, s.workspaceId, record!.id, {
      status: 'APPROVED',
      reviewedByUserId: randomUUID(),
    });

    expect(await loadLearningContext(store, s.workspaceId, request)).toHaveLength(1);
  });
});
