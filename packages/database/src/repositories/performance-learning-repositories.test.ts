import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LearningEvidence, PerformanceSubject } from '@combat/domain';
import { deriveLearningConfidence } from '@combat/domain';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';
import {
  ingestPerformanceObservation,
  InvalidPerformanceMetricsError,
  listPerformanceObservationsForCampaign,
  listPerformanceObservationsForVariant,
  OpenReportingWindowError,
  performanceIdempotencyKey,
  type IngestPerformanceObservationInput,
} from './performance-repository';
import {
  createLearningRecord,
  getLearningRecord,
  LearningWithoutEvidenceError,
  listLearningRecords,
  loadLearningContext,
  reviewLearningRecord,
  type CreateLearningRecordInput,
} from './learning-repository';

/** A fixed clock so ingestion is deterministic — never wall-clock dependent. */
const NOW = new Date('2026-07-26T00:00:00Z');
const WINDOW_START = new Date('2026-07-18T00:00:00Z');
const WINDOW_END = new Date('2026-07-25T00:00:00Z');

function subject(overrides: Partial<PerformanceSubject> = {}): PerformanceSubject {
  return {
    platform: 'TIKTOK',
    externalPostId: 'post-abc',
    campaignId: overrides.campaignId ?? randomUUID(),
    durationSeconds: 15,
    ...overrides,
  };
}

function ingestInput(
  overrides: Partial<IngestPerformanceObservationInput> = {},
): IngestPerformanceObservationInput {
  return {
    subject: overrides.subject ?? subject(),
    source: overrides.source ?? 'FIXTURE',
    periodStart: overrides.periodStart ?? WINDOW_START,
    periodEnd: overrides.periodEnd ?? WINDOW_END,
    raw: overrides.raw ?? {
      impressions: 20_000,
      reach: 15_000,
      clicks: 800,
      completions: 9_000,
      conversions: 60,
      spendCents: 40_000,
    },
    fixtureRef: overrides.fixtureRef ?? 'fixtures/tiktok-week-30.json',
    now: overrides.now ?? NOW,
    ...overrides,
  };
}

function evidence(impressions: number, campaignId: string): LearningEvidence {
  return {
    performanceObservationId: randomUUID(),
    campaignId,
    platform: 'TIKTOK',
    impressions,
  };
}

function learningInput(
  overrides: Partial<CreateLearningRecordInput> = {},
): CreateLearningRecordInput {
  const sourceCampaignId = overrides.sourceCampaignId ?? randomUUID();
  const ev = overrides.evidence ?? [
    evidence(30_000, sourceCampaignId),
    evidence(30_000, sourceCampaignId),
  ];
  const derivation = deriveLearningConfidence(ev);
  return {
    learningKey: overrides.learningKey ?? 'hook-under-two-seconds',
    insight: overrides.insight ?? 'Hooks under two seconds hold attention on vertical short form.',
    scope: overrides.scope ?? 'STRATEGY',
    applicability: overrides.applicability ?? {
      platforms: ['TIKTOK'],
      durationsSeconds: [15],
      tags: ['hook'],
    },
    confidence: overrides.confidence ?? derivation.confidence,
    evidence: ev,
    totalImpressions: overrides.totalImpressions ?? derivation.totalImpressions,
    sourceCampaignId,
    createdByAgentInvocationId: overrides.createdByAgentInvocationId ?? randomUUID(),
    promptVersionId: overrides.promptVersionId ?? randomUUID(),
    ...overrides,
  };
}

