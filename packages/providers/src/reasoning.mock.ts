import type { ReasoningInvokeInput, ReasoningModelMeta, ReasoningProvider } from './reasoning';

/**
 * Deterministic, no-network default for local dev and CI (CLAUDE.md:
 * "Mocks perform no real network I/O and must be deterministic"). Returns
 * whatever `input.outputSchema`'s caller expects only if the caller supplies
 * canned responses via `responses` — with none queued it falls back to an
 * empty-ish echo shape, which is enough to exercise wiring/latency/token
 * bookkeeping in tests that don't care about the actual structured content.
 *
 * For tests that need schema-valid, per-agent responses (golden fixtures,
 * multi-stage handoffs), prefer `@combat/agent-runtime`'s
 * `createQueuedReasoningProvider`, which implements this same interface with
 * an exact response queued per call.
 */
export class MockReasoningProvider implements ReasoningProvider {
  readonly name = 'mock-reasoning';

  async invoke(
    input: ReasoningInvokeInput,
  ): Promise<{ raw: string; modelMeta: ReasoningModelMeta }> {
    const lastUserMessage = [...input.messages].reverse().find((m) => m.role === 'user');
    const textLength =
      typeof lastUserMessage?.content === 'string'
        ? lastUserMessage.content.length
        : (lastUserMessage?.content ?? [])
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .reduce((sum, block) => sum + block.text.length, 0);

    return {
      raw: JSON.stringify({ result: {}, reasoning: {} }),
      modelMeta: {
        model: 'mock-model',
        tokensIn: textLength,
        tokensOut: 0,
        latencyMs: 0,
      },
    };
  }
}
