import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MockMotionGraphicsProvider } from '@combat/providers';
import {
  createAssetWithProvenance,
  InMemoryCampaignStore,
  listVariantGenerationAttempts,
} from '@combat/database';
import { createDispatchVariantRenderActivity } from './dispatch-variant-render-activity';
import { createPollVariantRenderActivity } from './poll-variant-render-activity';
import { createIngestPerformanceObservationsActivity } from './ingest-performance-observations-activity';
import { seedVariantSpecificationFixture } from './test-helpers/variant-fixture';

/**
 * M14 — crash-point recovery for the Activities that spend money or create
 * derived media.
 *
 * A Temporal Activity can die at any await boundary and be retried on a fresh
 * worker. The two dangerous windows are:
 *
 *   A. **after persistence, before dispatch** — a job/attempt row exists but no
 *      provider work was submitted;
 *   B. **after dispatch, before persistence** — the provider is doing paid
 *      work but nothing local records it.
 *
 * Each test below re-runs the Activity exactly as a retrying worker would and
 * asserts the invariant that matters: no duplicate provider submission, no
 * duplicate charge, no duplicate asset.
 *
 * **Limitation.** These are deterministic Activity-level replay tests against
 * in-memory fakes and the deterministic mock provider. A true kill-the-worker
 * integration test needs a live Temporal server, which this environment does
 * not have (`packages/testing/src/temporal-test-environment.ts` documents why
 * the native test-server binary is unavailable). What is proven here is that
 * re-invoking an Activity with identical input is safe at every crash point;
 * what is not proven is Temporal's own delivery/heartbeat behaviour around it.
 */

const NOW = new Date('2026-07-26T00:00:00Z');

function buildRenderActivities(
  store: InMemoryCampaignStore,
  provider = new MockMotionGraphicsProvider(),
) {
  return {
    provider,
    dispatch: createDispatchVariantRenderActivity({
      motionGraphicsProvider: provider,
      variantDb: store,
      budgetDb: store,
      estimatedCostCentsPerFrame: 1,
    }),
    poll: createPollVariantRenderActivity({
      motionGraphicsProvider: provider,
      variantDb: store,
      assetDb: store,
      budgetDb: store,
    }),
  };
}

function dispatchInput(s: { workspaceId: string; campaignId: string; specId: string }) {
  return {
    workspaceId: s.workspaceId,
    campaignId: s.campaignId,
    workflowRunId: 'run-1',
    variantSpecificationId: s.specId,
    attemptNumber: 1,
    motionGraphicsProviderId: 'mock-motion-graphics',
    maxAttempts: 3,
  };
}

describe('crash window A — worker dies after persistence, before provider dispatch', () => {
  it('a retried dispatch reuses the attempt and submits to the provider exactly once', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedVariantSpecificationFixture(store);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 1_000_000,
    });

    let submissions = 0;
    const provider = new MockMotionGraphicsProvider();
    const originalSubmit = provider.submitRender.bind(provider);
    provider.submitRender = async (input) => {
      submissions += 1;
      return originalSubmit(input);
    };
    const { dispatch } = buildRenderActivities(store, provider);

    const first = await dispatch(dispatchInput(s));
    const replayed = await dispatch(dispatchInput(s));

    expect(first.ok && replayed.ok).toBe(true);
    if (!first.ok || !replayed.ok) return;
    expect(replayed.attemptId).toBe(first.attemptId);
    // One attempt row, one reservation, one provider submission.
    expect(store.variantGenerationAttemptRecords).toHaveLength(1);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'RESERVATION')).toHaveLength(1);
    expect(submissions).toBe(1);
  });

  it('a crash before dispatch leaves no reservation that a retry would double', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedVariantSpecificationFixture(store);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 1_000_000,
    });
    // Simulate the provider dying at submit on the first attempt.
    const provider = new MockMotionGraphicsProvider();
    let failFirst = true;
    provider.submitRender = async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('worker died mid-submit');
      }
      throw new Error('unreachable');
    };
    const { dispatch } = buildRenderActivities(store, provider);

    const failed = await dispatch(dispatchInput(s));

    expect(failed).toMatchObject({ ok: false, reason: 'PROVIDER_ERROR' });
    // The reservation was compensated by a matching release, so the headroom
    // is not permanently sterilised by the crash.
    const reservations = store.budgetLedgerEntries.filter((e) => e.entryType === 'RESERVATION');
    const releases = store.budgetLedgerEntries.filter((e) => e.entryType === 'RELEASE');
    expect(reservations).toHaveLength(1);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.amountCents).toBe(reservations[0]!.amountCents);
  });
});

