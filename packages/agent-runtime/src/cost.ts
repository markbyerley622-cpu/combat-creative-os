/**
 * Persisted alongside every `AgentRun` (requirement 5 — "estimated cost").
 * Amounts are in integer micro-cents (1 / 1,000,000 of a US cent) to avoid
 * floating-point drift when summing many small invocations into a budget
 * ledger (see `packages/domain`'s `BudgetLedgerEntry`, whose `amountCents`
 * a future Activity derives from this by rounding).
 */
export interface CostRecord {
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroCents: number;
  /** false when `model` wasn't in the pricing table and a fallback rate was used. */
  readonly pricingKnown: boolean;
}

interface PricePerMillionTokensUsd {
  readonly input: number;
  readonly output: number;
}

/** USD per million tokens, cached from the Claude API pricing table. */
const PRICING_USD_PER_MTOK: Record<string, PricePerMillionTokensUsd> = {
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'mock-model': { input: 0, output: 0 },
};

const FALLBACK_PRICE: PricePerMillionTokensUsd = PRICING_USD_PER_MTOK['claude-opus-4-8']!;

export function computeCost(model: string, tokensIn: number, tokensOut: number): CostRecord {
  const price = PRICING_USD_PER_MTOK[model];
  const usd = price ?? FALLBACK_PRICE;
  const costUsd = (tokensIn / 1_000_000) * usd.input + (tokensOut / 1_000_000) * usd.output;
  return {
    model,
    tokensIn,
    tokensOut,
    costMicroCents: Math.round(costUsd * 100 * 1_000_000),
    pricingKnown: price !== undefined,
  };
}
