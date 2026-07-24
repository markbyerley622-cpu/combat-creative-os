import { describe, expect, it } from 'vitest';
import { computeCost } from './cost';

describe('computeCost', () => {
  it('computes integer micro-cents for a known model', () => {
    // claude-opus-4-8: $5/$25 per MTok -> 1000 in + 1000 out tokens = 0.005 + 0.025 = 0.03 USD = 3 cents
    const cost = computeCost('claude-opus-4-8', 1000, 1000);
    expect(cost.pricingKnown).toBe(true);
    expect(cost.costMicroCents).toBe(3 * 1_000_000);
  });

  it('is zero-cost for the mock model', () => {
    const cost = computeCost('mock-model', 1_000_000, 1_000_000);
    expect(cost.costMicroCents).toBe(0);
    expect(cost.pricingKnown).toBe(true);
  });

  it('falls back to a conservative rate and flags pricingKnown=false for an unrecognized model', () => {
    const known = computeCost('claude-opus-4-8', 1000, 1000);
    const unknown = computeCost('some-future-model', 1000, 1000);
    expect(unknown.pricingKnown).toBe(false);
    expect(unknown.costMicroCents).toBe(known.costMicroCents);
  });
});
