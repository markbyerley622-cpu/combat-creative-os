import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMembership, InMemoryCampaignStore, type PrismaClient } from '@combat/database';
import { createLogger } from '@combat/observability';
import { MockReviewProvider, MockStorageProvider } from '@combat/providers';
import type { WorkflowClient } from '@temporalio/client';
import { createFakeProfileDirectory, createFakeTokenVerifier } from '@combat/auth/testing';
import { buildServer } from './server';
import { PUBLIC_ROUTES } from './authentication';
import { MUTATING_ROUTES } from './route-authorization';

/**
 * AAMP-1 step 2 — the authentication boundary itself.
 *
 * The route suites prove *authorization* with an already-authenticated caller.
 * This file proves the step before it: that a caller must present a verified
 * session token at all, that the verified subject maps to the right local
 * `User`, that first sign-in provisions exactly once, and that nothing about
 * caller identity can be influenced by the request body, query or an unverified
 * header.
 *
 * Every token here is verified by a deterministic in-process fake. No Clerk
 * account, credential, key or network call is involved, in this file or
 * anywhere else in the suite.
 */

const silentLogger = createLogger({ serviceName: 'api-test', level: 'silent', pretty: false });

const SUBJECT = 'user_2verifiedSubject';
const TOKEN = 'header.payload.signature';
const EMAIL = 'member@example.test';

function fakePrisma(): PrismaClient {
  return { $queryRaw: async () => [{ '?column?': 1 }] } as unknown as PrismaClient;
}

function fakeWorkflowClient(): WorkflowClient {
  return {
    start: async () => ({ workflowId: 'wf', firstExecutionRunId: 'run' }),
    getHandle: () => ({ signal: async () => undefined, query: async () => undefined }),
  } as unknown as WorkflowClient;
}

/**
 * A server whose verifier accepts exactly one token. Everything else — no
 * header, a different scheme, a truncated JWT, a tampered signature, an expired
 * token — is rejected by the same code path a real `verifyToken` rejection
 * takes.
 */
function buildHarness(store: InMemoryCampaignStore) {
  const app = buildServer({
    logger: silentLogger,
    prisma: fakePrisma(),
    tokenVerifier: createFakeTokenVerifier({
      tokens: new Map([[TOKEN, { clerkUserId: SUBJECT, sessionId: 'sess_1' }]]),
    }),
    profileDirectory: createFakeProfileDirectory(
      new Map([[SUBJECT, { email: EMAIL, displayName: 'Verified Member' }]]),
    ),
    userDb: store,
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
    workflowClient: fakeWorkflowClient(),
  });
  return app;
}

const bearer = { authorization: `Bearer ${TOKEN}` };

// ---------------------------------------------------------------------------
// 1. No credential, bad credential — 401, uniformly
// ---------------------------------------------------------------------------

