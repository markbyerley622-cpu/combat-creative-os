import type {
  ReasoningContentBlock,
  ReasoningInvokeInput,
  ReasoningMessage,
  ReasoningModelMeta,
  ReasoningProvider,
} from './reasoning';

interface AnthropicContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface AnthropicToolUseBlock extends AnthropicContentBlock {
  readonly type: 'tool_use';
  readonly input: unknown;
}

interface AnthropicMessageResponse {
  readonly model: string;
  readonly content: readonly AnthropicContentBlock[];
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/**
 * The minimal surface of `@anthropic-ai/sdk`'s `Anthropic` client this
 * adapter needs. Kept as a small structural interface (rather than importing
 * the SDK's own types directly here) so tests can inject a fake without a
 * network dependency; a real `Anthropic` instance satisfies this shape
 * without any adaptation — see `createClaudeReasoningProvider`, the only
 * place that actually imports `@anthropic-ai/sdk`.
 */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessageResponse>;
  };
}

const OUTPUT_TOOL_STRICT = true;

/**
 * Real Anthropic-backed `ReasoningProvider`. Forces a strict tool schema for
 * every call (requirement 3 — "Use Claude Structured Outputs or strict tool
 * schemas") via `tool_choice: {type: 'tool', name: ...}`, so the model
 * cannot respond with free text instead of the required structure.
 *
 * Per CLAUDE.md ("Do not connect a real video-generation provider ... or
 * spend money through one without an explicit, separate decision"), this
 * class is never constructed by the automated test suite — only
 * `MockReasoningProvider` is. Constructing it for real use requires an
 * explicit `ANTHROPIC_API_KEY`, read only via `@combat/config`'s validated
 * env schema (never `process.env` directly) by whichever app wires it up.
 */
export class ClaudeReasoningProvider implements ReasoningProvider {
  readonly name = 'claude';

  constructor(private readonly client: AnthropicMessagesClient) {}

  async invoke(input: ReasoningInvokeInput): Promise<{ raw: string; modelMeta: ReasoningModelMeta }> {
    const start = Date.now();
    const tool = {
      name: input.outputSchema.name,
      description: input.outputSchema.description,
      input_schema: input.outputSchema.jsonSchema,
      strict: OUTPUT_TOOL_STRICT,
    };

    const response = await this.client.messages.create({
      model: input.modelPolicy.model,
      max_tokens: input.maxOutputTokens,
      system: input.systemPrompt,
      thinking: input.modelPolicy.thinking === 'adaptive' ? { type: 'adaptive' } : { type: 'disabled' },
      output_config: { effort: input.modelPolicy.effort },
      messages: input.messages.map(toAnthropicMessage),
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    });

    const toolUse = response.content.find(
      (block): block is AnthropicToolUseBlock => block.type === 'tool_use',
    );
    if (!toolUse) {
      throw new Error(
        `Claude response for prompt version ${input.promptVersion} contained no tool_use block for tool "${tool.name}"`,
      );
    }

    return {
      raw: JSON.stringify(toolUse.input),
      modelMeta: {
        model: response.model,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        latencyMs: Date.now() - start,
      },
    };
  }
}

function toAnthropicMessage(message: ReasoningMessage): Record<string, unknown> {
  return {
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map(toAnthropicContentBlock),
  };
}

function toAnthropicContentBlock(block: ReasoningContentBlock): Record<string, unknown> {
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: block.mediaType, data: block.base64Data },
  };
}

/**
 * Constructs a `ClaudeReasoningProvider` backed by the real `@anthropic-ai/sdk`
 * client. This is the only function in this package that imports the SDK —
 * kept isolated so `ClaudeReasoningProvider` itself stays testable without a
 * network dependency (see `AnthropicMessagesClient` above).
 */
export async function createClaudeReasoningProvider(apiKey: string): Promise<ClaudeReasoningProvider> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  // The real SDK's `messages.create` overloads require a fully-typed params
  // object (streaming vs non-streaming variants); this adapter narrows that
  // down to the minimal shape `AnthropicMessagesClient` declares, isolating
  // the one necessary type assertion to this single call site.
  const adapter: AnthropicMessagesClient = {
    messages: {
      create: (params) =>
        client.messages.create(
          params as unknown as Parameters<typeof client.messages.create>[0],
        ) as unknown as Promise<AnthropicMessageResponse>,
    },
  };
  return new ClaudeReasoningProvider(adapter);
}
