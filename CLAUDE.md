# Combat Creative OS — persistent rules

This file is the operating contract for anyone (human or agent) working in
this repository. It is deliberately short — for the full design rationale
see `docs/architecture.md` and `docs/adr/`.

Current milestone: **M11, Final QA & Final Approval gate, done** — the
existing `final-qa-controller` agent is wired into `CampaignProductionWorkflow`
at FINAL_QA through `runFinalQaControllerActivity` (`packages/workflows`), which
registers the campaign's `FINAL_MASTER` asset (deterministic checksum, no bytes,
real provenance chain `FINAL_MASTER -> ROUGH_CUT + SOUND_STEM[]`), derives the
master's technical probe and delivery specification from persisted production
facts, runs the agent through the same `executeSpecialistAgentActivity` boundary
every other agent uses (agents never touch repositories/providers/other agents),
and persists the verdict as the system's first **asset-based**
`QualityAssessment` (`subjectStage: 'FINAL_QA'`, immutable + idempotent per
`(assetId, subjectStage)` via `createQualityAssessmentForAsset`) plus one typed
`QualityFailure` per finding — exactly the rows `finalQAPassed` /
`finalQARepairTargetIs*` / `finalQAAudioFailure` already read. On a pass the
workflow auto-forwards FINAL_QA → FINAL_APPROVAL, where the **FINAL human gate
still applies unchanged** (only `apps/api`'s `POST .../approvals/final` records
the approval and signals; the workflow re-verifies it). On a failure it issues a
**repair-targeted `AUTO_RETRY`** to the most upstream of COMPOSITING |
ROUGH_CUT | SOUND_DESIGN, selected from the findings' categories via
`QUALITY_FAILURE_ROUTING`; `advanceCampaignStageActivity`'s AUTO_RETRY mode
gained a `repairTarget` for this and still filters to **non-gated** edges only,
refusing an ambiguous multi-edge retry — no automated retry can cross a human
gate. An unroutable failure escalates to BLOCKED. `apps/api` gained one
read-only `GET .../final-qa` route (verdict + findings + master + delivery
context + budget + whether the caller holds `APPROVE_FINAL_MASTER`);
`apps/dashboard` gained a Final Approval screen calling the existing approval
endpoint. An approved master advances to **VARIANT_GENERATION, where it reaches
BLOCKED** (no Variant Generator until M12) — the exact M11 stopping point. All
three human gates remain unbypassable. See `docs/architecture.md` §8's M11 entry
for the full accounting and interim decisions (the technical probe is **derived,
not ffprobe'd** — duration/resolution/captions come from the persisted
Timeline + rough edit and are genuine checks, but **loudness is nominal, not
measured**, since no master bytes exist; no `DeliverySpecification` row is
created — per-platform rules are §7.2 open question 5, blocking M12; the
`FINAL_MASTER` is a mock asset with no bytes; **Final QA performs no licensing
check** — §7.2 open question 1). Still no variants/export/distribution, no real
caller authentication, no real Veo/Runway/ComfyUI adapter (only the
deterministic mock — do not connect one or spend money without an explicit,
separate decision), and no live-Postgres/Temporal/MinIO/ffmpeg environment in
this session — `apps/api/src/dev-fake-server.ts` (in-memory-backed) is what both
`apps/api`'s own tests and `apps/dashboard`'s Playwright suite run against
instead. Anthropic is reachable via `@combat/providers`'s
`ClaudeReasoningProvider`, but only when explicitly configured
(`REASONING_PROVIDER=claude` + `ANTHROPIC_API_KEY`); the default `mock`
provider is what every automated test uses.

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
