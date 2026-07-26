import { z } from 'zod';
import { DeliveryPlatformSchema } from '@combat/domain';

export const CampaignStrategistInputSchema = z.object({
  brandName: z.string().min(1),
  objective: z.string().min(1),
  targetPlatforms: z.array(DeliveryPlatformSchema).min(1),
  durationsSeconds: z.array(z.number().int().positive()).min(1),
  budgetCents: z.number().int().nonnegative(),
  keyMessages: z.array(z.string().min(1)).default([]),
  mandatories: z.array(z.string().min(1)).default([]),
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
  /**
   * The requester's brief in their own words, carried verbatim. Optional so
   * every existing caller keeps compiling; supplied by `aamp:generate`, which
   * treats it as the campaign's canonical statement of intent. The derived
   * `objective`/`keyMessages` fields are a summary of this, never a
   * replacement for it — a summary is where a brief's specificity goes to die.
   */
  campaignPrompt: z.string().min(1).max(8000).optional(),
  /**
   * Verifiable product and event facts, as pre-formatted `PRODUCT — …` /
   * `EVENT — …` lines. Binding constraints, not suggestions: an agent may
   * choose which to lead on and may not contradict or invent alongside them.
   */
  factualConstraints: z.array(z.string().min(1)).default([]),
});
export type CampaignStrategistInput = z.infer<typeof CampaignStrategistInputSchema>;

export const CampaignStrategistResultSchema = z.object({
  audienceProfile: z.object({
    name: z.string().min(1),
    demographics: z.record(z.string(), z.unknown()).default({}),
    psychographics: z.record(z.string(), z.unknown()).default({}),
    painPoints: z.array(z.string().min(1)).min(1),
    platformBehavior: z.record(z.string(), z.unknown()).default({}),
  }),
  strategy: z.object({
    positioning: z.string().min(1),
    targetAudienceSummary: z.string().min(1),
    keyMessages: z.array(z.string().min(1)).min(1),
    toneGuidelines: z.array(z.string().min(1)).min(1),
  }),
});
export type CampaignStrategistResult = z.infer<typeof CampaignStrategistResultSchema>;
