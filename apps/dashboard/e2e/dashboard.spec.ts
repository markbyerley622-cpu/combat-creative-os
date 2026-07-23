import { test, expect } from '@playwright/test';

test('homepage renders the foundation placeholder', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Combat Creative OS' })).toBeVisible();
  await expect(page.getByText('apps/api')).toBeVisible();
});

test('frontend liveness endpoint responds', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.status).toBe('ok');
});
