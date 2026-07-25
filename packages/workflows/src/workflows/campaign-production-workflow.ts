import { condition, executeChild, proxyActivities, setHandler } from '@temporalio/workflow';
import type {
  CampaignProductionWorkflowInput,
  CampaignProductionWorkflowOutput,
  GateApprovalSignalPayload,
} from '@combat/domain';
import type { CampaignProductionActivities } from './campaign-production-workflow-activities';
import {
  approveConceptSignal,
  approveFinalSignal,
  getCurrentStageQuery,
  getPendingGateQuery,
  getRevisionCountQuery,
  getStatusQuery,
  selectShotsSignal,
} from './campaign-production-workflow-signals';
import type { shotGenerationWorkflow } from './shot-generation-workflow';
import type { compositingWorkflow } from './compositing-workflow';
import {
  applyAutoForwardResult,
  applyAutoRetryResult,
  applyBoundExceeded,
  applyCompositingSelectionCheck,
  applyCompositingWorkflowResult,
  applyGateAdvanceResult,
  applyLoadLatestShotSpecificationsResult,
  applyRunContinuityAssessmentResult,
  applyRunFinalQaControllerResult,
  applyRunShotPromptEngineerResult,
  applyRunSoundDirectorResult,
  applyRunStrategyConceptScriptResult,
  applyRunVisualQualityAssessmentsResult,
  applyShotGenerationWorkflowResult,
  buildAutoForwardIdempotencyKey,
  buildAutoRetryIdempotencyKey,
  buildGateIdempotencyKey,
  decideGateSignal,
  decideVerifyResult,
  initialCampaignProductionState,
} from './campaign-production-workflow-state';

/**
 * Deterministic workflow code only — no I/O, no fetch, no Date.now(), no
 * imports outside @temporalio/workflow and type-only activity/domain
 * imports (CLAUDE.md "Architecture boundaries"). Drives the 20-stage
 * campaign lifecycle (docs/architecture.md §3.1/§3.2) through
 * `advanceCampaignStageActivity`, awaiting the three approval gates via
 * Signals and exposing state via Queries. Every branching decision lives in
 * campaign-production-workflow-state.ts's pure functions — this file is only
 * the Temporal-SDK plumbing around them.
 */
