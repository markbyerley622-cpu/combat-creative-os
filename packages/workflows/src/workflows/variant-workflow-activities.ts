import type * as activities from '../activities';
import type { Equal, Expect } from './activity-name-contract';

/** The Activity signatures `variantWorkflow` proxies (see shot-generation-workflow-activities.ts for the type-only-contract rationale). */
export interface VariantActivities {
  runVariantGeneratorActivity(
    input: activities.RunVariantGeneratorInput,
  ): Promise<activities.RunVariantGeneratorOutput>;
  dispatchVariantRenderActivity(
    input: activities.DispatchVariantRenderInput,
  ): Promise<activities.DispatchVariantRenderOutput>;
  pollVariantRenderActivity(
    input: activities.PollVariantRenderInput,
  ): Promise<activities.PollVariantRenderOutput>;
  cancelVariantRenderActivity(
    input: activities.CancelVariantRenderInput,
  ): Promise<{ cancelled: boolean }>;
  runVariantFinalQaActivity(
    input: activities.RunVariantFinalQaInput,
  ): Promise<activities.RunVariantFinalQaOutput>;
}

export const VARIANT_ACTIVITY_NAMES = [
  'runVariantGeneratorActivity',
  'dispatchVariantRenderActivity',
  'pollVariantRenderActivity',
  'cancelVariantRenderActivity',
  'runVariantFinalQaActivity',
] as const satisfies readonly (keyof VariantActivities)[];

export type _AssertVariantNames = Expect<
  Equal<keyof VariantActivities, (typeof VARIANT_ACTIVITY_NAMES)[number]>
>;
