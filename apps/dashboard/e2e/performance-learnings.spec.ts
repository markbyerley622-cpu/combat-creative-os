import { test, expect } from '@playwright/test';
import { bearer, signIn } from './auth';

/**
 * M13 — the performance and learning screens, against the DISTRIBUTED campaign
 * apps/api/src/dev-fake-server.ts seeds with two closed-window observations and
 * two learnings (one APPROVED at MEDIUM confidence, one PROPOSED at LOW).
 *
 * Covers what only a browser run can: that performance history renders with
 * derived rates, that a learning shows its evidence and applicability, and that
 * the injection floor is visible to a reviewer. The RBAC counterparts are
 * direct API requests that bypass the UI entirely.
 */
const FIXTURES = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  ownerUserId: '22222222-2222-2222-2222-222222222222',
  reviewerUserId: '33333333-3333-3333-3333-333333333333',
  performanceCampaignId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  /** A verified user with no Membership row — authenticates, then is refused. */
  strangerUserId: '99999999-9999-9999-9999-999999999999',
};
const API_BASE_URL = 'http://127.0.0.1:4100';

test.describe('Campaign performance screen', () => {
  test('shows closed-window observations with derived rates and their source', async ({ page }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto(`/campaigns/${FIXTURES.performanceCampaignId}/performance`);

    await expect(page.getByRole('heading', { name: 'Campaign performance' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Observations \(2\)/ })).toBeVisible();

    // Derived rates, not raw counters.
    await expect(page.getByText('5.00%').first()).toBeVisible();
    await expect(page.getByText('3.00%').first()).toBeVisible();
    // Provenance of the data is visible.
    await expect(page.getByText('FIXTURE').first()).toBeVisible();
  });

  test('states plainly that no advertising platform is connected', async ({ page }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto(`/campaigns/${FIXTURES.performanceCampaignId}/performance`);

    await expect(page.getByText(/No advertising platform is connected/)).toBeVisible();
  });

  test('a REVIEWER can read history but cannot record data', async ({ page }) => {
    await signIn(page, FIXTURES.reviewerUserId);
    await page.goto(`/campaigns/${FIXTURES.performanceCampaignId}/performance`);

    await expect(page.getByRole('heading', { name: /Observations \(2\)/ })).toBeVisible();
    await expect(page.getByText(/cannot record performance data/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load demo fixture' })).toBeDisabled();
  });
});

test.describe('Creative learnings screen', () => {
  test('shows each learning with its evidence, applicability and confidence', async ({ page }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto('/learnings');

    await expect(page.getByRole('heading', { name: 'Creative learnings' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /fifteen-second-cut-outperforms-ten/ }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: /warm-lighting-may-help/ })).toBeVisible();

    // Evidence weight is surfaced, not just the claim.
    await expect(
      page.getByText(/Evidence \(2 observation\(s\), 60,000 impressions\)/),
    ).toBeVisible();
    // Applicability is explicit.
    await expect(page.getByText(/INSTAGRAM_REELS · 15s, 10s/)).toBeVisible();
  });

  test('makes the injection floor visible: a LOW-confidence learning is never offered', async ({
    page,
  }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto('/learnings');

    await expect(
      page.getByText('Offered as advisory context to the Strategist / Creative Director'),
    ).toBeVisible();
    await expect(
      page.getByText('Not offered to any agent — evidence is too thin for injection.'),
    ).toBeVisible();
  });

  test('a REVIEWER cannot approve or reject a learning', async ({ page }) => {
    await signIn(page, FIXTURES.reviewerUserId);
    await page.goto('/learnings');

    await expect(page.getByRole('heading', { name: 'Creative learnings' })).toBeVisible();
    await expect(page.getByText(/cannot approve or reject a learning/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});

test.describe('Forged request bypassing the dashboard UI', () => {
  test('a REVIEWER is refused performance ingestion server-side', async ({ request }) => {
    const response = await request.post(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/campaigns/${FIXTURES.performanceCampaignId}/performance/observations`,
      {
        headers: bearer(FIXTURES.reviewerUserId),
        data: {
          source: 'FIXTURE',
          observations: [
            {
              platform: 'TIKTOK',
              externalPostId: 'forged',
              periodStart: '2026-07-18T00:00:00.000Z',
              periodEnd: '2026-07-25T00:00:00.000Z',
              raw: { impressions: 10, clicks: 1, conversions: 0, spendCents: 5 },
            },
          ],
        },
      },
    );

    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'FORBIDDEN' });
  });

  test('a REVIEWER is refused a learning approval server-side', async ({ request }) => {
    const list = await request.get(`${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/learnings`, {
      headers: bearer(FIXTURES.reviewerUserId),
    });
    const proposed = (await list.json()).learnings.find(
      (l: { status: string }) => l.status === 'PROPOSED',
    );
    expect(proposed).toBeDefined();

    const response = await request.post(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/learnings/${proposed.id}/review`,
      { headers: bearer(FIXTURES.reviewerUserId), data: { decision: 'APPROVED' } },
    );

    expect(response.status()).toBe(403);
  });

  test('a verified non-member cannot read learnings at all', async ({ request }) => {
    const response = await request.get(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/learnings`,
      { headers: bearer(FIXTURES.strangerUserId) },
    );

    // 403, not 401: this caller is who they say they are, and still has no
    // membership. Authorization is read from PostgreSQL, not from the token.
    expect(response.status()).toBe(403);
  });

  test('an unauthenticated request is refused before authorization is even considered', async ({
    request,
  }) => {
    const response = await request.get(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/learnings`,
    );

    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHENTICATED' });
  });

  test('there is no endpoint to connect an advertising platform', async ({ request }) => {
    for (const path of ['connect', 'oauth', 'sync']) {
      const response = await request.post(
        `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/campaigns/${FIXTURES.performanceCampaignId}/performance/${path}`,
        { headers: bearer(FIXTURES.ownerUserId), data: {} },
      );
      expect(response.status()).toBe(404);
    }
  });
});
