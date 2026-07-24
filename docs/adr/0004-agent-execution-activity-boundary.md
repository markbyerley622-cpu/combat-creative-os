# ADR-0004: Wire specialist-agent execution into a Temporal Activity boundary

Status: Accepted
Date: 2026-07-24

## Context

ADR-0003 implemented `packages/agent-runtime` (the `executeAgent` harness) and
eleven of fourteen `packages/agents` specialists, explicitly deferring "the
orchestrator wiring that turns `AgentRun` into a persisted `AgentInvocation`
row" to a later milestone (`docs/architecture.md` §8, M3/M4). Per
`docs/architecture.md` §2/§3.2, that wiring must live inside a Temporal
Activity — workflow files perform no I/O — and must enforce budget checks
before dispatch (§3.3) and record every invocation as an `AgentInvocation`
(§4.1).

This change builds that boundary: a Temporal Activity function that resolves
an agent from the canonical registry, checks budget, calls `executeAgent`,
and persists the outcome. It does **not** build `CampaignProductionWorkflow`
or sequence any agent inside a real workflow — that remains M3/M4's
sequencing work, out of this change's scope. This is the same kind of
explicit, documented milestone-order exception ADR-0003 made, one layer up:
the execution *boundary* now exists ahead of the full workflow that will
call it stage-by-stage.

## Decisions

1. **New `AgentInvocation` Prisma model** (`packages/database/prisma/schema.prisma`),
   matching `docs/architecture.md` §4.1's description (agent, definition
   version, model/provider, prompt version, input/output hashes, token
   usage, cost, attempt count, timestamps, correlation ids, typed failure).
   `workflowRunId` is a plain indexed string column, not a foreign key — no
   `WorkflowRun` table exists in this schema (architecture.md's ER diagram's
   `WorkflowRun` is Postgres's future queryable mirror of Temporal state, not
   yet implemented; see `docs/domain-model.md`). `(campaignId,
   idempotencyKey)` is unique, mirroring `CampaignTransitionAudit`'s existing
   idempotency mechanism. No live migration was created — this environment
   has no Docker/Postgres (see `docs/domain-model.md` §8); `pnpm db:generate`
   was run and succeeds without a live connection.
2. **`ExecuteSpecialistAgentInput`/`ExecuteSpecialistAgentOutput`** — new
   strict Zod contracts in `@combat/domain`
   (`packages/domain/src/agent-invocation-activity.ts`), distinct from the
   framework's own `AgentRun`/illustrative `AgentInput`/`AgentOutput`. A
   superset failure-reason enum adds `AGENT_NOT_FOUND` to `agent-runtime`'s
   `AgentFailureReason`, since an unregistered agent name can only ever be
   detected at this boundary, before any `AgentDefinition` exists.
3. **`createExecuteSpecialistAgentActivity(deps)`**
   (`packages/workflows/src/activities/execute-specialist-agent-activity.ts`)
   — a factory, not a bare function, so every dependency (agent registry,
   reasoning provider, three repository data sources, clock, attempt getter)
   is injected (requirement 10). Production wiring (pointing `agentRegistry`
   at `@combat/agents`'s `AGENT_REGISTRY` and the DB sources at a real Prisma
   client) is left to a future `apps/worker` change — `apps/worker` today is
   still an M0 readiness-server scaffold with no real Temporal Worker
   registration, and standing that up is explicitly out of this milestone's
   scope.
4. **Idempotency is keyed on `(campaignId, idempotencyKey)` alone, not
   `(campaignId, idempotencyKey, attempt)`.** The Activity's very first step
   looks up an existing `AgentInvocation` for that pair and returns it
   directly — without calling the reasoning provider again — if found. This
   is what makes a Temporal-level Activity retry (the same logical call,
   redelivered after a worker crash or timeout) idempotent: the caller
   supplies one idempotency key per logical invocation, and any number of
   physical retries of that same call collapse onto one persisted terminal
   row. A workflow that wants to give an agent a *genuinely new* attempt
   (e.g., after a retryable `PROVIDER_ERROR`) does so by calling the Activity
   again with a new idempotency key — a workflow-level decision, deferred to
   the M3/M4 sequencing work this ADR explicitly does not build.
   "Retry exhaustion" (one of the required persisted outcomes) is therefore
   `agent-runtime`'s own bounded corrective-reprompt retry (one retry on
   schema failure, already owned by `executeAgent`) reaching `SCHEMA_INVALID`
   — not a Temporal-attempt-counting mechanism this Activity would otherwise
   have to duplicate.
