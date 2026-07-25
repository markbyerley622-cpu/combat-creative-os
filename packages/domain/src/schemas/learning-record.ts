import { z } from 'zod';
import { DeliveryPlatformSchema } from './shared-enums';

/**
 * M13 — which agent an insight may be offered to. Mirrors the Performance
 * Analyst's `appliesTo` values and, critically, bounds where a learning can
 * ever reach: only STRATEGY and CONCEPT context injection exists today
 * (docs/architecture.md §5's `relevantLearnings?: Learning[]` — "strategy/
 * concept only"). `PROMPTING` is modeled because the agent can produce it, but
 * nothing consumes it yet.
 */
export const LEARNING_SCOPES = ['STRATEGY', 'CONCEPT', 'PROMPTING'] as const;
export const LearningScopeSchema = z.enum(LEARNING_SCOPES);
export type LearningScope = z.infer<typeof LearningScopeSchema>;

/**
 * Confidence is **derived, never asserted by the agent** — see
 * `deriveLearningConfidence` in `workflow/learning-confidence.ts`. The band is
 * a function of how much closed performance data actually backs the claim, so
 * a single low-volume observation can never produce a HIGH-confidence learning.
 */
export const LEARNING_CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const LearningConfidenceSchema = z.enum(LEARNING_CONFIDENCES);
export type LearningConfidence = z.infer<typeof LearningConfidenceSchema>;

export const LEARNING_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED'] as const;
export const LearningStatusSchema = z.enum(LEARNING_STATUSES);
export type LearningStatus = z.infer<typeof LearningStatusSchema>;

/**
 * One `PerformanceObservation` this learning was distilled from, kept as an
 * explicit, checkable reference rather than a prose citation. Every learning
 * carries at least one: an insight with no evidence is not persistable.
 */
export const LearningEvidenceSchema = z.object({
  performanceObservationId: z.string().uuid(),
  campaignId: z.string().uuid(),
  creativeVariantId: z.string().uuid().optional(),
  platform: DeliveryPlatformSchema,
  /** Impressions behind this evidence row — the volume the confidence band is computed over. */
  impressions: z.number().int().nonnegative(),
});
export type LearningEvidence = z.infer<typeof LearningEvidenceSchema>;

/**
 * Where a learning is applicable. Empty arrays mean "unrestricted on that
 * dimension"; a populated array narrows it. `loadLearningContext` filters on
 * these, so a TikTok-only insight is never offered to a Reels-only campaign.
 */
export const LearningApplicabilitySchema = z.object({
  platforms: z.array(DeliveryPlatformSchema).default([]),
  durationsSeconds: z.array(z.number().int().positive()).default([]),
  /** Free-form tags (audience, objective, product category) the agent proposed. */
  tags: z.array(z.string().min(1)).default([]),
});
export type LearningApplicability = z.infer<typeof LearningApplicabilitySchema>;

/**
 * M13 — a distilled, attributable, versioned creative insight. This is
 * `docs/architecture.md` §4.1's `Learning`, promoted from the local
 * `packages/agents/src/performance-analyst/schema.ts` definition into a real
 * persisted `@combat/domain` entity (that file's doc comment anticipated
 * exactly this: "pending a database milestone that promotes it into a real
 * table").
 *
 * **A learning is advisory context, never an instruction.** It is offered to
 * the Strategist/Creative Director alongside — never in place of — the approved
 * brief, and nothing in the system lets a learning change a campaign stage,
 * an approval, an asset, or a human decision. See `loadLearningContext`.
 *
 * Immutable + versioned: revising an insight writes a new version and marks the
 * prior one superseded, so a `Strategy` produced under version N stays
 * explicable.
 */
export const LearningRecordSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  version: z.number().int().positive(),
  /** Stable identity across versions — a revision keeps the key, bumps the version. */
  learningKey: z.string().min(1),
  insight: z.string().min(1),
  scope: LearningScopeSchema,
  applicability: LearningApplicabilitySchema,
  /** Derived from the evidence volume, never taken from the agent. */
  confidence: LearningConfidenceSchema,
  evidence: z.array(LearningEvidenceSchema).min(1),
  /** Total impressions across `evidence` — the number the confidence band was derived from. */
  totalImpressions: z.number().int().nonnegative(),
  status: LearningStatusSchema,
  /** The campaign whose performance produced this learning. */
  sourceCampaignId: z.string().uuid(),
  /** Provenance: the Performance Analyst invocation and prompt version behind it. */
  createdByAgentInvocationId: z.string().uuid(),
  promptVersionId: z.string().uuid(),
  reviewedByUserId: z.string().uuid().optional(),
  reviewedAt: z.date().optional(),
  supersededAt: z.date().optional(),
  createdAt: z.date(),
});
export type LearningRecord = z.infer<typeof LearningRecordSchema>;

/**
 * The bounded, attributable shape a learning takes when it reaches an agent.
 * Deliberately NOT the full record: no raw metrics, no evidence payloads, no
 * campaign internals — just the insight, what backs it, and how far it can be
 * trusted. This is what makes context injection bounded rather than an
 * unrestricted historical prompt dump.
 */
export const LearningContextItemSchema = z.object({
  /** Source id, preserved so any claim in a Strategy can be traced back. */
  learningRecordId: z.string().uuid(),
  learningKey: z.string().min(1),
  version: z.number().int().positive(),
  insight: z.string().min(1),
  confidence: LearningConfidenceSchema,
  /** How many observations back it — the agent sees the weight of the claim. */
  evidenceCount: z.number().int().positive(),
  totalImpressions: z.number().int().nonnegative(),
  applicability: LearningApplicabilitySchema,
});
export type LearningContextItem = z.infer<typeof LearningContextItemSchema>;
