import { z } from 'zod';
import { LearningConfidenceSchema, LearningScopeSchema } from '../schemas/learning-record';

/**
 * M13 — contracts for `PerformanceAnalysisWorkflow`, a **separate top-level
 * workflow**, not a child of `CampaignProductionWorkflow`
 * (docs/architecture.md §3.1/§3.2: coupling it into the linear pipeline would
 * force the production workflow to stay open for weeks waiting on ad
 * performance).
 *
 * It is deliberately incapable of touching production state: its Activities
 * read `PerformanceObservation`s and write `LearningRecord`s, and nothing in
 * its contract references a campaign stage, an approval, an asset or an
 * export. It cannot advance a stage or satisfy a gate because it never calls
 * `advanceCampaignStageActivity` and holds no approval signal.
 */

/** Minimum closed observations required before analysis is worth running at all. */
export const DEFAULT_MIN_OBSERVATIONS_FOR_ANALYSIS = 1;

/**
 * Deterministic Temporal workflow ID for a campaign's performance analysis.
 * Derived from the campaign business key plus the analysis window, so a
 * re-analysis over a *different* window is a distinct execution while a replay
 * of the same window is not.
 */
export function performanceAnalysisWorkflowId(campaignId: string, windowKey: string): string {
  return `performance-analysis:${campaignId}:${windowKey}`;
}

export const PerformanceAnalysisWorkflowInputSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  workflowRunId: z.string().min(1),
  /**
   * Stable label for the analysis window (e.g. `2026-W30`). Part of the
   * workflow id and every idempotency key, so re-running the same window is a
   * no-op rather than a duplicate set of learnings.
   */
  windowKey: z.string().min(1),
  minObservations: z.number().int().positive().default(DEFAULT_MIN_OBSERVATIONS_FOR_ANALYSIS),
  /** 1-based; distinguishes the agent idempotency key of a deliberate re-analysis. */
  analysisAttempt: z.number().int().positive().default(1),
});
export type PerformanceAnalysisWorkflowInput = z.infer<
  typeof PerformanceAnalysisWorkflowInputSchema
>;

export const PERFORMANCE_ANALYSIS_STATUSES = ['COMPLETED', 'SKIPPED', 'BLOCKED'] as const;
export const PerformanceAnalysisStatusSchema = z.enum(PERFORMANCE_ANALYSIS_STATUSES);
export type PerformanceAnalysisStatus = z.infer<typeof PerformanceAnalysisStatusSchema>;

export const PerformanceAnalysisLearningSummarySchema = z.object({
  learningRecordId: z.string().uuid(),
  learningKey: z.string().min(1),
  version: z.number().int().positive(),
  scope: LearningScopeSchema,
  confidence: LearningConfidenceSchema,
  evidenceCount: z.number().int().positive(),
});
export type PerformanceAnalysisLearningSummary = z.infer<
  typeof PerformanceAnalysisLearningSummarySchema
>;

export const PerformanceAnalysisWorkflowOutputSchema = z.object({
  status: PerformanceAnalysisStatusSchema,
  observationsAnalyzed: z.number().int().nonnegative(),
  /** Every learning is written PROPOSED — a human approves before any agent sees it. */
  learnings: z.array(PerformanceAnalysisLearningSummarySchema).default([]),
  skippedReason: z.string().optional(),
  failureReason: z.string().optional(),
  failureMessage: z.string().optional(),
});
export type PerformanceAnalysisWorkflowOutput = z.infer<
  typeof PerformanceAnalysisWorkflowOutputSchema
>;

export const PerformanceAnalysisProgressSchema = z.object({
  phase: z.enum(['LOADING', 'ANALYZING', 'PERSISTING', 'DONE']),
  observationsLoaded: z.number().int().nonnegative(),
  learningsPersisted: z.number().int().nonnegative(),
});
export type PerformanceAnalysisProgress = z.infer<typeof PerformanceAnalysisProgressSchema>;