describe('performance-repository — ingestion', () => {
  it('normalizes counters into derived rates on ingest', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();

    const { observation } = await ingestPerformanceObservation(store, workspaceId, ingestInput());

    expect(observation.workspaceId).toBe(workspaceId);
    expect(observation.normalized.clickThroughRate).toBeCloseTo(0.04);
    expect(observation.normalized.conversionRate).toBeCloseTo(0.075);
    expect(observation.normalized.costPerClickCents).toBe(50);
    expect(observation.source).toBe('FIXTURE');
    expect(observation.fixtureRef).toBe('fixtures/tiktok-week-30.json');
  });

  it('is idempotent: repeat ingestion of the same post+window returns the existing row', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const input = ingestInput();

    const first = await ingestPerformanceObservation(store, workspaceId, input);
    const second = await ingestPerformanceObservation(store, workspaceId, input);

    expect(first.alreadyExisted).toBe(false);
    expect(second.alreadyExisted).toBe(true);
    expect(second.observation.id).toBe(first.observation.id);
    expect(store.performanceObservationRecords).toHaveLength(1);
  });

  it('treats a different reporting window for the same post as a distinct observation', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const s = subject();

    await ingestPerformanceObservation(store, workspaceId, ingestInput({ subject: s }));
    const { alreadyExisted } = await ingestPerformanceObservation(
      store,
      workspaceId,
      ingestInput({
        subject: s,
        periodStart: new Date('2026-07-11T00:00:00Z'),
        periodEnd: new Date('2026-07-18T00:00:00Z'),
      }),
    );

    expect(alreadyExisted).toBe(false);
    expect(store.performanceObservationRecords).toHaveLength(2);
  });

  it('produces a deterministic dedup key from the subject and window', () => {
    const s = subject();
    expect(performanceIdempotencyKey(s, WINDOW_START, WINDOW_END)).toBe(
      performanceIdempotencyKey(s, WINDOW_START, WINDOW_END),
    );
  });

  it('refuses a reporting window that has not closed yet', async () => {
    const store = new InMemoryCampaignStore();

    await expect(
      ingestPerformanceObservation(
        store,
        randomUUID(),
        ingestInput({ periodEnd: new Date('2026-08-01T00:00:00Z') }),
      ),
    ).rejects.toBeInstanceOf(OpenReportingWindowError);
    expect(store.performanceObservationRecords).toHaveLength(0);
  });

  it.each([
    ['clicks above impressions', { impressions: 100, clicks: 500, conversions: 0, spendCents: 0 }],
    ['conversions above clicks', { impressions: 100, clicks: 5, conversions: 50, spendCents: 0 }],
    ['spend with no impressions', { impressions: 0, clicks: 0, conversions: 0, spendCents: 999 }],
  ])('rejects invalid metrics (%s) without persisting', async (_label, raw) => {
    const store = new InMemoryCampaignStore();

    await expect(
      ingestPerformanceObservation(store, randomUUID(), ingestInput({ raw })),
    ).rejects.toBeInstanceOf(InvalidPerformanceMetricsError);
    expect(store.performanceObservationRecords).toHaveLength(0);
  });

  it('scopes reads by workspace and by campaign/variant provenance', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const campaignId = randomUUID();
    const creativeVariantId = randomUUID();

    await ingestPerformanceObservation(
      store,
      workspaceId,
      ingestInput({ subject: subject({ campaignId, creativeVariantId }) }),
    );
    await ingestPerformanceObservation(
      store,
      workspaceId,
      ingestInput({
        subject: subject({ campaignId, externalPostId: 'post-def' }),
      }),
    );
    await ingestPerformanceObservation(
      store,
      otherWorkspaceId,
      ingestInput({ subject: subject({ campaignId }) }),
    );

    expect(
      await listPerformanceObservationsForCampaign(store, workspaceId, campaignId),
    ).toHaveLength(2);
    expect(
      await listPerformanceObservationsForCampaign(store, otherWorkspaceId, campaignId),
    ).toHaveLength(1);
    expect(
      await listPerformanceObservationsForVariant(store, workspaceId, creativeVariantId),
    ).toHaveLength(1);
    // Another workspace can never see this variant's data.
    expect(
      await listPerformanceObservationsForVariant(store, otherWorkspaceId, creativeVariantId),
    ).toHaveLength(0);
  });
});

describe('learning-repository — versioning and review', () => {
  it('writes a new learning as PROPOSED, never immediately visible to an agent', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();

    const { record } = await createLearningRecord(store, workspaceId, learningInput());

    expect(record.status).toBe('PROPOSED');
    expect(record.version).toBe(1);
    expect(record.supersededAt).toBeUndefined();

    // A PROPOSED record is not injectable context.
    const context = await loadLearningContext(store, workspaceId, {
      scope: 'STRATEGY',
      targetPlatforms: ['TIKTOK'],
      targetDurationsSeconds: [15],
    });
    expect(context).toHaveLength(0);
  });

  it('refuses an insight with no evidence', async () => {
    const store = new InMemoryCampaignStore();

    await expect(
      createLearningRecord(store, randomUUID(), learningInput({ evidence: [] })),
    ).rejects.toBeInstanceOf(LearningWithoutEvidenceError);
    expect(store.learningRecordRecords).toHaveLength(0);
  });

  it('versions and supersedes the prior live record for the same key', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();

    const first = await createLearningRecord(store, workspaceId, learningInput());
    const second = await createLearningRecord(store, workspaceId, learningInput());

    expect(second.record.version).toBe(2);
    const reloaded = await getLearningRecord(store, workspaceId, first.record.id);
    expect(reloaded?.supersededAt).toBeInstanceOf(Date);
  });

  it('is idempotent per agent invocation — a replay writes no second version', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const input = learningInput();

    const first = await createLearningRecord(store, workspaceId, input);
    const second = await createLearningRecord(store, workspaceId, input);

    expect(second.alreadyExisted).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(store.learningRecordRecords).toHaveLength(1);
  });

  it('records a human review decision and only then admits the learning as context', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const reviewerId = randomUUID();
    const { record } = await createLearningRecord(store, workspaceId, learningInput());

    const approved = await reviewLearningRecord(store, workspaceId, record.id, {
      status: 'APPROVED',
      reviewedByUserId: reviewerId,
    });

    expect(approved.status).toBe('APPROVED');
    expect(approved.reviewedByUserId).toBe(reviewerId);
    expect(approved.reviewedAt).toBeInstanceOf(Date);

    const context = await loadLearningContext(store, workspaceId, {
      scope: 'STRATEGY',
      targetPlatforms: ['TIKTOK'],
      targetDurationsSeconds: [15],
    });
    expect(context).toHaveLength(1);
    expect(context[0]!.learningRecordId).toBe(record.id);
  });

  it('a REJECTED learning never becomes context', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const { record } = await createLearningRecord(store, workspaceId, learningInput());
    await reviewLearningRecord(store, workspaceId, record.id, {
      status: 'REJECTED',
      reviewedByUserId: randomUUID(),
    });

    expect(
      await loadLearningContext(store, workspaceId, {
        scope: 'STRATEGY',
        targetPlatforms: ['TIKTOK'],
        targetDurationsSeconds: [15],
      }),
    ).toHaveLength(0);
  });
});

