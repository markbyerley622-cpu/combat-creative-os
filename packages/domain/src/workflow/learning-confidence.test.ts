import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LearningEvidence } from '../schemas/learning-record';
import {
  CONFIDENCE_THRESHOLDS,
  deriveLearningConfidence,
  normalizePerformanceMetrics,
  validateRawMetrics,
} from './learning-confidence';

function evidence(impressions: number): LearningEvidence {
  return {
    performanceObservationId: randomUUID(),
    campaignId: randomUUID(),
    platform: 'TIKTOK',
    impressions,
  };
}

describe('validateRawMetrics', () => {
  it('accepts internally consistent counters', () => {
    expect(
      validateRawMetrics({
        impressions: 10_000,
        reach: 8_000,
        clicks: 400,
        completions: 6_000,
        conversions: 40,
        spendCents: 20_000,
      }),
    ).toEqual([]);
  });

  it.each([
    ['reach above impressions', { reach: 20_000 }, 'REACH_EXCEEDS_IMPRESSIONS'],
    ['clicks above impressions', { clicks: 20_000 }, 'CLICKS_EXCEED_IMPRESSIONS'],
    ['completions above impressions', { completions: 20_000 }, 'COMPLETIONS_EXCEED_IMPRESSIONS'],
    ['conversions above clicks', { conversions: 5_000 }, 'CONVERSIONS_EXCEED_CLICKS'],
  ])('rejects %s', (_label, override, code) => {
    const violations = validateRawMetrics({
      impressions: 10_000,
      reach: 8_000,
      clicks: 400,
      completions: 6_000,
      conversions: 40,
      spendCents: 20_000,
      ...override,
    });

    expect(violations.map((v) => v.code)).toContain(code);
  });

  it('rejects spend recorded against zero impressions', () => {
    const violations = validateRawMetrics({
      impressions: 0,
      clicks: 0,
      conversions: 0,
      spendCents: 5_000,
    });

    expect(violations.map((v) => v.code)).toContain('SPEND_WITHOUT_IMPRESSIONS');
  });
});

describe('normalizePerformanceMetrics', () => {
  it('derives every rate from the counters', () => {
    const normalized = normalizePerformanceMetrics({
      impressions: 10_000,
      reach: 8_000,
      clicks: 500,
      completions: 4_000,
      conversions: 50,
      spendCents: 25_000,
    });

    expect(normalized.clickThroughRate).toBeCloseTo(0.05);
    expect(normalized.completionRate).toBeCloseTo(0.4);
    expect(normalized.conversionRate).toBeCloseTo(0.1);
    expect(normalized.costPerClickCents).toBe(50);
    expect(normalized.costPerConversionCents).toBe(500);
  });

  it('leaves a rate undefined rather than 0 when its denominator is zero', () => {
    const normalized = normalizePerformanceMetrics({
      impressions: 0,
      clicks: 0,
      conversions: 0,
      spendCents: 0,
    });

    // "No data yet" must stay distinguishable from "genuinely zero".
    expect(normalized.clickThroughRate).toBeUndefined();
    expect(normalized.conversionRate).toBeUndefined();
    expect(normalized.costPerClickCents).toBeUndefined();
    expect(normalized.costPerConversionCents).toBeUndefined();
  });

  it('omits completionRate entirely when completions were not reported', () => {
    const normalized = normalizePerformanceMetrics({
      impressions: 1_000,
      clicks: 10,
      conversions: 1,
      spendCents: 500,
    });

    expect(normalized.completions).toBeUndefined();
    expect(normalized.completionRate).toBeUndefined();
  });

  it('is deterministic for the same fixture input', () => {
    const raw = { impressions: 7_777, clicks: 333, conversions: 11, spendCents: 4_321 };
    expect(normalizePerformanceMetrics(raw)).toEqual(normalizePerformanceMetrics(raw));
  });
});

describe('deriveLearningConfidence — low evidence can never yield a confident claim', () => {
  it('a single observation is always LOW, however large', () => {
    const derivation = deriveLearningConfidence([evidence(10_000_000)]);

    expect(derivation.confidence).toBe('LOW');
    expect(derivation.observationCount).toBe(1);
    expect(derivation.rationale).toContain('below the MEDIUM thresholds');
  });

  it('many thin observations are still LOW', () => {
    const derivation = deriveLearningConfidence([
      evidence(10),
      evidence(10),
      evidence(10),
      evidence(10),
      evidence(10),
    ]);

    expect(derivation.confidence).toBe('LOW');
    expect(derivation.totalImpressions).toBe(50);
  });

  it('reaches MEDIUM only once both thresholds are met', () => {
    const { medium } = CONFIDENCE_THRESHOLDS;
    const perObservation = medium.minImpressions / medium.minObservations;

    const justUnder = deriveLearningConfidence([
      evidence(perObservation - 1),
      evidence(perObservation),
    ]);
    const atThreshold = deriveLearningConfidence([
      evidence(perObservation),
      evidence(perObservation),
    ]);

    expect(justUnder.confidence).toBe('LOW');
    expect(atThreshold.confidence).toBe('MEDIUM');
  });

  it('reaches HIGH only with a genuinely repeated, high-volume result', () => {
    const { high } = CONFIDENCE_THRESHOLDS;
    const perObservation = high.minImpressions / high.minObservations;

    const tooFewObservations = deriveLearningConfidence([
      evidence(high.minImpressions),
      evidence(high.minImpressions),
    ]);
    const enough = deriveLearningConfidence(
      Array.from({ length: high.minObservations }, () => evidence(perObservation)),
    );

    // Volume alone is not enough — the result has to repeat.
    expect(tooFewObservations.confidence).toBe('MEDIUM');
    expect(enough.confidence).toBe('HIGH');
    expect(enough.rationale).toContain('HIGH thresholds');
  });

  it('reports the exact counts the band was derived from', () => {
    const derivation = deriveLearningConfidence([evidence(100), evidence(250)]);

    expect(derivation.observationCount).toBe(2);
    expect(derivation.totalImpressions).toBe(350);
  });
});
