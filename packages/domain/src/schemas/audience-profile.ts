import { z } from 'zod';

export const AudienceProfileSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignBriefId: z.string().uuid(),
  name: z.string().min(1),
  demographics: z.record(z.string(), z.unknown()).default({}),
  psychographics: z.record(z.string(), z.unknown()).default({}),
  painPoints: z.array(z.string().min(1)).default([]),
  platformBehavior: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.date(),
});
export type AudienceProfile = z.infer<typeof AudienceProfileSchema>;
