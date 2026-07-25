import type * as activities from '../activities';
import type { Equal, Expect } from './activity-name-contract';

/**
 * The Activity signatures `campaignProductionWorkflow` proxies, named for what
 * the Worker must register them as. `proxyActivities<T>()` only uses `T` for
 * compile-time destructuring/typing, so this interface is a type-only
 * contract — `../activities` exports the `create*Activity(deps)` factories
 * these are built from, kept dependency-injectable for unit tests, not
 * directly-registrable functions.
 *
 * Post-M14 audit finding C-1: instantiating those factories and registering
 * the result is no longer "not-yet-done wiring". `createWorkerActivities`
 * (packages/workflows/src/worker) builds the real registration object from
 * these same contracts, and `worker-activities.test.ts` asserts it covers
 * `CAMPAIGN_PRODUCTION_ACTIVITY_NAMES` below exactly. This file stays I/O-free
 * regardless.
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
  /**
   * M6: runs the Shot Prompt Engineer once per shot in the campaign's latest
   * script for one PROMPTING visit, persisting each result as an immutable
   * versioned `ShotSpecification`. See run-shot-prompt-engineer-activity.ts's
   * doc comment.
   */
  runShotPromptEngineerActivity(
    input: activities.RunShotPromptEngineerInput,
  ): Promise<activities.RunShotPromptEngineerOutput>;
  /**
   * M6: resolves the `ShotSpecification` ids for the current SHOT_GENERATION
   * visit (first visit or a revision revisit — see
   * load-latest-shot-specifications-activity.ts's doc comment) before
   * starting `ShotGenerationWorkflow` as a child workflow.
   */
  loadLatestShotSpecificationsActivity(
    input: activities.LoadLatestShotSpecificationsInput,
  ): Promise<activities.LoadLatestShotSpecificationsOutput>;
  /**
   * M7: runs the Visual Quality Controller once per shot's latest SUCCEEDED
   * candidate at VISUAL_QA, persisting an immutable QualityAssessment +
   * typed QualityFailures per candidate. See
   * run-visual-quality-assessment-activity.ts's doc comment.
   */
  runVisualQualityAssessmentsActivity(
    input: activities.RunVisualQualityAssessmentsInput,
  ): Promise<activities.RunVisualQualityAssessmentsOutput>;
  /**
   * M7: runs the Continuity Controller once over the ordered candidate
   * sequence at CONTINUITY_QA, persisting a per-candidate QualityAssessment.
   * See run-continuity-assessment-activity.ts's doc comment.
   */
  runContinuityAssessmentActivity(
    input: activities.RunContinuityAssessmentInput,
  ): Promise<activities.RunContinuityAssessmentOutput>;
  /**
   * M8: at the SHOT_SELECTION gate, verifies the *persisted* ShotSelectionSet
   * is APPROVED, complete, and current before the workflow advances to
   * COMPOSITING — the workflow-engine guarantee that only a valid human
   * selection can satisfy the gate. See verify-shot-selection-activity.ts.
   */
  verifyShotSelectionActivity(
    input: activities.VerifyShotSelectionInput,
  ): Promise<activities.VerifyShotSelectionOutput>;
  /**
   * M8: on a HUMAN_SHOT_SELECTION -> SHOT_GENERATION regeneration re-entry,
   * loads the reviewer's per-shot regeneration feedback to supply to the
   * generation stage. See load-shot-selection-regeneration-feedback-activity.ts.
   */
  loadShotSelectionRegenerationFeedbackActivity(
    input: activities.LoadShotSelectionRegenerationFeedbackInput,
  ): Promise<activities.LoadShotSelectionRegenerationFeedbackOutput>;
  /**
   * M10: runs the Sound Director at SOUND_DESIGN, persisting the Timeline +
   * versioned SoundDesignPlan + SoundCues (with mock SOUND_STEM assets). See
   * run-sound-director-activity.ts's doc comment.
   */
  runSoundDirectorActivity(
    input: activities.RunSoundDirectorInput,
  ): Promise<activities.RunSoundDirectorOutput>;
  /**
   * M11: runs the Final QA Controller at FINAL_QA over the campaign's
   * registered FINAL_MASTER asset, persisting the immutable asset-based
   * QualityAssessment (+ typed QualityFailures) that `finalQAPassed` /
   * `finalQARepairTargetIs*` read, and reporting the repair target a failing
   * master routes to. See run-final-qa-controller-activity.ts's doc comment.
   */
  runFinalQaControllerActivity(
    input: activities.RunFinalQaControllerInput,
  ): Promise<activities.RunFinalQaControllerOutput>;
}

/**
 * The same contract as a runtime-enumerable tuple, so the Worker-registration
 * conformance test can compare against it without hand-maintaining a parallel
 * list. The assertion below fails to compile if this tuple and the interface
 * above ever disagree in either direction.
 */
export const CAMPAIGN_PRODUCTION_ACTIVITY_NAMES = [
  'advanceCampaignStageActivity',
  'verifyHumanApprovalActivity',
  'runStrategyConceptScriptActivity',
  'runShotPromptEngineerActivity',
  'loadLatestShotSpecificationsActivity',
  'runVisualQualityAssessmentsActivity',
  'runContinuityAssessmentActivity',
  'verifyShotSelectionActivity',
  'loadShotSelectionRegenerationFeedbackActivity',
  'runSoundDirectorActivity',
  'runFinalQaControllerActivity',
] as const satisfies readonly (keyof CampaignProductionActivities)[];

export type CampaignProductionActivityName = (typeof CAMPAIGN_PRODUCTION_ACTIVITY_NAMES)[number];

export type _AssertCampaignProductionNames = Expect<
  Equal<keyof CampaignProductionActivities, CampaignProductionActivityName>
>;
