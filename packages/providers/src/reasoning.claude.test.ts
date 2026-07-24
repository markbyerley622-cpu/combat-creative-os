import { describe, expect, it, vi } from 'vitest';
import { ClaudeReasoningProvider, type AnthropicMessagesClient } from './reasoning.claude';
import type { ReasoningInvokeInput } from './reasoning';

function buildInput(overrides: Partial<ReasoningInvokeInput> = {}): ReasoningInvokeInput {
  return {
    idempotencyKey: 'run-1',
    promptVersion: '1',
    systemPrompt: 'You are a test agent.',
    messages: [{ role: 'user', content: 'do the thing' }],
    outputSchema: {
      name: 'submit_agent_output',
      description: 'test schema',
      jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    maxOutputTokens: 1024,
    modelPolicy: { model: 'claude-opus-4-8', effort: 'medium', thinking: 'adaptive' },
    ...overrides,
  };
}

describe('ClaudeReasoningProvider', () => {
  it('forces a strict tool_choice and returns the tool_use input as raw JSON', async () => {
    const create = vi.fn().mockResolvedValue({
      model: 'claude-opus-4-8',
      usage: { input_tokens: 42, output_tokens: 7 },
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'submit_agent_output', input: { result: { ok: true }, reasoning: {} } }],
    });
    const client: AnthropicMessagesClient = { messages: { create } };
    const provider = new ClaudeReasoningProvider(client);

    const { raw, modelMeta } = await provider.invoke(buildInput());

    expect(JSON.parse(raw)).toEqual({ result: { ok: true }, reasoning: {} });
    expect(modelMeta).toEqual({ model: 'claude-opus-4-8', tokensIn: 42, tokensOut: 7, latencyMs: expect.any(Number) });

    const callArgs = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs['tool_choice']).toEqual({ type: 'tool', name: 'submit_agent_output' });
    expect((callArgs['tools'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: 'submit_agent_output',
      strict: true,
    });
  });

  it('throws when the response contains no tool_use block', async () => {
    const create = vi.fn().mockResolvedValue({
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: 'I refuse to use the tool.' }],
    });
    const provider = new ClaudeReasoningProvider({ messages: { create } });

    await expect(provider.invoke(buildInput())).rejects.toThrow(/no tool_use block/);
  });

  it('serializes multimodal image content blocks', async () => {
    const create = vi.fn().mockResolvedValue({
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'submit_agent_output', input: {} }],
    });
    const provider = new ClaudeReasoningProvider({ messages: { create } });

    await provider.invoke(
      buildInput({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'assess this frame' },
              { type: 'image', mediaType: 'image/png', base64Data: 'ZmFrZQ==' },
            ],
          },
        ],
      }),
    );

    const callArgs = create.mock.calls[0]![0] as { messages: Array<{ content: unknown }> };
    expect(callArgs.messages[0]!.content).toEqual([
      { type: 'text', text: 'assess this frame' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
    ]);
  });
});
