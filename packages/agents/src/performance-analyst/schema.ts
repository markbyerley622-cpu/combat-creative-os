import { z } from 'zod';
import { DeliveryPlatformSchema } from '@combat/domain';

/**
 * M13 — one closed-window observation, as the analyst sees it. Carries the
 * `observationId` so every learning the agent produces can cite the exact
 * observations behind it; the Activity checks those citations against the
 * observations it actually supplied, so an insight can never claim evidence
 * that was not in its input.
 *
 * Rates arrive pre-derived (`normalizePerformanceMetrics`) and are undefined
 * rather than zero when their denominator was zero, so the agent can tell
 * "no data" from "genuinely zero".
 */
export const PerformanceObservationInputSchema = z.object({
  observationId: z.string().uuid(),
  platform: DeliveryPlatformSchema,
  durationSeconds: z.number().int().positive().optional(),
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  conversions: z.number().int().nonnegative(),
  spendCents: z.number().int().nonnegative(),
  clickThroughRate: z.number().min(0).max(1).optional(),
  completionRate: z.number().min(0).max(1).optional(),
  conversionRate: z.number().min(0).max(1).optional(),
  costPerClickCents: z.number().nonnegative().optional(),
  costPerConversionCents: z.number().nonnegative().optional(),
});
export type PerformanceObservationInput = z.infer<typeof PerformanceObservationInputSchema>;

/**
 * **M13 supersedes the M0 input shape** (a bare `metrics[]` with a
 * caller-supplied `ctr` and no observation identity), which could not support
 * an evidence-referenced learning — same "the agent's real contract is the
 * fuller shape" supersession M6 applied to `ShotPrompt` → `ShotSpecification`.
 */
export const PerformanceAnalystInputSchema = z.object({
  observations: z.array(PerformanceObservationInputSchema).min(1),
});
export type PerformanceAnalystInput = z.infer<typeof PerformanceAnalystInputSchema>;

/**
 * The agent's proposed learning. Deliberately **without a confidence field**:
 * confidence is derived from evidence volume by `deriveLearningConfidence` in
 * `@combat/domain`, so a model cannot assert that a thin sample is reliable.
 *
 * `LearningRecord` (the persisted entity) now lives in `@combat/domain` — this
 * is only the content shape, with no id, workspaceId, version or foreign key,
 * exactly as every other agent result schema is scoped.
 */
export const ProposedLearningSchema = z.object({
  /** Stable slug identifying the insight across revisions — the persisted `learningKey`. */
  learningKey: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'learningKey must be a lowercase kebab-case slug'),
  insight: z.string().min(1),
  appliesTo: z.enum(['strategy', 'concept', 'prompting']),
  tags: z.array(z.string().min(1)).default([]),
  /** Platforms the insight applies to; empty means unrestricted. */
  platforms: z.array(DeliveryPlatformSchema).default([]),
  /** Cut durations the insight applies to; empty means unrestricted. */
  durationsSeconds: z.array(z.number().int().positive()).default([]),
  /** Explicit evidence — every id must appear in the input's `observations`. */
  evidenceObservationIds: z.array(z.string().uuid()).min(1),
});
export type ProposedLearning = z.infer<typeof ProposedLearningSchema>;

export const PerformanceAnalystResultSchema = z.object({
  learnings: z.array(ProposedLearningSchema).min(1),
});
export type PerformanceAnalystResult = z.infer<typeof PerformanceAnalystResultSchema>;
