import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';
import {
  createRoughEditSpecification,
  getLatestRoughEditSpecification,
  type RoughEditSpecificationRecord,
} from './rough-edit-specification-repository';
import {
  getOrCreateCompositionAttempt,
  getOrCreateCompositionJob,
  listCompositionAttempts,
  updateCompositionAttempt,
} from './composition-repository';
import { createRenderJob, listRenderJobsForCampaign } from './render-job-repository';
import {
  createEditDecisionList,
  getLatestEditDecisionList,
  listEditDecisionEntries,
} from './edit-decision-list-repository';

function specInput(
  campaignId: string,
  version = 1,
  overrides: Partial<RoughEditSpecificationRecord> = {},
): Omit<RoughEditSpecificationRecord, 'id' | 'createdAt' | 'workspaceId'> {
  return {
    campaignId,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotSelectionSetId: randomUUID(),
    shotSelectionSetVersion: 1,
    version,
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
            sourceAssetId: randomUUID(),
            sourceInFrame: 0,
            sourceOutFrame: 90,
            timelineStartFrame: 0,
            durationFrames: 90,
            transitionIn: 'CUT',
          },
        ],
      },
    ],
    overlays: [],
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
    ...overrides,
  };
}

describe('rough-edit-specification-repository', () => {
  it('creates and returns the latest version, idempotent per (campaign, version)', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();

    const first = await createRoughEditSpecification(store, workspaceId, specInput(campaignId, 1));
    const retry = await createRoughEditSpecification(store, workspaceId, specInput(campaignId, 1));
    expect(retry.id).toBe(first.id);
    expect(store.roughEditSpecificationRecords).toHaveLength(1);

    await createRoughEditSpecification(store, workspaceId, specInput(campaignId, 2));
    const latest = await getLatestRoughEditSpecification(store, workspaceId, campaignId);
    expect(latest?.version).toBe(2);
  });

  it('is workspace-scoped', async () => {
    const store = new InMemoryCampaignStore();
    const campaignId = randomUUID();
    await createRoughEditSpecification(store, randomUUID(), specInput(campaignId, 1));
    const latest = await getLatestRoughEditSpecification(store, randomUUID(), campaignId);
    expect(latest).toBeUndefined();
  });
});

describe('composition-repository', () => {
  it('is idempotent for job (per spec) and attempt (per idempotencyKey)', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const roughEditSpecificationId = randomUUID();

    const job = await getOrCreateCompositionJob(store, workspaceId, {
      campaignId,
      roughEditSpecificationId,
      maxAttempts: 3,
    });
    const jobRetry = await getOrCreateCompositionJob(store, workspaceId, {
      campaignId,
      roughEditSpecificationId,
      maxAttempts: 3,
    });
    expect(jobRetry.id).toBe(job.id);

    const attemptInput = {
      compositionJobId: job.id,
      attemptNumber: 1,
      idempotencyKey: 'k1',
      providerId: 'mock-motion-graphics',
      status: 'SUBMITTED' as const,
      startedAt: new Date(),
    };
    const a1 = await getOrCreateCompositionAttempt(store, workspaceId, attemptInput);
    const a2 = await getOrCreateCompositionAttempt(store, workspaceId, attemptInput);
    expect(a1.alreadyExisted).toBe(false);
    expect(a2.alreadyExisted).toBe(true);
    expect(a2.attempt.id).toBe(a1.attempt.id);

    await updateCompositionAttempt(store, a1.attempt.id, {
      status: 'SUCCEEDED',
      actualCostCents: 50,
    });
    const attempts = await listCompositionAttempts(store, job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('SUCCEEDED');
    expect(attempts[0]?.actualCostCents).toBe(50);
  });
});

describe('render-job-repository', () => {
  it('creates a COMPOSITING render job visible to the campaign fact reader', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    await createRenderJob(store, workspaceId, {
      campaignId,
      kind: 'COMPOSITING',
      status: 'SUCCEEDED',
      inputAssetIds: [randomUUID()],
      outputAssetId: randomUUID(),
    });
    const jobs = await listRenderJobsForCampaign(store, workspaceId, campaignId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe('COMPOSITING');
    // The transition-facts reader (campaignId-only) also sees it.
    const factView = await store.renderJob.findMany({ where: { campaignId } });
    expect(factView.some((r) => r.status === 'SUCCEEDED')).toBe(true);
  });
});

describe('edit-decision-list-repository', () => {
  it('creates a versioned EDL with ordered entries, idempotent per version', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const list = await createEditDecisionList(store, workspaceId, {
      campaignId,
      version: 1,
      entries: [
        {
          assetId: randomUUID(),
          sourceInFrame: 0,
          sourceOutFrame: 90,
          timelinePosition: 0,
          trackType: 'VIDEO',
          order: 0,
        },
        {
          assetId: randomUUID(),
          sourceInFrame: 0,
          sourceOutFrame: 90,
          timelinePosition: 90,
          trackType: 'VIDEO',
          order: 1,
        },
      ],
    });
    const retry = await createEditDecisionList(store, workspaceId, {
      campaignId,
      version: 1,
      entries: [],
    });
    expect(retry.id).toBe(list.id);

    const entries = await listEditDecisionEntries(store, list.id);
    expect(entries.map((e) => e.order)).toEqual([0, 1]);
    const latest = await getLatestEditDecisionList(store, workspaceId, campaignId);
    expect(latest?.version).toBe(1);
    // Fact reader sees it (roughCutAssembled).
    const factView = await store.editDecisionList.findMany({ where: { campaignId } });
    expect(factView.length).toBeGreaterThan(0);
  });
});
