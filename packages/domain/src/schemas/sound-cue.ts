import { z } from 'zod';
import { SoundCueTypeSchema } from './shared-enums';

export const SoundCueSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  timelineId: z.string().uuid(),
  type: SoundCueTypeSchema,
  startFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
  assetId: z.string().uuid().optional(),
  notes: z.string().optional(),
  createdAt: z.date(),
});
export type SoundCue = z.infer<typeof SoundCueSchema>;
