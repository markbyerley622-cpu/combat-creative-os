import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@combat/observability';
import {
  addMembership,
  createAssetWithProvenance,
  createCreativeConcept,
  createDraftShotSelectionSet,
  createLearningRecord,
  createQualityAssessmentForCandidate,
  createScriptWithShots,
  createShotSpecification,
  submitCampaignBrief,
  InMemoryCampaignStore,
  rejectShotSelection,
  setShotSelectionCandidate,
  type GenerationCandidateRecord,
  type PrismaClient,
} from '@combat/database';
import { ROLE_NAMES, ROLE_PERMISSIONS, roleHasPermission, type RoleName } from '@combat/domain';
import { MockReviewProvider, MockStorageProvider } from '@combat/providers';
import type { WorkflowClient } from '@temporalio/client';
import { buildServer } from './server';
import { MUTATING_ROUTES, type MutatingRouteAudit } from './route-authorization';
import {
  diffRouteSets,
  listRegisteredMutatingRoutes,
  parseRouteTree,
  routeKey,
} from './route-inventory';
import { bearerFor, permissiveTestAuthentication } from './test-helpers/authenticated-caller';

/**
 * Post-M14 audit finding C-3 — registry conformance made real, plus a
 * permission probe per audited endpoint.
 *
 * Two things are proven here that M14's suite did not prove:
 *
 * 1. **The conformance check actually detects drift.** `authorization-audit.
 *    test.ts` asserts the live router and `MUTATING_ROUTES` agree exactly;
 *    that assertion is only worth something if the comparison behind it fails
 *    when they disagree. Each way they can disagree is exercised below against
 *    synthetic inputs.
 * 2. **Every registry entry's permission is the one the route enforces.** M14
 *    asserted the registry *names* a canonical permission and that hostile
 *    callers are refused. It never checked that the named permission is the
 *    one actually required: an endpoint could demand a stricter permission
 *    than audited (locking out legitimate roles), or the registry could name a
 *    permission the route ignores. Each route is now driven twice — once by a
 *    caller holding the audited permission with valid resource ownership, once
 *    by the most-privileged role that lacks it.
 */

const silentLogger = createLogger({
  serviceName: 'api-registry-conformance-test',
  level: 'silent',
  pretty: false,
});

function fakePrisma(): PrismaClient {
  return { $queryRaw: async () => [{ '?column?': 1 }] } as unknown as PrismaClient;
}

function spy() {
  const calls: unknown[][] = [];
  const fn = async (...args: unknown[]) => {
    calls.push(args);
    return { workflowId: 'wf', firstExecutionRunId: 'run' };
  };
  return Object.assign(fn, { calls });
}

function buildHarness(store: InMemoryCampaignStore) {
  const signal = spy();
  const start = spy();
  const storageProvider = new MockStorageProvider();
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
    storageProvider,
    reviewProvider: new MockReviewProvider(),
    workflowClient: {
      start,
      getHandle: () => ({ signal, query: async () => undefined }),
    } as unknown as WorkflowClient,
  });
  return { app, signal, start, storageProvider };
}

// ---------------------------------------------------------------------------
// 1. The conformance comparison itself
// ---------------------------------------------------------------------------

