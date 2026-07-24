import { z } from 'zod';

/**
 * Intended input/output boundary per docs/architecture.md §6.1
 * ("Motion-Compositing Coordinator | Shot, SelectedCandidate, brand template
 * refs (Figma) | CompositingPlan { aeTemplate, dataBindings,
 * figmaOverlays[] }"). Not yet implemented — see `agent.ts`.
 */
export const MotionCompositingCoordinatorInputSchema = z.object({
  shot: z.object({ index: z.number().int().nonnegative(), description: z.string().min(1) }),
  selectedCandidateRef: z.string().min(1),
  brandTemplateRefs: z.array(z.string().min(1)).default([]),
});
export type MotionCompositingCoordinatorInput = z.infer<
  typeof MotionCompositingCoordinatorInputSchema
>;

export const MotionCompositingCoordinatorResultSchema = z.object({
  aeTemplate: z.string().min(1),
  dataBindings: z.record(z.string(), z.unknown()).default({}),
  figmaOverlays: z.array(z.string().min(1)).default([]),
});
export type MotionCompositingCoordinatorResult = z.infer<
  typeof MotionCompositingCoordinatorResultSchema
>;
