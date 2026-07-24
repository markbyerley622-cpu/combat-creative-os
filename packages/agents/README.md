# @combat/agents

The specialist-agent execution framework for Combat Creative OS. Every
specialist agent named in `docs/architecture.md` §6.1 is registered here as
one `AgentDefinition` built on `@combat/agent-runtime`'s `executeAgent`
harness — there is no ad hoc prompt/model/schema wiring anywhere else in the
codebase.

## Status

Eleven agents are fully implemented with production system prompts, Zod
input/output schemas, and tests. Three are typed, registered
`NOT_IMPLEMENTED` placeholders pending later provider/asset/compositing
milestones (see "Placeholders" below).

| Canonical id (registry key)      | Display label                  | Status         | Rubric? |
| -------------------------------- | ------------------------------ | -------------- | ------- |
| `campaign-strategist`            | Campaign Strategist            | ✅             |         |
| `creative-director`              | Creative Director              | ✅             |         |
| `script-timing-director`         | Script Director                | ✅             |         |
| `asset-manager`                  | Asset Manager                  | ⏳ placeholder |         |
| `shot-prompt-engineer`           | Shot Prompt Engineer           | ✅             |         |
| `video-generation-coordinator`   | Video Generation Coordinator   | ⏳ placeholder |         |
| `visual-quality-controller`      | Visual QA Controller           | ✅             | ✅      |
| `continuity-controller`          | Continuity Controller          | ✅             | ✅      |
| `motion-compositing-coordinator` | Motion-Compositing Coordinator | ⏳ placeholder |         |
| `edit-director`                  | Edit Director                  | ✅             |         |
| `sound-director`                 | Sound Director                 | ✅             |         |
| `final-qa-controller`            | Final QA Controller            | ✅             | ✅      |
| `variant-generator`              | Variant Generator              | ✅             |         |
| `performance-analyst`            | Performance Analyst            | ✅             |         |

`script-timing-director` and `visual-quality-controller` are the canonical
registry identifiers, preserved from the approved architecture; "Script
Director" and "Visual QA Controller" are `displayName` labels only — see
`docs/adr/0003-agent-execution-framework.md`.

**Partially wired up (ADR-0004).** `packages/workflows/src/activities/
execute-specialist-agent-activity.ts` now calls `executeAgent` through a
Temporal Activity, persists every terminal outcome as an `AgentInvocation`
(`packages/database`), and enforces WORKSPACE/CAMPAIGN/PROVIDER budget
checks before dispatch — but it takes the agent registry as an injected
dependency rather than importing `@combat/agents` directly, so this package
has no new caller yet. No `CampaignProductionWorkflow`/
`ShotGenerationWorkflow` exists to sequence agents stage-by-stage — that
remains later-milestone work per `docs/architecture.md` §8. The production
wiring that actually points that Activity's registry at this package's
`AGENT_REGISTRY` is a future `apps/worker` change.

## How it fits together

```
@combat/agent-runtime          (framework — no business logic)
  AgentDefinition, executeAgent, AgentRun, AgentFailure*, AgentEvaluation,
  PromptTemplate, ToolPolicy, ModelPolicy, TokenBudget, CostRecord

@combat/agents                 (this package — the 14 specialist agents)
  registry.ts                  SPECIALIST_AGENT_NAMES, AGENT_REGISTRY
  shared/                      shared rubrics + finding/criterion schemas
  <agent-name>/
    schema.ts                  Zod input/result schemas
    prompts/v1.ts               versioned PromptTemplate (v2.ts etc. for revisions)
    agent.ts                   the AgentDefinition, wired to the schemas + prompt
  fixtures/                    golden fixtures (Combat Reviews 15s ad)
```

A caller (a future Temporal Activity) does:

```ts
import { getAgentDefinition } from '@combat/agents';
import { executeAgent } from '@combat/agent-runtime';

const definition = getAgentDefinition('creative-director');
const run = await executeAgent(definition, agentInput, { reasoningProvider });

if (run.status !== 'SUCCEEDED') {
  // run.failure.reason / run.failure.retryable tell you what to do next —
  // never apply run.result, which is null on failure.
}
```

`executeAgent` (in `@combat/agent-runtime`) is the one place every agent's
reasoning call goes through:

1. Validates `input.input` against the agent's `inputSchema` — rejects
   malformed input before any provider call (requirement 1).
2. Forces a strict, schema-validated structured output from the reasoning
   provider via a single mandatory tool call (`tool_choice` forced, `strict:
true`) — requirement 3.
3. Validates the response against `resultSchema` wrapped with a shared
   `ReasoningBreakdown` (facts/decisions/assumptions/recommendations —
   requirement 11). On failure, retries **once** with a corrective re-prompt
   listing the exact validation errors; on a second failure, returns
   `status: 'FAILED'` with `failure.reason: 'SCHEMA_INVALID'` — never a
   silent best-effort guess (requirement 4).
4. Computes `inputHash`/`outputHash`, `cost` (from a per-model pricing
   table), and `latencyMs`, and logs a **redacted** record (requirement 15)
   via the caller-supplied logger.
