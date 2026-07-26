import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@combat/observability';
import {
  addMembership,
  createCreativeConcept,
  createDraftShotSelectionSet,
  createScriptWithShots,
  InMemoryCampaignStore,
  type PrismaClient,
} from '@combat/database';
import { PERMISSIONS, ROLE_NAMES, roleHasPermission, type RoleName } from '@combat/domain';
import { MockReviewProvider, MockStorageProvider } from '@combat/providers';
import type { WorkflowClient } from '@temporalio/client';
import { buildServer } from './server';
import { MUTATING_ROUTES } from './route-authorization';
import { diffRouteSets, listRegisteredMutatingRoutes } from './route-inventory';
import { bearerFor, permissiveTestAuthentication } from './test-helpers/authenticated-caller';

/**
 * M14 — the authorization audit, executed rather than asserted in prose.
 *
 * Two halves: a conformance check that `MUTATING_ROUTES` matches what Fastify
 * actually registered (so an endpoint cannot ship unaudited), and an
 * adversarial sweep that drives every mutating endpoint from a hostile caller
 * and proves nothing was persisted, signalled, reserved or audited.
 */

const silentLogger = createLogger({
  serviceName: 'api-audit-test',
  level: 'silent',
  pretty: false,
});

function fakePrisma(): PrismaClient {
  return { $queryRaw: async () => [{ '?column?': 1 }] } as unknown as PrismaClient;
}

interface Harness {
  app: ReturnType<typeof buildServer>;
  store: InMemoryCampaignStore;
  signal: ReturnType<typeof vitestFn>;
  start: ReturnType<typeof vitestFn>;
}

// Small local spy so this file needs no vi import gymnastics for the workflow client.
function vitestFn() {
  const calls: unknown[][] = [];
  const fn = async (...args: unknown[]) => {
    calls.push(args);
    return { workflowId: 'wf', firstExecutionRunId: 'run' };
  };
  (fn as unknown as { calls: unknown[][] }).calls = calls;
  return fn as typeof fn & { calls: unknown[][] };
}

function buildHarness(store: InMemoryCampaignStore): Harness {
  const signal = vitestFn();
  const start = vitestFn();
  const workflowClient = {
    start,
    getHandle: () => ({ signal, query: async () => undefined }),
  } as unknown as WorkflowClient;

  const auth = permissiveTestAuthentication();
  const app = buildServer({
    logger: silentLogger,
    prisma: fakePrisma(),
    tokenVerifier: auth.tokenVerifier,
    profileDirectory: auth.profileDirectory,
    userDb: auth.userDb,
    approvalDb: store,
    campaignDb: store,
    assetDb: store,
    shotGenerationDb: store,
    shotReviewDb: store,
    compositingDb: store,
    soundDesignDb: store,
    finalQaDb: store,
    variantDb: store,
    performanceDb: store,
    storageProvider: new MockStorageProvider(),
    reviewProvider: new MockReviewProvider(),
    workflowClient,
  });
  return { app, store, signal, start };
}

/** A workspace with one member at `role`, one campaign, and a draft selection set. */
async function seedWorkspace(store: InMemoryCampaignStore, role: RoleName = 'OWNER_ADMIN') {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const userId = randomUUID();
  await addMembership(store, workspaceId, { userId, role });
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'HUMAN_SHOT_SELECTION' });

  const concept = await createCreativeConcept(store, workspaceId, {
    campaignId,
    version: 1,
    logline: 'l',
    visualDirection: 'v',
    narrativeArc: 'n',
    referenceNotes: [],
  });
  const { script, shots } = await createScriptWithShots(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    version: 1,
    totalDurationFrames: 300,
    shots: [
      {
        index: 0,
        description: 'Shot 0',
        durationFrames: 300,
        beat: 'HOOK',
        dependsOnShotIndices: [],
      },
    ],
  });
  const { set } = await createDraftShotSelectionSet(store, workspaceId, {
    campaignId,
    scriptId: script.id,
    scriptVersion: 1,
    creativeConceptId: concept.id,
    creativeConceptVersion: 1,
    version: 1,
    createdByUserId: userId,
    requiredShots: shots.map((shot, index) => ({
      shotId: shot.id,
      sequencePosition: index,
      shotSpecificationId: randomUUID(),
      shotSpecificationVersion: 1,
    })),
  });

  return { workspaceId, campaignId, userId, setId: set.id, shotId: shots[0]!.id };
}

