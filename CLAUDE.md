# Combat Creative OS — persistent rules

This file is the operating contract for anyone (human or agent) working in
this repository. It is deliberately short — for the full design rationale
see `docs/architecture.md` and `docs/adr/`.

Current state: **M14 (production hardening) done, plus the post-M14 foundation
audit repair** — corrective maintenance, not a feature milestone. **AAMP-0
(architecture and delivery blueprint) is documented** in
`docs/aamp-architecture.md` and `docs/adr/0005-aamp-creative-memory-and-real-media-architecture.md`.

**AAMP-1 step 1 (live PostgreSQL migration baseline) is done** — Docker Compose
runs `postgres` healthy, and the first real Prisma migration
(`packages/database/prisma/migrations/20260726053508_init/`) is generated,
applied, drift-checked and committed. It changed no application code. Runbook:
`docs/runbooks/database-migrations.md`; accounting: `docs/architecture.md` §8's
AAMP-1 step 1 entry.

**AAMP-1 step 2 (verified Clerk authentication) is done** — see
`docs/adr/0006-clerk-identity-with-postgresql-authorization.md` and
`docs/architecture.md` §8's AAMP-1 step 2 entry.

**AAMP real-media vertical slice 1 (real FFmpeg advertisement rendering) is
done** — the system produces a genuine playable 1080×1920 MP4 from a render
manifest. See the "Real media rendering" section below and
`docs/architecture.md` §8's vertical-slice-1 entry.

**AAMP generation vertical slice 2 (ComfyUI video generation gateway) is
done** — but read what it does and does not prove. **Proven:** real FFmpeg
rendering (a genuine playable 1080×1920 h264 MP4 passing actual-media QA,
measured by ffprobe), the full `pnpm aamp:generate` chain end to end, and
ComfyUI protocol integration against a fake protocol server. **Not proven:**
real AI video generation — **no model-generated frame has ever passed through
this code**, because this machine has a 4 GB GPU against a 12 GB floor and
**cannot execute either intended quality profile**, and no endpoint is
configured. Also note **mock reasoning ignores the campaign prompt**: it
replays committed golden fixtures. See the "ComfyUI video generation" section
below, `docs/runbooks/comfyui-video-generation.md` and `docs/architecture.md`
§8's vertical-slice-2 entry.

**Real prompt-driven source-based advertisement generation is done** — a
natural-language brief plus a library of owned assets now produces a
prompt-specific vertical advertisement with no GPU and no generated footage.
See the "Prompt-driven source generation" section below and
`docs/runbooks/prompt-driven-advertisement-generation.md`. **The next milestone
is Creative Memory benchmark ingestion.** AAMP-1 step 3 (the `SERIALIZABLE`
budget transaction, `docs/aamp-architecture.md` §6 task 5) remains outstanding
and unstarted.

## Prompt-driven source generation — permanent rules

- **A normal run requires genuine reasoning.** `REASONING_PROVIDER=mock` is
  refused (exit 3) unless the operator explicitly passes `--fixture-demo`.
  Fixture creative replays committed golden results and **ignores the campaign
  prompt entirely**, so it can never stand in for a campaign result. Never add
  a silent fallback from real reasoning to fixtures.
- **The brief reaches the agents verbatim.** `campaignPrompt` and ordered
  `factualConstraints` are typed inputs on all four planning agents; the
  derived `objective`/`keyMessages` are a summary, never a replacement. Every
  planning prompt version carries the shared brief-handling addendum.
- **No agency imitation, ever.** Creative intent is expressed as explicit
  properties — pacing, contrast, framing, typography, rhythm. Every planning
  prompt forbids naming or imitating an agency, studio or existing campaign.
- **Only `OWNED`, `COMMISSIONED` and `LICENSED_FOR_OUTPUT` may reach FFmpeg**,
  and only with `permittedOutputUse: true`. `ANALYSIS_ONLY` and
  `UNKNOWN_RIGHTS` are refused when the production manifest is parsed —
  benchmark and competitor material must never enter it. Expired licences,
  unsafe paths, checksum mismatches, missing files and kind mismatches are
  refused before or during resolution, never worked around.
