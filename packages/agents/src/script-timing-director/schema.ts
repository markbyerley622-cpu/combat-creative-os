import { z } from 'zod';

/** Which beat of the ad structure a shot belongs to (hook/promise/feature/CTA). */
export const ShotBeatSchema = z.enum(['HOOK', 'PROMISE', 'FEATURE', 'CTA']);
export type ShotBeat = z.infer<typeof ShotBeatSchema>;

export const ScriptTimingDirectorInputSchema = z.object({
  logline: z.string().min(1),
  visualDirection: z.string().min(1),
  narrativeArc: z.string().min(1),
  targetDurationsSeconds: z.array(z.number().int().positive()).min(1),
  keyMessages: z.array(z.string().min(1)).default([]),
  /** The mandatory call-to-action copy every cutdown must end on. */
  callToAction: z.string().min(1),
  frameRate: z.number().int().positive().default(30),
  /** Set only on a regeneration attempt following a CONCEPT-gate CHANGES_REQUESTED/REJECTED decision — the human reviewer's free-text comments, carried verbatim into this next attempt. */
  revisionFeedback: z.string().min(1).optional(),
});
export type ScriptTimingDirectorInput = z.infer<typeof ScriptTimingDirectorInputSchema>;

export const ScriptShotSchema = z.object({
  /** Position within this output only — a future Activity assigns real Shot ids at persistence time. */
  index: z.number().int().nonnegative(),
  description: z.string().min(1),
  durationFrames: z.number().int().positive(),
  beat: ShotBeatSchema,
  /** Indices (within this same shot list) this shot depends on, if any. */
  dependsOnShotIndices: z.array(z.number().int().nonnegative()).default([]),
});
export type ScriptShot = z.infer<typeof ScriptShotSchema>;

export const ScriptTimingDirectorResultSchema = z.object({
  totalDurationFrames: z.number().int().positive(),
  shots: z.array(ScriptShotSchema).min(1),
});
export type ScriptTimingDirectorResult = z.infer<typeof ScriptTimingDirectorResultSchema>;
