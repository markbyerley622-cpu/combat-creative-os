import { z } from 'zod';

/**
 * M8 — the human Shot Selection at HUMAN_SHOT_SELECTION. A `ShotSelectionSet`
 * is one immutable-once-approved, versioned revision of a reviewer's choices:
 * exactly one selected candidate per required shot, plus per-shot rationale,
 * QA linkage, and regeneration feedback. Each revision loop
 * (HUMAN_SHOT_SELECTION -> SHOT_GENERATION -> ... -> HUMAN_SHOT_SELECTION)
 * produces a new set with an incremented `version`; a DRAFT set is editable,
 * an APPROVED set is frozen (see docs/domain-model.md §4/§8). Every entity
 * carries `workspaceId` (tenancy) and the concept/script/spec versions the
 * selection was made against, so a stale selection can be detected.
 */
export const SHOT_SELECTION_SET_STATUSES = ['DRAFT', 'APPROVED'] as const;
export const ShotSelectionSetStatusSchema = z.enum(SHOT_SELECTION_SET_STATUSES);
export type ShotSelectionSetStatus = z.infer<typeof ShotSelectionSetStatusSchema>;

export const SHOT_SELECTION_ENTRY_STATUSES = ['PENDING', 'SELECTED', 'REJECTED'] as const;
export const ShotSelectionEntryStatusSchema = z.enum(SHOT_SELECTION_ENTRY_STATUSES);
export type ShotSelectionEntryStatus = z.infer<typeof ShotSelectionEntryStatusSchema>;

/** One reviewer choice for one required shot within a `ShotSelectionSet`. */
export const ShotSelectionSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    shotSelectionSetId: z.string().uuid(),
    shotId: z.string().uuid(),
    /** Deterministic sequence ordering — the shot's position in the cut. */
    sequencePosition: z.number().int().nonnegative(),
    shotSpecificationId: z.string().uuid(),
    shotSpecificationVersion: z.number().int().positive(),
    status: ShotSelectionEntryStatusSchema,
    /** The chosen candidate — required when SELECTED, absent when PENDING/REJECTED. */
    selectedCandidateId: z.string().uuid().optional(),
    visualQaAssessmentId: z.string().uuid().optional(),
    continuityQaAssessmentId: z.string().uuid().optional(),
    rationale: z.string().optional(),
    /** Structured feedback fed to the next generation attempt — required when REJECTED. */
    regenerationFeedback: z.string().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .refine((s) => (s.status === 'SELECTED' ? Boolean(s.selectedCandidateId) : true), {
    message: 'a SELECTED shot must reference a selectedCandidateId',
  })
  .refine((s) => (s.status === 'REJECTED' ? Boolean(s.regenerationFeedback) : true), {
    message: 'a REJECTED shot must carry regenerationFeedback',
  });
export type ShotSelection = z.infer<typeof ShotSelectionSchema>;

export const ShotSelectionSetSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    scriptId: z.string().uuid(),
    scriptVersion: z.number().int().positive(),
    creativeConceptId: z.string().uuid(),
    creativeConceptVersion: z.number().int().positive(),
    /** Revision number — a new set per HUMAN_SHOT_SELECTION visit. */
    version: z.number().int().positive(),
    status: ShotSelectionSetStatusSchema,
    createdByUserId: z.string().uuid(),
    /** The reviewer who approved the set — set only once APPROVED. */
    reviewerUserId: z.string().uuid().optional(),
    rationale: z.string().optional(),
    /** Optimistic-concurrency counter — every draft mutation bumps it; an update supplies the expected value. */
    revision: z.number().int().nonnegative(),
    /** Idempotency identity for creation/approval (derived from workflow run + version). */
    idempotencyKey: z.string().optional(),
    approvedAt: z.date().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .refine(
    (s) => (s.status === 'APPROVED' ? Boolean(s.reviewerUserId) && Boolean(s.approvedAt) : true),
    {
      message: 'an APPROVED set must record its reviewer and approval time',
    },
  );
export type ShotSelectionSet = z.infer<typeof ShotSelectionSetSchema>;

/** Append-only history of candidate replacements within a draft set — provenance for who swapped what and why. */
export const ShotSelectionReplacementSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  shotSelectionSetId: z.string().uuid(),
  shotId: z.string().uuid(),
  previousCandidateId: z.string().uuid().optional(),
  newCandidateId: z.string().uuid().optional(),
  replacedByUserId: z.string().uuid(),
  reason: z.string().optional(),
  createdAt: z.date(),
});
export type ShotSelectionReplacement = z.infer<typeof ShotSelectionReplacementSchema>;
