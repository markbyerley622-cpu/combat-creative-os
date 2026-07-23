import { z } from 'zod';
import { ShotStatusSchema } from './shared-enums';

export const ShotSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  scriptId: z.string().uuid(),
  index: z.number().int().nonnegative(),
  description: z.string().min(1),
  durationFrames: z.number().int().positive(),
  status: ShotStatusSchema,
  dependsOnShotIds: z.array(z.string().uuid()).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Shot = z.infer<typeof ShotSchema>;
