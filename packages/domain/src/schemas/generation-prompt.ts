import { z } from 'zod';

/**
 * `promptVersionId` is required (not optional) — CLAUDE.md "Prompt version
 * used for every generation must be recorded" is enforced by making the
 * field mandatory here and a non-nullable foreign key in schema.prisma,
 * rather than relying on callers to remember to set it.
 */
export const GenerationPromptSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  shotId: z.string().uuid(),
  promptVersionId: z.string().uuid(),
  providerId: z.string().min(1),
  promptText: z.string().min(1),
  negativePrompt: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.date(),
});
export type GenerationPrompt = z.infer<typeof GenerationPromptSchema>;
