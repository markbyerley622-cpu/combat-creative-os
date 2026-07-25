import { z } from 'zod';

export const PromptTemplateSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  createdAt: z.date(),
});
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

/**
 * `version` is a monotonically increasing integer per template, never reused
 * — see ShotSpecification.promptVersionId, which pins a generation to exactly
 * one of these rows so "prompt version used for every generation" is always
 * reconstructible.
 */
export const PromptVersionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  promptTemplateId: z.string().uuid(),
  version: z.number().int().positive(),
  systemPrompt: z.string().min(1),
  isActive: z.boolean().default(false),
  createdAt: z.date(),
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;
