import { test, expect } from '@playwright/test';
import { signIn, signOut } from './auth';

const FIXTURES = {
  ownerUserId: '22222222-2222-2222-2222-222222222222',
};

/**
 * AAMP-1 step 2 replaced the development identity gate this file used to
 * assert. There is no longer a form asking for a workspace and user id — the
 * browser presents a session token, and the workspace comes from the caller's
 * `Membership` rows.
 */
test('a signed-in operator lands on their workspace campaigns', async ({ page }) => {
  await signIn(page, FIXTURES.ownerUserId);

  await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible();
  // The picker is gone: no screen asks anyone to type an identity again.
  await expect(page.getByLabel('Workspace ID')).toHaveCount(0);
  await expect(page.getByLabel('User ID (membership)')).toHaveCount(0);
});

test('a signed-out visitor is never shown workspace data', async ({ page }) => {
  await signOut(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Campaigns' })).toHaveCount(0);
});

test('frontend liveness endpoint responds without credentials', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.status).toBe('ok');
});
