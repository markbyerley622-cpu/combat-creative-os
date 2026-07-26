import type { FastifyInstance } from 'fastify';
import { listWorkspacesForUser, type MembershipDataSource } from '@combat/database';
import { requirePrincipal } from './authentication';

/**
 * AAMP-1 step 2 — "who am I, and where may I act".
 *
 * The dashboard used to obtain its `workspaceId` from a browser form the person
 * typed a UUID into. With the development identity picker gone, it has to come
 * from somewhere authoritative, and this is that somewhere: the verified
 * principal's own `Membership` rows, read from PostgreSQL.
 *
 * This is a read route and mutates nothing, so it is not part of
 * `MUTATING_ROUTES`. It still authenticates like everything else — the
 * `onRequest` hook has already run by the time the handler executes — and it
 * discloses only the caller's own memberships, so it cannot be used to
 * enumerate workspaces the caller is not in.
 */
export interface MeRouteDeps {
  db: MembershipDataSource;
}

export function registerMeRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: MeRouteDeps,
): void {
  app.get('/me', async (request, reply) => {
    const principal = requirePrincipal(request);
    const workspaces = await listWorkspacesForUser(deps.db, principal.userId);
    return reply.status(200).send({
      userId: principal.userId,
      email: principal.email,
      workspaces,
    });
  });
}
