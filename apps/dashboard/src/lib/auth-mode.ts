/**
 * Which identity provider the dashboard talks to.
 *
 * `clerk` is the only mode a deployed dashboard ever runs in. `e2e-fake` exists
 * so the Playwright suite can drive the real screens against
 * `apps/api`'s in-memory dev-fake-server without a Clerk account, credentials
 * or network access — CI must stay free of both.
 *
 * **This is not an authentication bypass, and cannot become one.** It only
 * changes which token the browser attaches. `apps/api` verifies every token
 * independently, and the fake verifier that accepts the e2e token lives in
 * `@combat/auth/testing`, which no production import path reaches and no
 * environment variable can select. Setting this mode against a real API
 * therefore yields 401 on every request — it grants nothing.
 *
 * It is still refused outright in production, because a flag that looks like an
 * auth switch should never be *reachable* there, whether or not it would work.
 */

/**
 * Where the browser keeps its bearer token in `e2e-fake` mode.
 *
 * This mirrors production's shape rather than the identity picker it replaced:
 * the browser holds a *token*, not a user id, and `apps/api` decides what that
 * token means. The Playwright suite writes one here to sign in as a fixture
 * user, exactly as Clerk writes a session token in `clerk` mode.
 */
export const E2E_TOKEN_STORAGE_KEY = 'combat-creative-os:e2e-token';

export type DashboardAuthMode = 'clerk' | 'e2e-fake';

export interface AuthModeEnv {
  readonly NEXT_PUBLIC_DASHBOARD_AUTH_MODE?: string | undefined;
  readonly NEXT_PUBLIC_DEPLOY_ENV?: string | undefined;
}

export class AuthModeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthModeRefused';
  }
}

export function resolveAuthMode(env: AuthModeEnv): DashboardAuthMode {
  const requested = env.NEXT_PUBLIC_DASHBOARD_AUTH_MODE;
  if (requested === undefined || requested === '' || requested === 'clerk') return 'clerk';
  if (requested !== 'e2e-fake') {
    throw new AuthModeRefused(
      `unknown NEXT_PUBLIC_DASHBOARD_AUTH_MODE "${requested}" — expected "clerk" or "e2e-fake"`,
    );
  }
  if (env.NEXT_PUBLIC_DEPLOY_ENV === 'production') {
    throw new AuthModeRefused(
      'NEXT_PUBLIC_DASHBOARD_AUTH_MODE=e2e-fake is refused when NEXT_PUBLIC_DEPLOY_ENV=production',
    );
  }
  return 'e2e-fake';
}

/** The mode this process is running in. */
export function currentAuthMode(): DashboardAuthMode {
  return resolveAuthMode({
    NEXT_PUBLIC_DASHBOARD_AUTH_MODE: process.env.NEXT_PUBLIC_DASHBOARD_AUTH_MODE,
    NEXT_PUBLIC_DEPLOY_ENV: process.env.NEXT_PUBLIC_DEPLOY_ENV,
  });
}

/** The token the browser is currently holding in `e2e-fake` mode, if any. */
export function e2eFakeToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(E2E_TOKEN_STORAGE_KEY);
}