const {
  advanceCampaignStageActivity,
  verifyHumanApprovalActivity,
  runStrategyConceptScriptActivity,
  runShotPromptEngineerActivity,
  loadLatestShotSpecificationsActivity,
  runVisualQualityAssessmentsActivity,
  runContinuityAssessmentActivity,
  verifyShotSelectionActivity,
  loadShotSelectionRegenerationFeedbackActivity,
  runSoundDirectorActivity,
  runFinalQaControllerActivity,
} = proxyActivities<CampaignProductionActivities>({
  // Longer than the other two activities' effective budget: this one makes
  // three sequential reasoning-provider calls plus their persistence writes,
  // not one.
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

export async function campaignProductionWorkflow(
  input: CampaignProductionWorkflowInput,
): Promise<CampaignProductionWorkflowOutput> {
  let state = initialCampaignProductionState(input.initialStage);
  const incomingSignals: GateApprovalSignalPayload[] = [];

  setHandler(approveConceptSignal, (payload) => {
    if (payload.gate === 'CONCEPT') incomingSignals.push(payload);
  });
  setHandler(selectShotsSignal, (payload) => {
    if (payload.gate === 'SHOT_SELECTION') incomingSignals.push(payload);
  });
  setHandler(approveFinalSignal, (payload) => {
    if (payload.gate === 'FINAL') incomingSignals.push(payload);
  });

  setHandler(getCurrentStageQuery, () => state.currentStage);
  setHandler(getStatusQuery, () => state.status);
  setHandler(getPendingGateQuery, () => state.pendingGate);
  setHandler(getRevisionCountQuery, (gate) => state.revisionCounts[gate]);

  let autoForwardAttempt = 0;

  while (state.status === 'RUNNING' || state.status === 'AWAITING_APPROVAL') {
    if (state.status === 'RUNNING') {
      // M4: STRATEGY_REVIEW is where the text-agent chain runs — Strategist,
      // Creative Director, and Script & Timing Director all execute here
      // (ahead of the CONCEPT gate) so the Concept Review screen can show
      // strategy + concept + script together. This does not move or rename
      // the CONCEPT gate itself, which remains exactly the documented
      // CONCEPT_REVIEW -> SCRIPT_REVIEW edge (docs/domain-model.md §4.2) —
      // it only decides when, within STRATEGY_REVIEW's dwell time, the
      // agents run relative to the auto-forward attempt below. Runs on
      // every visit (including a revision loop back from CONCEPT_REVIEW),
      // since `state.revisionCounts.CONCEPT` is what makes each visit
      // produce a genuinely new version rather than replaying a stale one.
      if (state.currentStage === 'STRATEGY_REVIEW') {
        const agentResult = await runStrategyConceptScriptActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          workflowRunId: input.workflowRunId,
          revisionAttempt: state.revisionCounts.CONCEPT + 1,
        });
        state = applyRunStrategyConceptScriptResult(state, agentResult);
        if (state.status !== 'RUNNING') {
          continue;
        }
      }

      autoForwardAttempt += 1;

      // M6: PROMPTING is where the Shot Prompt Engineer runs, once per shot
      // in the latest script, ahead of the SHOT_GENERATION stage — same
      // "run before the auto-forward attempt" placement as STRATEGY_REVIEW's
      // hook above. There is no REVISION edge onto PROMPTING in the current
      // lifecycle graph (docs/domain-model.md §4), so this only ever runs
      // once per campaign in practice; `autoForwardAttempt` is still used
      // for the idempotency key (rather than a gate-tied revision count, as
      // STRATEGY_REVIEW uses) since no gate currently targets a PROMPTING
      // revisit.
      if (state.currentStage === 'PROMPTING') {
        const promptResult = await runShotPromptEngineerActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          workflowRunId: input.workflowRunId,
          providerId: input.videoProviderId,
          revisionAttempt: autoForwardAttempt,
        });
        state = applyRunShotPromptEngineerResult(state, promptResult);
        if (state.status !== 'RUNNING') {
          continue;
        }
      }

      // M6: SHOT_GENERATION resolves the current visit's ShotSpecifications
      // (first visit from PROMPTING, or a revision revisit from
      // VISUAL_QA/CONTINUITY_QA/HUMAN_SHOT_SELECTION — all three land here
      // directly, docs/domain-model.md §4's revision-loop edges) and runs
      // `ShotGenerationWorkflow` as a child workflow to completion before
      // the normal AUTO_FORWARD attempt below, which will then find
      // `allShotsHaveCandidate` true. `executeChild` (not `startChild`) is
      // used because this stage's auto-forward must wait for every shot's
      // generation to resolve before proceeding — never composite ahead of
      // that (CLAUDE.md: "Do not weaken ... approval gates" and M6
      // requirement 7: "no compositing begins" before successful
      // generation). The child is referenced by its registered workflow
      // *type name*, not a runtime import of `shotGenerationWorkflow` itself
      // — `import type` only supplies the type for `executeChild`'s generic
      // inference, keeping this file free of any non-type-only import
      // (CLAUDE.md "Architecture boundaries").
      if (state.currentStage === 'SHOT_GENERATION') {
        const specResult = await loadLatestShotSpecificationsActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
        });
        state = applyLoadLatestShotSpecificationsResult(state, specResult);
        if (state.status !== 'RUNNING') {
          continue;
        }
        if (specResult.ok) {
          // M8: if this SHOT_GENERATION visit is a HUMAN_SHOT_SELECTION
          // regeneration re-entry, load the reviewer's per-shot feedback and
          // carry it into the child for provenance (the mock provider does not
          // consume it — targeted regeneration is deferred; see the M8 entry
          // in docs/architecture.md §8).
          const regen = await loadShotSelectionRegenerationFeedbackActivity({
            workspaceId: input.workspaceId,
            campaignId: input.campaignId,
          });
          const childResult = await executeChild<typeof shotGenerationWorkflow>(
            'shotGenerationWorkflow',
            {
              workflowId: `${input.workflowRunId}:SHOT_GENERATION:${autoForwardAttempt}`,
              args: [
                {
                  workspaceId: input.workspaceId,
                  campaignId: input.campaignId,
                  workflowRunId: input.workflowRunId,
                  shotSpecificationIds: specResult.shotSpecificationIds,
                  regenerationFeedback: regen.feedback.length > 0 ? [...regen.feedback] : undefined,
                  // Matches shot-generation-workflow-contracts.ts's
                  // DEFAULT_MAX_GENERATION_ATTEMPTS/DEFAULT_GENERATION_BATCH_SIZE/
                  // DEFAULT_POLL_INTERVAL_MS — supplied explicitly rather than
                  // imported as values, since workflow files may only import
                  // @temporalio/workflow and type-only signatures (CLAUDE.md
                  // "Architecture boundaries"); Zod `.default()`s never apply
                  // along this path because nothing on it ever calls `.parse()`.
                  maxAttempts: 3,
                  batchSize: 3,
                  pollIntervalMs: 2000,
                },
              ],
            },
          );
          state = applyShotGenerationWorkflowResult(state, childResult);
          if (state.status !== 'RUNNING') {
            continue;
          }
        }
      }

      // M7: VISUAL_QA runs the Visual Quality Controller over each shot's
      // latest candidate, persisting immutable assessments. If every shot
      // passes, the normal AUTO_FORWARD below finds `allShotsPassedVisualQA`
      // true and advances to CONTINUITY_QA. If a shot fails, an AUTO_RETRY
      // routes back to SHOT_GENERATION — bounded by `visualQARetryAllowed`
      // (the Activity returns MISSING_PREREQUISITE, escalating to BLOCKED,
      // once a shot exhausts its generation attempts) and unable to cross any
      // human gate (AUTO_RETRY only ever traverses VISUAL_QA/CONTINUITY_QA ->
      // SHOT_GENERATION). The assessment Activity never advances a stage or
      // fires an approval signal itself.
      if (state.currentStage === 'VISUAL_QA') {
        const visualResult = await runVisualQualityAssessmentsActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          workflowRunId: input.workflowRunId,
          providerId: input.videoProviderId,
          revisionAttempt: autoForwardAttempt,
        });
        state = applyRunVisualQualityAssessmentsResult(state, visualResult);
        if (state.status !== 'RUNNING') {
          continue;
        }
        if (visualResult.ok && !visualResult.allPassed) {
          const retryResult = await advanceCampaignStageActivity({
            mode: 'AUTO_RETRY',
            workspaceId: input.workspaceId,
            campaignId: input.campaignId,
            fromStage: state.currentStage,
            idempotencyKey: buildAutoRetryIdempotencyKey(
              input.workflowRunId,
              state.currentStage,
              autoForwardAttempt,
            ),
          });
          state = applyAutoRetryResult(state, retryResult);
          continue;
        }
      }

      // M7: CONTINUITY_QA runs the Continuity Controller over the ordered
      // candidate sequence — reached only after VISUAL_QA cleared every shot,
      // so eligible visual results always exist. Same pass/AUTO_RETRY routing
      // as VISUAL_QA, gated by the bounded `continuityQARetryAllowed` fact.
      if (state.currentStage === 'CONTINUITY_QA') {
        const continuityResult = await runContinuityAssessmentActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          workflowRunId: input.workflowRunId,
          providerId: input.videoProviderId,
          revisionAttempt: autoForwardAttempt,
        });
        state = applyRunContinuityAssessmentResult(state, continuityResult);
        if (state.status !== 'RUNNING') {
          continue;
        }
        if (continuityResult.ok && !continuityResult.allPassed) {
          const retryResult = await advanceCampaignStageActivity({
            mode: 'AUTO_RETRY',
            workspaceId: input.workspaceId,
            campaignId: input.campaignId,
            fromStage: state.currentStage,
            idempotencyKey: buildAutoRetryIdempotencyKey(
              input.workflowRunId,
              state.currentStage,
              autoForwardAttempt,
            ),
          });
          state = applyAutoRetryResult(state, retryResult);
          continue;
        }
      }

      // M9: COMPOSITING runs the CompositingWorkflow child — Edit Director ->
      // versioned RoughEditSpecification -> mock rough-edit render -> registered
      // ROUGH_CUT asset + COMPOSITING RenderJob + EditDecisionList. It starts
      // ONLY from a still-valid approved selection: `verifyShotSelectionActivity`
      // re-reads the persisted set here (defense-in-depth over the gate), so a
      // stale/incomplete selection cannot begin compositing. On COMPLETED, the
      // normal AUTO_FORWARD below finds `compositingComplete` true and advances
      // to ROUGH_CUT; a BLOCKED/CANCELLED child escalates the parent to BLOCKED
      // — no rough-cut/sound work begins ahead of a real rough edit. The child
      // id is derived from the campaign key (matches
      // `compositingChildWorkflowId` in @combat/domain, which apps/api's cancel
      // endpoint targets) — constructed inline because workflow files may not
      // import a value from @combat/domain (CLAUDE.md "Architecture boundaries").
      if (state.currentStage === 'COMPOSITING') {
        const selectionCheck = await verifyShotSelectionActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
        });
        state = applyCompositingSelectionCheck(
          state,
          selectionCheck.valid,
          selectionCheck.valid ? '' : selectionCheck.reason,
        );
        if (state.status !== 'RUNNING') {
          continue;
        }
        if (selectionCheck.valid) {
          const childResult = await executeChild<typeof compositingWorkflow>(
            'compositingWorkflow',
            {
              workflowId: `compositing:${input.campaignId}`,
              args: [
                {
                  workspaceId: input.workspaceId,
                  campaignId: input.campaignId,
                  workflowRunId: input.workflowRunId,
                  shotSelectionSetId: selectionCheck.setId,
                  motionGraphicsProviderId: 'mock-motion-graphics',
                  maxAttempts: 3,
                  pollIntervalMs: 2000,
                },
              ],
            },
          );
          state = applyCompositingWorkflowResult(state, childResult);
          if (state.status !== 'RUNNING') {
            continue;
          }
        }
      }

      // M10: SOUND_DESIGN runs the Sound Director over the rough edit, persisting
      // the assembled Timeline + versioned SoundDesignPlan + SoundCues (with mock
      // SOUND_STEM assets) — same "run before the AUTO_FORWARD attempt" placement
      // as the STRATEGY_REVIEW/PROMPTING hooks. On success the normal AUTO_FORWARD
      // below finds `soundDesignComplete` true and advances to FINAL_QA (which
      // then legitimately BLOCKS — no Final QA Controller until M11). A failure
      // escalates straight to BLOCKED.
      if (state.currentStage === 'SOUND_DESIGN') {
        const soundResult = await runSoundDirectorActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          workflowRunId: input.workflowRunId,
          revisionAttempt: autoForwardAttempt,
        });
        state = applyRunSoundDirectorResult(state, soundResult);
        if (state.status !== 'RUNNING') {
          continue;
        }
      }

      // M11: FINAL_QA runs the Final QA Controller over the campaign's
      // FINAL_MASTER asset, persisting the immutable asset-based
      // QualityAssessment that `finalQAPassed` reads. A pass falls through to
      // the AUTO_FORWARD below, which advances to FINAL_APPROVAL — where the
      // FINAL human gate still has to be satisfied by a real persisted
      // HumanApproval, exactly as before. A failure issues an AUTO_RETRY to the
      // repair target the Activity derived from the failure categories
      // (COMPOSITING | ROUGH_CUT | SOUND_DESIGN — all non-gated edges, so this
      // never crosses an approval gate), bounded by the persisted
      // `finalQARepairTargetIs*` facts. An unroutable failure escalates to
      // BLOCKED inside the reducer rather than guessing an edge.
      if (state.currentStage === 'FINAL_QA') {
        const finalQaResult = await runFinalQaControllerActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          workflowRunId: input.workflowRunId,
          revisionAttempt: autoForwardAttempt,
        });
        state = applyRunFinalQaControllerResult(state, finalQaResult);
        if (state.status !== 'RUNNING') {
          continue;
        }
        if (finalQaResult.ok && !finalQaResult.pass) {
          const retryResult = await advanceCampaignStageActivity({
            mode: 'AUTO_RETRY',
            workspaceId: input.workspaceId,
            campaignId: input.campaignId,
            fromStage: state.currentStage,
            repairTarget: finalQaResult.repairTarget,
            idempotencyKey: buildAutoRetryIdempotencyKey(
              input.workflowRunId,
              state.currentStage,
              autoForwardAttempt,
            ),
          });
          state = applyAutoRetryResult(state, retryResult);
          continue;
        }
      }

      const result = await advanceCampaignStageActivity({
        mode: 'AUTO_FORWARD',
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        fromStage: state.currentStage,
        idempotencyKey: buildAutoForwardIdempotencyKey(
          input.workflowRunId,
          state.currentStage,
          autoForwardAttempt,
        ),
      });
      state = applyAutoForwardResult(state, result);
      continue;
    }

    const gate = state.pendingGate!;
    await condition(() => incomingSignals.length > 0);
    const payload = incomingSignals.shift()!;

    const signalDecision = decideGateSignal(state, payload);
    if (signalDecision.kind === 'IGNORE') {
      continue;
    }

    const verifyResult = await verifyHumanApprovalActivity({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      approvalId: signalDecision.approvalId,
      expectedGate: gate,
    });
    const verifyOutcome = decideVerifyResult(state, gate, input.maxRevisionsPerGate, verifyResult);
    if (verifyOutcome.kind === 'IGNORE') {
      continue;
    }
    if (verifyOutcome.kind === 'BOUND_EXCEEDED') {
      state = applyBoundExceeded(state, gate, input.maxRevisionsPerGate);
      continue;
    }

    const { approval } = verifyOutcome;

    // M8: the SHOT_SELECTION gate is satisfied by an APPROVED decision ONLY
    // when the persisted ShotSelectionSet is itself valid (APPROVED, complete,
    // current). This re-reads persisted state via an Activity — a signal
    // cannot fabricate gate satisfaction, and an invalid/stale selection never
    // crosses to COMPOSITING. A non-approved (regeneration) decision skips this
    // check and routes to SHOT_GENERATION as before.
    if (gate === 'SHOT_SELECTION' && approval.decision === 'APPROVED') {
      const selectionCheck = await verifyShotSelectionActivity({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
      });
      if (!selectionCheck.valid) {
        // Do not advance; stay AWAITING_APPROVAL so a corrected re-approval can
        // proceed. The signal is treated as not-yet-satisfying the gate.
        continue;
      }
    }

    const advanceResult = await advanceCampaignStageActivity({
      mode: 'GATE_DECISION',
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      fromStage: state.currentStage,
      idempotencyKey: buildGateIdempotencyKey(input.workflowRunId, gate, approval.id),
      gate,
      decision: approval.decision,
      repairTarget: approval.repairTarget,
      requestedByUserId: approval.decidedByUserId,
    });
    state = applyGateAdvanceResult(state, gate, approval, advanceResult);
  }

  return {
    finalStage: state.currentStage,
    status: state.status,
    blockedReason: state.blockedReason,
  };
}
