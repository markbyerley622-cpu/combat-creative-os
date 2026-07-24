/**
 * Claude API wrapper used by `@combat/agent-runtime`. `reasoning.mock.ts` is
 * the deterministic default for local dev/tests; `reasoning.claude.ts` is the
 * real Anthropic-backed adapter, gated behind an explicit `ANTHROPIC_API_KEY`
 * and never exercised by the automated test suite (CLAUDE.md: "Do not
 * connect a real ... provider or spend money through one without an
 * explicit, separate decision" — here that decision is per-request, made by
 * whichever caller constructs `ClaudeReasoningProvider`, not by test code).
 */
export interface ReasoningTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Base64-encoded image content — the multimodal path requirement 14 asks
 * for ("Support multimodal inputs for future image and video-frame
 * assessment"), used by visual-quality-controller/final-qa-controller to
 * attach generated frames/thumbnails to a QC request.
 */
export interface ReasoningImageBlock {
  readonly type: 'image';
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly base64Data: string;
}

export type ReasoningContentBlock = ReasoningTextBlock | ReasoningImageBlock;

export interface ReasoningMessage {
  readonly role: 'user' | 'assistant';
  /** A plain string is shorthand for a single text block. */
  readonly content: string | readonly ReasoningContentBlock[];
}

export interface ReasoningOutputSchema {
  readonly name: string;
  readonly description: string;
  /** A strict JSON Schema — see `@combat/agent-runtime`'s `toStrictJsonSchema`. */
  readonly jsonSchema: Record<string, unknown>;
}

export interface ReasoningModelPolicyHint {
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly thinking: 'adaptive' | 'disabled';
}

export interface ReasoningInvokeInput {
  readonly idempotencyKey: string;
  readonly promptVersion: string;
  readonly systemPrompt: string;
  readonly messages: readonly ReasoningMessage[];
  readonly outputSchema: ReasoningOutputSchema;
  readonly maxOutputTokens: number;
  readonly modelPolicy: ReasoningModelPolicyHint;
}

export interface ReasoningModelMeta {
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
}

export interface ReasoningProvider {
  readonly name: string;
  /** `raw` is the JSON-serialized structured output (the tool call's input), not free text. */
  invoke(input: ReasoningInvokeInput): Promise<{ raw: string; modelMeta: ReasoningModelMeta }>;
}
