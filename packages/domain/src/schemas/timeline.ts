import { z } from 'zod';

export const TimelineEntrySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  timelineId: z.string().uuid(),
  shotId: z.string().uuid(),
  transitionSpecificationId: z.string().uuid().optional(),
  order: z.number().int().nonnegative(),
  startFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const TimelineSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  scriptId: z.string().uuid(),
  version: z.number().int().positive(),
  frameRate: z.number().int().positive().default(30),
  durationFrames: z.number().int().positive(),
  entries: z.array(TimelineEntrySchema).default([]),
  createdAt: z.date(),
});
export type Timeline = z.infer<typeof TimelineSchema>;
