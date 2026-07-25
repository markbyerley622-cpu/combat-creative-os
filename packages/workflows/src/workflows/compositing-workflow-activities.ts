import type * as activities from '../activities';

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
