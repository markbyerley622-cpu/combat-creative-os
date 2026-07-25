import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from './in-memory-campaign-store';

/**
 * Post-M14 audit finding H-1 — the in-memory store must reject what Postgres
 * rejects.
 *
 * Every case below maps 1:1 to a `@@unique` in
 * `packages/database/prisma/schema.prisma`. Before this, only three of them
 * were mirrored, so a duplicate `(campaignId, version)` row or a
 * double-inserted generation attempt passed the whole suite and would have
 * surfaced for the first time against a real database. These tests are what
 * keeps the fake honest as the schema grows.
 */

const CONTEXT = { workspaceId: randomUUID(), campaignId: randomUUID() };

function versionedRow(version: number) {
  return { ...CONTEXT, version };
}

describe('in-memory store mirrors the schema — (campaignId, version) families', () => {
  it('campaign_briefs rejects a duplicate version', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      ...versionedRow(1),
      campaignName: 'c',
      productName: 'p',
      productDescription: 'd',
      objective: 'o',
      targetAudience: 't',
      customerProblem: 'c',
      valueProposition: 'v',
      productFeatures: [],
      targetPlatforms: ['TIKTOK'],
      aspectRatios: ['9:16'],
      durationsSeconds: [15],
      brandVoice: 'b',
      visualDirection: 'v',
      requiredMessaging: [],
      callToAction: 'cta',
      references: [],
      assetReferences: [],
      prohibitedClaims: [],
      budgetCents: 1,
      locale: 'en-US',
    } as unknown as Parameters<typeof store.campaignBrief.create>[0]['data'];

    await store.campaignBrief.create({ data });
    await expect(store.campaignBrief.create({ data })).rejects.toThrow(
      /unique constraint violation on campaign_briefs \(campaignId, version\)/,
    );
    expect(store.campaignBriefRecords).toHaveLength(1);
  });

  it('strategies rejects a duplicate version', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      ...versionedRow(1),
      positioning: 'p',
      targetAudienceSummary: 's',
      keyMessages: [],
      toneGuidelines: [],
      audienceProfile: {
        name: 'n',
        demographics: {},
        psychographics: {},
        painPoints: [],
        platformBehavior: {},
      },
    } as unknown as Parameters<typeof store.strategy.create>[0]['data'];

    await store.strategy.create({ data });
    await expect(store.strategy.create({ data })).rejects.toThrow(
      /unique constraint violation on strategies/,
    );
  });

  it('creative_concepts rejects a duplicate version', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      ...versionedRow(1),
      logline: 'l',
      visualDirection: 'v',
      narrativeArc: 'n',
      referenceNotes: [],
    } as unknown as Parameters<typeof store.creativeConcept.create>[0]['data'];

    await store.creativeConcept.create({ data });
    await expect(store.creativeConcept.create({ data })).rejects.toThrow(
      /unique constraint violation on creative_concepts/,
    );
  });

  it('scripts rejects a duplicate version', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      ...versionedRow(1),
      creativeConceptId: randomUUID(),
      totalDurationFrames: 300,
    } as unknown as Parameters<typeof store.script.create>[0]['data'];

    await store.script.create({ data });
    await expect(store.script.create({ data })).rejects.toThrow(
      /unique constraint violation on scripts/,
    );
  });

  it('allows a genuinely new version of the same campaign artifact', async () => {
    const store = new InMemoryCampaignStore();
    const base = {
      ...CONTEXT,
      creativeConceptId: randomUUID(),
      totalDurationFrames: 300,
    };

    await store.script.create({
      data: { ...base, version: 1 } as unknown as Parameters<typeof store.script.create>[0]['data'],
    });
    await store.script.create({
      data: { ...base, version: 2 } as unknown as Parameters<typeof store.script.create>[0]['data'],
    });

    expect(store.scriptRecords.map((s) => s.version)).toEqual([1, 2]);
  });
});

