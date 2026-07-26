import type { APIRequestContext, Page } from '@playwright/test';

/**
 * AAMP-1 step 2 — how the browser suite authenticates.
 *
 * The development identity picker is gone, so a spec can no longer "sign in" by
 * typing a user id into a form. It signs in the way production does: the
 * browser holds a **bearer token**, and `apps/api` decides who that token is.
 * The only difference from production is which verifier the server uses — the
 * deterministic fake in `@combat/auth/testing`, wired by `dev-fake-server.ts`,
 * so the suite needs no Clerk account, credential or network access.
 *
 * `bearer()` is used for the direct API probes, which exist precisely to prove
 * that UI visibility is never authorization: the request behind a control is
 * refused server-side even when sent by hand.
 */

/** Must match `apps/dashboard/src/lib/auth-mode.ts`'s `E2E_TOKEN_STORAGE_KEY`. */
const E2E_TOKEN_STORAGE_KEY = 'combat-creative-os:e2e-token';

/** Must match `apps/api/src/test-helpers/authenticated-caller.ts`'s `bearerFor`. */
export function tokenFor(userId: string): string {
  return `token_${userId}`;
}

export function bearer(userId: string): { Authorization: string } {
  return { Authorization: `Bearer ${tokenFor(userId)}` };
}

/**
 * Signs the browser in as `userId` before the app's first render, so the
 * workspace lookup on mount already carries a token.
 */
export async function signIn(page: Page, userId: string): Promise<void> {
  await page.addInitScript(
    ([key, token]) => {
      window.localStorage.setItem(key as string, token as string);
    },
    [E2E_TOKEN_STORAGE_KEY, tokenFor(userId)],
  );
  await page.goto('/');
}

/** Signs the browser out — no token in storage at all. */
export async function signOut(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    window.localStorage.removeItem(key as string);
  }, E2E_TOKEN_STORAGE_KEY);
}

/** A direct, authenticated API call — the "sent by hand" half of each gate check. */
export function authed(
  request: APIRequestContext,
  userId: string,
): { headers: { Authorization: string } } {
  return { headers: bearer(userId) };
}