describe('an unauthenticated request is refused', () => {
  it('401s a mutation with no Authorization header, before any database work', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns`,
      payload: { name: 'Probe' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'UNAUTHENTICATED',
      message: 'a verified session token is required',
    });
    expect(store.campaigns).toHaveLength(0);
    // Nothing was provisioned either — an anonymous request creates no user.
    expect(store.users).toHaveLength(0);
  });

  it('401s a read route with no Authorization header', async () => {
    const store = new InMemoryCampaignStore();
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${randomUUID()}/campaigns`,
    });

    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['a malformed token', 'Bearer not-a-jwt'],
    ['a truncated JWT', 'Bearer header.payload'],
    ['a tampered signature', `Bearer ${TOKEN}x`],
    ['an expired token (the verifier rejects it)', 'Bearer expired.token.value'],
    ['the wrong scheme', `Basic ${TOKEN}`],
    ['a bare token with no scheme', TOKEN],
    ['an empty bearer', 'Bearer '],
  ])('401s %s', async (_label, authorization) => {
    const store = new InMemoryCampaignStore();
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${randomUUID()}/campaigns`,
      headers: { authorization },
      payload: { name: 'Probe' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('UNAUTHENTICATED');
    expect(store.campaigns).toHaveLength(0);
  });

  it('gives an unknown-token and a not-a-member caller distinguishable but non-probing answers', async () => {
    const store = new InMemoryCampaignStore();
    const app = buildHarness(store);

    const badToken = await app.inject({
      method: 'GET',
      url: `/workspaces/${randomUUID()}/campaigns`,
      headers: { authorization: 'Bearer someone.elses.token' },
    });
    const goodTokenNoMembership = await app.inject({
      method: 'GET',
      url: `/workspaces/${randomUUID()}/campaigns`,
      headers: bearer,
    });

    // 401 = "I don't know who you are"; 403 = "I know who you are, and no".
    // Neither reveals whether the workspace exists.
    expect(badToken.statusCode).toBe(401);
    expect(goodTokenNoMembership.statusCode).toBe(403);
  });
});

describe('public routes stay reachable without a token', () => {
  it('exposes exactly /health and /ready, and nothing else', () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual(['/health', '/ready']);
  });

  it.each(PUBLIC_ROUTES)('%s answers 200 unauthenticated', async (path) => {
    const app = buildHarness(new InMemoryCampaignStore());

    const response = await app.inject({ method: 'GET', url: path });

    expect(response.statusCode).toBe(200);
  });

  it('a public probe discloses no workspace, user or campaign data', async () => {
    const app = buildHarness(new InMemoryCampaignStore());

    const body = (await app.inject({ method: 'GET', url: '/ready' })).body;

    expect(body).not.toMatch(/workspace|campaign|user|email/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Verified subject -> local user
// ---------------------------------------------------------------------------

describe('a verified subject resolves to its local user', () => {
  it('acts as the User its Membership row points at, not a freshly minted one', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const seeded = store.seedUser({ clerkUserId: SUBJECT, email: EMAIL });
    await addMembership(store, workspaceId, { userId: seeded.id, role: 'OWNER_ADMIN' });
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns`,
      headers: bearer,
      payload: { name: 'Q3 Launch' },
    });

    expect(response.statusCode).toBe(201);
    expect(store.users).toHaveLength(1);
    expect(store.users[0]!.id).toBe(seeded.id);
  });

  it('reports the resolved principal and only its own workspaces from GET /me', async () => {
    const store = new InMemoryCampaignStore();
    const mine = randomUUID();
    const foreign = randomUUID();
    const seeded = store.seedUser({ clerkUserId: SUBJECT, email: EMAIL });
    await addMembership(store, mine, { userId: seeded.id, role: 'REVIEWER' });
    await addMembership(store, foreign, { userId: randomUUID(), role: 'OWNER_ADMIN' });
    const app = buildHarness(store);

    const response = await app.inject({ method: 'GET', url: '/me', headers: bearer });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: seeded.id,
      email: EMAIL,
      workspaces: [{ workspaceId: mine, role: 'REVIEWER' }],
    });
  });

  it('401s GET /me without a token', async () => {
    const app = buildHarness(new InMemoryCampaignStore());

    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
  });

  it('links a member invited before they ever signed in, preserving their role', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    // Invited: a local user with the right email and a role, but no subject yet.
    const invited = store.seedUser({ email: EMAIL, clerkUserId: null });
    await addMembership(store, workspaceId, { userId: invited.id, role: 'OWNER_ADMIN' });
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns`,
      headers: bearer,
      payload: { name: 'First sign-in' },
    });

    expect(response.statusCode).toBe(201);
    expect(store.users).toHaveLength(1);
    expect(store.users[0]!.clerkUserId).toBe(SUBJECT);
  });
});

describe('first-login provisioning is idempotent', () => {
  it('creates exactly one user across many requests', async () => {
    const store = new InMemoryCampaignStore();
    const app = buildHarness(store);

    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design: this asserts repeat sign-ins converge
      await app.inject({ method: 'GET', url: '/me', headers: bearer });
    }

    expect(store.users).toHaveLength(1);
    expect(store.users[0]!.clerkUserId).toBe(SUBJECT);
  });

  it('creates exactly one user when concurrent first requests race', async () => {
    const store = new InMemoryCampaignStore();
    const app = buildHarness(store);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => app.inject({ method: 'GET', url: '/me', headers: bearer })),
    );

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.json().userId)).size).toBe(1);
    expect(store.users).toHaveLength(1);
  });

  it('refuses a subject whose email already belongs to a different subject', async () => {
    const store = new InMemoryCampaignStore();
    store.seedUser({ email: EMAIL, clerkUserId: 'user_somebodyElse' });
    const app = buildHarness(store);

    const response = await app.inject({ method: 'GET', url: '/me', headers: bearer });

    // 401, not 500 and not a silent takeover of the other person's row.
    expect(response.statusCode).toBe(401);
    expect(store.users).toHaveLength(1);
    expect(store.users[0]!.clerkUserId).toBe('user_somebodyElse');
  });
});

// ---------------------------------------------------------------------------
// 3. Identity cannot be claimed
// ---------------------------------------------------------------------------

describe('caller identity cannot be supplied by the client', () => {
  it('a body userId cannot impersonate another user — it is rejected outright', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const attacker = store.seedUser({ clerkUserId: SUBJECT, email: EMAIL });
    // The victim is a fully-privileged member; the attacker is a REVIEWER,
    // which does not hold MANAGE_CAMPAIGNS.
    const victim = store.seedUser({ email: 'victim@example.test' });
    await addMembership(store, workspaceId, { userId: attacker.id, role: 'REVIEWER' });
    await addMembership(store, workspaceId, { userId: victim.id, role: 'OWNER_ADMIN' });
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns`,
      headers: bearer,
      payload: { name: 'Impersonation attempt', userId: victim.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('INVALID_BODY');
    expect(store.campaigns).toHaveLength(0);
  });

  it('a query userId is inert — authorization uses the token’s user', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const attacker = store.seedUser({ clerkUserId: SUBJECT, email: EMAIL });
    const victim = store.seedUser({ email: 'victim@example.test' });
    // The attacker is not a member at all; the victim is.
    await addMembership(store, workspaceId, { userId: victim.id, role: 'OWNER_ADMIN' });
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns?userId=${victim.id}`,
      headers: bearer,
    });

    expect(response.statusCode).toBe(403);
    expect(attacker.id).not.toBe(victim.id);
  });

  it('an unverified identity header is ignored', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const victim = store.seedUser({ email: 'victim@example.test' });
    await addMembership(store, workspaceId, { userId: victim.id, role: 'OWNER_ADMIN' });
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns`,
      headers: { 'x-user-id': victim.id, 'x-workspace-id': workspaceId },
    });

    // No bearer token: an invented header proves nothing.
    expect(response.statusCode).toBe(401);
  });

  it('the decision recorded at a gate is attributed to the verified caller', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const caller = store.seedUser({ clerkUserId: SUBJECT, email: EMAIL });
    const other = store.seedUser({ email: 'other@example.test' });
    await addMembership(store, workspaceId, { userId: caller.id, role: 'OWNER_ADMIN' });
    await addMembership(store, workspaceId, { userId: other.id, role: 'OWNER_ADMIN' });
    const campaign = store.seedCampaign({ workspaceId, currentStage: 'CONCEPT_REVIEW' });
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns/${campaign.id}/approvals/concept`,
      headers: bearer,
      payload: { decision: 'APPROVED' },
    });

    expect(response.statusCode).toBe(202);
    expect(store.approvals).toHaveLength(1);
    expect(store.approvals[0]!.decidedByUserId).toBe(caller.id);
    expect(store.approvals[0]!.decidedByUserId).not.toBe(other.id);
  });
});

// ---------------------------------------------------------------------------
// 4. Authorization still comes from PostgreSQL, and tenancy still 404s
// ---------------------------------------------------------------------------

describe('authorization remains PostgreSQL-authoritative', () => {
  it('a verified caller with no Membership row is refused', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    store.seedUser({ clerkUserId: SUBJECT, email: EMAIL });
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/campaigns`,
      headers: bearer,
      payload: { name: 'No membership' },
    });

    expect(response.statusCode).toBe(403);
    expect(store.campaigns).toHaveLength(0);
  });

  it('changing only the persisted role changes the outcome, with the same token', async () => {
    const workspaceId = randomUUID();

    const attempt = async (role: 'ANALYST' | 'OWNER_ADMIN') => {
      const store = new InMemoryCampaignStore();
      const user = store.seedUser({ clerkUserId: SUBJECT, email: EMAIL });
      await addMembership(store, workspaceId, { userId: user.id, role });
      return buildHarness(store).inject({
        method: 'POST',
        url: `/workspaces/${workspaceId}/campaigns`,
        headers: bearer,
        payload: { name: 'Role probe' },
      });
    };

    // The token is byte-identical in both runs; only the Membership row differs.
    expect((await attempt('ANALYST')).statusCode).toBe(403);
    expect((await attempt('OWNER_ADMIN')).statusCode).toBe(201);
  });

  it('a campaign in another workspace is still 404, never 403', async () => {
    const store = new InMemoryCampaignStore();
    const mine = randomUUID();
    const theirs = randomUUID();
    const user = store.seedUser({ clerkUserId: SUBJECT, email: EMAIL });
    await addMembership(store, mine, { userId: user.id, role: 'OWNER_ADMIN' });
    const foreignCampaign = store.seedCampaign({
      workspaceId: theirs,
      currentStage: 'CONCEPT_REVIEW',
    });
    const app = buildHarness(store);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${mine}/campaigns/${foreignCampaign.id}/approvals/concept`,
      headers: bearer,
      payload: { decision: 'APPROVED' },
    });

    expect(response.statusCode).toBe(404);
    expect(store.approvals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Source-level guarantees
// ---------------------------------------------------------------------------

const API_SRC = __dirname;
const ROUTE_FILES = readdirSync(API_SRC).filter(
  (name) => name.endsWith('-routes.ts') && !name.endsWith('.test.ts'),
);

describe('no route reads caller identity from request input', () => {
  it('covers every route file (so this check cannot silently apply to none)', () => {
    expect(ROUTE_FILES.length).toBeGreaterThanOrEqual(10);
    // Every mutating route in the registry lives in one of these files.
    expect(MUTATING_ROUTES.length).toBeGreaterThan(0);
  });

  it.each(ROUTE_FILES)('%s never reads a userId out of the body or query', (file) => {
    const source = readFileSync(join(API_SRC, file), 'utf8');

    // The three shapes the pre-AAMP-1 code used to take an identity from the
    // request. `request.principal` is the only permitted source.
    expect(source).not.toMatch(/\.data\.userId\b/);
    expect(source).not.toMatch(/request\.(body|query)[^\n]*userId/);
    expect(source).not.toMatch(/userId: z\.string\(\)/);
  });

  it.each(ROUTE_FILES)('%s takes its caller from the verified principal', (file) => {
    const source = readFileSync(join(API_SRC, file), 'utf8');
    // Not every read route resolves a caller (none currently), but any file that
    // authorizes must do so through the hook's principal.
    if (/authorize|listMembershipsForWorkspace/.test(source)) {
      expect(source).toMatch(/requirePrincipal\(request\)/);
    }
  });
});

describe('Clerk Organizations are not used', () => {
  const AUTH_SRC = join(API_SRC, '..', '..', '..', 'packages', 'auth', 'src');
  const AUTH_FILES = readdirSync(AUTH_SRC).filter((name) => name.endsWith('.ts'));

  it.each(AUTH_FILES)('packages/auth/src/%s references no organization concept', (file) => {
    const source = readFileSync(join(AUTH_SRC, file), 'utf8');

    // Tenancy is `Workspace` + `Membership` in PostgreSQL. An `org_id`/`org_role`
    // claim reaching authorization would be a second, unaudited tenancy system.
    expect(source).not.toMatch(/\borg_id\b|\borg_role\b|\borg_slug\b|\borgId\b/);
    expect(source).not.toMatch(/createOrganization|organizationList|\.organizations\b/);
  });

  it.each(ROUTE_FILES)('%s references no organization concept', (file) => {
    const source = readFileSync(join(API_SRC, file), 'utf8');
    expect(source).not.toMatch(/\borg_id\b|\borg_role\b|\borgId\b|organization/i);
  });

  it('the verified principal exposes no organisation or workspace field', async () => {
    const store = new InMemoryCampaignStore();
    const user = store.seedUser({ clerkUserId: SUBJECT, email: EMAIL });
    const workspaceId = randomUUID();
    await addMembership(store, workspaceId, { userId: user.id, role: 'REVIEWER' });
    const app = buildHarness(store);

    const me = (await app.inject({ method: 'GET', url: '/me', headers: bearer })).json();

    // `workspaces` here is read from Membership rows, not from a token claim.
    expect(Object.keys(me).sort()).toEqual(['email', 'userId', 'workspaces']);
  });
});

describe('the Clerk secret key cannot leak', () => {
  const REPO_ROOT = join(API_SRC, '..', '..', '..');

  it('apps/dashboard has no code path that reads CLERK_SECRET_KEY', () => {
    const dashboardSrc = join(REPO_ROOT, 'apps', 'dashboard', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        // Test files are excluded because the dashboard's own
        // `auth-mode.test.ts` asserts this same property and therefore has to
        // name the identifier. Only shippable source can leak into a bundle.
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (readFileSync(full, 'utf8').includes('CLERK_SECRET_KEY')) offenders.push(full);
        }
      }
    };
    walk(dashboardSrc);

    expect(offenders).toEqual([]);
  });

  it('only the composition root reads the secret key in apps/api', () => {
    const readers = readdirSync(API_SRC).filter(
      (name) =>
        name.endsWith('.ts') &&
        !name.endsWith('.test.ts') &&
        readFileSync(join(API_SRC, name), 'utf8').includes('CLERK_SECRET_KEY'),
    );

    expect(readers).toEqual(['index.ts']);
  });

  it('never returns the token or any credential in a response body', async () => {
    const store = new InMemoryCampaignStore();
    const user = store.seedUser({ clerkUserId: SUBJECT, email: EMAIL });
    await addMembership(store, randomUUID(), { userId: user.id, role: 'REVIEWER' });
    const app = buildHarness(store);

    for (const url of ['/me', '/health', '/ready']) {
      // eslint-disable-next-line no-await-in-loop -- three fixed probes, order irrelevant
      const body = (await app.inject({ method: 'GET', url, headers: bearer })).body;
      expect(body).not.toContain(TOKEN);
      expect(body).not.toMatch(/sk_(test|live)_/);
      expect(body.toLowerCase()).not.toContain('authorization');
    }
  });

  it('a 401 body reveals nothing about why the token failed', async () => {
    const app = buildHarness(new InMemoryCampaignStore());

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer tampered.token.here' },
    });

    expect(response.json()).toEqual({
      error: 'UNAUTHENTICATED',
      message: 'a verified session token is required',
    });
    expect(response.body).not.toContain('tampered');
  });
});
