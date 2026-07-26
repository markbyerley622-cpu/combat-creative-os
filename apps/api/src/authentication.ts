import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  extractBearerToken,
  resolvePrincipal,
  type ClerkProfileDirectory,
  type ClerkTokenVerifier,
  type VerifiedPrincipal,
} from '@combat/auth';
import type { UserDataSource } from '@combat/database';

/**
 * AAMP-1 step 2 — the single place `apps/api` decides *who is calling*.
 *
 * Before this file existed, every route parsed a `userId` out of its own
 * request body or query string. That made the caller's identity a claim, and
 * eighteen mutating routes each had to be trusted to handle it. Now there is
 * exactly one authentication decision, taken in an `onRequest` hook before any
 * route handler, any Zod body parse, any repository read and any
 * `roleHasPermission` call.
 *
 * Three properties are deliberate:
 *
 * - **Default deny.** The hook applies to the whole instance and rejects unless
 *   the path is in `PUBLIC_ROUTES`. A route added tomorrow is authenticated
 *   without its author doing anything; forgetting is not a failure mode.
 * - **Authentication only.** It attaches a principal and stops. Membership,
 *   role, permission and workspace scoping are untouched and still resolved
 *   from PostgreSQL by `route-authorization.ts` — the ordering
 *   (membership → permission → campaign ownership → child-resource
 *   association) is exactly what it was, with a verified `userId` feeding it
 *   instead of a claimed one.
 * - **Uniform 401.** No token, a malformed token, an expired token, a bad
 *   signature and an unprovisionable subject all produce the same body. The
 *   reason is logged for operators, never returned, so nothing about which
 *   subjects or users exist is probeable from outside.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by `registerAuthentication` for every non-public route. Optional at
     * the type level because public routes genuinely have none — use
     * `requirePrincipal` rather than asserting it.
     */
    principal?: VerifiedPrincipal;
  }
}

export interface AuthenticationDeps {
  readonly verifier: ClerkTokenVerifier;
  readonly directory: ClerkProfileDirectory;
  readonly db: UserDataSource;
}

/**
 * Paths served without a caller identity. Deliberately tiny and exact-matched:
 * both are infrastructure probes that expose no workspace data — liveness says
 * the process is up, readiness says whether its database is reachable. Adding
 * anything here removes authentication from it, so the conformance test in
 * `authentication.test.ts` pins this list.
 */
export const PUBLIC_ROUTES: readonly string[] = ['/health', '/ready'];

const UNAUTHENTICATED = {
  error: 'UNAUTHENTICATED',
  message: 'a verified session token is required',
} as const;

/**
 * The principal for a route the hook has authenticated. Throws rather than
 * returning `undefined`: reaching a guarded handler without a principal would
 * mean the hook was bypassed, which must fail loudly (500), never fall through
 * to an unauthenticated read.
 */
export function requirePrincipal(request: FastifyRequest): VerifiedPrincipal {
  if (!request.principal) {
    throw new Error('route handler ran without an authenticated principal');
  }
  return request.principal;
}

function isPublic(request: FastifyRequest): boolean {
  // CORS preflight carries no credentials by design and returns no data; the
  // cors plugin answers it. Authenticating it would break every browser call.
  if (request.method === 'OPTIONS') return true;
  const url = request.routeOptions?.url ?? request.url.split('?')[0];
  return PUBLIC_ROUTES.includes(url ?? '');
}

/**
 * Installs the authentication hook. Call this **before** registering routes so
 * the hook is ordered ahead of every handler.
 */
export function registerAuthentication(
  app: FastifyInstance<any, any, any, any, any>,
  deps: AuthenticationDeps,
): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublic(request)) return;

    const token = extractBearerToken(request.headers.authorization);
    const result = await resolvePrincipal(
      { verifier: deps.verifier, directory: deps.directory, db: deps.db },
      token,
    );

    if (!result.ok) {
      // The reason is operator-facing only. The token itself is never logged:
      // it is a bearer credential, and pino's redaction covers the header, but
      // the safest handling is not to put it anywhere in the first place.
      request.log.info({ reason: result.reason }, 'request rejected: not authenticated');
      return reply.status(401).send(UNAUTHENTICATED);
    }

    request.principal = result.principal;
    return;
  });
}
