import type { Logger } from '@combat/observability';
import type { ReasoningProvider } from '@combat/providers';

/**
 * Execution-time dependencies for a single `executeAgent` call — distinct
 * from `@combat/domain`'s `AgentInputContext`, which is *data* the agent
 * reasons over (campaign id, budget remaining, prior artifacts). This is
 * infrastructure: which reasoning provider to call, where to log, and how to
 * measure time — supplied by the calling Activity, never by the agent
 * itself (CLAUDE.md: "Agents cannot mutate workflow state directly").
 */
export interface AgentExecutionContext {
  readonly reasoningProvider: ReasoningProvider;
  readonly logger?: Logger;
  /** Overridable for deterministic latency assertions in tests. Defaults to Date.now. */
  readonly now?: () => number;
}
