import type * as activities from '../activities';
import type { Equal, Expect } from './activity-name-contract';

/**
 * The three Activity signatures `shotGenerationWorkflow` proxies — mirrors
 * `campaign-production-workflow-activities.ts`: a type-only contract for
 * `proxyActivities<T>()`, paired with the runtime name tuple the Worker
 * registration conformance test enumerates.
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

export const SHOT_GENERATION_ACTIVITY_NAMES = [
  'dispatchShotGenerationActivity',
  'pollShotGenerationActivity',
  'cancelShotGenerationActivity',
] as const satisfies readonly (keyof ShotGenerationActivities)[];

export type _AssertShotGenerationNames = Expect<
  Equal<keyof ShotGenerationActivities, (typeof SHOT_GENERATION_ACTIVITY_NAMES)[number]>
>;
