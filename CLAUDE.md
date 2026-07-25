# Combat Creative OS — persistent rules

This file is the operating contract for anyone (human or agent) working in
this repository. It is deliberately short — for the full design rationale
see `docs/architecture.md` and `docs/adr/`.

Current milestone: **M13, performance analysis & creative learning, done** —
a deterministic, **provider-independent** learning loop. Closed-window
performance data is ingested from fixtures or manual entry as immutable
`PerformanceObservation`s (architecture.md §4.1's `PerformanceRecord`,
implemented — post identity + source provenance + raw counters + derived rates,
idempotent per `(post, platform, window)`); the existing `performance-analyst`
agent distils them into `LearningRecord`s (§4.1's `Learning`, promoted out of
the agents package into a real versioned table with explicit evidence
references and full agent/prompt provenance).

**Three properties the agent cannot talk its way past:** completed data only (a
window that has not elapsed is refused at the persistence boundary and filtered
out before analysis); evidence must be real (every cited observation id is
checked against what was actually supplied — a bad citation is a typed
`UNSUPPORTED_EVIDENCE` failure, not a persisted learning); and **confidence is
derived, never asserted** (`deriveLearningConfidence` computes the band from
observation count _and_ impression volume, so one observation is always LOW
however large, and the agent's schema has no confidence field at all).

`PerformanceAnalysisWorkflow` is a **separate top-level workflow**, decoupled
structurally rather than by convention: it proxies exactly one Activity whose
only writes are `LearningRecord` rows, defines **no signals**, carries no
stage/approval/asset/export field, and never calls
`advanceCampaignStageActivity` — so it cannot advance a stage, satisfy or bypass
a human gate, modify an approved asset, or trigger an export. It adds no
transition facts, so no amount of performance data can make a campaign
transition valid.

Approved learnings reach the Campaign Strategist and Creative Director as
**bounded, attributable** context: `selectLearningContext` admits only APPROVED,
non-superseded, workspace-scoped records at or above MEDIUM confidence whose
applicability overlaps the target campaign, ranks by confidence and evidence
weight, and caps at 5 items — each rendered with its confidence band, evidence
count and source record id so any influenced claim is traceable. It is offered
**alongside** the approved brief, never in place of it (brief fields are passed
verbatim and are not overridable), and a human with `APPROVE_CONCEPT` must
approve a record before it is ever injected. Injection is opt-in via an optional
`learningDb` dep, so every pre-M13 caller behaves exactly as before.
`apps/api` gained ingestion (`MANAGE_CAMPAIGNS`), performance history and
learning listing (`VIEW_REPORTING`) and learning review (`APPROVE_CONCEPT`);
`apps/dashboard` gained performance and learning-review screens.

**Explicitly deferred: real platform integration.** There is no ad-platform API
client, OAuth flow, scraper, webhook or credential anywhere — `PerformanceSource`
is `FIXTURE | MANUAL_ENTRY` only, and the dashboard says so in plain text. A real
connector would add one source value feeding the same ingestion Activity and
would change nothing downstream. Also deferred: the `PROMPTING` learning scope is
persistable but unconsumed, and no scheduler triggers the analysis workflow (it is
started explicitly). See `docs/architecture.md` §8's M13 entry for the full
accounting. Still no export/distribution, no real caller authentication, no real
Veo/Runway/ComfyUI adapter (only the deterministic mock — do not connect one or
spend money without an explicit, separate decision), **Final QA still performs no
licensing check** (§7.2 open question 1), and no
live-Postgres/Temporal/MinIO/ffmpeg environment in this session —
`apps/api/src/dev-fake-server.ts` (in-memory-backed) is what both `apps/api`'s
own tests and `apps/dashboard`'s Playwright suite run against instead. Anthropic
is reachable via `@combat/providers`'s `ClaudeReasoningProvider`, but only when
explicitly configured (`REASONING_PROVIDER=claude` + `ANTHROPIC_API_KEY`); the
default `mock` provider is what every automated test uses.

## Context and token efficiency

- Read only files relevant to the active task.
- Search for relevant code before opening large files.
- Do not repeat architecture already documented.
- Keep progress explanations concise.
- Use package-level tests during implementation.
- Run the complete repository validation only once at the end.
- Do not print lengthy successful command output.
- When a command fails, inspect only the relevant error section.
- Use subagents only for independent, clearly bounded work.
- Do not make multiple agents inspect the same files.
- At the end of each milestone, update relevant documentation, commit the
  work and report only:
  - commit hash
  - files changed
  - tests run
  - remaining limitations
  - next milestone

## Architecture boundaries

- **Temporal workflow files never do I/O.** Files under
  `packages/workflows/src/workflows/*` may only import `@temporalio/workflow`
  and type-only activity signatures — no `fetch`, `Date.now()`,
  `Math.random()`, filesystem, or network access. All I/O lives in
  `packages/workflows/src/activities/*`.
- **Specialist agents never call other agents or the database directly.**
  An agent is `(validated input) → (validated output)` plus one reasoning
  call. Only the orchestrator (workflows/activities) sequences agents and
  persists their output. This is why the system is an orchestrator over
  specialist agents rather than a free-form multi-agent chat — see
  `docs/adr/0001-specialist-workflows-over-freeform-chat.md`.
- **`apps/dashboard` holds no business logic.** No direct DB access, no
  Temporal client, no provider calls. Every command/query goes through
  `apps/api`. UI visibility is never authorization — every permission check
  happens server-side in `apps/api`.
- **Dependency direction**: `workflows` → `domain` only. `activities` →
  `agents`, `providers`, `media`, `database`. `agents` → `agent-runtime` +
  `domain` (not `database`, not `providers` directly). `packages/testing` is
  a leaf: other packages may depend on it for test helpers; it depends on
  nothing else in the workspace, to keep the dependency graph acyclic.
- Every entity that isn't global reference data carries a `workspaceId`.
  Single-workspace MVP now; the schema and repository layer already require
  scoping — see `docs/architecture.md` §4.4.

## Coding conventions

- TypeScript strict mode is non-negotiable (`tsconfig.base.json`) — do not
  add `// @ts-ignore` or loosen a compiler flag to work around an error;
  fix the type.
- Packages compile to CommonJS (`dist/`) via `tsc`; consuming packages import
  the compiled output, not source paths, across package boundaries.
- No default exports for shared modules — named exports only, so refactors
  and greps stay predictable.
- Prefer small, focused files per concern (one interface/one mock per
  provider, one repository per aggregate) over grab-bag "utils" files.

## Required validation commands

Before reporting any change complete, run (scoped to what you touched, or
the whole tree for cross-cutting changes):

```sh
pnpm typecheck   # turbo run typecheck across the workspace
pnpm lint        # turbo run lint
pnpm test        # turbo run test (Vitest)
pnpm build       # turbo run build
```

Dashboard end-to-end coverage: `pnpm --filter dashboard test:e2e` (Playwright;
builds and boots the app first — see `apps/dashboard/playwright.config.ts`).

If a command can't be run because required local infrastructure isn't
available (no Docker, no live Postgres/Temporal), say so explicitly rather
than silently skipping it or claiming it passed.

## Security rules

- No secret, API key, or token is ever hardcoded or committed. `.env` is
  git-ignored; only `.env.example` (placeholders only, no real credentials)
  is committed.
- Every mutating `apps/api` route checks the caller's role against
  `packages/domain`'s permission matrix (`roleHasPermission`) before doing
  anything else.
- Every `packages/database` repository function that touches a
  workspace-owned table takes `workspaceId` as its first argument and folds
  it into the query — never look up such a row by id alone.
- The three human approval signals (`approveConcept`, `selectShots`,
  `approveFinal`) are dispatched only from `apps/api`. No other app, no
  workflow/activity code, and no "dev convenience" path may fire them
  automatically.
- Provider credentials (once real adapters exist) are read only via
  `packages/config`'s validated env schema — never read `process.env`
  directly in adapter code.

## Migration rules

- Prisma schema changes go through `pnpm --filter @combat/database run
migrate` (`prisma migrate dev`) against a live Postgres — never hand-edit
  files under `packages/database/prisma/migrations/`.
- Every new table modeling workspace-owned data gets a `workspaceId` column
  and an index on it, unless it's the tenancy root (`Workspace` itself).
- Run `pnpm db:generate` after any schema change before typechecking/building
  — generated Prisma client types must stay in sync with the schema.

## Provider-adapter rules

- Every provider category (video generation, design, motion graphics,
  review, storage, reasoning) is accessed through the interface in
  `packages/providers`, never through a direct SDK call from an activity.
- Every real adapter must have a working deterministic mock before or
  alongside it — mocks are not an afterthought, they're how local dev and CI
  run without paid API keys.
- Mocks perform no real network I/O and must be deterministic (no
  wall-clock-dependent assertions, no reliance on external services).
- After Effects/`aerender` is never containerized — it is addressed only
  through `MotionGraphicsProvider` as an external Windows render worker.
- Do not connect a real video-generation provider (Veo/Runway) or spend
  money through one without an explicit, separate decision to do so.

## Workflow-idempotency rules

- Every provider/DB call made from an activity is wrapped with an
  idempotency key derived from `(workflowRunId, stage, entityId, attempt)`.
  Retries and workflow replays must never double-submit paid work.
- Every generation/render dispatch is preceded by a budget check at every
  applicable level (workspace, campaign, shot, provider) — see the
  `Budget`/`BudgetLedger` design in `docs/architecture.md` §4.3. A budget
  reservation is written before dispatch; a charge or release closes it out.
  No budget ledger row is ever mutated in place.
- Bound retries explicitly (no unbounded regeneration loops) and escalate to
  a human state rather than retrying forever.

## Documentation expectations

- A structural change (new package/app, new workflow stage, changed service
  boundary, changed dependency direction) updates `docs/architecture.md` in
  the same change — don't let the doc drift from what's actually built.
- A decision that reverses or narrows something the architecture doc states
  as resolved gets a note in §7 (or a new ADR if the reasoning is
  substantial), not a silent edit.
- Comments in code explain _why_, not _what_ — don't restate what
  well-named code already shows; do explain a non-obvious constraint,
  invariant, or workaround.
