import type { ReasoningInvokeInput, ReasoningModelMeta, ReasoningProvider } from '@combat/providers';

/**
 * Deterministic mock-agent responses for tests (requirement 6). Unlike
 * `@combat/providers`'s generic `MockReasoningProvider` (which doesn't know
 * any agent's output shape), this returns an exact, schema-valid response
 * per call, in order — the standard way to drive multi-stage agent-handoff
 * integration tests (campaign-strategist -> creative-director -> ...)
 * without any network I/O or non-determinism.
 *
 * Each queued entry is the *business result* only (`{ result, reasoning }`
 * is assembled here) — callers supply `result` (their agent's TResult
 * shape) and an optional partial `reasoning` breakdown.
 */
export interface QueuedAgentResponse {
  readonly result: unknown;
  readonly reasoning?: {
    readonly facts?: readonly string[];
    readonly decisions?: readonly string[];
    readonly assumptions?: readonly string[];
    readonly recommendations?: readonly string[];
  };
  readonly modelMeta?: Partial<ReasoningModelMeta>;
}

export class QueuedReasoningProvider implements ReasoningProvider {
  readonly name = 'queued-test-reasoning';
  private readonly queue: QueuedAgentResponse[];
  private cursor = 0;
  readonly calls: ReasoningInvokeInput[] = [];

  constructor(responses: readonly QueuedAgentResponse[]) {
    this.queue = [...responses];
  }

  async invoke(input: ReasoningInvokeInput): Promise<{ raw: string; modelMeta: ReasoningModelMeta }> {
    this.calls.push(input);
    const next = this.queue[this.cursor];
    if (!next) {
      throw new Error(
        `QueuedReasoningProvider: no response queued for call #${this.cursor + 1} (agent prompt version ${input.promptVersion})`,
      );
    }
    this.cursor += 1;
    return {
      raw: JSON.stringify({
        result: next.result,
        reasoning: {
          facts: next.reasoning?.facts ?? [],
          decisions: next.reasoning?.decisions ?? [],
          assumptions: next.reasoning?.assumptions ?? [],
          recommendations: next.reasoning?.recommendations ?? [],
        },
      }),
      modelMeta: {
        model: next.modelMeta?.model ?? 'mock-model',
        tokensIn: next.modelMeta?.tokensIn ?? 0,
        tokensOut: next.modelMeta?.tokensOut ?? 0,
        latencyMs: next.modelMeta?.latencyMs ?? 0,
      },
    };
  }
}

export function createQueuedReasoningProvider(
  responses: readonly QueuedAgentResponse[],
): QueuedReasoningProvider {
  return new QueuedReasoningProvider(responses);
}
