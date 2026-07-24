import { z } from 'zod';

/**
 * Content-only shape produced by the Campaign Strategist agent
 * (packages/agents/src/campaign-strategist/schema.ts's
 * `CampaignStrategistResultSchema.audienceProfile`), embedded on the
 * `Strategy` row as JSON rather than reused from the `AudienceProfile`
 * Prisma model — that model is FK-scoped to `CampaignBrief`, a different
 * aggregate, and isn't guaranteed to stay shape-identical to what the
 * agent returns.
 */
export const StrategyAudienceProfileSchema = z.object({
  name: z.string().min(1),
  demographics: z.record(z.string(), z.unknown()).default({}),
  psychographics: z.record(z.string(), z.unknown()).default({}),
  painPoints: z.array(z.string().min(1)).min(1),
  platformBehavior: z.record(z.string(), z.unknown()).default({}),
});
export type StrategyAudienceProfile = z.infer<typeof StrategyAudienceProfileSchema>;

/**
 * Campaign Strategist's output, persisted as an immutable versioned row —
 * same versioning convention as `CampaignBrief`/`CreativeConcept`/`Script`
 * (a revision is a new row with an incremented `version`, never a mutation).
 */
export const StrategySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  version: z.number().int().positive(),
  positioning: z.string().min(1),
  targetAudienceSummary: z.string().min(1),
  keyMessages: z.array(z.string().min(1)).min(1),
  toneGuidelines: z.array(z.string().min(1)).min(1),
  audienceProfile: StrategyAudienceProfileSchema,
  createdAt: z.date(),
});
export type Strategy = z.infer<typeof StrategySchema>;