- **Selection is deterministic and explainable.** Scores are pure functions of
  the request and manifest, ties break on asset id, nothing reads a clock.
  Every selection records why it won. When nothing fits, use the designed
  `BRAND_CARD` or raise the typed missing-source error — never substitute
  unrelated footage.
- **Measurements beat declarations.** Every accepted asset is probed with
  ffprobe; a declared duration or dimension that disagrees is recorded as a
  discrepancy and the measured value is what the timeline uses.
- **Technically valid, prompt-specific and agency-grade are three different
  claims.** QA measures the first and gates READY on it. Only a `REAL` run
  supports the second. The system never asserts the third: the scorecard always
  carries `agencyGradeClaim: NOT_ASSESSED` and `requiresHumanApproval: true`,
  and its dimension scores are structural heuristics, not quality judgements.
- **A QA failure prevents READY.** No heuristic score may override it.

## Real media rendering — permanent rules (vertical slice 1)

- **The render manifest is the only input.** `packages/media`'s versioned
  `RenderManifestV1Schema` is `.strict()` and validates cross-field rules,
  including that scene durations minus transition overlaps land **exactly** on
  the requested output duration. A new requirement is a new manifest version,
  never an edit to v1.
- **Licensing is enforced at source resolution, before FFmpeg exists.** Only
  `OWNED` and `LICENSED_FOR_OUTPUT` resolve; expiry is checked against a
  caller-supplied instant. An `ANALYSIS_ONLY` reference is refused with a typed
  error before the filesystem is touched or ffprobe is invoked. There is no
  other way for the renderer to learn a file path.
- **No authored string ever becomes filter grammar.** Captions, overlay copy and
  CTA text travel in a generated ASS file; only numbers and validated enum
  values are interpolated into `filter_complex`. FFmpeg runs with `cwd` set to
  the job directory and references that file by **bare filename** — a Windows
  `C:\…` path inside a filter argument collides with the `:` option separator.
- **Every binding QA fact is measured from the produced file** — ffprobe for
  container/codecs/geometry/duration, extracted RGB frames for blankness, CTA
  presence and caption presence. Never report a manifest value as a
  measurement. A report with any failed binding check sends the file to
  `rejected/` with `ingestionStatus: FAILED`; the deliverable path is reachable
  only through a passing report.
- **`packages/media` stays vendor-neutral and workspace-independent** (its only
  dependency is `zod`). The `MotionGraphicsProvider` adapter lives in
  `packages/providers`, which depends on `@combat/media` — that edge is
  deliberate and documented. `packages/domain` and `packages/media` still do not
  depend on each other; `RenderManifest`'s output block is kept _structurally_
  compatible with `VERTICAL_SHORT_FORM_V1`.
- **Never commit generated video, fixtures or copyrighted footage.**
  `.aamp-output/` and `packages/media/fixtures/generated/` are git-ignored.
  Fixture media is regenerated from FFmpeg `lavfi` sources with
  `pnpm aamp:fixtures`; the manifest that references it is committed, the media
  is not.
- **CI never invokes real FFmpeg.** The live integration test detects the binary
  and skips loudly when it is absent. Commands: `pnpm aamp:fixtures`, then
  `pnpm aamp:render --manifest packages/media/fixtures/combat-reviews-15s.manifest.json`.

## ComfyUI video generation — permanent rules (generation vertical slice 2)

- **Callers never author ComfyUI graphs.** Only server-owned, versioned
  profiles in `packages/providers/src/comfyui/workflow-profiles.ts` build a
  node graph; `submit()` takes the vendor-neutral request shape plus a profile
  key. A path from an API body to a ComfyUI node would be remote code
  execution on the render host.
