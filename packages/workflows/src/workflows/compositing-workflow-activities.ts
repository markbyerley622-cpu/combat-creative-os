import type * as activities from '../activities';
import type { Equal, Expect } from './activity-name-contract';

/** The Activity signatures `compositingWorkflow` proxies (see shot-generation-workflow-activities.ts for the type-only-contract rationale). */
export interface CompositingActivities {
  runEditDirectorActivity(
    input: activities.RunEditDirectorInput,
  ): Promise<activities.RunEditDirectorOutput>;
  dispatchCompositionRenderActivity(
    input: activities.DispatchCompositionRenderInput,
  ): Promise<activities.DispatchCompositionRenderOutput>;
  pollCompositionRenderActivity(
    input: activities.PollCompositionRenderInput,
  ): Promise<activities.PollCompositionRenderOutput>;
  cancelCompositionRenderActivity(
    input: activities.CancelCompositionRenderInput,
  ): Promise<{ cancelled: boolean }>;
}

export const COMPOSITING_ACTIVITY_NAMES = [
  'runEditDirectorActivity',
  'dispatchCompositionRenderActivity',
  'pollCompositionRenderActivity',
  'cancelCompositionRenderActivity',
] as const satisfies readonly (keyof CompositingActivities)[];

export type _AssertCompositingNames = Expect<
  Equal<keyof CompositingActivities, (typeof COMPOSITING_ACTIVITY_NAMES)[number]>
>;
