/**
 * Historical entry point for "the shape every specialist agent must
 * implement." That shape is now `@combat/agent-runtime`'s `executeAgent`
 * applied to an `AgentDefinition` from `./registry` — there is no longer a
 * bespoke per-agent handler function to implement. Re-exported here so
 * existing imports of `@combat/agents`'s `agent-contract` module keep
 * resolving to the current framework instead of a stale, unused type.
 */
export { executeAgent, defineAgent } from '@combat/agent-runtime';
export type { AgentDefinition, AgentRun } from '@combat/agent-runtime';
