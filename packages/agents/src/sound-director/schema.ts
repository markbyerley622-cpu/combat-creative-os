import { z } from 'zod';
import { SoundCueTypeSchema } from '@combat/domain';

export const SoundDirectorInputSchema = z.object({
  frameRate: z.number().int().positive().default(30),
  durationFrames: z.number().int().positive(),
  timelineEntries: z
    .array(
      z.object({
        shotIndex: z.number().int().nonnegative(),
        startFrame: z.number().int().nonnegative(),
        durationFrames: z.number().int().positive(),
      }),
    )
    .min(1),
  brandAudioGuidelines: z.array(z.string().min(1)).default([]),
});
export type SoundDirectorInput = z.infer<typeof SoundDirectorInputSchema>;

/** Content-only mirror of `@combat/domain`'s `SoundCueSchema` (no assetId — assigned once a stem is produced). */
export const SoundCuePlanSchema = z.object({
  type: SoundCueTypeSchema,
  startFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
  notes: z.string().optional(),
});
export type SoundCuePlan = z.infer<typeof SoundCuePlanSchema>;

export const SoundDirectorResultSchema = z.object({
  musicBrief: z.string().min(1),
  mixNotes: z.string().min(1),
  cues: z.array(SoundCuePlanSchema).min(1),
});
export type SoundDirectorResult = z.infer<typeof SoundDirectorResultSchema>;
