import { z } from 'zod';
import { CampaignStageSchema } from '../workflow/campaign-stage';
import { AspectRatioSchema, DeliveryPlatformSchema } from './shared-enums';

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
 * The full M4 campaign-brief field set — everything a user fills in on the
 * dashboard's brief editor. Split out from `CampaignBriefSchema` so
 * `apps/api`'s draft-save/submit endpoints can validate a request body
 * against exactly this shape without also requiring the persisted-row
 * fields (`id`/`workspaceId`/`campaignId`/`version`/`acceptedAt`/`createdAt`).
 * Every array field defaults to `[]` rather than being required, since a
 * draft brief may legitimately omit optional detail before submission —
 * `CampaignBriefSubmitSchema` (below) is what tightens this for the actual
 * submit action.
 */
export const CampaignBriefContentSchema = z.object({
  campaignName: z.string().min(1),
  productName: z.string().min(1),
  productDescription: z.string().min(1),
  objective: z.string().min(1),
  targetAudience: z.string().min(1),
  customerProblem: z.string().min(1),
  valueProposition: z.string().min(1),
  productFeatures: z.array(z.string().min(1)).default([]),
  targetPlatforms: z.array(DeliveryPlatformSchema).min(1),
  aspectRatios: z.array(AspectRatioSchema).min(1),
  durationsSeconds: z.array(z.number().int().positive()).min(1),
  brandVoice: z.string().min(1),
  visualDirection: z.string().min(1),
  requiredMessaging: z.array(z.string().min(1)).default([]),
  callToAction: z.string().min(1),
  references: z.array(z.string().min(1)).default([]),
  assetReferences: z.array(z.string().min(1)).default([]),
  prohibitedClaims: z.array(z.string().min(1)).default([]),
  budgetCents: z.number().int().nonnegative(),
  deadline: z.date().optional(),
  locale: z.string().min(1).default('en-US'),
  notes: z.string().optional(),
});
export type CampaignBriefContent = z.infer<typeof CampaignBriefContentSchema>;

/**
 * CampaignBrief is versioned and immutable once accepted (architecture.md
 * §4.1) — `acceptedAt` is set exactly once and the application layer never
 * mutates a brief after that; a revision creates a new `version` row instead.
 */
export const CampaignBriefSchema = CampaignBriefContentSchema.extend({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  version: z.number().int().positive(),
  acceptedAt: z.date().optional(),
  createdAt: z.date(),
});
export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;
