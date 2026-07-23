import { z } from 'zod';
import { TransitionTypeSchema } from './shared-enums';

/**
 * A reusable edit-transition definition (cut/dissolve/wipe/fade) referenced
 * by TimelineEntry rows — see timeline.ts. Named `TransitionSpecification`
 * (not `Transition`) to avoid any confusion with campaign *stage*
 * transitions in packages/domain/src/workflow.
 */
export const TransitionSpecificationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  type: TransitionTypeSchema,
  durationFrames: z.number().int().nonnegative(),
  easing: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.date(),
});
export type TransitionSpecification = z.infer<typeof TransitionSpecificationSchema>;
