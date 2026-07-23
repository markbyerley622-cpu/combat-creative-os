/**
 * Claude API wrapper used by the future agent-runtime package. No real
 * Anthropic client is wired up yet (no business agents this milestone) — this
 * interface exists so packages/agents has a stable contract to build against
 * once agent implementations start.
 */
export interface ReasoningMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ReasoningInvokeInput {
  idempotencyKey: string;
  promptVersion: string;
  systemPrompt: string;
  messages: ReasoningMessage[];
}

export interface ReasoningModelMeta {
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export interface ReasoningProvider {
  readonly name: string;
  invoke(input: ReasoningInvokeInput): Promise<{ raw: string; modelMeta: ReasoningModelMeta }>;
}