- **Never invent node names, input names or workflow JSON.** Take them from
  ComfyUI's own source, the official model tutorials or maintained first-party
  examples, and record the source. A profile's `templateStatus` states how far
  verification got — `SIGNATURES_VERIFIED_NOT_EXECUTED` is not
  `EXECUTED_AGAINST_LIVE_SERVER`, and only a passing opt-in real integration
  test may raise it. A profile that cannot be established from official
  sources refuses to build a graph rather than shipping a guess.
- **No authored string becomes a path, filename or command.** Prompt text
  travels only as a JSON value inside a node's `inputs`. Output filename
  prefixes and uploaded reference filenames are checksum-derived. Filenames
  ComfyUI returns are used only as URL-encoded `/view` query parameters, never
  joined onto a local path.
- **Every response crosses `comfyui/protocol.ts`.** A shape this client does
  not expect is a typed failure at the boundary, never an `undefined` read
  three call frames later.
- **The job id is ComfyUI's `prompt_id`, derived from the idempotency key.**
  That is what makes polling survive a restart and a retry land on the same
  job instead of paying for a second render. Do not replace it with a random
  id or an in-memory handle.
- **Provider success never marks an asset READY.** Bytes are downloaded,
  hashed, and measured with ffprobe before persistence; an unreadable, empty
  or non-video result fails the attempt and releases its reservation.
  Measurements from the file are binding — never persist a requested value as
  if it were measured.
- **Rights are enforced before transmission.** `ANALYSIS_ONLY`, absent rights
  metadata, an expired licence and an unrecognised usage class all refuse
  before an upload is attempted. Only `OWNED`, `LICENSED_FOR_OUTPUT` and
  provenance-permitting `GENERATED` may be sent.
- **Production cannot select the mock.** `refineVideoGenerationConfig` refuses
  `mock` in production and refuses `comfyui` without an endpoint; the factory
  re-checks both. Never add a fallback that quietly substitutes the mock — a
  fabricated advertisement that passes every gate is the failure mode being
  guarded against.
- **CI never contacts a ComfyUI endpoint and never downloads a model.** The
  fake protocol server is for protocol tests only and is not evidence of
  working generation. The binding acceptance test is opt-in:
  `COMFYUI_INTEGRATION=1 pnpm --filter @combat/providers test:comfyui`.
- **Every `aamp:generate` result declares its execution mode.** The four modes
  (`REAL_REASONING_AND_REAL_GENERATION`,
  `REAL_REASONING_AND_FIXTURE_GENERATION`,
  `FIXTURE_REASONING_AND_REAL_GENERATION`,
  `FIXTURE_REASONING_AND_FIXTURE_GENERATION`) are derived from the selected
  providers, never set independently, so a label cannot disagree with what
  ran. The mode goes to stderr before and after the run, into `--json`, and
  into a `*.generation-provenance.json` sidecar carrying
  `isRealAdvertisement`. Never remove or soften these — a 1080×1920 MP4 with a
  `PASS` verdict reads as a finished advertisement, and in three of the four
  modes it is not one.
- **Fixture output is never presented as generation.**
  `FixtureVideoGenerationProvider` synthesises FFmpeg `lavfi` test patterns for
  demos only. It lives in `apps/aamp-cli`, outside `packages/providers`, so no
  `apps/worker` configuration value can select it, and it records
  `modelIdentifier: NONE-SYNTHETIC-TEST-PATTERN`. Do not move it into
  `packages/providers` or add it to `createVideoGenerationProvider`.
- **Requesting real generation without a working endpoint fails hard.** The CLI
  verifies nodes and VRAM before generating and exits 3 with the specific
  problems. Never add a fallback from `comfyui` to any fixture path.
- **Mock reasoning ignores the campaign prompt.** It replays committed golden
  fixtures, so it exercises plumbing and says nothing about creative quality.
  Never evaluate or report creative quality from a `FIXTURE_REASONING` run.