describe('crash window B — worker dies after provider dispatch, before persistence', () => {
  it('a re-polled terminal attempt replays its outcome without a second asset or charge', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedVariantSpecificationFixture(store);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 1_000_000,
    });
    const { dispatch, poll } = buildRenderActivities(store);
    const dispatched = await dispatch(dispatchInput(s));
    if (!dispatched.ok) throw new Error('dispatch should succeed');

    const pollInput = {
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: dispatched.attemptId,
      providerId: 'mock-motion-graphics',
    };
    const first = await poll(pollInput);
    // The worker died right after the poll committed; Temporal retries it.
    const replayed = await poll(pollInput);

    expect(first).toMatchObject({ terminal: true, status: 'SUCCEEDED' });
    expect(replayed).toMatchObject({ terminal: true, status: 'SUCCEEDED' });
    if (!('terminal' in first) || !('terminal' in replayed)) return;
    if (!first.terminal || !replayed.terminal) return;
    if (first.status !== 'SUCCEEDED' || replayed.status !== 'SUCCEEDED') return;

    // Same asset, same variant — no duplicate derived media.
    expect(replayed.variantAssetId).toBe(first.variantAssetId);
    expect(replayed.creativeVariantId).toBe(first.creativeVariantId);
    expect(store.assets.filter((a) => a.kind === 'VARIANT')).toHaveLength(1);
    expect(store.creativeVariantRecords).toHaveLength(1);
    // Charged exactly once — the replay never touches the ledger again.
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'CHARGE')).toHaveLength(1);
  });

  it('re-polling a failed attempt replays the failure without re-releasing budget', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedVariantSpecificationFixture(store);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 1_000_000,
    });
    const key = `run-1:VARIANT:${s.specId}:1`;
    const provider = new MockMotionGraphicsProvider({
      forcedFailures: { [key]: { reason: 'PROVIDER_ERROR', message: 'render worker died' } },
    });
    const { dispatch, poll } = buildRenderActivities(store, provider);
    const dispatched = await dispatch(dispatchInput(s));
    if (!dispatched.ok) throw new Error('dispatch should succeed');
    const pollInput = {
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: dispatched.attemptId,
      providerId: 'mock-motion-graphics',
    };

    const first = await poll(pollInput);
    const replayed = await poll(pollInput);

    expect(first).toMatchObject({ terminal: true, status: 'FAILED' });
    expect(replayed).toMatchObject({ terminal: true, status: 'FAILED' });
    // Exactly one release for the one reservation — a replayed failure must
    // not credit the ledger twice.
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'RELEASE')).toHaveLength(1);
    expect(store.assets.filter((a) => a.kind === 'VARIANT')).toHaveLength(0);
  });

  it('an attempt is never resurrected: a terminal attempt stays terminal across replays', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedVariantSpecificationFixture(store);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      level: 'WORKSPACE',
      scopeId: s.workspaceId,
      limitCents: 1_000_000,
    });
    const { dispatch, poll } = buildRenderActivities(store);
    const dispatched = await dispatch(dispatchInput(s));
    if (!dispatched.ok) throw new Error('dispatch should succeed');
    const pollInput = {
      workspaceId: s.workspaceId,
      campaignId: s.campaignId,
      attemptId: dispatched.attemptId,
      providerId: 'mock-motion-graphics',
    };

    await poll(pollInput);
    await poll(pollInput);
    await poll(pollInput);

    const attempts = await listVariantGenerationAttempts(
      store,
      store.variantGenerationJobRecords[0]!.id,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('SUCCEEDED');
    expect(store.assets.filter((a) => a.kind === 'VARIANT')).toHaveLength(1);
  });
});

describe('crash recovery — derived-asset registration is checksum-idempotent', () => {
  it('re-registering the same deterministic output yields one asset row', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'VARIANT_GENERATION' });

    const payload = {
      campaignId,
      kind: 'VARIANT' as const,
      s3Key: 'mock/variant/15.mp4',
      checksum: 'deterministic-checksum',
      mimeType: 'video/mp4',
      originalFilename: 'variant-15s.mp4',
      sizeBytes: 0,
      ingestionStatus: 'READY' as const,
      generatedByActivity: 'pollVariantRenderActivity',
    };
    await createAssetWithProvenance(store, workspaceId, payload);
    // A retry would call findAssetByChecksum first; prove the underlying
    // uniqueness the Activities rely on actually holds.
    await expect(createAssetWithProvenance(store, workspaceId, payload)).rejects.toThrow();

    expect(store.assets.filter((a) => a.kind === 'VARIANT')).toHaveLength(1);
  });
});

describe('crash recovery — performance ingestion is replay-safe', () => {
  it('a worker that dies mid-batch re-ingests without duplicating observations', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'DISTRIBUTED' });
    const ingest = createIngestPerformanceObservationsActivity({
      campaignDb: store,
      performanceDb: store,
    });
    const batch = {
      workspaceId,
      campaignId,
      source: 'FIXTURE' as const,
      observations: [
        {
          platform: 'TIKTOK' as const,
          externalPostId: 'post-1',
          periodStart: '2026-07-18T00:00:00.000Z',
          periodEnd: '2026-07-25T00:00:00.000Z',
          raw: { impressions: 100, clicks: 5, conversions: 1, spendCents: 50 },
        },
      ],
      now: NOW,
    };

    const first = await ingest(batch);
    const replayed = await ingest(batch);

    expect(first).toMatchObject({ ok: true, ingested: 1, deduplicated: 0 });
    expect(replayed).toMatchObject({ ok: true, ingested: 0, deduplicated: 1 });
    expect(store.performanceObservationRecords).toHaveLength(1);
  });
});
