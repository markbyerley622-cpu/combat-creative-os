import type * as activities from '../activities';

/**
 * The three Activity signatures `shotGenerationWorkflow` proxies — mirrors
 * `campaign-production-workflow-activities.ts`'s doc comment: this is a
 * type-only contract for `proxyActivities<T>()`, not a claim these are
 * already Worker-registrable; wiring real dependencies into the
 * `create*Activity(deps)` factories and registering the result with
 * `Worker.create` in `apps/worker` remains separate, not-yet-done work.
 */
export interface ShotGenerationActivities {
  dispatchShotGenerationActivity(
    input: activities.DispatchShotGenerationInput,
  ): Promise<activities.DispatchShotGenerationOutput>;
  pollShotGenerationActivity(
    input: activities.PollShotGenerationInput,
  ): Promise<activities.PollShotGenerationOutput>;
  cancelShotGenerationActivity(
    input: activities.CancelShotGenerationInput,
  ): Promise<activities.CancelShotGenerationOutput>;
}