## Authentication — permanent rules (AAMP-1 step 2, ADR-0006)

- **Clerk proves who; PostgreSQL decides what.** A verified session token yields
  exactly one fact — the Clerk subject. Role, workspace membership, permission
  and entitlement are **never** read from a token claim; they are resolved from
  `Membership` rows through the existing repository boundary, in the existing
  order (membership → permission → campaign ownership → child-resource
  association).
- **Never accept caller identity from request input.** No `userId` in a body,
  query string or unverified header, ever. Body schemas that could carry one are
  `.strict()`, and a source-level test asserts no route file reads `userId` from
  `request.body`/`request.query`.
- **`apps/api` authenticates in exactly one place** —
  `apps/api/src/authentication.ts`'s instance-wide `onRequest` hook, which runs
  before every handler, Zod parse, repository read and `roleHasPermission` call.
  It is default-deny; `PUBLIC_ROUTES` (`/health`, `/ready`) is the entire
  exemption list and adding to it removes authentication from that path.
  Route handlers take the caller from `requirePrincipal(request)` and nowhere
  else.
- **Clerk Organizations stay disabled.** Tenancy is `Workspace` + `Membership`.
  `VerifiedPrincipal` deliberately carries no workspace or organisation field.
- **The identity fakes are not selectable by configuration.**
  `@combat/auth/testing` is reachable only by a code import (tests and
  `dev-fake-server.ts`); no env var can choose a fake verifier in a real
  process. `apps/api` fails closed without `CLERK_SECRET_KEY`, in every
  environment. The dashboard never reads a secret key — it holds only the
  publishable key.
- **`packages/auth` owns the vendor seam.** Everything above
  `ClerkTokenVerifier`/`ClerkProfileDirectory` is vendor-neutral; only
  `clerk-adapter.ts` imports `@clerk/backend`.

## Post-M14 audit repair (current HEAD)

A read-only audit of the M14 tree returned FAIL. Six findings, all repaired.
Full accounting in `docs/architecture.md` §8's post-M14 entry.

**C-1 — the Worker registered no usable activity.** `apps/worker` passed
`@combat/workflows`' `activities` namespace to `Worker.create`, but that
namespace exports `create*Activity(deps)` _factories_, so not one proxied name
was registered and every workflow would have failed on its first Activity task
against a real Temporal server. Each workflow contract now also exports a
runtime name tuple, compile-time proven to cover its interface exactly
(`workflows/activity-name-contract.ts`); `createWorkerActivities(deps)`
(`packages/workflows/src/worker`) builds the real registration object from those
same contracts; `apps/worker` wires the concrete dependencies. There is no
second activity-name list anywhere. A conformance test asserts exact coverage in
both directions with named diagnostics — a future missing registration fails
before merge.

**C-2 — `spentCents` reported roughly double the real spend.** All three
settlement paths charged the actual cost but released only `estimated − actual`,
leaving the RESERVATION row standing beside its CHARGE; an under-estimated job
released nothing at all. `settleBudgetReservation` is now the single settlement
path — charge actual, release the reservation in full — and `chargeBudget` /
`releaseBudget` are idempotent on `(policyId, idempotencyKey)`. The test that
encoded the wrong total was corrected.

**C-3 — registry conformance was cosmetic.** The M14 check matched only each
audited path's last URL segment against the router dump, plus a hardcoded route
count. `route-inventory.ts` now parses `printRoutes({ includeHooks: false })`
into full `(method, path)` pairs and compares them to `MUTATING_ROUTES` as exact
sets both ways. Every registry entry also gets a permission probe: accepted for
a role holding the audited permission with valid resource ownership, 403 with no
side effects for the most-privileged role lacking it.

