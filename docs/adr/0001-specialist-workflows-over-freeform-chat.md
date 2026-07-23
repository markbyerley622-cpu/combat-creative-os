# ADR-0001: Specialist orchestrated workflows instead of a free-form multi-agent chat system

Status: Proposed
Date: 2026-07-23

## Context

Combat Creative OS turns a structured campaign brief into a finished, multi-variant
video advertisement through fourteen distinct production stages, three of which
require binding human approval. Two architectures were considered:

1. **A free-form multi-agent chat system** — a set of agent personas (Strategist,
   Creative Director, Editor, etc.) conversing in a shared thread, with an
   orchestrating agent (or the agents themselves) deciding when to hand off, what
   to produce, and when the ad is "done."
2. **A deterministic orchestrator over specialist agents**, where a workflow engine
   (Temporal) drives an explicit state machine, each specialist agent is a
   stateless function with a strictly versioned schema for its input and output,
   and human approval gates are enforced by the workflow engine itself rather than
   by agent cooperation.

This system is production infrastructure for a commercial advertising pipeline: it
spends real money against third-party generation APIs, produces assets that ship
under a real brand, and is legally required to pass through human sign-off at
specific points. That context — not a preference for one agent framework over
another — is what settles this decision.

## Decision

Combat Creative OS will be built as **decision 2**: a Temporal-driven orchestrator
calling strictly-typed, schema-validated specialist agents, with human approval
gates enforced as durable workflow state, not as a step a conversational agent
chooses to take.

## Rationale

**Determinism and replayability.** Temporal (and any durable-execution model)
requires workflow code to be deterministic so it can be replayed from history after
a crash or deployment. A free-form chat loop — where the number of turns, their
content, and the termination condition all depend on model output — cannot give
that guarantee. A fixed state machine with bounded, explicit transitions can.

**Approval gates that cannot be bypassed.** The brief requires that concept
approval, shot selection, and final-master approval are non-negotiable checkpoints.
In a chat system, "ask for approval" is a behavior an agent performs, which means
it can also be a behavior an agent skips, hallucinates the result of, or gets
argued out of by another agent. In this design, the workflow literally cannot
transition past `CONCEPT_APPROVAL`, `SHOT_SELECTION`, or `FINAL_APPROVAL` without a
recorded Signal carrying an authorized user ID — it is a property of the engine,
not of agent behavior.

**Bounded cost.** Every stage of this pipeline can spend money (generation API
calls, render jobs) or tokens. A conversational multi-agent loop has no natural
stopping point beyond the agents' own judgment, which is a poor control for a
system with an explicit budget requirement. A fixed pipeline has a known number of
agent invocations per campaign, each individually budget-checked before dispatch.

**Schema boundaries catch drift immediately.** Handoff between specialists in a
chat system happens via one agent reading and interpreting another agent's
free-text output. Small drifts compound silently across a fourteen-stage pipeline.
Here, every agent's output is validated against a versioned Zod schema before
anything downstream touches it; a malformed handoff fails loudly at the boundary
where it occurred, not three stages later as a confusing artifact.

**Debuggability and auditability.** When a specific ad's final master has a defect,
the team needs to answer "what input produced this, at what stage, with which
prompt version, at what cost." A structured `AgentInvocation` log with typed
input/output tied to a workflow stage answers that directly. A chat transcript
requires re-reading a conversation and guessing which turn mattered.

**Independent testability.** Each specialist agent and each workflow stage can be
unit- and integration-tested in isolation with fixture inputs, because its contract
is a typed function signature, not "whatever emerges from conversation." This is
what makes the milestone plan in the architecture doc viable — each milestone ships
a testable slice. A chat-based system's behavior is emergent and much harder to
pin down in a test.

**Parallelism the pipeline actually needs.** Several stages (per-shot generation,
per-shot compositing, per-duration variant cutting) are naturally parallel,
independent units of work. Temporal child workflows model this directly. A
turn-based chat is inherently serial and would need its own ad hoc concurrency
model bolted on to get the same throughput.

## Consequences

- Adding a new specialist step means adding a new package with a schema and
  wiring it into the workflow state machine — slightly more upfront ceremony than
  adding a new chat persona, in exchange for the guarantees above.
- The orchestrator, not the agents, owns all sequencing and retry/escalation
  logic (§3.3 of the architecture doc). Agents are deliberately "dumber" than they
  would be in an autonomous framework — they reason over one bounded task and
  return structured output, nothing more.
- This rules out patterns like an agent autonomously deciding to skip a stage,
  re-invoke another agent directly, or invent a new stage at runtime. Any such
  need must be a deliberate change to the workflow definition and domain schema,
  reviewed like any other change to production infrastructure.
- Human-in-the-loop is a first-class citizen of the state machine (Signals), not
  an afterthought layered on top of agent output.

## Alternatives considered

- **Single autonomous "make an ad" agent** — rejected outright per the brief; no
  approval gates, no per-stage auditability, unbounded cost/behavior.
- **Free-form multi-agent chat (e.g., a shared-thread framework)** — rejected for
  the reasons above; well-suited to exploratory/creative tasks without financial
  or compliance stakes, poorly suited to durable, auditable, budget-constrained
  production infrastructure.
- **Hybrid: chat-based creative stages (Strategy/Concept), orchestrated pipeline
  for production stages** — considered and rejected for consistency: splitting the
  system into two different execution models doubles the operational surface
  (two ways to audit, two ways to test, two failure modes) for a benefit
  (marginally more "creative" brainstorming) that a well-designed Creative
  Director prompt can achieve within the same structured-output model.
