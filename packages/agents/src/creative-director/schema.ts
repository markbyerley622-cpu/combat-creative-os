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
  /** Set only on a regeneration attempt following a CONCEPT-gate CHANGES_REQUESTED/REJECTED decision — the human reviewer's free-text comments, carried verbatim into this next attempt. */
  revisionFeedback: z.string().min(1).optional(),
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
