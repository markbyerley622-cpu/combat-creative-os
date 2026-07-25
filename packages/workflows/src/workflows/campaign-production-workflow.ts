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
import {
  applyAutoForwardResult,
  applyBoundExceeded,
  applyGateAdvanceResult,
  applyLoadLatestShotSpecificationsResult,
  applyRunShotPromptEngineerResult,
  applyRunStrategyConceptScriptResult,
  applyShotGenerationWorkflowResult,
  buildAutoForwardIdempotencyKey,
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
