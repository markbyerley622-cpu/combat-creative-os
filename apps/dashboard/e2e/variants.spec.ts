import { test, expect } from '@playwright/test';

/**
 * M12 — the delivery-variant comparison screen, against the campaign
 * apps/api/src/dev-fake-server.ts seeds at VARIANT_QA with all three
 * VERTICAL_SHORT_FORM_V1 cuts (15s and 6s passing QA, 10s failing).
 *
 * Covers the two things only a real browser run can: that the three cuts are
 * comparable side by side, and that a variant with no rendered bytes shows an
 * explicit placeholder rather than a broken player. The RBAC counterpart is a
 * direct API request that bypasses the UI entirely.
 */
const FIXTURES = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  ownerUserId: '22222222-2222-2222-2222-222222222222',
  reviewerUserId: '33333333-3333-3333-3333-333333333333',
  variantCampaignId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};
const API_BASE_URL = 'http://127.0.0.1:4100';

async function signIn(page: import('@playwright/test').Page, userId: string) {
  await page.goto('/');
  await page.getByLabel('Workspace ID').fill(FIXTURES.workspaceId);
  await page.getByLabel('User ID (membership)').fill(userId);
  await page.getByRole('button', { name: 'Continue' }).click();
}

test.describe('Delivery variants screen', () => {
  test('compares the 15s, 10s and 6s cuts with their QA verdicts', async ({ page }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto(`/campaigns/${FIXTURES.variantCampaignId}/variants`);

    await expect(
      page.getByRole('heading', { name: 'Delivery variants', exact: true }),
    ).toBeVisible();

    // All three durations are rendered as comparable columns.
    for (const duration of ['15s', '10s', '6s']) {
      await expect(page.getByRole('heading', { name: new RegExp(`^${duration}`) })).toBeVisible();
    }

    // Each cut exposes its own cut map for side-by-side comparison.
    await expect(page.getByLabel('Cut map for the 15s variant')).toBeVisible();
    await expect(page.getByLabel('Cut map for the 10s variant')).toBeVisible();
    await expect(page.getByLabel('Cut map for the 6s variant')).toBeVisible();

    // The failing 10s variant surfaces its QA finding; the passing ones do not.
    await expect(page.getByText('Variant runs 1.4s over the 10s slot.')).toBeVisible();
    await expect(page.getByText('Variant QA: passed (1.00)').first()).toBeVisible();
    await expect(page.getByText('Variant QA: failed (0.25)')).toBeVisible();

    // Cut rationale and what was removed are reviewable.
    await expect(page.getByText('Kept the hook and the CTA for the 15s cut.')).toBeVisible();
  });

  test('shows an explicit preview placeholder rather than a player (no rendered bytes)', async ({
    page,
  }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto(`/campaigns/${FIXTURES.variantCampaignId}/variants`);

    const placeholders = page.getByText(/Preview placeholder — no rendered video/);
    await expect(placeholders.first()).toBeVisible();
    await expect(placeholders).toHaveCount(3);
    // No media element is ever mounted for a byte-less variant.
    await expect(page.locator('video')).toHaveCount(0);
  });

  test('exposes no export or download control (out of M12 scope)', async ({ page }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto(`/campaigns/${FIXTURES.variantCampaignId}/variants`);

    await expect(
      page.getByRole('heading', { name: 'Delivery variants', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /export/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /download/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /publish/i })).toHaveCount(0);
  });

  test('a REVIEWER sees the comparison but cannot cancel', async ({ page }) => {
    await signIn(page, FIXTURES.reviewerUserId);
    await page.goto(`/campaigns/${FIXTURES.variantCampaignId}/variants`);

    await expect(
      page.getByRole('heading', { name: 'Delivery variants', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/cannot cancel an active variant run/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel active variant run' })).toBeDisabled();
  });
});

test.describe('Forged request bypassing the dashboard UI', () => {
  test('a REVIEWER (lacking TRIGGER_GENERATION) is refused a variant cancel server-side', async ({
    request,
  }) => {
    const response = await request.post(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/campaigns/${FIXTURES.variantCampaignId}/variants/cancel`,
      { data: { userId: FIXTURES.reviewerUserId } },
    );

    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'FORBIDDEN' });
  });

  test('a non-member cannot read the variant list', async ({ request }) => {
    const response = await request.get(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/campaigns/${FIXTURES.variantCampaignId}/variants?userId=99999999-9999-9999-9999-999999999999`,
    );

    expect(response.status()).toBe(403);
  });
});
