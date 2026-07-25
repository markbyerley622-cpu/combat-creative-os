import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';
import { createTimeline, getLatestTimeline, listTimelineEntries } from './timeline-repository';
import {
  createSoundCue,
  createSoundDesignPlan,
  getLatestSoundDesignPlan,
  listSoundCuesForTimeline,
} from './sound-design-repository';

describe('timeline-repository', () => {
  it('creates a versioned timeline with ordered entries, idempotent per version', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const scriptId = randomUUID();

    const t1 = await createTimeline(store, workspaceId, {
      campaignId,
      scriptId,
      version: 1,
      frameRate: 30,
      durationFrames: 180,
      entries: [
        { shotId: randomUUID(), order: 1, startFrame: 90, durationFrames: 90 },
        { shotId: randomUUID(), order: 0, startFrame: 0, durationFrames: 90 },
      ],
    });
    const retry = await createTimeline(store, workspaceId, {
      campaignId,
      scriptId,
      version: 1,
      frameRate: 30,
      durationFrames: 180,
      entries: [],
    });
    expect(retry.id).toBe(t1.id);

    const entries = await listTimelineEntries(store, t1.id);
    expect(entries.map((e) => e.order)).toEqual([0, 1]);
    expect((await getLatestTimeline(store, workspaceId, campaignId))?.version).toBe(1);
    // Fact reader sees it.
    const facts = await store.timeline.findMany({ where: { campaignId } });
    expect(facts.length).toBeGreaterThan(0);
  });
});

describe('sound-design-repository', () => {
  it('persists a versioned plan + cues visible to the soundDesignComplete fact', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const timelineId = randomUUID();

    const plan = await createSoundDesignPlan(store, workspaceId, {
      campaignId,
      timelineId,
      roughEditSpecificationId: randomUUID(),
      version: 1,
      musicBrief: 'driving',
      mixNotes: 'ducked vo',
      brandAudioGuidelines: ['no lyrics'],
      qualityRubric: [],
      promptVersionId: randomUUID(),
      createdByAgentInvocationId: randomUUID(),
    });
    const retry = await createSoundDesignPlan(store, workspaceId, {
      campaignId,
      timelineId,
      roughEditSpecificationId: randomUUID(),
      version: 1,
      musicBrief: 'x',
      mixNotes: 'x',
      brandAudioGuidelines: [],
      qualityRubric: [],
      promptVersionId: randomUUID(),
      createdByAgentInvocationId: randomUUID(),
    });
    expect(retry.id).toBe(plan.id);

    await createSoundCue(store, workspaceId, {
      timelineId,
      type: 'MUSIC',
      startFrame: 0,
      durationFrames: 180,
      assetId: randomUUID(),
      notes: 'bed',
    });
    await createSoundCue(store, workspaceId, {
      timelineId,
      type: 'SFX',
      startFrame: 30,
      durationFrames: 10,
    });

    const cues = await listSoundCuesForTimeline(store, timelineId);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.type).toBe('MUSIC');
    expect((await getLatestSoundDesignPlan(store, workspaceId, campaignId))?.version).toBe(1);
    // The transition-facts reader (timelineId set) also sees the cues.
    const factView = await store.soundCue.findMany({ where: { timelineId: { in: [timelineId] } } });
    expect(factView.length).toBe(2);
  });

  it('is workspace-scoped', async () => {
    const store = new InMemoryCampaignStore();
    const campaignId = randomUUID();
    await createSoundDesignPlan(store, randomUUID(), {
      campaignId,
      timelineId: randomUUID(),
      roughEditSpecificationId: randomUUID(),
      version: 1,
      musicBrief: 'm',
      mixNotes: 'n',
      brandAudioGuidelines: [],
      qualityRubric: [],
      promptVersionId: randomUUID(),
      createdByAgentInvocationId: randomUUID(),
    });
    expect(await getLatestSoundDesignPlan(store, randomUUID(), campaignId)).toBeUndefined();
  });
});