**H-1** — the in-memory store now mirrors every `(campaignId, version)` family,
every per-job idempotency-key constraint and the one-job-per-specification
constraints, not just the three it had. **H-2** — `.github/workflows/ci.yml`
runs the documented validation commands; nothing else. **H-3** —
`dev-fake-server.ts` gained campaigns parked at `HUMAN_SHOT_SELECTION` and
`FINAL_APPROVAL`, and the Playwright suite covers both gates: the UI is
reachable, gate-advancing controls stay disabled until the required state
exists, and the request behind each control is refused server-side when sent
directly.

## M14 — production hardening & operational safety

**Authorization audit.** All 18 mutating `apps/api` endpoints are enumerated in
a typed registry (`apps/api/src/route-authorization.ts`) carrying the exact
`Permission` from the canonical `@combat/domain` matrix, the target resource and
the required ownership checks. The registry is executable: tests assert it
matches the routes Fastify registered, that every permission exists in the
matrix, that every campaign-scoped mutation verifies campaign ownership, and
that `ANALYST` holds no mutating permission — so an endpoint added without a
registry entry fails the suite rather than shipping unaudited.

**Three authorization defects found and fixed.** (1) Five shot-review mutations
accepted a body-supplied `setId` verified only against the _workspace_, letting
a privileged caller mutate one campaign's selection set through another
campaign's route in the same tenant. (2) Performance ingestion pinned a
client-supplied `creativeVariantId`/`variantAssetId` as provenance without
checking it belonged to the path campaign. Both now run
`assertBelongsToCampaign`. (3) `/shot-review/comment` required `SELECT_SHOTS`;
narrowed to `PROVIDE_CANDIDATE_FEEDBACK`.

**Two budget defects found and fixed.** `checkAndReserveBudget` was an
unguarded read-then-write: concurrent _distinct-key_ reservations could both
observe headroom and over-spend the cap, and concurrent _same-key_ retries
crashed on the unique constraint instead of resolving idempotently. Now a
constraint violation resolves to the winner's row, and after insert the ledger
prefix up to the new reservation is re-summed so the row that actually crossed
the cap is compensated while earlier writers stand (first-writer-wins). **The
durable fix is a `SERIALIZABLE` transaction in Postgres**, which cannot be
exercised without a live database — the compensating guard is what is tested.

**Also hardened.** Crash-point replay for both dangerous windows (worker dies
after persistence before dispatch; after dispatch before persistence) — no
duplicate provider submission, charge or derived asset. Signal resilience —
duplicate, late, wrong-gate, non-pending, forged and pre-gate signals each
cross the gate at most once and poison nothing. `workerEnvSchema` now **fails
closed** when `REASONING_PROVIDER=claude` has no `ANTHROPIC_API_KEY`, instead of
silently degrading production to the deterministic mock. `createLogger` gained
pino redaction (it previously had **none**) covering credentials, connection
strings, auth headers and model payloads, while leaving correlation identifiers
readable. The in-memory store now mirrors the `Asset` uniqueness constraint, so
a missing checksum-dedup can no longer pass tests while failing on Postgres.

**Remaining production blockers — as recorded at M14, with authentication now
closed by AAMP-1 step 2.** Caller authentication was the standing blocker here;
it is resolved (see the AAMP-1 step 2 note and ADR-0006 above), so the paragraph
below stands except for that item. The audit repair makes the Worker's
activity _registration_ correct and provable without a Temporal server; it does
not prove the Worker runs against one, because none is available here.
Database migrations are no longer outstanding — AAMP-1 step 1 applied the first
one — but no application process has been pointed at live Postgres yet, so every
test still runs against the in-memory store. Also outstanding: live
Temporal/MinIO/ffmpeg, real Veo/Runway/ComfyUI adapters (only the deterministic
mock — do not connect one or spend money without an explicit, separate
decision), real export/render implementation, real ad-platform integration, and
**Final QA still performs no licensing check** (`docs/architecture.md` §7.2
item 1). See §8's M14 entry for the full accounting, including exactly what is
enforced in code versus deferred. `apps/api/src/dev-fake-server.ts`
(in-memory-backed) is what both `apps/api`'s own tests and `apps/dashboard`'s
Playwright suite run against. Anthropic is reachable via `@combat/providers`'s
`ClaudeReasoningProvider`, but only when explicitly configured; the default
`mock` provider is what every automated test uses.

