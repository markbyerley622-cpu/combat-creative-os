import { z } from 'zod';

export const EditDecisionEntrySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  editDecisionListId: z.string().uuid(),
  assetId: z.string().uuid(),
  sourceInFrame: z.number().int().nonnegative(),
  sourceOutFrame: z.number().int().nonnegative(),
  timelinePosition: z.number().int().nonnegative(),
  trackType: z.enum(['VIDEO', 'AUDIO']),
  order: z.number().int().nonnegative(),
});
export type EditDecisionEntry = z.infer<typeof EditDecisionEntrySchema>;

export const EditDecisionListSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  version: z.number().int().positive(),
  entries: z.array(EditDecisionEntrySchema).default([]),
  createdAt: z.date(),
});
export type EditDecisionList = z.infer<typeof EditDecisionListSchema>;
