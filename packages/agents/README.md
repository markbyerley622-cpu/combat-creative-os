# @combat/agents

Scaffolding only. No specialist agent (Campaign Strategist, Creative Director,
etc.) is implemented in this milestone — see `docs/architecture.md` §6 and the
2026-07-23 scaffolding plan for why that's deliberately out of scope here.

This package currently holds:

- `registry.ts` — the fourteen specialist agent names/slots.
- `agent-contract.ts` — the handler type future agent implementations must satisfy.

The `agent-runtime` harness (prompt versioning, schema-validated invoke,
retry-with-corrective-reprompt, audit logging — architecture.md §6) is also a
later milestone; agent implementations will be built on top of it once it
exists.
