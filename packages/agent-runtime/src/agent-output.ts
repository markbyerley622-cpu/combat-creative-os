import type { AgentOutput, AgentValidationStatus } from '@combat/domain';
import type { AgentRun } from './agent-run';

/**
 * Bridges the harness's own `AgentRun<TResult>` (the rich, persistable
 * record — cost, hashes, evaluation) back to `@combat/domain`'s originally
 * scaffolded `AgentOutput<T>` envelope, for any caller that only needs the
 * architecture.md §6 shape (e.g. a future `apps/api` read model). `AgentRun`
 * is the source of truth `executeAgent` returns; this is a derived,
 * narrower view, not a second parallel result type.
 */
export function toAgentOutput<TResult>(run: AgentRun<TResult>): AgentOutput<TResult> {
  return {
    invocationId: run.invocationId,
    output: run.result,
    rationale: run.reasoning?.recommendations.join(' '),
    modelMeta: {
      model: run.modelMeta.model,
      tokensIn: run.modelMeta.tokensIn,
      tokensOut: run.modelMeta.tokensOut,
      latencyMs: run.modelMeta.latencyMs,
    },
    validationStatus: toValidationStatus(run),
  };
}

function toValidationStatus<TResult>(run: AgentRun<TResult>): AgentValidationStatus {
  if (run.status === 'SUCCEEDED') return 'VALID';
  if (run.failure?.reason === 'SCHEMA_INVALID') return 'SCHEMA_INVALID';
  return 'NEEDS_HUMAN_REVIEW';
}
