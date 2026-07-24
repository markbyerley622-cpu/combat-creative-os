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
  /** Prior campaigns' distilled insights from performance-analyst, if any. */
  priorLearnings: z.array(z.string().min(1)).default([]),
  /** Set only on a regeneration attempt following a CONCEPT-gate CHANGES_REQUESTED/REJECTED decision — the human reviewer's free-text comments, carried verbatim into this next attempt. */
  revisionFeedback: z.string().min(1).optional(),
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
