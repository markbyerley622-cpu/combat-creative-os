import { z } from 'zod';
import { RenderJobKindSchema, RenderJobStatusSchema } from './shared-enums';

/** Backs both COMPOSITING-stage motion-graphics jobs and EXPORTING-stage final renders. */
export const RenderJobSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  kind: RenderJobKindSchema,
  status: RenderJobStatusSchema,
  inputAssetIds: z.array(z.string().uuid()).default([]),
  outputAssetId: z.string().uuid().optional(),
  providerJobRef: z.string().optional(),
  createdAt: z.date(),
  completedAt: z.date().optional(),
});
export type RenderJob = z.infer<typeof RenderJobSchema>;
