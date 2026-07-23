import { z } from 'zod';

export const ScriptSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  creativeConceptId: z.string().uuid(),
  version: z.number().int().positive(),
  totalDurationFrames: z.number().int().positive(),
  createdAt: z.date(),
});
export type Script = z.infer<typeof ScriptSchema>;
