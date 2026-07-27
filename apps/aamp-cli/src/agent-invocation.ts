import { randomUUID } from 'node:crypto';

import { AGENT_REGISTRY } from '@combat/agents';
import { executeAgent, type AgentDefinition } from '@combat/agent-runtime';
import type { AgentInput } from '@combat/domain';
import type { ReasoningProvider } from '@combat/providers';

/**
 * One specialist-agent invocation, through the canonical registry.
 *
 * Extracted so the campaign path and the product-launch path invoke agents the
 * same way rather than growing two near-identical private helpers. It is
 * deliberately thin: look the definition up in `AGENT_REGISTRY`, wrap the input
 * in the standard envelope, call `executeAgent`, and fail loudly. It persists
 * nothing, sequences nothing and reserves no budget — that machinery belongs to
 * the Activity path, and duplicating it here would write ledger rows for a run
 * no workflow ever saw.
 */

export class AgentInvocationError extends Error {
  constructor(
    public readonly agentName: string,
    public readonly detail: string,
  ) {
    super(`Agent "${agentName}" failed: ${detail}`);
    this.name = 'AgentInvocationError';
  }
}

export interface AgentInvocationOptions {
  readonly reasoningProvider: ReasoningProvider;
  readonly workflowRunId: string;
  readonly campaignId: string;
  readonly stage: string;
  readonly onProgress?: (message: string) => void;
}

export interface AgentInvocationResult<TResult> {
  readonly result: TResult;
  /** `agent-name@vN` — which prompt version actually authored this output. */
  readonly agentVersion: string;
}

function envelope<T>(
  input: T,
  options: { workflowRunId: string; campaignId: string; stage: string; promptVersion: string },
): AgentInput<T> {
  return {
    invocationId: randomUUID(),
    workflowRunId: options.workflowRunId,
    stage: options.stage,
    promptVersion: options.promptVersion,
    input,
    context: {
      campaignId: options.campaignId,
      priorArtifactRefs: [],
      budgetRemainingCents: 0,
    },
  };
}

export async function invokeAgent<TInput, TResult>(
  agentName: string,
  input: TInput,
  options: AgentInvocationOptions,
): Promise<AgentInvocationResult<TResult>> {
  // The registry is keyed by the canonical agent-name union; callers look up by
  // string, so the widening happens here once rather than at every call site.
  const registry: Readonly<Record<string, AgentDefinition<unknown, unknown>>> = AGENT_REGISTRY;
  const definition = registry[agentName] as AgentDefinition<TInput, TResult> | undefined;
  if (!definition) throw new AgentInvocationError(agentName, 'not present in AGENT_REGISTRY');

  options.onProgress?.(`agent ${agentName} (prompt v${definition.promptVersion.version})`);

  const run = await executeAgent(
    definition,
    envelope(input, {
      workflowRunId: options.workflowRunId,
      campaignId: options.campaignId,
      stage: options.stage,
      promptVersion: String(definition.promptVersion.version),
    }),
    { reasoningProvider: options.reasoningProvider },
  );

  if (run.status !== 'SUCCEEDED' || run.result === null) {
    throw new AgentInvocationError(
      agentName,
      run.failure ? `${run.failure.reason}: ${run.failure.message}` : 'returned no result',
    );
  }
  return { result: run.result, agentVersion: `${agentName}@v${definition.promptVersion.version}` };
}