describe('in-memory store mirrors the schema — per-job idempotency keys', () => {
  it('shot_generation_attempts rejects a duplicate key for the same job', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      workspaceId: CONTEXT.workspaceId,
      shotGenerationJobId: 'job-1',
      attemptNumber: 1,
      idempotencyKey: 'run:GEN:spec:1',
      providerId: 'mock',
      status: 'SUBMITTED',
      requestedCandidateCount: 2,
      generationParams: {},
    } as unknown as Parameters<typeof store.shotGenerationAttempt.create>[0]['data'];

    await store.shotGenerationAttempt.create({ data });
    await expect(store.shotGenerationAttempt.create({ data })).rejects.toThrow(
      /unique constraint violation on shot_generation_attempts \(shotGenerationJobId, idempotencyKey\)/,
    );
    expect(store.shotGenerationAttemptRecords).toHaveLength(1);
  });

  it('the same key against a different job is allowed', async () => {
    const store = new InMemoryCampaignStore();
    const base = {
      workspaceId: CONTEXT.workspaceId,
      attemptNumber: 1,
      idempotencyKey: 'shared-key',
      providerId: 'mock',
      status: 'SUBMITTED',
      requestedCandidateCount: 2,
      generationParams: {},
    };

    for (const shotGenerationJobId of ['job-1', 'job-2']) {
      // eslint-disable-next-line no-await-in-loop -- ordered inserts
      await store.shotGenerationAttempt.create({
        data: { ...base, shotGenerationJobId } as unknown as Parameters<
          typeof store.shotGenerationAttempt.create
        >[0]['data'],
      });
    }

    expect(store.shotGenerationAttemptRecords).toHaveLength(2);
  });

  it('composition_attempts rejects a duplicate key for the same job', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      workspaceId: CONTEXT.workspaceId,
      compositionJobId: 'cjob-1',
      attemptNumber: 1,
      idempotencyKey: 'run:COMP:1',
      providerId: 'mock',
      status: 'SUBMITTED',
    } as unknown as Parameters<typeof store.compositionAttempt.create>[0]['data'];

    await store.compositionAttempt.create({ data });
    await expect(store.compositionAttempt.create({ data })).rejects.toThrow(
      /unique constraint violation on composition_attempts/,
    );
  });

  it('variant_generation_attempts rejects a duplicate key for the same job', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      workspaceId: CONTEXT.workspaceId,
      variantGenerationJobId: 'vjob-1',
      attemptNumber: 1,
      idempotencyKey: 'run:VAR:1',
      providerId: 'mock',
      status: 'SUBMITTED',
    } as unknown as Parameters<typeof store.variantGenerationAttempt.create>[0]['data'];

    await store.variantGenerationAttempt.create({ data });
    await expect(store.variantGenerationAttempt.create({ data })).rejects.toThrow(
      /unique constraint violation on variant_generation_attempts/,
    );
  });

  it('performance_observations rejects a duplicate key in the same workspace', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      workspaceId: CONTEXT.workspaceId,
      idempotencyKey: 'obs-1',
      subject: { platform: 'TIKTOK', externalPostId: 'p' },
      source: 'FIXTURE',
      periodStart: new Date(),
      periodEnd: new Date(),
      raw: {},
      normalized: {},
    } as unknown as Parameters<typeof store.performanceObservation.create>[0]['data'];

    await store.performanceObservation.create({ data });
    await expect(store.performanceObservation.create({ data })).rejects.toThrow(
      /unique constraint violation on performance_observations/,
    );
  });

  it('campaigns rejects a duplicate intake idempotency key in the same workspace', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      workspaceId: CONTEXT.workspaceId,
      name: 'c',
      idempotencyKey: 'intake-1',
    } as unknown as Parameters<typeof store.campaign.create>[0]['data'];

    await store.campaign.create({ data });
    await expect(store.campaign.create({ data })).rejects.toThrow(
      /unique constraint violation on campaigns/,
    );
  });

  it('campaigns without an idempotency key are unconstrained', async () => {
    const store = new InMemoryCampaignStore();
    const data = { workspaceId: CONTEXT.workspaceId, name: 'c' } as unknown as Parameters<
      typeof store.campaign.create
    >[0]['data'];

    await store.campaign.create({ data });
    await store.campaign.create({ data });

    expect(store.campaigns).toHaveLength(2);
  });
});

describe('in-memory store mirrors the schema — one job per specification', () => {
  it('shot_generation_jobs rejects a second job for the same specification', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      ...CONTEXT,
      shotSpecificationId: 'spec-1',
      requestedCandidateCount: 2,
      maxAttempts: 3,
      status: 'PENDING',
      attemptCount: 0,
    } as unknown as Parameters<typeof store.shotGenerationJob.create>[0]['data'];

    await store.shotGenerationJob.create({ data });
    await expect(store.shotGenerationJob.create({ data })).rejects.toThrow(
      /unique constraint violation on shot_generation_jobs \(shotSpecificationId\)/,
    );
  });

  it('generation_candidates rejects a duplicate candidateIndex for one attempt', async () => {
    const store = new InMemoryCampaignStore();
    const data = {
      workspaceId: CONTEXT.workspaceId,
      shotSpecificationId: 'spec-1',
      shotGenerationAttemptId: 'attempt-1',
      candidateIndex: 0,
      status: 'SUCCEEDED',
    } as unknown as Parameters<typeof store.generationCandidate.create>[0]['data'];

    await store.generationCandidate.create({ data });
    await expect(store.generationCandidate.create({ data })).rejects.toThrow(
      /unique constraint violation on generation_candidates/,
    );
  });
});
