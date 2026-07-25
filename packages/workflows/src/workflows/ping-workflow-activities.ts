import type { pingActivity } from '../activities';
import type { Equal, Expect } from './activity-name-contract';

/**
 * `pingWorkflow`'s Activity contract. Trivial, but declared the same way as
 * every other executable workflow's so the Worker-registration conformance
 * test can enumerate it uniformly rather than special-casing the one workflow
 * whose Activity is a plain function instead of a `create*Activity(deps)`
 * factory (post-M14 audit finding C-1).
 */
export interface PingActivities {
  pingActivity: typeof pingActivity;
}

export const PING_ACTIVITY_NAMES = [
  'pingActivity',
] as const satisfies readonly (keyof PingActivities)[];

export type _AssertPingNames = Expect<
  Equal<keyof PingActivities, (typeof PING_ACTIVITY_NAMES)[number]>
>;
