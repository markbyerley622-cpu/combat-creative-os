import type { ReasoningInvokeInput, ReasoningModelMeta, ReasoningProvider } from './reasoning';

export class MockReasoningProvider implements ReasoningProvider {
  readonly name = 'mock-reasoning';

  async invoke(
    input: ReasoningInvokeInput,
  ): Promise<{ raw: string; modelMeta: ReasoningModelMeta }> {
    const lastUserMessage = [...input.messages].reverse().find((m) => m.role === 'user');
    return {
      raw: JSON.stringify({
        echo: lastUserMessage?.content ?? '',
        promptVersion: input.promptVersion,
      }),
      modelMeta: {
        model: 'mock-model',
        tokensIn: lastUserMessage?.content.length ?? 0,
        tokensOut: 0,
        latencyMs: 0,
      },
    };
  }
}
