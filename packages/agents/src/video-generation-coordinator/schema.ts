import { z } from 'zod';

/**
 * Intended input/output boundary per docs/architecture.md §6.1 ("Video
 * Generation Coordinator | ShotPrompt[], candidate count, budget |
 * GenerationJob[] dispatch plan (this agent plans dispatch; the Activity
 * executes it)"). Not yet implemented — see `agent.ts`.
 */
export const VideoGenerationCoordinatorInputSchema = z.object({
  shotPrompts: z
    .array(
      z.object({
        shotIndex: z.number().int().nonnegative(),
        providerId: z.string().min(1),
        promptText: z.string().min(1),
      }),
    )
    .min(1),
  candidateCountPerShot: z.number().int().positive(),
  budgetRemainingCents: z.number().int().nonnegative(),
});
export type VideoGenerationCoordinatorInput = z.infer<typeof VideoGenerationCoordinatorInputSchema>;

export const VideoGenerationCoordinatorResultSchema = z.object({
  dispatchPlan: z.array(
    z.object({
      shotIndex: z.number().int().nonnegative(),
      providerId: z.string().min(1),
      candidateCount: z.number().int().positive(),
      priority: z.number().int().nonnegative(),
    }),
  ),
});
export type VideoGenerationCoordinatorResult = z.infer<
  typeof VideoGenerationCoordinatorResultSchema
>;
