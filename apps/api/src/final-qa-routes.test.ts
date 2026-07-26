import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  addMembership,
  createAssetWithProvenance,
  createQualityAssessmentForAsset,
  createRoughEditSpecification,
  createTimeline,
  InMemoryCampaignStore,
} from '@combat/database';
import type { RoleName } from '@combat/domain';
import { registerFinalQaRoutes } from './final-qa-routes';
import { registerAuthentication } from './authentication';
import { bearerFor, permissiveTestAuthentication } from './test-helpers/authenticated-caller';

interface SeedOptions {
  readonly role?: RoleName;
  readonly withMaster?: boolean;
  readonly withAssessment?: boolean;
  readonly pass?: boolean;
  readonly currentStage?: 'FINAL_QA' | 'FINAL_APPROVAL';
}

async function seed(store: InMemoryCampaignStore, opts: SeedOptions = {}) {
  const {
    role = 'CREATIVE_DIRECTOR',
    withMaster = true,
    withAssessment = true,
    pass = true,
    currentStage = 'FINAL_APPROVAL',
  } = opts;

  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const memberId = randomUUID();
  await addMembership(store, workspaceId, { userId: memberId, role });
  store.seedCampaign({ id: campaignId, workspaceId, currentStage });

  const clip = {
    order: 0,
    shotId: randomUUID(),
    shotIndex: 0,
    sourceAssetId: randomUUID(),
    sourceInFrame: 0,
    sourceOutFrame: 450,
    timelineStartFrame: 0,
    durationFrames: 450,
    transitionIn: 'CUT' as const,
  };
  await createRoughEditSpecification(store, workspaceId, {
    campaignId,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotSelectionSetId: randomUUID(),
    shotSelectionSetVersion: 1,
    version: 1,
    outputFormat: 'mp4',
    aspectRatio: '9:16',
    resolutionWidth: 1080,
    resolutionHeight: 1920,
    frameRate: 30,
    targetDurationFrames: 450,
    tracks: [{ trackType: 'VIDEO', clips: [clip] }],
    overlays: [{ kind: 'CAPTION', description: 'captions' }],
    pacingNotes: 'fast',
    beatStructure: [],
    continuityNotes: [],
    textSafeAreas: [],
    brandTokens: [],
    captionPlaceholder: 'burn captions',
    musicPlaceholder: 'm',
    sfxPlaceholder: 's',
    platform: 'INSTAGRAM_REELS',
    platformDeliveryNotes: 'reels',
    editRationale: 'hook first',
    qualityRubric: [],
    promptVersionId: randomUUID(),
    createdByAgentInvocationId: randomUUID(),
  });
  await createTimeline(store, workspaceId, {
    campaignId,
    scriptId: randomUUID(),
    version: 1,
    frameRate: 30,
    durationFrames: 450,
    entries: [{ shotId: randomUUID(), order: 0, startFrame: 0, durationFrames: 450 }],
  });

  let masterId: string | undefined;
  if (withMaster) {
    const created = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'FINAL_MASTER',
      s3Key: 'mock/final-master/1.mp4',
      checksum: `final-master-${campaignId}`,
      mimeType: 'video/mp4',
      originalFilename: 'final-master-v1.mp4',
      sizeBytes: 0,
      ingestionStatus: 'READY',
      generatedByActivity: 'runFinalQaControllerActivity',
    });
    masterId = created.asset.id;

    if (withAssessment) {
      await createQualityAssessmentForAsset(store, workspaceId, {
        campaignId,
        assetId: masterId,
        subjectStage: 'FINAL_QA',
        pass,
        overallScore: pass ? 1 : 0.25,
        scores: { 'technical-delivery-spec': pass ? 1 : 0 },
        assessedBy: 'AGENT',
        createdByAgentInvocationId: randomUUID(),
        failures: pass
          ? []
          : [
              {
                category: 'AUDIO_TECHNICAL',
                severity: 'BLOCKING',
                description: 'Programme loudness is above the ceiling',
                suggestedAction: 'Re-mix to -14 LUFS',
              },
            ],
      });
    }
  }

  return { workspaceId, campaignId, memberId, masterId };
}

