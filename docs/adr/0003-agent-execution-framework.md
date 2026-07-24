# ADR-0003: Implement the specialist-agent execution framework ahead of strict milestone order

Status: Accepted
Date: 2026-07-24

## Context

`docs/architecture.md` §8 lays out M0-M14 as an ordered milestone plan, and
CLAUDE.md's preamble stated the current milestone as "repository foundation
and local infrastructure only... No specialist agent... is implemented yet."
`packages/agents` and `packages/agent-runtime` (referenced but not yet
scaffolded) were explicitly out of scope until M2.

A direct request was made to implement the full specialist-agent execution
framework now: `AgentDefinition`/`AgentExecutionContext`/`AgentRun`/
`AgentFailure`/`AgentEvaluation`/`PromptTemplate`/`ToolPolicy`/`ModelPolicy`/
`TokenBudget`/`CostRecord`, production system prompts for eleven named
agents, and golden-fixture tests proving handoffs work — i.e., most of M2
(agent runtime harness) plus the agent-authoring portion of M4/M6/M7/M9/M10/
M11/M12/M13, without their accompanying workflow/Activity/database wiring.

Separately, the request's list of eleven agents didn't match
`docs/architecture.md` §6.1's approved list of fourteen: it renamed
`script-timing-director` -> "script-director" and
`visual-quality-controller` -> "visual-qa-controller", and omitted
`asset-manager`, `video-generation-coordinator`, and
`motion-compositing-coordinator` entirely.

## Decision

1. **Implement the framework and eleven agents now**, as a deliberate,
   explicit milestone-order exception — not a silent scope creep. This ADR
   is that record, per CLAUDE.md "Documentation expectations" ("a decision
   that reverses or narrows something the architecture doc states as
   resolved gets a note in §7 or a new ADR").
2. **Preserve all fourteen canonical registry identities** from the approved
   architecture (`packages/agents/src/registry.ts`'s `SPECIALIST_AGENT_NAMES`
   is unchanged). `script-timing-director` and `visual-quality-controller`
   remain the canonical ids; "Script Director" and "Visual QA Controller"
   are `displayName` labels only, satisfying the request's naming without
   renaming or aliasing the underlying identifier.
3. **The three agents outside the requested eleven — `asset-manager`,
   `video-generation-coordinator`, `motion-compositing-coordinator` — are
   registered as typed, NOT_IMPLEMENTED placeholders**, not silently
   dropped and not stubbed with fake success:
   - `implemented: false`, `disabledByDefault: true` on their
     `AgentDefinition`.
   - `executeAgent` (in `@combat/agent-runtime`) throws a typed,
     non-retryable `AgentNotImplementedError` for any definition with
     `implemented: false`, before any reasoning-provider call is attempted —
     so a placeholder can never return a mocked success in production or in
     a test that forgets it's a placeholder.
   - Each records the specific milestone/dependency blocking its real
     implementation in `futureMilestone` (see `packages/agents/README.md`'s
     placeholder table).
   - Each keeps its canonical name and the input/output schema boundary
     `docs/architecture.md` §6.1 already specified, so a later milestone
     implements against an agreed contract instead of inventing one.
   - `placeholder-agents.test.ts` proves all three cannot be executed
     accidentally.
4. **No duplicate/renamed agents were created.** There is exactly one
   `AgentDefinition` per canonical name; the display-label rename request is
   satisfied entirely through `displayName`, never through a second
   registry entry.
5. **`docs/architecture.md` is not rewritten** — its §6.1 table, §8
   milestone plan, and package tree stand as approved. This ADR documents
   an execution-order exception (agent logic built early, orchestrator
   wiring still pending), not a reversal of any architectural decision.

## Consequences

- `packages/agent-runtime` is a new package (previously deferred per
  §7.1 item 0). `packages/agents` gained real dependencies on it and on
  `@combat/providers`.
- `@combat/domain`'s `AgentInput<T>` gained an optional `attachments` field
  (multimodal image content) — additive, not a breaking change to the
  existing envelope shape.
- `@combat/providers`'s `ReasoningProvider` interface changed shape
  (`outputSchema`, `maxOutputTokens`, `modelPolicy` on the invoke input;
  multimodal content blocks on messages) to support strict structured
  output and future image/frame assessment. `reasoning.mock.ts` was updated
  to match; a real `ClaudeReasoningProvider` (`reasoning.claude.ts`) was
  added alongside it, gated behind an explicit `ANTHROPIC_API_KEY` via
  `@combat/config`'s new `reasoningEnvSchema` (default `REASONING_PROVIDER=
mock`, so local dev/CI still need zero paid API keys).
- No Temporal workflow, Activity, or database repository was added or
  changed to call these agents — that remains M3/M4/M6/M7/M9/M10/M11/M12/
  M13's workflow-wiring scope, not this change's. `AgentRun` (this
  framework's output) and the eventual `AgentInvocation` database row
  (architecture.md §4.1) are not yet connected; a future Activity is
  responsible for persisting one from the other.
- `packages/agents/README.md` documents current status, the framework's
  mechanics, and how to add a new agent or implement a placeholder.

## Alternatives considered

- **Replace the registry with exactly the requested eleven names** (renaming
  the two and dropping the three) — rejected: this would have been a real
  architecture reversal requiring its own justification, and would have
  discarded schema/prompt work three later milestones (M6, M9) already
  depend on having a named slot for.
- **Implement only the eleven, leaving the other three untouched in the old
  scaffold-only registry** — rejected: `docs/architecture.md` §6.1 already
  gives all fourteen agents an input/output contract; leaving three as bare
  names with no schema boundary would let a future implementer invent one
  from scratch instead of building against the agreed contract, and would
  leave the registry file half-migrated to the new `AgentDefinition` shape
  and half not.
