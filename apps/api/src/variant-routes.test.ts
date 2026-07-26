import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { WorkflowClient } from '@temporalio/client';
import {
  addMembership,
  createAssetWithProvenance,
  createQualityAssessmentForAsset,
  createVariantSpecification,
  getOrCreateCreativeVariant,
  getOrCreateVariantGenerationAttempt,
  getOrCreateVariantGenerationJob,
  InMemoryCampaignStore,
  updateCreativeVariant,
  type CreateVariantSpecificationInput,
} from '@combat/database';
import type { RoleName } from '@combat/domain';
import { MockStorageProvider } from '@combat/providers';
import { registerVariantRoutes } from './variant-routes';
import { registerAuthentication } from './authentication';
import { bearerFor, permissiveTestAuthentication } from './test-helpers/authenticated-caller';

function specInput(
  campaignId: string,
  targetDurationSeconds: number,
  overrides: Partial<CreateVariantSpecificationInput> = {},
): CreateVariantSpecificationInput {
  return {
    campaignId,
    parentMasterAssetId: overrides.parentMasterAssetId ?? randomUUID(),
    parentFinalQaAssessmentId: randomUUID(),
    timelineId: randomUUID(),
    timelineVersion: 1,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotSelectionSetId: randomUUID(),
    shotSelectionSetVersion: 1,
    roughEditSpecificationId: randomUUID(),
    roughEditSpecificationVersion: 1,
    soundDesignPlanId: randomUUID(),
    soundDesignPlanVersion: 1,
    deliveryProfileId: randomUUID(),
    deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
    deliveryProfileVersion: 1,
    deliverySpecificationId: randomUUID(),
    platform: 'INSTAGRAM_REELS',
    targetDurationSeconds,
    targetDurationFrames: targetDurationSeconds * 30,
    aspectRatio: '9:16',
    resolutionWidth: 1080,
    resolutionHeight: 1920,
    frameRate: 30,
    cutPoints: [
      {
        order: 0,
        sourceStartFrame: 0,
        sourceEndFrame: targetDurationSeconds * 30,
        variantStartFrame: 0,
      },
    ],
    retainedClips: [
      {
        order: 0,
        shotId: randomUUID(),
        shotIndex: 0,
        sourceAssetId: randomUUID(),
        sourceStartFrame: 0,
        sourceEndFrame: targetDurationSeconds * 30,
      },
    ],
    retainedCues: [],
    retainedCaptions: [
      {
        text: 'Caption',
        variantStartFrame: 0,
        variantEndFrame: targetDurationSeconds * 30,
        safeArea: 'BOTTOM',
      },
    ],
    ctaPlacement: {
      present: true,
      variantStartFrame: targetDurationSeconds * 30 - 60,
      variantEndFrame: targetDurationSeconds * 30,
    },
    captionBurnRequired: true,
    safeAreas: ['BOTTOM'],
    cutRationale: `Kept the hook and CTA for the ${targetDurationSeconds}s cut.`,
    removedRationale: ['Dropped the promise beat.'],
    qualityRubric: [],
    promptVersionId: randomUUID(),
    createdByAgentInvocationId: randomUUID(),
    ...overrides,
  };
}

interface SeedOptions {
  readonly role?: RoleName;
  readonly withVariants?: boolean;
  readonly qaPass?: boolean;
}

