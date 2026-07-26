# ADR 0006 — Clerk for identity, PostgreSQL for authorization

Date: 2026-07-26
Status: Accepted
Milestone: AAMP-1 step 2 (`docs/aamp-architecture.md` §6 task 4)
Supersedes: nothing. Closes `docs/architecture.md` §7.1 item 0 and item 11b.

## Context

Every mutating endpoint in `apps/api` took the caller's `userId` from the
request body, and every read route took it from the query string. That made RBAC
real but identity fictional: the system could prove a `Membership` row granted a
permission, and could not prove the caller was the person that row named. Anyone
who knew or guessed a valid user id could act as them. M14 hardened what an
identity may _do_; nothing proved _who_ it was. The `packages/auth` package the
architecture assumed since §2.2 had never been built.

Decision criterion 1 in `docs/aamp-architecture.md` §6 was left open: an external
IdP (OIDC) versus first-party sessions, judged on audit needs, SSO, time to
implement and breach blast radius. This ADR resolves it.

## Decision

### 1. Clerk is the identity provider, and only that

`@clerk/nextjs` in `apps/dashboard`, `@clerk/backend` in `apps/api` via
`packages/auth`. Clerk owns sign-up, sign-in, credential storage, password
reset, MFA and session lifetime. It is the answer to _"who is calling?"_ and to
nothing else.

Choosing an external IdP over first-party sessions was decided on blast radius:
this repository would otherwise have to build and maintain password hashing,
reset flows, session rotation, MFA and breach response, none of which is the
product. The cost is a vendor dependency on the authentication path — accepted
because it is a _replaceable_ dependency: everything above the
`ClerkTokenVerifier` / `ClerkProfileDirectory` interfaces in
`packages/auth/src/principal.ts` is vendor-neutral, and swapping providers means
writing one adapter.

### 2. PostgreSQL remains the authorization authority

**No role, workspace, membership, permission or entitlement is ever read from a
token claim.** A verified token yields exactly one fact — the subject
identifier — and every authorization decision after that is the code that was
already there: `Membership` → `roleHasPermission` → campaign ownership →
child-resource association, in that order, unchanged.

This is what keeps the authorization audit surface honest. `MUTATING_ROUTES` in
`apps/api/src/route-authorization.ts` is still the single registry of what each
endpoint requires, its conformance tests still compare it against the router in
both directions, and a compromised or over-permissive IdP configuration cannot
grant authority inside this system.

A test asserts the property directly: with a byte-identical token, changing only
the persisted `Membership.role` changes 403 into 201.

### 3. Clerk Organizations are disabled

Tenancy is `Workspace` + `Membership`, defined in this repository's schema,
scoped by every repository function, and audited by existing tests. Clerk
Organizations would be a second tenancy model with its own membership list,
roles and invitation flow — two systems that could disagree about who belongs
where, with the wrong one winning silently.

`VerifiedPrincipal` therefore has no workspace or organisation field at all, so
no route can take its tenant scope from a token instead of from the path plus a
`Membership` lookup. Tests scan `packages/auth` and every `apps/api` route file
for `org_id`/`orgId`/organisation components, and the dashboard's source tree
for Clerk's organisation UI.

### 4. The verified subject maps to a local `User`

`User.clerkUserId` (nullable, unique — migration
`20260726062308_add_user_clerk_subject`) holds the Clerk `sub`.
`resolveUserForClerkSubject` resolves it in three ordered steps:

1. **Already mapped** — return the row. Every sign-in after the first takes this
   path, writes nothing, and makes no call to Clerk.
2. **Invited but never signed in** — a row with the same email and no subject is
   _linked_. This is what lets someone keep the `Membership` rows, and therefore
   the role, they were granted before their first sign-in. A row already bound to
   a different subject is refused rather than re-bound.
3. **New** — a row is created. A concurrent duplicate loses the unique index and
   resolves by re-reading the winner, so simultaneous first requests converge on
   one user instead of one of them failing.

Nullable, because a `User` may legitimately exist before it has ever signed in.
Unique, because one subject resolving to two local users would split a person's
permissions in a way nothing downstream could detect.

### 5. Client-supplied `userId` is removed, not merely ignored

`userId` is gone from every request body and query string in `apps/api` and from
every call in the dashboard's API client. The body schemas that carried it are
`.strict()`, so a client that still sends one gets a 400 rather than having it
silently discarded — "no route accepts caller identity from request input"
becomes an enforced property instead of a convention. A source-level test asserts
no route file reads `userId` from `request.body` or `request.query`.

Authentication is a single instance-wide `onRequest` hook
(`apps/api/src/authentication.ts`) that runs before every handler, Zod parse,
repository read and permission check. It is **default-deny**: only `/health` and
`/ready` are exempt, by explicit allowlist, so a route added tomorrow is
authenticated without its author doing anything.

## Consequences

**Gained.** Caller identity is cryptographically verified. Impersonation by
request field is impossible. The dashboard's development identity picker — which
asked a human to type a workspace and user id — is deleted, along with the
`localStorage` "session" behind it. Workspace now comes from `GET /me`, which
reads the verified caller's own `Membership` rows, so the browser cannot even
name a workspace it is not in. `apps/api` fails closed without
`CLERK_SECRET_KEY`, in every environment.

**Costs and limits.**

- A vendor now sits on the authentication path. Mitigated by the adapter seam,
  not eliminated.
- First sign-in makes one Backend API call to read email and display name
  (session tokens carry neither by default). Steady-state requests make none.
- `CLERK_AUTHORIZED_PARTIES` is only _required_ in production. Locally an
  unset allowlist means the `azp` claim is not checked.
- The Playwright suite runs in `e2e-fake` mode, where the browser presents a
  fixture token instead of a Clerk session. This is not an authentication
  bypass: `apps/api` verifies every request either way, the fake verifier lives
  in `@combat/auth/testing` which no production import path reaches and no
  environment variable can select, and the mode is refused when
  `NEXT_PUBLIC_DEPLOY_ENV=production`.
- Authentication has not been exercised against live Clerk from this
  environment. What is proven here is the verification path, the subject
  mapping, provisioning idempotency and the 401/403/404 matrix — all against
  deterministic in-process fakes, with no credential and no network call.

## Alternatives considered

**First-party sessions.** Rejected: it makes this repository responsible for
credential storage and breach response, which is a large permanent surface for
no product benefit.

**Clerk Organizations as the tenancy model.** Rejected: see §3. It would replace
an audited, tested, schema-enforced tenancy model with a vendor one, and leave
two sources of truth about membership.

**Trusting role claims from the token** (Clerk metadata carrying the role).
Rejected: it moves an authorization decision outside the database and outside
`MUTATING_ROUTES`' audit, and makes IdP misconfiguration a privilege-escalation
path.

**Keeping body `userId` as a fallback during migration.** Rejected: a fallback
identity path is an impersonation path for as long as it exists, and
`docs/aamp-architecture.md` §6 explicitly requires that rollback never
re-enables it.
