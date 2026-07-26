import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import { currentAuthMode } from '@/lib/auth-mode';

/**
 * AAMP-1 step 2 — the dashboard's route protection.
 *
 * Scaffolded by `clerk init`, then tightened: the generated middleware was a
 * bare `clerkMiddleware()` with no protection at all ("routes are public by
 * default"), which would leave every campaign screen renderable while signed
 * out. This one is **default-deny** — everything the matcher covers is
 * protected unless it appears in `isPublic`.
 *
 * Protecting a page is a *usability* control, not the security boundary. It
 * stops a signed-out person landing on a screen that can only render errors.
 * The boundary itself is `apps/api`'s authentication hook, which refuses any
 * request without a verified token regardless of what the browser rendered —
 * the dashboard holds no business logic and no data of its own (CLAUDE.md).
 */

const isPublic = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  // The dashboard's own liveness probe: infrastructure must reach it without
  // credentials, and it discloses nothing.
  '/api/health',
]);

const clerk = clerkMiddleware(async (auth, request) => {
  if (!isPublic(request)) {
    await auth.protect();
  }
});

export default function middleware(request: NextRequest, event: Parameters<typeof clerk>[1]) {
  // In e2e-fake mode there is no Clerk instance to talk to, so requests pass
  // through to the pages — which then authenticate against apps/api exactly as
  // they do in production. The server-side check is unchanged.
  if (currentAuthMode() === 'e2e-fake') return NextResponse.next();
  return clerk(request, event);
}

/**
 * Clerk's required matcher, present exactly once: skip Next internals and
 * anything that looks like a static file; run on everything else plus all API
 * routes.
 */
export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