async function seed(store: InMemoryCampaignStore, opts: SeedOptions = {}) {
  const { role = 'OWNER_ADMIN', withVariants = true, qaPass = true } = opts;
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const memberId = randomUUID();
  await addMembership(store, workspaceId, { userId: memberId, role });
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'VARIANT_QA' });

  const assetIds: string[] = [];
  if (withVariants) {
    const parentMasterAssetId = randomUUID();
    for (const duration of [15, 10, 6]) {
      // eslint-disable-next-line no-await-in-loop -- deterministic ordered fixture setup
      const { specification } = await createVariantSpecification(
        store,
        workspaceId,
        specInput(campaignId, duration, { parentMasterAssetId }),
      );
      // eslint-disable-next-line no-await-in-loop -- same rationale
      const job = await getOrCreateVariantGenerationJob(store, workspaceId, {
        campaignId,
        variantSpecificationId: specification.id,
        maxAttempts: 3,
      });
      // eslint-disable-next-line no-await-in-loop -- same rationale
      await getOrCreateVariantGenerationAttempt(store, workspaceId, {
        variantGenerationJobId: job.id,
        attemptNumber: 1,
        idempotencyKey: `run-1:VARIANT:${specification.id}:1`,
        providerId: 'mock-motion-graphics',
        status: 'SUCCEEDED',
        estimatedCostCents: duration * 30,
        actualCostCents: duration * 28,
        startedAt: new Date(),
      });
      // eslint-disable-next-line no-await-in-loop -- same rationale
      const asset = await createAssetWithProvenance(store, workspaceId, {
        campaignId,
        kind: 'VARIANT',
        s3Key: `mock/variant/${duration}.mp4`,
        checksum: `variant-${campaignId}-${duration}`,
        mimeType: 'video/mp4',
        originalFilename: `variant-${duration}s.mp4`,
        sizeBytes: 0,
        ingestionStatus: 'READY',
        generatedByActivity: 'pollVariantRenderActivity',
      });
      assetIds.push(asset.asset.id);
      // eslint-disable-next-line no-await-in-loop -- same rationale
      const { variant } = await getOrCreateCreativeVariant(store, workspaceId, {
        campaignId,
        deliverySpecificationId: specification.deliverySpecificationId,
        variantSpecificationId: specification.id,
        durationSeconds: duration,
      });
      // eslint-disable-next-line no-await-in-loop -- same rationale
      const { assessment } = await createQualityAssessmentForAsset(store, workspaceId, {
        campaignId,
        assetId: asset.asset.id,
        subjectStage: 'VARIANT_QA',
        pass: qaPass,
        overallScore: qaPass ? 1 : 0.25,
        scores: { 'technical-delivery-spec': qaPass ? 1 : 0 },
        assessedBy: 'AGENT',
        createdByAgentInvocationId: randomUUID(),
        failures: qaPass
          ? []
          : [
              {
                category: 'EDIT_TIMING',
                severity: 'BLOCKING',
                description: 'variant runs long',
                suggestedAction: 'recut on a shot boundary',
              },
            ],
      });
      // eslint-disable-next-line no-await-in-loop -- same rationale
      await updateCreativeVariant(store, variant.id, {
        status: qaPass ? 'READY' : 'FAILED',
        assetId: asset.asset.id,
        qualityAssessmentId: assessment.id,
      });
    }
  }

  return { workspaceId, campaignId, memberId, assetIds };
}

function buildApp(store: InMemoryCampaignStore, signal = vi.fn().mockResolvedValue(undefined)) {
  const app = Fastify();
  // AAMP-1 step 2: these suites exercise authorization, so the caller arrives
  // authenticated exactly as a production caller does — a verified bearer
  // token, never a request field. See test-helpers/authenticated-caller.ts.
  registerAuthentication(app, permissiveTestAuthentication().hookDeps);
  const workflowClient = { getHandle: () => ({ signal }) } as unknown as WorkflowClient;
  registerVariantRoutes(app, {
    db: store,
    storageProvider: new MockStorageProvider(),
    workflowClient,
  });
  return { app, signal };
}

function url(s: { workspaceId: string; campaignId: string }): string {
  return `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/variants`;
}

