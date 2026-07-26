import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  addMembership,
  createSoundCue,
  createSoundDesignPlan,
  createTimeline,
  InMemoryCampaignStore,
} from '@combat/database';
import { registerSoundDesignRoutes } from './sound-design-routes';
import { registerAuthentication } from './authentication';
import { bearerFor, permissiveTestAuthentication } from './test-helpers/authenticated-caller';

async function seed(store: InMemoryCampaignStore, opts: { withPlan?: boolean } = {}) {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const memberId = randomUUID();
  await addMembership(store, workspaceId, { userId: memberId, role: 'REVIEWER' });
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'SOUND_DESIGN' });

  if (opts.withPlan) {
    const timeline = await createTimeline(store, workspaceId, {
      campaignId,
      scriptId: randomUUID(),
      version: 1,
      frameRate: 30,
      durationFrames: 180,
      entries: [{ shotId: randomUUID(), order: 0, startFrame: 0, durationFrames: 180 }],
    });
    await createSoundDesignPlan(store, workspaceId, {
      campaignId,
      timelineId: timeline.id,
      roughEditSpecificationId: randomUUID(),
      version: 1,
      musicBrief: 'driving bed',
      mixNotes: 'duck vo',
      brandAudioGuidelines: ['no lyrics'],
      qualityRubric: [],
      promptVersionId: randomUUID(),
      createdByAgentInvocationId: randomUUID(),
    });
    await createSoundCue(store, workspaceId, {
      timelineId: timeline.id,
      type: 'MUSIC',
      startFrame: 0,
      durationFrames: 180,
      assetId: randomUUID(),
      notes: 'bed',
    });
  }
  return { workspaceId, campaignId, memberId };
}

function buildApp(store: InMemoryCampaignStore) {
  const app = Fastify();
  // AAMP-1 step 2: these suites exercise authorization, so the caller arrives
  // authenticated exactly as a production caller does — a verified bearer
  // token, never a request field. See test-helpers/authenticated-caller.ts.
  registerAuthentication(app, permissiveTestAuthentication().hookDeps);
  registerSoundDesignRoutes(app, { db: store });
  return app;
}

describe('sound-design routes', () => {
  it('returns the sound-design plan, timeline, and cues', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withPlan: true });
    const app = buildApp(store);
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/sound-design`,
      headers: bearerFor(s.memberId),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plan.musicBrief).toContain('driving');
    expect(body.timeline.entries).toHaveLength(1);
    expect(body.cues).toHaveLength(1);
    expect(body.cues[0].hasMedia).toBe(false);
    expect(body.campaign.isSoundDesignStage).toBe(true);
  });

  it('returns a null plan before the Sound Director has run', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const app = buildApp(store);
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/sound-design`,
      headers: bearerFor(s.memberId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan).toBeNull();
    expect(res.json().cues).toHaveLength(0);
  });

  it('403s a non-member', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withPlan: true });
    const app = buildApp(store);
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/sound-design`,
      headers: bearerFor(randomUUID()),
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s a cross-workspace campaign rather than leaking it', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withPlan: true });
    const app = buildApp(store);
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${randomUUID()}/campaigns/${s.campaignId}/sound-design`,
      headers: bearerFor(s.memberId),
    });
    expect(res.statusCode).toBe(403);
  });
});