5. Returns one `AgentRun` for every outcome — success or failure — so the
   orchestrator always has one shape to check `status` against before
   applying any state change (requirement 9). Agents never persist
   anything themselves (requirement 8). `@combat/agent-runtime`'s
   `toAgentOutput(run)` derives the narrower `@combat/domain` `AgentOutput<T>`
   envelope from an `AgentRun` for callers that only need that shape.

## Mock-agent testing (requirement 6)

`@combat/agent-runtime` exports `createQueuedReasoningProvider`, which
returns an exact, schema-valid response per call, in order — no network I/O,
fully deterministic. See `src/handoff.test.ts` for the pattern: it drives the
Combat Reviews 15-second-ad golden fixture (`src/fixtures/combat-reviews-15s.ts`)
through four real handoff stages — campaign-strategist → creative-director →
script-timing-director → shot-prompt-engineer — with every intermediate
value validated by the real schemas and no paid API called.

`@combat/providers`'s `ClaudeReasoningProvider` (the real Anthropic-backed
adapter) is never constructed by this package's automated tests — only by
whichever app wires up a real `ANTHROPIC_API_KEY` via `@combat/config`'s
`reasoningEnvSchema`, as an explicit, separate decision (CLAUDE.md
"Provider-adapter rules").

## Placeholders (`asset-manager`, `video-generation-coordinator`, `motion-compositing-coordinator`)

These three are registered with their canonical name and intended input/
output schema boundary (from `docs/architecture.md` §6.1), but
`implemented: false` and `disabledByDefault: true`. Calling `executeAgent` on
any of them throws a typed, non-retryable `AgentNotImplementedError` before
any reasoning-provider call is made — see `src/placeholder-agents.test.ts`.
Each records the milestone/dependency blocking its real implementation in
`futureMilestone`:

- `asset-manager` — needs a brand asset-library provider category not yet
  designed in `docs/architecture.md` §5.
- `video-generation-coordinator` — needs M6 (real video-gen provider
  dispatch/budget semantics).
- `motion-compositing-coordinator` — needs M9 (`MotionGraphicsProvider` +
  `DesignProvider` wiring).

## How to add a new specialist agent

There is no fifteenth slot in the approved architecture without an
architecture-doc change first (CLAUDE.md "Documentation expectations"). To
implement one of the three placeholders, or to add a new prompt version to
an existing agent:

1. **New prompt version** (not a new agent): add `prompts/v2.ts` next to
   the existing `prompts/v1.ts`, bump `version: 2`, and write a one-line
   `changelog` describing what changed. Update the agent's `agent.ts` to
   import `V2` instead of `V1`. Never edit a shipped version file in place —
   `PromptTemplate` files are append-only history (requirement 10).
2. **Implementing a placeholder**: in that agent's `agent.ts`, flip
   `implemented: true`, `disabledByDefault: false`, remove
   `futureMilestone`, and replace `definePlaceholderPrompt(...)` with a real
   `prompts/v1.ts` following the structure below. Update this README's status
   table and `docs/architecture.md` if the schema boundary changed from what
   §6.1 originally specified.
3. **Every prompt must contain these sections**, checked by
   `src/prompts.snapshot.test.ts`: `# Role`, `# Objective`, `# Input
Contract`, `# Output Contract`, `# Decision Rules`, `# Rejection Rules`,
   `# Escalation Rules`, `# Quality Rubric`, `# Prohibited Behavior`, `#
Reasoning Discipline`.
4. **QA-category agents** (anything that evaluates another agent's creative
   output) must set `rubric` (a `QualityRubric` from
   `packages/agents/src/shared/rubrics.ts` or a new one) and
   `deriveEvaluation`, and must never list their own name in
   `reviewsOutputOf` — `defineAgent` throws at import time if you do
   (requirement 12), and `registry.test.ts` asserts every QA agent has a
   rubric and every non-QA agent doesn't (requirement 13).
5. **Add the agent to `registry.ts`** — `AGENT_REGISTRY`, the re-export
   list, and (if genuinely new, not a placeholder graduating) `docs/
architecture.md` §6.1's table and the package tree in §1.
6. **Add schema-contract coverage**: one valid input/result sample in
   `src/schema-contract.test.ts`'s `VALID_SAMPLES`, and — if the agent sits
   in a handoff chain worth exercising end-to-end — extend
   `src/fixtures/combat-reviews-15s.ts` and `src/handoff.test.ts`.
7. Run `pnpm --filter @combat/agents test` (and `typecheck`/`lint`/`build`)
   before considering it done.

## Tests

- **Unit** — `@combat/agent-runtime`'s own test suite covers retry/schema-
  validation logic, cost computation, hashing, and redaction independent of
  any specific agent.
- **Schema** — `schema-contract.test.ts` proves every implemented agent's
  input/result schemas accept a valid sample and reject an empty object.
- **Integration / golden fixture** — `handoff.test.ts` drives the Combat
  Reviews 15-second-ad fixture through four real agent handoffs.
- **Snapshot** — `prompts.snapshot.test.ts` snapshots every agent's system
  prompt (catches accidental prompt edits) and asserts all ten required
  prompt sections are present.
- **Placeholder safety** — `placeholder-agents.test.ts` proves the three
  deferred agents cannot be executed accidentally.

No test in this package calls a paid API.
