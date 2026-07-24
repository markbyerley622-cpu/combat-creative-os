/**
 * A per-agent ceiling on token usage. `maxOutputTokens` is passed to the
 * reasoning provider as the hard `max_tokens` cap; `maxInputTokens` is a
 * soft budget the caller (a future Activity) should check the assembled
 * prompt against before dispatch, since the agent-runtime harness itself has
 * no access to a tokenizer without an extra network round trip.
 */
export interface TokenBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  maxInputTokens: 32_000,
  maxOutputTokens: 8_000,
};