/** A complete, schema-valid brief so `/brief/submit` reaches the auth checks. */
const BRIEF_CONTENT = {
  campaignName: 'Probe',
  productName: 'Combat Reviews',
  productDescription: 'x',
  objective: 'x',
  targetAudience: 'x',
  customerProblem: 'x',
  valueProposition: 'x',
  productFeatures: ['x'],
  targetPlatforms: ['TIKTOK'],
  aspectRatios: ['9:16'],
  durationsSeconds: [15],
  brandVoice: 'x',
  visualDirection: 'x',
  requiredMessaging: ['x'],
  callToAction: 'x',
  references: [],
  assetReferences: [],
  prohibitedClaims: [],
  budgetCents: 1000,
  locale: 'en-US',
};

/** Upload bodies require licensing metadata (M5's no-unlicensed-media rule). */
const UPLOAD_BODY = {
  originalFilename: 'a.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 10,
  licensing: { licenseType: 'ROYALTY_FREE', rightsHolder: 'Combat Reviews' },
};

/** A representative body for each mutating path, with `:params` substituted. */
function bodyFor(path: string, ctx: { setId: string; shotId: string }): Record<string, unknown> {
  const { setId, shotId } = ctx;
  if (path.endsWith('/approvals/concept')) return { decision: 'APPROVED' };
  if (path.endsWith('/approvals/final')) return { decision: 'APPROVED' };
  if (path.endsWith('/campaigns')) return { name: 'Probe campaign', idempotencyKey: randomUUID() };
  if (path.endsWith('/brief/draft')) return { content: {} };
  if (path.endsWith('/brief/submit')) return { content: BRIEF_CONTENT };
  if (path.endsWith('/workflow/start')) return {};
  if (path.endsWith('/assets/request-upload')) return { ...UPLOAD_BODY };
  if (path.endsWith('/assets/confirm-upload')) return { uploadId: randomUUID(), ...UPLOAD_BODY };
  if (path.endsWith('/shot-review/draft')) return {};
  if (path.endsWith('/shot-review/select'))
    return { setId, shotId, candidateId: randomUUID(), expectedRevision: 0 };
  if (path.endsWith('/shot-review/reject-shot'))
    return { setId, shotId, expectedRevision: 0, regenerationFeedback: 'try again' };
  if (path.endsWith('/shot-review/comment')) return { body: 'a comment' };
  if (path.endsWith('/shot-review/approve')) return { setId, expectedRevision: 0 };
  if (path.endsWith('/shot-review/request-regeneration')) return { setId };
  if (path.endsWith('/compositing/cancel')) return {};
  if (path.endsWith('/variants/cancel')) return {};
  if (path.endsWith('/performance/observations'))
    return {
      source: 'FIXTURE',
      observations: [
        {
          platform: 'TIKTOK',
          externalPostId: 'probe',
          periodStart: '2026-07-18T00:00:00.000Z',
          periodEnd: '2026-07-25T00:00:00.000Z',
          raw: { impressions: 10, clicks: 1, conversions: 0, spendCents: 5 },
        },
      ],
    };
  if (path.endsWith('/learnings/:learningId/review')) return { decision: 'APPROVED' };
  throw new Error(`no probe body defined for ${path}`);
}

function urlFor(
  path: string,
  ctx: { workspaceId: string; campaignId: string; learningId: string },
): string {
  return path
    .replace(':workspaceId', ctx.workspaceId)
    .replace(':campaignId', ctx.campaignId)
    .replace(':learningId', ctx.learningId);
}

