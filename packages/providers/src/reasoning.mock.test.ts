import { describe, expect, it } from 'vitest';
import { MockReasoningProvider } from './reasoning.mock';
import type { ReasoningInvokeInput } from './reasoning';

const baseInput: ReasoningInvokeInput = {
  idempotencyKey: 'run-1',
  promptVersion: '1',
  systemPrompt: 'system',
  messages: [{ role: 'user', content: 'hello world' }],
  outputSchema: { name: 'submit_agent_output', description: '', jsonSchema: {} },
  maxOutputTokens: 100,
  modelPolicy: { model: 'claude-opus-4-8', effort: 'medium', thinking: 'adaptive' },
};

describe('MockReasoningProvider', () => {
  it('performs no network I/O and returns a deterministic shape', async () => {
    const provider = new MockReasoningProvider();
    const first = await provider.invoke(baseInput);
    const second = await provider.invoke(baseInput);

    expect(first).toEqual(second);
    expect(JSON.parse(first.raw)).toEqual({ result: {}, reasoning: {} });
    expect(first.modelMeta.model).toBe('mock-model');
    expect(first.modelMeta.latencyMs).toBe(0);
  });

  it('counts tokens from multimodal text blocks without needing pixel understanding', async () => {
    const provider = new MockReasoningProvider();
    const { modelMeta } = await provider.invoke({
      ...baseInput,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'abc' },
            { type: 'image', mediaType: 'image/png', base64Data: 'ZmFrZQ==' },
          ],
        },
      ],
    });

    expect(modelMeta.tokensIn).toBe(3);
  });
});
