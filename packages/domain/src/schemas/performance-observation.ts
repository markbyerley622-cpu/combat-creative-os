import { z } from 'zod';
import { DeliveryPlatformSchema } from './shared-enums';

/**
 * M13 — where a performance observation came from. **Deliberately excludes any
 * real ad-platform connector**: M13 builds the learning system
 * provider-independently, and no social/ad API integration, scraping, or
 * credential exists (see docs/architecture.md §8's M13 entry and §7.2). A real
 * connector would add a value here without changing anything downstream — the
 * normalization, confidence and learning layers never learn a platform SDK.
 */
export const PERFORMANCE_SOURCES = ['FIXTURE', 'MANUAL_ENTRY'] as const;
export const PerformanceSourceSchema = z.enum(PERFORMANCE_SOURCES);
export type PerformanceSource = z.infer<typeof PerformanceSourceSchema>;

/**
 * Identity of the published post/creative an observation measures, plus the
 * provenance chain back into this system. `externalPostId` is the platform's
 * own identifier for the post — opaque to us, and the dedup key component that
 * makes repeat ingestion idempotent.
 *
 * `creativeVariantId`/`variantAssetId` are optional because a manually-entered
 * observation may predate (or sit outside) a tracked variant; when present they
 * pin the exact `CreativeVariant` and `VARIANT` asset that was published, which
 * is what makes a derived learning attributable to a specific cut.
 */
export const PerformanceSubjectSchema = z.object({
  platform: DeliveryPlatformSchema,
  /** The platform's own post identifier. Opaque; never parsed. */
  externalPostId: z.string().min(1),
  /** Optional platform account/handle the post was published under. */
  externalAccountId: z.string().min(1).optional(),
  campaignId: z.string().uuid(),
  creativeVariantId: z.string().uuid().optional(),
  variantAssetId: z.string().uuid().optional(),
  /** The variant's target duration, when known — lets learnings be scoped per cut length. */
  durationSeconds: z.number().int().positive().optional(),
});
export type PerformanceSubject = z.infer<typeof PerformanceSubjectSchema>;

/**
 * Raw counters as reported. Every field is a non-negative integer count or a
 * cent amount — no pre-computed rates are accepted from the caller, because a
 * supplied rate cannot be checked against its own numerator/denominator.
 * Rates are derived in `NormalizedPerformanceMetricsSchema` instead.
 */
export const RawPerformanceMetricsSchema = z.object({
  impressions: z.number().int().nonnegative(),
  /** Distinct accounts reached. Must never exceed impressions. */
  reach: z.number().int().nonnegative().optional(),
  clicks: z.number().int().nonnegative(),
  /** Video plays that reached the end. Must never exceed impressions. */
  completions: z.number().int().nonnegative().optional(),
  conversions: z.number().int().nonnegative(),
  spendCents: z.number().int().nonnegative(),
});
export type RawPerformanceMetrics = z.infer<typeof RawPerformanceMetricsSchema>;

/**
 * Derived, comparable rates — computed by `normalizePerformanceMetrics`, never
 * supplied by a caller. Rates are undefined (not zero) when their denominator
 * is zero, so "no impressions yet" is never mistaken for "0% CTR".
 */
export const NormalizedPerformanceMetricsSchema = z.object({
  impressions: z.number().int().nonnegative(),
  reach: z.number().int().nonnegative().optional(),
  clicks: z.number().int().nonnegative(),
  completions: z.number().int().nonnegative().optional(),
  conversions: z.number().int().nonnegative(),
  spendCents: z.number().int().nonnegative(),
  /** clicks / impressions. */
  clickThroughRate: z.number().min(0).max(1).optional(),
  /** completions / impressions. */
  completionRate: z.number().min(0).max(1).optional(),
  /** conversions / clicks. */
  conversionRate: z.number().min(0).max(1).optional(),
  /** spendCents / clicks, rounded to the nearest cent. */
  costPerClickCents: z.number().nonnegative().optional(),
  /** spendCents / conversions, rounded to the nearest cent. */
  costPerConversionCents: z.number().nonnegative().optional(),
});
export type NormalizedPerformanceMetrics = z.infer<typeof NormalizedPerformanceMetricsSchema>;

/**
 * M13 — one immutable measurement of one published creative over one closed
 * reporting window. This is `docs/architecture.md` §4.1's `PerformanceRecord`,
 * implemented; it supersedes the thin M0 `PerformanceMetrics` shape (which had
 * no post identity, no source provenance, no reporting window and accepted a
 * caller-supplied `ctr`) the same way M6's `ShotSpecification` superseded
 * `ShotPrompt`.
 *
 * **Only closed windows are ingestible.** `periodEnd` must be in the past
 * relative to the ingesting caller's clock and after `periodStart`; a learning
 * may only ever be derived from completed performance data, so a still-open
 * window is refused at the boundary rather than silently averaged.
 */
export const PerformanceObservationSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    subject: PerformanceSubjectSchema,
    source: PerformanceSourceSchema,
    /** Inclusive start of the closed reporting window. */
    periodStart: z.date(),
    /** Exclusive end of the closed reporting window. Must already have elapsed. */
    periodEnd: z.date(),
    raw: RawPerformanceMetricsSchema,
    normalized: NormalizedPerformanceMetricsSchema,
    /** Dedup key — a repeat ingestion of the same window for the same post returns the existing row. */
    idempotencyKey: z.string().min(1),
    /** The user who entered a MANUAL_ENTRY observation, or the fixture that produced it. */
    ingestedByUserId: z.string().uuid().optional(),
    fixtureRef: z.string().min(1).optional(),
    createdAt: z.date(),
  })
  .refine((o) => o.periodEnd > o.periodStart, {
    message: 'periodEnd must be after periodStart',
    path: ['periodEnd'],
  });
export type PerformanceObservation = z.infer<typeof PerformanceObservationSchema>;