describe('C-3 — the registry/router comparison detects every kind of drift', () => {
  const AUDITED = [
    { method: 'POST', path: '/workspaces/:workspaceId/campaigns' },
    { method: 'POST', path: '/workspaces/:workspaceId/campaigns/:campaignId/brief/submit' },
  ];

  it('reports nothing when the two sets match exactly', () => {
    expect(diffRouteSets(AUDITED, AUDITED)).toEqual({ unaudited: [], unregistered: [] });
  });

  it('fails when an audited route is not registered at all', () => {
    const registered = AUDITED.slice(0, 1);

    const diff = diffRouteSets(registered, AUDITED);

    expect(diff.unregistered).toEqual([
      'POST /workspaces/:workspaceId/campaigns/:campaignId/brief/submit',
    ]);
    expect(diff.unaudited).toEqual([]);
  });

  it('fails when a real mutating route is missing from the audit registry', () => {
    const registered = [
      ...AUDITED,
      { method: 'POST', path: '/workspaces/:workspaceId/campaigns/:campaignId/danger/unaudited' },
    ];

    const diff = diffRouteSets(registered, AUDITED);

    expect(diff.unaudited).toEqual([
      'POST /workspaces/:workspaceId/campaigns/:campaignId/danger/unaudited',
    ]);
    expect(diff.unregistered).toEqual([]);
  });

  it('fails when the method matches but the path does not', () => {
    const registered = [
      AUDITED[0]!,
      { method: 'POST', path: '/workspaces/:workspaceId/campaigns/:campaignId/brief/submitt' },
    ];

    const diff = diffRouteSets(registered, AUDITED);

    expect(diff.unaudited).toHaveLength(1);
    expect(diff.unregistered).toHaveLength(1);
  });

  it('fails when the path matches but the method does not', () => {
    const registered = AUDITED.map((route) => ({ ...route, method: 'PUT' }));

    const diff = diffRouteSets(registered, AUDITED);

    expect(diff.unaudited).toHaveLength(2);
    expect(diff.unregistered).toHaveLength(2);
  });
});

describe('C-3 — the router dump is parsed into full paths, not fragments', () => {
  const TREE = [
    '└── (empty root node)',
    '    ├── /health (GET, HEAD)',
    '    └── /workspaces/:workspaceId',
    '        ├── /campaigns (POST, GET, HEAD)',
    '        │   └── /:campaignId/brief/submit (POST)',
    '        └── /learnings/:learningId/review (POST)',
  ].join('\n');

  it('reassembles each route from its ancestors', () => {
    expect(parseRouteTree(TREE).map(routeKey)).toEqual([
      'GET /health',
      'HEAD /health',
      'POST /workspaces/:workspaceId/campaigns',
      'GET /workspaces/:workspaceId/campaigns',
      'HEAD /workspaces/:workspaceId/campaigns',
      'POST /workspaces/:workspaceId/campaigns/:campaignId/brief/submit',
      'POST /workspaces/:workspaceId/learnings/:learningId/review',
    ]);
  });

  it('keeps only mutating methods when filtering the live router', async () => {
    const { app } = buildHarness(new InMemoryCampaignStore());
    await app.ready();

    const methods = new Set(listRegisteredMutatingRoutes(app).map((route) => route.method));

    expect([...methods]).toEqual(['POST']);
  });

  it('never reports a bare wildcard as a route', async () => {
    const { app } = buildHarness(new InMemoryCampaignStore());
    await app.ready();

    expect(listRegisteredMutatingRoutes(app).map((r) => r.path)).not.toContain('*');
  });
});

// ---------------------------------------------------------------------------
// 2. Permission probes
// ---------------------------------------------------------------------------

/**
 * The role that lacks `permission` while holding as many other permissions as
 * the canonical matrix allows. The five roles are fixed by the approved
 * architecture, so this picks the strongest genuine counter-example rather
 * than inventing a synthetic role the system would never issue.
 */
function mostPrivilegedRoleWithout(permission: MutatingRouteAudit['permission']): RoleName {
  const candidates = ROLE_NAMES.filter((role) => !roleHasPermission(role, permission));
  return candidates.reduce((best, role) =>
    ROLE_PERMISSIONS[role].length > ROLE_PERMISSIONS[best].length ? role : best,
  );
}

/** The role that holds `permission` and the most other permissions — a realistic authorized caller. */
function roleWith(permission: MutatingRouteAudit['permission']): RoleName {
  const candidates = ROLE_NAMES.filter((role) => roleHasPermission(role, permission));
  return candidates.reduce((best, role) =>
    ROLE_PERMISSIONS[role].length < ROLE_PERMISSIONS[best].length ? role : best,
  );
}

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

/** The same content, typed as the repository's accepted-brief input. */
const BRIEF_INPUT = BRIEF_CONTENT as Parameters<typeof submitCampaignBrief>[2]['content'];

const UPLOAD_BODY = {
  originalFilename: 'a.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 10,
  licensing: { licenseType: 'ROYALTY_FREE' as const, rightsHolder: 'Combat Reviews' },
};