5. **Campaign ownership and stage-mismatch failures throw; they are not
   persisted as `AgentInvocation` rows.** Requirement 6's persisted-outcome
   list (success, schema-invalid, provider error, budget rejection,
   placeholder/unknown-agent rejection, retry exhaustion) deliberately does
   not include these two. A request scoped to the wrong workspace, or naming
   a stage the campaign isn't actually in, is an orchestrator bug — retrying
   it can never succeed, and there is no well-formed `(workspaceId,
   campaignId)` pairing to attribute an audit row to when the ownership
   check itself is what failed. `CampaignNotFoundError`/
   `CampaignStageMismatchError` are thrown; a real Temporal Worker
   registering this Activity should wrap them as
   `ApplicationFailure.nonRetryable` (left to the future `apps/worker` wiring
   in decision 3).
6. **Budget is checked at WORKSPACE, CAMPAIGN, and PROVIDER levels only, not
   SHOT.** `docs/domain-model.md` §8 already notes SHOT-level checks belong
   at generation-dispatch granularity inside a future `ShotGenerationWorkflow`
   Activity; a specialist-agent invocation in general isn't shot-scoped (e.g.
   `campaign-strategist` has no shot). `ExecuteSpecialistAgentInput`'s
   `budgetScope.shotId` is reserved, unused, groundwork for that future
   check. The pre-dispatch cost estimate reuses `agent-runtime`'s own
   `computeCost` against the resolved agent's `tokenBudget` ceiling (not a
   second cost model) and is trued up — charged at actual cost, remainder
   released — once `executeAgent` returns.
7. **Failure `details` are redacted (`agent-runtime`'s `redact()`) before
   being persisted**, not just before being logged. `executeAgent` already
   redacts what it logs, but a provider error's raw `details`/`cause` could
   still reach the database unredacted if the Activity persisted it
   verbatim — CLAUDE.md's "no secret ... is ever hardcoded or committed"
   applies to persisted data, not only log output.

## Consequences

- `packages/database`'s public API gains
  `agent-invocation-repository.ts` (`recordAgentInvocation`,
  `findAgentInvocationByIdempotencyKey`) and the `AgentInvocation` Prisma
  model with `Workspace`/`Campaign` back-relations.
- `packages/domain`'s public API gains `agent-invocation-activity.ts`.
- `packages/workflows` gains its first real (non-`ping`) Activity and its
  first dependencies on `@combat/agent-runtime`, `@combat/database`,
  `@combat/domain`, `@combat/observability`, and `@combat/providers` — all
  permitted by the existing `activities → agents, providers, media, database`
  / `agents → agent-runtime + domain` dependency rules. It does **not**
  depend on `@combat/agents` — the registry is injected, not imported,
  keeping the Activity itself agent-catalog-agnostic and fully testable
  without the real eleven production prompts.
- No workflow file changes. `ping-workflow.ts` remains the only workflow;
  `CampaignProductionWorkflow` is still unbuilt (M3/M4).
- No `apps/worker` change. The real Temporal Worker registration that would
  call `createExecuteSpecialistAgentActivity` with a live Prisma client and
  the real `AGENT_REGISTRY` remains future work.

## Alternatives considered

- **Bake Temporal's own attempt counter into the idempotency key** (`(...,
  attempt)`), so every physical retry gets a fresh shot at the reasoning
  provider automatically. Rejected: this would mean a worker crash/timeout
  immediately after a successful-but-unacknowledged provider call could
  cause a second real (potentially paid) provider call on redelivery —
  exactly what CLAUDE.md's idempotency-key rule exists to prevent. Keying on
  the caller-supplied key alone, with the workflow deciding when a *new*
  attempt is warranted, is the safer default.
- **Import `@combat/agents`'s `AGENT_REGISTRY` directly** instead of
  injecting it. Rejected: it would make every Activity-level test depend on
  the real eleven production prompts/schemas (and their `@combat/providers`
  import chain) and would violate requirement 10's DI mandate; injection
  costs one factory-function indirection and buys full test isolation.
