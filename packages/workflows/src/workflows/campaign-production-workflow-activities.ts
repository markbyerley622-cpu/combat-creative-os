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
