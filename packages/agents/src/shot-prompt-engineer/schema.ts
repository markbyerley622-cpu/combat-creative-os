import { z } from 'zod';
import { QualityFailureCategorySchema, QualityFailureSeveritySchema } from '@combat/domain';

export const ShotPromptEngineerInputSchema = z.object({
  shot: z.object({
    index: z.number().int().nonnegative(),
    description: z.string().min(1),
    durationFrames: z.number().int().positive(),
  }),
  visualDirection: z.string().min(1),
  providerId: z.string().min(1),
  /** Set only on a regeneration attempt driven by QC/Continuity revision feedback. */
  priorRevisionFeedback: z
    .object({
      category: QualityFailureCategorySchema,
      severity: QualityFailureSeveritySchema,
      description: z.string().min(1),
      suggestedAction: z.string().optional(),
    })
    .optional(),
});
export type ShotPromptEngineerInput = z.infer<typeof ShotPromptEngineerInputSchema>;

/** Mirrors `@combat/domain`'s `GenerationPromptSchema` content fields exactly. */
export const ShotPromptEngineerResultSchema = z.object({
  providerId: z.string().min(1),
  promptText: z.string().min(1),
  negativePrompt: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type ShotPromptEngineerResult = z.infer<typeof ShotPromptEngineerResultSchema>;
