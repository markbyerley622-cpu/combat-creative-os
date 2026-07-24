import type * as activities from '../activities';

/**
 * The two Activity signatures `campaignProductionWorkflow` proxies, named
 * for what the Worker must register them as. `proxyActivities<T>()` only
 * uses `T` for compile-time destructuring/typing — it does not require
 * `../activities`' runtime namespace object to expose members under these
 * exact names, so this file is a type-only contract, not a claim that
 * `advanceCampaignStageActivity`/`verifyHumanApprovalActivity` already exist
 * as directly Worker-registrable functions today. `../activities` currently
 * only exports the `create*Activity(deps)` factories those two functions are
 * built from (kept dependency-injectable for unit tests); instantiating them
 * with real dependencies and registering the result with `Worker.create` in
 * apps/worker is separate, not-yet-done wiring work (see
 * docs/architecture.md §7.1) — not part of this workflow file, which must
 * stay I/O-free regardless.
 */
export interface CampaignProductionActivities {
  advanceCampaignStageActivity(
    input: activities.AdvanceCampaignStageInput,
  ): Promise<activities.AdvanceCampaignStageOutput>;
  verifyHumanApprovalActivity(
    input: activities.VerifyHumanApprovalInput,
  ): Promise<activities.VerifyHumanApprovalOutput>;
  /**
   * M4: sequences Campaign Strategist -> Creative Director -> Script &
   * Timing Director for one STRATEGY_REVIEW visit, persisting each output as
   * an immutable versioned row. See run-strategy-concept-script-activity.ts's
   * doc comment for why this is one Activity rather than six separate
   * proxied calls from this workflow file.
   */
  runStrategyConceptScriptActivity(
    input: activities.RunStrategyConceptScriptInput,
  ): Promise<activities.RunStrategyConceptScriptOutput>;
}
