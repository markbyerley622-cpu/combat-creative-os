import { z } from 'zod';
import { GenerationCandidateStatusSchema } from './shared-enums';

export const GenerationCandidateSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  generationPromptId: z.string().uuid(),
  assetId: z.string().uuid().optional(),
  providerJobRef: z.string().optional(),
  status: GenerationCandidateStatusSchema,
  attempt: z.number().int().positive(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type GenerationCandidate = z.infer<typeof GenerationCandidateSchema>;
