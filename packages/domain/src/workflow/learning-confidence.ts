import type {
  NormalizedPerformanceMetrics,
  RawPerformanceMetrics,
} from '../schemas/performance-observation';
import type { LearningConfidence, LearningEvidence } from '../schemas/learning-record';

/**
 * M13 — deterministic, I/O-free normalization and confidence derivation. These
 * are the two places the learning loop refuses to take a claim at face value:
 * rates are computed from counters rather than accepted from a caller, and
 * confidence is computed from how much closed data actually backs an insight
 * rather than asserted by the agent that wrote it.
 *
 * Pure and exported so both are unit-testable against fixture metrics without
 * a provider, workflow or database.
 */

export const PERFORMANCE_METRIC_VIOLATIONS = [
  'REACH_EXCEEDS_IMPRESSIONS',
  'CLICKS_EXCEED_IMPRESSIONS',
  'COMPLETIONS_EXCEED_IMPRESSIONS',
  'CONVERSIONS_EXCEED_CLICKS',
  'SPEND_WITHOUT_IMPRESSIONS',
] as const;
export type PerformanceMetricViolationCode = (typeof PERFORMANCE_METRIC_VIOLATIONS)[number];

export interface PerformanceMetricViolation {
  readonly code: PerformanceMetricViolationCode;
  readonly detail: string;
}

/**
 * Rejects internally inconsistent counters before they can be normalized into
 * a plausible-looking but impossible rate (a 300% CTR, conversions with no
 * clicks). Zod already guarantees each field is a non-negative integer; this
 * checks the relationships between them.
 */
export function validateRawMetrics(raw: RawPerformanceMetrics): PerformanceMetricViolation[] {
  const violations: PerformanceMetricViolation[] = [];
  if (raw.reach !== undefined && raw.reach > raw.impressions) {
    violations.push({
      code: 'REACH_EXCEEDS_IMPRESSIONS',
      detail: `reach ${raw.reach} exceeds impressions ${raw.impressions}`,
    });
  }
  if (raw.clicks > raw.impressions) {
    violations.push({
      code: 'CLICKS_EXCEED_IMPRESSIONS',
      detail: `clicks ${raw.clicks} exceed impressions ${raw.impressions}`,
    });
  }
  if (raw.completions !== undefined && raw.completions > raw.impressions) {
    violations.push({
      code: 'COMPLETIONS_EXCEED_IMPRESSIONS',
      detail: `completions ${raw.completions} exceed impressions ${raw.impressions}`,
    });
  }
  if (raw.conversions > raw.clicks) {
    violations.push({
      code: 'CONVERSIONS_EXCEED_CLICKS',
      detail: `conversions ${raw.conversions} exceed clicks ${raw.clicks}`,
    });
  }
  if (raw.spendCents > 0 && raw.impressions === 0) {
    violations.push({
      code: 'SPEND_WITHOUT_IMPRESSIONS',
      detail: `spend ${raw.spendCents} recorded against zero impressions`,
    });
  }
  return violations;
}

/** `numerator / denominator`, or undefined when the denominator is zero — never 0. */
function rate(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

function costPer(spendCents: number, count: number): number | undefined {
  return count > 0 ? Math.round(spendCents / count) : undefined;
}

/**
 * Derives comparable rates from validated counters. A rate whose denominator is
 * zero stays `undefined` rather than collapsing to 0, so "not enough data yet"
 * is structurally distinguishable from "genuinely zero" everywhere downstream.
 */
export function normalizePerformanceMetrics(
  raw: RawPerformanceMetrics,
): NormalizedPerformanceMetrics {
  return {
    impressions: raw.impressions,
    reach: raw.reach,
    clicks: raw.clicks,
    completions: raw.completions,
    conversions: raw.conversions,
    spendCents: raw.spendCents,
    clickThroughRate: rate(raw.clicks, raw.impressions),
    completionRate:
      raw.completions === undefined ? undefined : rate(raw.completions, raw.impressions),
    conversionRate: rate(raw.conversions, raw.clicks),
    costPerClickCents: costPer(raw.spendCents, raw.clicks),
    costPerConversionCents: costPer(raw.spendCents, raw.conversions),
  };
}

/**
 * Evidence thresholds for each confidence band. Deliberately conservative and
 * explicit rather than tuned: the point of M13 is that a thin sample cannot
 * manufacture a confident claim, and a reviewer can see exactly why a band was
 * assigned.
 */
export const CONFIDENCE_THRESHOLDS = {
  /** MEDIUM needs more than one independent observation AND real volume. */
  medium: { minObservations: 2, minImpressions: 5_000 },
  /** HIGH needs a genuinely repeated result across several observations. */
  high: { minObservations: 4, minImpressions: 50_000 },
} as const;

export interface ConfidenceDerivation {
  readonly confidence: LearningConfidence;
  readonly observationCount: number;
  readonly totalImpressions: number;
  /** Why this band, in one line — surfaced to reviewers rather than left implicit. */
  readonly rationale: string;
}

/**
 * Derives a learning's confidence band from its evidence alone.
 *
 * This is the guarantee that **low-evidence data cannot produce a
 * high-confidence claim**: the agent has no say here, and the bands are
 * monotonic in both observation count and impression volume — failing either
 * threshold drops the band. An insight with a single observation is always LOW,
 * however emphatic the model was about it.
 */
export function deriveLearningConfidence(
  evidence: readonly LearningEvidence[],
): ConfidenceDerivation {
  const observationCount = evidence.length;
  const totalImpressions = evidence.reduce((sum, e) => sum + e.impressions, 0);

  const { medium, high } = CONFIDENCE_THRESHOLDS;
  if (observationCount >= high.minObservations && totalImpressions >= high.minImpressions) {
    return {
      confidence: 'HIGH',
      observationCount,
      totalImpressions,
      rationale: `${observationCount} observations totalling ${totalImpressions} impressions meet the HIGH thresholds (${high.minObservations}/${high.minImpressions})`,
    };
  }
  if (observationCount >= medium.minObservations && totalImpressions >= medium.minImpressions) {
    return {
      confidence: 'MEDIUM',
      observationCount,
      totalImpressions,
      rationale: `${observationCount} observations totalling ${totalImpressions} impressions meet the MEDIUM thresholds (${medium.minObservations}/${medium.minImpressions}) but not HIGH`,
    };
  }
  return {
    confidence: 'LOW',
    observationCount,
    totalImpressions,
    rationale: `${observationCount} observations totalling ${totalImpressions} impressions fall below the MEDIUM thresholds (${medium.minObservations}/${medium.minImpressions})`,
  };
}