type SpecInput = Parameters<typeof createShotSpecification>[2];
function specInput(campaignId: string, shotId: string, index: number): SpecInput {
  return {
    campaignId,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotId,
    version: 1,
    shotNumber: index,
    sequencePosition: index,
    intendedDurationSeconds: 3,
    visualObjective: 'o',
    action: 'a',
    subject: 's',
    environment: 'e',
    cameraMovement: 'static',
    lensFraming: 'wide',
    lighting: 'soft',
    colorTreatment: 'neutral',
    motionIntensity: 'LOW',
    transitionIn: 'CUT',
    transitionOut: 'CUT',
    textSafeAreas: [],
    referenceAssetIds: [],
    continuityRequirements: [],
    providerId: 'mock-video-generation',
    promptVersionId: randomUUID(),
    generationPrompt: 'p',
    generationParams: { durationSeconds: 3, aspectRatio: '9:16', providerOptions: {} },
    outputRequirements: { durationSeconds: 3, aspectRatio: '9:16', minCandidateCount: 1 },
    qualityRubric: [],
    licensingConstraints: [],
    createdByAgentInvocationId: randomUUID(),
  };
}

interface ProbeContext {
  workspaceId: string;
  campaignId: string;
  userId: string;
  learningId: string;
  setId?: string;
  shotId?: string;
  candidateId?: string;
  revision?: number;
  uploadId?: string;
}

/**
 * Builds a workspace whose single member holds `role`, plus the resource state
 * the route under test legitimately requires: a script with shots, a QA-passed
 * candidate per shot, a draft selection set, and a reviewable learning record.
 * Campaign stage is chosen per route so the authorized probe reaches a real
 * success path rather than a state conflict.
 */
async function seedFor(
  store: InMemoryCampaignStore,
  route: MutatingRouteAudit,
  role: RoleName,
): Promise<ProbeContext> {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const userId = randomUUID();
  await addMembership(store, workspaceId, { userId, role });

  // `/brief/submit` and `/workflow/start` are only valid before the workflow
  // has moved the campaign on; everything else here is a shot-review or
  // post-production action.
  const stage =
    route.path.includes('/brief/') || route.path.includes('/workflow/start')
      ? 'DRAFT'
      : 'HUMAN_SHOT_SELECTION';
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: stage });

  // `/workflow/start` legitimately refuses a campaign with no accepted brief;
  // that is a resource prerequisite, not an authorization shortcut.
  await submitCampaignBrief(store, workspaceId, { campaignId, content: BRIEF_INPUT });

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
    totalDurationFrames: 90,
    shots: [
      {
        index: 0,
        description: 'Shot 0',
        durationFrames: 90,
        beat: 'HOOK',
        dependsOnShotIndices: [],
      },
    ],
  });

  const shot = shots[0]!;
  const spec = await createShotSpecification(store, workspaceId, specInput(campaignId, shot.id, 0));
  const { asset } = await createAssetWithProvenance(store, workspaceId, {
    campaignId,
    kind: 'VIDEO_CANDIDATE',
    s3Key: `candidates/${randomUUID()}`,
    checksum: randomUUID(),
    mimeType: 'video/mp4',
    originalFilename: 'c.mp4',
    sizeBytes: 1024,
    ingestionStatus: 'READY',
  });
  const candidate: GenerationCandidateRecord = {
    id: randomUUID(),
    workspaceId,
    shotSpecificationId: spec.id,
    shotGenerationAttemptId: randomUUID(),
    candidateIndex: 0,
    status: 'SUCCEEDED',
    assetId: asset.id,
    providerCandidateRef: 'ref',
    seed: 42,
    durationSeconds: 3,
    aspectRatio: '9:16',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  store.generationCandidateRecords.push(candidate);
  for (const subjectStage of ['VISUAL_QA', 'CONTINUITY_QA'] as const) {
    // eslint-disable-next-line no-await-in-loop -- ordered fixture setup
    await createQualityAssessmentForCandidate(store, {
      workspaceId,
      campaignId,
      candidate,
      candidateCampaignId: campaignId,
      latestCandidateId: candidate.id,
      subjectStage,
      pass: true,
      overallScore: 1,
      scores: {},
      assessedBy: 'AGENT',
      failures: [],
    });
  }

  const { set } = await createDraftShotSelectionSet(store, workspaceId, {
    campaignId,
    scriptId: script.id,
    scriptVersion: script.version,
    creativeConceptId: concept.id,
    creativeConceptVersion: concept.version,
    version: 1,
    createdByUserId: userId,
    requiredShots: [
      {
        shotId: shot.id,
        sequencePosition: 0,
        shotSpecificationId: spec.id,
        shotSpecificationVersion: 1,
      },
    ],
  });

  // `/shot-review/approve` needs every shot selected; `/request-regeneration`
  // needs at least one rejected. Both are legitimate resource prerequisites,
  // not authorization shortcuts.
  let revision = set.revision;
  if (route.path.endsWith('/shot-review/approve')) {
    const result = await setShotSelectionCandidate(store, workspaceId, {
      userId,
      setId: set.id,
      shotId: shot.id,
      candidateId: candidate.id,
      expectedRevision: revision,
    });
    if (result.ok) revision = result.set.revision;
  }
  if (route.path.endsWith('/shot-review/request-regeneration')) {
    const result = await rejectShotSelection(store, workspaceId, {
      userId,
      setId: set.id,
      shotId: shot.id,
      expectedRevision: revision,
      regenerationFeedback: 'try again',
    });
    if (result.ok) revision = result.set.revision;
  }

  const { record: learning } = await createLearningRecord(store, workspaceId, {
    learningKey: `probe-${randomUUID()}`,
    insight: 'i',
    scope: 'STRATEGY',
    applicability: { platforms: [], durationsSeconds: [], tags: [] },
    confidence: 'MEDIUM',
    evidence: [
      {
        performanceObservationId: randomUUID(),
        campaignId,
        platform: 'TIKTOK',
        impressions: 10_000,
      },
    ],
    totalImpressions: 10_000,
    sourceCampaignId: campaignId,
    createdByAgentInvocationId: randomUUID(),
    promptVersionId: randomUUID(),
  });

  return {
    workspaceId,
    campaignId,
    userId,
    learningId: learning.id,
    setId: set.id,
    shotId: shot.id,
    candidateId: candidate.id,
    revision,
  };
}

