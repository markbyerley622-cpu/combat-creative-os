import { z } from 'zod';
import { CampaignStageSchema } from '../workflow/campaign-stage';
import { DeliveryPlatformSchema } from './shared-enums';

/**
 * The campaign aggregate root. `version` is an optimistic-concurrency counter
 * incremented on every applied stage transition (see
 * packages/database's campaign-transition-service.ts) — a compare-and-swap
 * update keyed on `(id, workspaceId, currentStage, version)` is what makes
 * concurrent transition attempts safe without a database-level advisory lock.
 */
export const CampaignSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1),
  currentStage: CampaignStageSchema,
  version: z.number().int().nonnegative(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Campaign = z.infer<typeof CampaignSchema>;

/**
 * CampaignBrief is versioned and immutable once accepted (architecture.md
 * §4.1) — `acceptedAt` is set exactly once and the application layer never
 * mutates a brief after that; a revision creates a new `version` row instead.
 */
export const CampaignBriefSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  version: z.number().int().positive(),
  brandName: z.string().min(1),
  objective: z.string().min(1),
  targetPlatforms: z.array(DeliveryPlatformSchema).min(1),
  durationsSeconds: z.array(z.number().int().positive()).min(1),
  budgetCents: z.number().int().nonnegative(),
  keyMessages: z.array(z.string().min(1)).default([]),
  mandatories: z.array(z.string().min(1)).default([]),
  acceptedAt: z.date().optional(),
  createdAt: z.date(),
});
export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;