## AAMP — permanent engineering rules

These rules govern **every** AAMP milestone (AAMP-1 live infrastructure, AAMP-2
Creative Memory, AAMP-3 real generation, AAMP-4 real composition/export, AAMP-5
human review and campaign proof, and the deferred creator-distribution work).
They sit alongside — never above — the boundary, security, migration,
provider-adapter and workflow-idempotency rules below. Full blueprint:
`docs/aamp-architecture.md`; rationale: `docs/adr/0005-aamp-creative-memory-and-real-media-architecture.md`.

### Boundaries

- Preserve existing domain, provider, activity, workflow, approval, budget,
  provenance and tenancy boundaries unless a documented ADR deliberately
  changes one.
- Introduce real integrations **behind existing provider interfaces** wherever
  technically valid — a new capability is an adapter plus, at most, additive
  optional fields, not a new seam.
- Agents never call providers, databases, storage, workflows or other agents
  directly. Creative Memory results reach an agent only as Activity-resolved
  `AgentInput.context` material — never as an agent-initiated query or tool.
- Preserve all three existing human gates, unchanged and non-bypassable:
  concept approval, shot selection, final approval.
- Every external operation must have typed input/output, idempotency,
  provenance, bounded retries, structured failure handling, deterministic mock
  tests and explicit cost/storage controls.

### Cost, credentials and mock mode

- Do not introduce paid APIs, real credentials, model downloads or
  infrastructure until the relevant implementation milestone explicitly
  authorises them.
- Every real-media milestone must preserve mock mode, so CI and local tests run
  with no GPU access, no external services and no paid credentials.

### Output quality

- Final-output quality is a **hybrid** system:
  - licensed/original footage and Combat Reviews app assets where appropriate;
  - AI-generated visuals for concepts, transitions, controlled shots and
    variants;
  - deterministic rendering for app overlays, typography, captions, CTA, timing
    and delivery.
- Never call output agency-grade or production-ready solely because a video
  model generated it.
- Evaluate quality against actual frames, audio, timing, brand rules,
  licensing, delivery specifications and human approval — measurements from the
  produced file are binding; an agent's assessment is advisory.

### Reference material and licensing

- Never treat copyright-protected reference footage as reusable output
  material.
- Reference material may be analysed for pacing, hook structure, visual
  language, caption rhythm, editing patterns, storytelling structure and CTA
  treatment.
- Only owned, licensed, public-domain or explicitly authorised assets may enter
  final output.
- Every retrieved reference must preserve source, licence, rights, expiry,
  attribution and usage restrictions.

### End of every AAMP milestone

- Update relevant documentation.
- Review the complete diff.
- Run milestone-relevant tests.
- Run full repository validation only once at the end, and only when
  application code changed.
- Commit separately.
- Report only: commit hash, files changed, tests run, remaining limitations,
  and the exact next milestone.

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
  `apps/worker` is the Worker-side composition root: it may depend on
  `database`, `providers` and `agents` to construct the concrete collaborators
  `createWorkerActivities` injects, the same way `apps/api` does. It holds no
  business logic of its own.
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
pnpm typecheck     # turbo run typecheck across the workspace
pnpm lint          # turbo run lint
pnpm test          # turbo run test (Vitest)
pnpm build         # turbo run build
pnpm format:check  # prettier --check .
```

Dashboard end-to-end coverage: `pnpm --filter dashboard test:e2e` (Playwright;
builds and boots the app first — see `apps/dashboard/playwright.config.ts`).

`.github/workflows/ci.yml` runs exactly these commands on every push and pull
request — nothing else. Keep the two in step: a command added here belongs
there, and no deployment, secret, paid service or external infrastructure
belongs in that workflow.

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
