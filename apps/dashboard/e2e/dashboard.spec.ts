import { test, expect } from '@playwright/test';

test('homepage renders the development-identity gate for a first-time visitor', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Combat Creative OS' })).toBeVisible();
  await expect(page.getByLabel('Workspace ID')).toBeVisible();
  await expect(page.getByLabel('User ID (membership)')).toBeVisible();
});

test('frontend liveness endpoint responds', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.status).toBe('ok');
});