/** Everything a rejected mutation must leave untouched. */
function snapshot(store: InMemoryCampaignStore) {
  return JSON.stringify({
    campaigns: store.campaigns.map((c) => ({ id: c.id, stage: c.currentStage, v: c.version })),
    approvals: store.approvals.length,
    audits: store.audits.length,
    assets: store.assets.length,
    briefs: store.campaignBriefRecords.length,
    selectionSets: store.shotSelectionSetRecords.length,
    selections: store.shotSelectionRecords.length,
    budgetLedger: store.budgetLedgerEntries.length,
    observations: store.performanceObservationRecords.length,
    learnings: store.learningRecordRecords.map((l) => l.status),
    variants: store.creativeVariantRecords.length,
    invocations: store.agentInvocations.length,
  });
}

describe('M14 — every mutating route is enumerated in the audit registry', () => {
  /**
   * Post-M14 audit finding C-3. This assertion used to check only that each
   * audited path's last URL segment appeared *somewhere* in the router dump,
   * against a hardcoded route count — which a route registered at the wrong
   * path or under the wrong method would still have satisfied, and which said
   * nothing about a real mutating endpoint missing from the registry
   * altogether. It is now an exact set comparison in both directions, derived
   * from the router itself. See `route-registry-conformance.test.ts` for the
   * proof that the comparison catches each kind of drift.
   */
  it('exactly matches the mutating routes Fastify registered, in both directions', async () => {
    const { app } = buildHarness(new InMemoryCampaignStore());
    await app.ready();

    const registered = listRegisteredMutatingRoutes(app);
    const audited = MUTATING_ROUTES.map((route) => ({ method: route.method, path: route.path }));
    const diff = diffRouteSets(registered, audited);

    expect(
      diff.unaudited,
      `mutating routes registered but missing from MUTATING_ROUTES: ${diff.unaudited.join(', ')}`,
    ).toEqual([]);
    expect(
      diff.unregistered,
      `MUTATING_ROUTES entries with no matching registered route: ${diff.unregistered.join(', ')}`,
    ).toEqual([]);
    expect(registered).toHaveLength(audited.length);
  });

  it('names a permission that exists in the canonical domain matrix', () => {
    for (const route of MUTATING_ROUTES) {
      expect(PERMISSIONS, `${route.path}`).toContain(route.permission);
    }
  });

  it('has no duplicate entries', () => {
    const keys = MUTATING_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('requires campaign-ownership verification on every campaign-scoped mutation', () => {
    for (const route of MUTATING_ROUTES) {
      if (route.path.includes(':campaignId')) {
        expect(route.verifiesCampaignOwnership, `${route.path}`).toBe(true);
      }
    }
  });

  it('grants no mutating permission to ANALYST — a read-only role by design', () => {
    for (const route of MUTATING_ROUTES) {
      expect(roleHasPermission('ANALYST', route.permission), `${route.path}`).toBe(false);
    }
  });

  it('every role in the matrix is a known role name', () => {
    expect(ROLE_NAMES).toContain('OWNER_ADMIN');
    expect(ROLE_NAMES.length).toBe(5);
  });
});

describe('M14 — adversarial: a caller with no membership mutates nothing', () => {
  it.each(MUTATING_ROUTES.map((r) => [r.path, r] as const))(
    'POST %s is refused and persists nothing',
    async (_label, route) => {
      const store = new InMemoryCampaignStore();
      const seeded = await seedWorkspace(store);
      const { app, signal, start } = buildHarness(store);
      const before = snapshot(store);

      const stranger = randomUUID();
      const response = await app.inject({
        method: 'POST',
        url: urlFor(route.path, { ...seeded, learningId: randomUUID() }),
        headers: bearerFor(stranger),
        payload: bodyFor(route.path, seeded),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('FORBIDDEN');
      expect(snapshot(store)).toBe(before);
      expect(signal.calls).toHaveLength(0);
      expect(start.calls).toHaveLength(0);
    },
  );
});

describe('M14 — adversarial: an under-privileged member mutates nothing', () => {
  it.each(
    MUTATING_ROUTES.filter((r) => !roleHasPermission('ANALYST', r.permission)).map(
      (r) => [r.path, r] as const,
    ),
  )('POST %s is refused for ANALYST and persists nothing', async (_label, route) => {
    const store = new InMemoryCampaignStore();
    const seeded = await seedWorkspace(store, 'ANALYST');
    const { app, signal, start } = buildHarness(store);
    const before = snapshot(store);

    const response = await app.inject({
      method: 'POST',
      url: urlFor(route.path, { ...seeded, learningId: randomUUID() }),
      headers: bearerFor(seeded.userId),
      payload: bodyFor(route.path, seeded),
    });

    expect(response.statusCode).toBe(403);
    expect(snapshot(store)).toBe(before);
    expect(signal.calls).toHaveLength(0);
    expect(start.calls).toHaveLength(0);
  });
});

describe('M14 — adversarial: cross-workspace access', () => {
  it.each(
    MUTATING_ROUTES.filter((r) => r.path.includes(':campaignId')).map((r) => [r.path, r] as const),
  )('POST %s: workspace A member cannot act on workspace B campaign', async (_label, route) => {
    const store = new InMemoryCampaignStore();
    const a = await seedWorkspace(store);
    const b = await seedWorkspace(store);
    const { app, signal, start } = buildHarness(store);
    const before = snapshot(store);

    // A valid, fully-privileged member of A — but B's campaign in the path.
    const response = await app.inject({
      method: 'POST',
      url: urlFor(route.path, {
        workspaceId: a.workspaceId,
        campaignId: b.campaignId,
        learningId: randomUUID(),
      }),
      headers: bearerFor(a.userId),
      payload: bodyFor(route.path, a),
    });

    // 404, never 403 — a campaign in another tenant is indistinguishable
    // from one that does not exist, so ids are not probeable.
    expect(response.statusCode).toBe(404);
    expect(snapshot(store)).toBe(before);
    expect(signal.calls).toHaveLength(0);
    expect(start.calls).toHaveLength(0);
  });

  it('forging workspace B in the path with an A-only identity is refused', async () => {
    const store = new InMemoryCampaignStore();
    const a = await seedWorkspace(store);
    const b = await seedWorkspace(store);
    const { app, signal } = buildHarness(store);
    const before = snapshot(store);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${b.workspaceId}/campaigns/${b.campaignId}/approvals/concept`,
      headers: bearerFor(a.userId),
      payload: { decision: 'APPROVED' },
    });

    expect(response.statusCode).toBe(403);
    expect(snapshot(store)).toBe(before);
    expect(signal.calls).toHaveLength(0);
  });

  it('a learning from another workspace cannot be approved', async () => {
    const store = new InMemoryCampaignStore();
    const a = await seedWorkspace(store);
    const b = await seedWorkspace(store);
    store.learningRecordRecords.push({
      id: randomUUID(),
      workspaceId: b.workspaceId,
      version: 1,
      learningKey: 'b-only',
      insight: 'private to B',
      scope: 'STRATEGY',
      applicability: { platforms: [], durationsSeconds: [], tags: [] },
      confidence: 'MEDIUM',
      evidence: [
        {
          performanceObservationId: randomUUID(),
          campaignId: b.campaignId,
          platform: 'TIKTOK',
          impressions: 10_000,
        },
      ],
      totalImpressions: 10_000,
      status: 'PROPOSED',
      sourceCampaignId: b.campaignId,
      createdByAgentInvocationId: randomUUID(),
      promptVersionId: randomUUID(),
      createdAt: new Date(),
    });
    const { app } = buildHarness(store);
    const target = store.learningRecordRecords[0]!;

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${a.workspaceId}/learnings/${target.id}/review`,
      headers: bearerFor(a.userId),
      payload: { decision: 'APPROVED' },
    });

    expect(response.statusCode).toBe(404);
    expect(target.status).toBe('PROPOSED');
  });
});

describe('M14 — adversarial: intra-workspace resource association', () => {
  /**
   * The subtle one. Both campaigns are in the SAME workspace and the caller is
   * fully privileged, so membership and permission both pass — only the
   * resource-association check can catch this.
   */
  it.each([
    [
      '/shot-review/select',
      (setId: string, shotId: string) => ({
        setId,
        shotId,
        candidateId: randomUUID(),
        expectedRevision: 0,
      }),
    ],
    [
      '/shot-review/reject-shot',
      (setId: string, shotId: string) => ({
        setId,
        shotId,
        expectedRevision: 0,
        regenerationFeedback: 'try again',
      }),
    ],
    ['/shot-review/approve', (setId: string, _shotId: string) => ({ setId, expectedRevision: 0 })],
    ['/shot-review/request-regeneration', (setId: string, _shotId: string) => ({ setId })],
  ] as const)(
    'POST %s rejects a setId belonging to a different campaign in the same workspace',
    async (suffix, makeBody) => {
      const store = new InMemoryCampaignStore();
      const victim = await seedWorkspace(store);
      // A second campaign in the SAME workspace, with the same member.
      const otherCampaignId = randomUUID();
      store.seedCampaign({
        id: otherCampaignId,
        workspaceId: victim.workspaceId,
        currentStage: 'HUMAN_SHOT_SELECTION',
      });
      const { app, signal } = buildHarness(store);
      const before = snapshot(store);

      const response = await app.inject({
        method: 'POST',
        url: `/workspaces/${victim.workspaceId}/campaigns/${otherCampaignId}${suffix}`,
        headers: bearerFor(victim.userId),
        payload: makeBody(victim.setId, victim.shotId),
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().message).toContain('shot selection set');
      expect(snapshot(store)).toBe(before);
      expect(signal.calls).toHaveLength(0);
    },
  );

  it('performance ingestion rejects a variant id from another campaign', async () => {
    const store = new InMemoryCampaignStore();
    const victim = await seedWorkspace(store);
    const otherCampaignId = randomUUID();
    store.seedCampaign({
      id: otherCampaignId,
      workspaceId: victim.workspaceId,
      currentStage: 'DISTRIBUTED',
    });
    // A variant that belongs to the victim campaign, not the target one.
    const foreignVariantId = randomUUID();
    store.creativeVariantRecords.push({
      id: foreignVariantId,
      workspaceId: victim.workspaceId,
      campaignId: victim.campaignId,
      deliverySpecificationId: randomUUID(),
      durationSeconds: 15,
      status: 'READY',
      createdAt: new Date(),
    });
    const { app } = buildHarness(store);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${victim.workspaceId}/campaigns/${otherCampaignId}/performance/observations`,
      headers: bearerFor(victim.userId),
      payload: {
        source: 'FIXTURE',
        observations: [
          {
            platform: 'TIKTOK',
            externalPostId: 'probe',
            creativeVariantId: foreignVariantId,
            periodStart: '2026-07-18T00:00:00.000Z',
            periodEnd: '2026-07-25T00:00:00.000Z',
            raw: { impressions: 10, clicks: 1, conversions: 0, spendCents: 5 },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(store.performanceObservationRecords).toHaveLength(0);
  });
});

describe('M14 — adversarial: malformed input never reaches persistence', () => {
  it.each(MUTATING_ROUTES.map((r) => [r.path, r] as const))(
    'POST %s rejects a malformed body before any side effect',
    async (_label, route) => {
      const store = new InMemoryCampaignStore();
      const seeded = await seedWorkspace(store);
      const { app, signal, start } = buildHarness(store);
      const before = snapshot(store);

      const response = await app.inject({
        method: 'POST',
        url: urlFor(route.path, { ...seeded, learningId: randomUUID() }),
        headers: bearerFor(seeded.userId),
        payload: { garbage: true },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('INVALID_BODY');
      expect(snapshot(store)).toBe(before);
      expect(signal.calls).toHaveLength(0);
      expect(start.calls).toHaveLength(0);
    },
  );
});