describe('learning-repository — workspace isolation of the knowledge store', () => {
  it('never surfaces another workspace learning as context', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();

    const { record } = await createLearningRecord(store, workspaceA, learningInput());
    await reviewLearningRecord(store, workspaceA, record.id, {
      status: 'APPROVED',
      reviewedByUserId: randomUUID(),
    });

    const request = {
      scope: 'STRATEGY' as const,
      targetPlatforms: ['TIKTOK'] as const,
      targetDurationsSeconds: [15] as const,
    };
    expect(await loadLearningContext(store, workspaceA, request)).toHaveLength(1);
    expect(await loadLearningContext(store, workspaceB, request)).toHaveLength(0);
    expect(await listLearningRecords(store, workspaceB)).toHaveLength(0);
    expect(await getLearningRecord(store, workspaceB, record.id)).toBeUndefined();
  });

  it('refuses to review a learning from another workspace', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const { record } = await createLearningRecord(store, workspaceId, learningInput());

    await expect(
      reviewLearningRecord(store, randomUUID(), record.id, {
        status: 'APPROVED',
        reviewedByUserId: randomUUID(),
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('deterministic fixture metrics produce the expected learning', () => {
  it('two 30k-impression fixture observations back exactly a MEDIUM-confidence learning', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();

    const observations = [];
    for (const externalPostId of ['post-1', 'post-2']) {
      // eslint-disable-next-line no-await-in-loop -- deterministic ordered fixture ingestion
      const { observation } = await ingestPerformanceObservation(
        store,
        workspaceId,
        ingestInput({
          subject: subject({ campaignId, externalPostId }),
          raw: { impressions: 30_000, clicks: 1_500, conversions: 90, spendCents: 60_000 },
        }),
      );
      observations.push(observation);
    }

    const ev: LearningEvidence[] = observations.map((o) => ({
      performanceObservationId: o.id,
      campaignId,
      platform: 'TIKTOK',
      impressions: o.normalized.impressions,
    }));
    const derivation = deriveLearningConfidence(ev);

    const { record } = await createLearningRecord(
      store,
      workspaceId,
      learningInput({
        sourceCampaignId: campaignId,
        evidence: ev,
        confidence: derivation.confidence,
        totalImpressions: derivation.totalImpressions,
      }),
    );

    expect(derivation.confidence).toBe('MEDIUM');
    expect(record.confidence).toBe('MEDIUM');
    expect(record.totalImpressions).toBe(60_000);
    expect(record.evidence.map((e) => e.performanceObservationId).sort()).toEqual(
      observations.map((o) => o.id).sort(),
    );
  });

  it('a single thin fixture observation can only back a LOW-confidence learning', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();

    const { observation } = await ingestPerformanceObservation(
      store,
      workspaceId,
      ingestInput({
        subject: subject({ campaignId }),
        raw: { impressions: 120, clicks: 4, conversions: 0, spendCents: 300 },
      }),
    );
    const ev: LearningEvidence[] = [
      {
        performanceObservationId: observation.id,
        campaignId,
        platform: 'TIKTOK',
        impressions: 120,
      },
    ];
    const derivation = deriveLearningConfidence(ev);

    const { record } = await createLearningRecord(
      store,
      workspaceId,
      learningInput({
        sourceCampaignId: campaignId,
        evidence: ev,
        confidence: derivation.confidence,
        totalImpressions: derivation.totalImpressions,
      }),
    );
    await reviewLearningRecord(store, workspaceId, record.id, {
      status: 'APPROVED',
      reviewedByUserId: randomUUID(),
    });

    expect(record.confidence).toBe('LOW');
    // Even APPROVED, a LOW-confidence learning is never injected.
    expect(
      await loadLearningContext(store, workspaceId, {
        scope: 'STRATEGY',
        targetPlatforms: ['TIKTOK'],
        targetDurationsSeconds: [15],
      }),
    ).toHaveLength(0);
  });
});