/** A well-formed body for `path`, using the seeded resource ids. */
function bodyFor(path: string, ctx: ProbeContext): Record<string, unknown> {
  const { setId, shotId, candidateId, revision } = ctx;
  if (path.endsWith('/approvals/concept')) return { decision: 'APPROVED' };
  if (path.endsWith('/approvals/final')) return { decision: 'APPROVED' };
  if (path.endsWith('/campaigns')) return { name: 'Probe campaign', idempotencyKey: randomUUID() };
  if (path.endsWith('/brief/draft')) return { content: {} };
  if (path.endsWith('/brief/submit')) return { content: BRIEF_CONTENT };
  if (path.endsWith('/workflow/start')) return {};
  if (path.endsWith('/assets/request-upload')) return { ...UPLOAD_BODY };
  if (path.endsWith('/assets/confirm-upload'))
    return {
      uploadId: ctx.uploadId ?? randomUUID(),
      ...UPLOAD_BODY,
      sizeBytes: Buffer.byteLength('probe-bytes'),
    };
  if (path.endsWith('/shot-review/draft')) return {};
  if (path.endsWith('/shot-review/select'))
    return { setId, shotId, candidateId, expectedRevision: revision };
  if (path.endsWith('/shot-review/reject-shot'))
    return { setId, shotId, expectedRevision: revision, regenerationFeedback: 'try again' };
  if (path.endsWith('/shot-review/comment')) return { body: 'a comment' };
  if (path.endsWith('/shot-review/approve')) return { setId, expectedRevision: revision };
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

function urlFor(path: string, ctx: ProbeContext): string {
  return path
    .replace(':workspaceId', ctx.workspaceId)
    .replace(':campaignId', ctx.campaignId)
    .replace(':learningId', ctx.learningId);
}

/** Everything a refused mutation must leave untouched. */
function snapshot(store: InMemoryCampaignStore): string {
  return JSON.stringify({
    campaigns: store.campaigns.map((c) => ({ id: c.id, stage: c.currentStage, v: c.version })),
    approvals: store.approvals.length,
    audits: store.audits.length,
    assets: store.assets.length,
    briefs: store.campaignBriefRecords.length,
    selectionSets: store.shotSelectionSetRecords.map((s) => ({
      id: s.id,
      status: s.status,
      revision: s.revision,
    })),
    selections: store.shotSelectionRecords.length,
    budgetLedger: store.budgetLedgerEntries.length,
    observations: store.performanceObservationRecords.length,
    learnings: store.learningRecordRecords.map((l) => l.status),
    variants: store.creativeVariantRecords.length,
    invocations: store.agentInvocations.length,
  });
}

describe('C-3 — a caller holding the audited permission is accepted', () => {
  it.each(MUTATING_ROUTES.map((r) => [r.path, r] as const))(
    'POST %s succeeds for a role with %s',
    async (_label, route) => {
      const store = new InMemoryCampaignStore();
      const role = roleWith(route.permission);
      const ctx = await seedFor(store, route, role);
      const { app, storageProvider } = buildHarness(store);

      // `/assets/confirm-upload` needs the uploadId its sibling route mints
      // and real bytes at the server-derived key — the same round trip a
      // browser performs, not a bypass of the route's own checks.
      if (route.path.endsWith('/assets/confirm-upload')) {
        const requested = await app.inject({
          method: 'POST',
          url: urlFor('/workspaces/:workspaceId/campaigns/:campaignId/assets/request-upload', ctx),
          headers: bearerFor(ctx.userId),
          payload: UPLOAD_BODY,
        });
        const { uploadId, uploadUrl } = requested.json();
        ctx.uploadId = uploadId as string;
        await storageProvider.putObject({
          s3Key: decodeURIComponent(new URL(uploadUrl as string).pathname.slice(1)),
          body: 'probe-bytes',
          contentType: UPLOAD_BODY.mimeType,
        });
      }

      const response = await app.inject({
        method: 'POST',
        url: urlFor(route.path, ctx),
        headers: bearerFor(ctx.userId),
        payload: bodyFor(route.path, ctx),
      });

      expect(
        response.statusCode,
        `${role} holds ${route.permission} but ${route.path} returned ${response.statusCode}: ${response.body}`,
      ).toBeLessThan(300);
      expect(response.statusCode).toBeGreaterThanOrEqual(200);
    },
  );
});

describe('C-3 — a caller lacking only the audited permission is refused', () => {
  it.each(MUTATING_ROUTES.map((r) => [r.path, r] as const))(
    'POST %s is 403 for the most-privileged role without the required permission',
    async (_label, route) => {
      const store = new InMemoryCampaignStore();
      const role = mostPrivilegedRoleWithout(route.permission);
      const ctx = await seedFor(store, route, role);
      const { app, signal, start } = buildHarness(store);
      const before = snapshot(store);

      const response = await app.inject({
        method: 'POST',
        url: urlFor(route.path, ctx),
        headers: bearerFor(ctx.userId),
        payload: bodyFor(route.path, ctx),
      });

      expect(
        response.statusCode,
        `${role} lacks ${route.permission}; ${route.path} must refuse it`,
      ).toBe(403);
      expect(response.json().error).toBe('FORBIDDEN');
      // Rejected requests leave no trace: no row written, no workflow signalled.
      expect(snapshot(store)).toBe(before);
      expect(signal.calls).toHaveLength(0);
      expect(start.calls).toHaveLength(0);
    },
  );

  it('every audited permission has both a holder and a non-holder among the canonical roles', () => {
    // Otherwise one of the two probes above would be vacuous.
    for (const route of MUTATING_ROUTES) {
      const holders = ROLE_NAMES.filter((r) => roleHasPermission(r, route.permission));
      const nonHolders = ROLE_NAMES.filter((r) => !roleHasPermission(r, route.permission));

      expect(holders.length, `${route.path}: no role holds ${route.permission}`).toBeGreaterThan(0);
      expect(
        nonHolders.length,
        `${route.path}: every role holds ${route.permission}`,
      ).toBeGreaterThan(0);
    }
  });
});