function buildApp(store: InMemoryCampaignStore) {
  const app = Fastify();
  // AAMP-1 step 2: these suites exercise authorization, so the caller arrives
  // authenticated exactly as a production caller does — a verified bearer
  // token, never a request field. See test-helpers/authenticated-caller.ts.
  registerAuthentication(app, permissiveTestAuthentication().hookDeps);
  registerFinalQaRoutes(app, { db: store });
  return app;
}

function url(s: { workspaceId: string; campaignId: string }): string {
  return `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/final-qa`;
}

describe('final-qa routes', () => {
  it('returns the passing Final QA verdict, the master, and the delivery context', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const res = await buildApp(store).inject({
      method: 'GET',
      url: url(s),
      headers: bearerFor(s.memberId),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assessment.pass).toBe(true);
    expect(body.assessment.overallScore).toBe(1);
    expect(body.findings).toHaveLength(0);
    expect(body.master.id).toBe(s.masterId);
    // Mock masters have no bytes — the UI renders a placeholder, not a player.
    expect(body.master.hasMedia).toBe(false);
    expect(body.deliveryContext).toMatchObject({
      platform: 'INSTAGRAM_REELS',
      aspectRatio: '9:16',
      frameRate: 30,
      durationFrames: 450,
    });
    expect(body.campaign.isFinalApprovalStage).toBe(true);
  });

  it('returns the typed findings of a failing verdict', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { pass: false, currentStage: 'FINAL_QA' });
    const res = await buildApp(store).inject({
      method: 'GET',
      url: url(s),
      headers: bearerFor(s.memberId),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assessment.pass).toBe(false);
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({
      category: 'AUDIO_TECHNICAL',
      severity: 'BLOCKING',
      suggestedAction: 'Re-mix to -14 LUFS',
    });
    expect(body.campaign.isFinalQaStage).toBe(true);
  });

  it('returns a null assessment before the Final QA Controller has run', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withMaster: false, currentStage: 'FINAL_QA' });
    const res = await buildApp(store).inject({
      method: 'GET',
      url: url(s),
      headers: bearerFor(s.memberId),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().master).toBeNull();
    expect(res.json().assessment).toBeNull();
    expect(res.json().findings).toHaveLength(0);
  });

  it.each([
    ['CREATIVE_DIRECTOR', true],
    ['OWNER_ADMIN', true],
    ['REVIEWER', false],
    ['PRODUCTION_OPERATOR', false],
    ['ANALYST', false],
  ] as const)(
    'reports whether role %s may approve the final master (canApprove=%s)',
    async (role, canApprove) => {
      const store = new InMemoryCampaignStore();
      const s = await seed(store, { role });
      const res = await buildApp(store).inject({
        method: 'GET',
        url: url(s),
        headers: bearerFor(s.memberId),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().caller).toMatchObject({ role, canApprove });
    },
  );

  it('403s a non-member', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const res = await buildApp(store).inject({
      method: 'GET',
      url: url(s),
      headers: bearerFor(randomUUID()),
    });

    expect(res.statusCode).toBe(403);
  });

  it('403s a cross-workspace read rather than leaking the campaign', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const res = await buildApp(store).inject({
      method: 'GET',
      url: `/workspaces/${randomUUID()}/campaigns/${s.campaignId}/final-qa`,
      headers: bearerFor(s.memberId),
    });

    expect(res.statusCode).toBe(403);
  });

  // AAMP-1 step 2: there is no longer a "malformed caller id" case to 400 on —
  // the caller id is never in the request. A request that presents no usable
  // credential is unauthenticated, and 401 is the correct answer.
  it('401s a request with no session token', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const res = await buildApp(store).inject({ method: 'GET', url: url(s) });

    expect(res.statusCode).toBe(401);
  });
});