describe('variant routes — read surface', () => {
  it('returns all three variant specifications with cut points, captions, CTA and safe areas', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const { app } = buildApp(store);

    const res = await app.inject({ method: 'GET', url: url(s), headers: bearerFor(s.memberId) });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.variants).toHaveLength(3);
    expect(
      body.variants.map(
        (v: { specification: { targetDurationSeconds: number } }) =>
          v.specification.targetDurationSeconds,
      ),
    ).toEqual([15, 10, 6]);

    const fifteen = body.variants[0];
    expect(fifteen.specification.cutPoints).toHaveLength(1);
    expect(fifteen.specification.retainedCaptions).toHaveLength(1);
    expect(fifteen.specification.ctaPlacement.present).toBe(true);
    expect(fifteen.specification.safeAreas).toEqual(['BOTTOM']);
    expect(fifteen.specification.captionBurnRequired).toBe(true);
    expect(fifteen.specification.cutRationale).toContain('15s');
    expect(fifteen.specification.deliveryProfileKey).toBe('VERTICAL_SHORT_FORM_V1');
    expect(body.campaign.isVariantStage).toBe(true);
  });

  it('returns each variant QA verdict and render/attempt state', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const { app } = buildApp(store);

    const body = (
      await app.inject({ method: 'GET', url: url(s), headers: bearerFor(s.memberId) })
    ).json();

    const first = body.variants[0];
    expect(first.variant.status).toBe('READY');
    expect(first.variant.hasMedia).toBe(false);
    expect(first.qa.pass).toBe(true);
    expect(first.job.attemptCount).toBe(0);
    expect(first.attempts).toHaveLength(1);
    expect(first.attempts[0]).toMatchObject({ attemptNumber: 1, status: 'SUCCEEDED' });
    expect(first.attempts[0].actualCostCents).toBeGreaterThan(0);
  });

  it('surfaces failure and retry state for a failing variant', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { qaPass: false });
    const { app } = buildApp(store);

    const body = (
      await app.inject({ method: 'GET', url: url(s), headers: bearerFor(s.memberId) })
    ).json();

    expect(body.variants[0].variant.status).toBe('FAILED');
    expect(body.variants[0].qa.pass).toBe(false);
    expect(body.variants[0].qa.findings[0]).toMatchObject({
      category: 'EDIT_TIMING',
      severity: 'BLOCKING',
      suggestedAction: 'recut on a shot boundary',
    });
    // A failing variant's cut is NOT frozen for export.
    expect(body.variants[0].specification.approvedForExport).toBe(false);
  });

  it('returns an empty list before any variant has been cut', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { withVariants: false });
    const { app } = buildApp(store);

    const res = await app.inject({ method: 'GET', url: url(s), headers: bearerFor(s.memberId) });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toHaveLength(0);
  });

  it('403s a non-member and never leaks a cross-workspace campaign', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const { app } = buildApp(store);

    expect(
      (await app.inject({ method: 'GET', url: url(s), headers: bearerFor(randomUUID()) }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/workspaces/${randomUUID()}/campaigns/${s.campaignId}/variants`,
          headers: bearerFor(s.memberId),
        })
      ).statusCode,
    ).toBe(403);
  });

  // See final-qa-routes.test.ts's identical note: with identity out of the
  // request, "malformed caller id" is not a reachable state; "no credential" is.
  it('401s a request with no session token', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const { app } = buildApp(store);

    expect((await app.inject({ method: 'GET', url: url(s) })).statusCode).toBe(401);
  });
});

describe('variant routes — preview placeholders', () => {
  it('reports hasMedia false with no URL for a mock variant (no bytes exist)', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const { app } = buildApp(store);

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/variants/${s.assetIds[0]}/preview`,
      headers: bearerFor(s.memberId),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hasMedia: false, url: null });
  });

  it('404s an asset that is not a VARIANT of this campaign', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const { app } = buildApp(store);

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/variants/${randomUUID()}/preview`,
      headers: bearerFor(s.memberId),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('variant routes — authorized cancel', () => {
  it.each([
    ['OWNER_ADMIN', 202],
    ['PRODUCTION_OPERATOR', 202],
    ['REVIEWER', 403],
    ['ANALYST', 403],
  ] as const)('role %s gets %i from the cancel endpoint', async (role, expected) => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store, { role });
    const { app, signal } = buildApp(store);

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/variants/cancel`,
      headers: bearerFor(s.memberId),
      payload: {},
    });

    expect(res.statusCode).toBe(expected);
    if (expected === 202) {
      expect(res.json()).toEqual({ cancelRequested: true });
      expect(signal).toHaveBeenCalledTimes(1);
    } else {
      expect(signal).not.toHaveBeenCalled();
    }
  });

  it('reports canCancel on the read route so the UI can disable a refused action', async () => {
    const store = new InMemoryCampaignStore();
    const reviewer = await seed(store, { role: 'REVIEWER' });
    const { app } = buildApp(store);

    const body = (
      await app.inject({ method: 'GET', url: url(reviewer), headers: bearerFor(reviewer.memberId) })
    ).json();

    expect(body.caller).toMatchObject({ role: 'REVIEWER', canCancel: false });
  });

  it('403s a non-member cancel without signalling', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const { app, signal } = buildApp(store);

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/variants/cancel`,
      headers: bearerFor(randomUUID()),
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(signal).not.toHaveBeenCalled();
  });
});

describe('variant routes — no export surface (M12 scope)', () => {
  it('exposes no download or export endpoint', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seed(store);
    const { app } = buildApp(store);

    for (const path of ['export', 'download', 'publish']) {
      // eslint-disable-next-line no-await-in-loop -- three fixed probes
      const res = await app.inject({
        method: 'POST',
        url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/variants/${path}`,
        headers: bearerFor(s.memberId),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
