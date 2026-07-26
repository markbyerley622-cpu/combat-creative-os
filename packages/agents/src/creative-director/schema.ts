import { z } from 'zod';

export const CreativeDirectorInputSchema = z.object({
  brandName: z.string().min(1),
  strategy: z.object({
    positioning: z.string().min(1),
    targetAudienceSummary: z.string().min(1),
    keyMessages: z.array(z.string().min(1)).min(1),
    toneGuidelines: z.array(z.string().min(1)).min(1),
  }),
  mandatories: z.array(z.string().min(1)).default([]),
  durationsSeconds: z.array(z.number().int().positive()).min(1),
  /**
   * M13: bounded, attributed insights from prior campaigns' performance —
   * each line carries its confidence band, evidence weight and source
   * `LearningRecord` id (see `formatLearningContext` in @combat/domain).
   * Advisory only: capped in count, never a substitute for the approved brief
   * or a human decision, and empty whenever no APPROVED, applicable,
   * sufficiently-evidenced learning exists.
   */
  priorLearnings: z.array(z.string().min(1)).default([]),
  /** Set only on a regeneration attempt following a CONCEPT-gate CHANGES_REQUESTED/REJECTED decision — the human reviewer's free-text comments, carried verbatim into this next attempt. */
  revisionFeedback: z.string().min(1).optional(),
  /** The requester's brief, verbatim. See `CampaignStrategistInputSchema` for why the summary is not a substitute. */
  campaignPrompt: z.string().min(1).max(8000).optional(),
  /** Binding product/event facts as `PRODUCT — …` / `EVENT — …` lines. */
  factualConstraints: z.array(z.string().min(1)).default([]),
});
export type CreativeDirectorInput = z.infer<typeof CreativeDirectorInputSchema>;

/** Mirrors `@combat/domain`'s `CreativeConceptSchema` content fields exactly. */
export const CreativeDirectorResultSchema = z.object({
  logline: z.string().min(1),
  visualDirection: z.string().min(1),
  narrativeArc: z.string().min(1),
  referenceNotes: z.array(z.string().min(1)).default([]),
});
export type CreativeDirectorResult = z.infer<typeof CreativeDirectorResultSchema>;
