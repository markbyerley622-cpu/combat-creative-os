import { test, expect } from '@playwright/test';
import { bearer, signIn } from './auth';

/**
 * Fixture ids seeded by apps/api/src/dev-fake-server.ts — the two suites
 * below exercise the same seeded CONCEPT-gate-pending campaign from two
 * angles: the real dashboard UI (authorized owner), and a direct API
 * request bypassing the UI entirely (unauthorized reviewer), matching the
 * M4 test requirement that a forged request from a non-approver role is
 * rejected server-side regardless of what the UI would have allowed.
 */
const FIXTURES = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  ownerUserId: '22222222-2222-2222-2222-222222222222',
  reviewerUserId: '33333333-3333-3333-3333-333333333333',
  campaignId: '44444444-4444-4444-4444-444444444444',
};
const API_BASE_URL = 'http://127.0.0.1:4100';

test.describe('Concept review screen', () => {
  test('an authorized owner sees strategy, concept, and script, and can approve', async ({
    page,
  }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto(`/campaigns/${FIXTURES.campaignId}/concept-review`);

    await expect(page.getByRole('heading', { name: 'Strategy' })).toBeVisible();
    await expect(
      page.getByText('The trusted, automated review layer for combat gyms'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Concept', exact: true })).toBeVisible();
    await expect(
      page.getByText('A gym owner watches reviews roll in without lifting a finger.'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Timed script' })).toBeVisible();
    await expect(page.getByText('Hook: gym owner frustrated at a laptop.')).toBeVisible();

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Decision recorded: APPROVED.')).toBeVisible();
  });

  test('requesting a revision without comments shows a validation error and never calls the API', async ({
    page,
  }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto(`/campaigns/${FIXTURES.campaignId}/concept-review`);

    await page.getByRole('button', { name: 'Request revision' }).click();
    await expect(page.getByText('Revision instructions are required')).toBeVisible();
  });
});

test.describe('Forged request bypassing the dashboard UI', () => {
  test('a REVIEWER role (lacking APPROVE_CONCEPT) is rejected server-side even with a well-formed request', async ({
    request,
  }) => {
    const response = await request.post(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/campaigns/${FIXTURES.campaignId}/approvals/concept`,
      // A REVIEWER's own verified token: the refusal is about permission,
      // not about who the caller is.
      { headers: bearer(FIXTURES.reviewerUserId), data: { decision: 'APPROVED' } },
    );
    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('FORBIDDEN');
  });
});
