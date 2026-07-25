import { proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type { VariantWorkflowInput, VariantWorkflowOutput } from '@combat/domain';
import type { VariantActivities } from './variant-workflow-activities';
import { cancelVariantsSignal, getVariantProgressQuery } from './variant-workflow-signals';
import {
  applyCancelSignal,
  applyCancelled,
  applyDispatchResult,
  applyEntryCancelled,
  applyPollFailed,
  applyPolling,
  applyRenderSucceeded,
  applyVariantGeneratorResult,
  applyVariantQaResult,
  initialVariantState,
  toOutput,
  toProgress,
  type VariantState,
} from './variant-workflow-state';

/**
 * M12 VariantWorkflow — a deterministic child of `CampaignProductionWorkflow`
 * (one per VARIANT_GENERATION visit). Cuts an approved, Final-QA-passed
 * `FINAL_MASTER` into one delivery variant per duration in the campaign's
 * delivery profile, renders each through the motion-graphics provider, and
 * re-runs Final QA over every completed variant.
 *
 * No I/O, no wall-clock, no Math.random here — every decision lives in
 * `variant-workflow-state.ts`; this file is the `proxyActivities`/`sleep` loop.
 * The Variant Generator runs once (it also re-verifies the master passed Final
 * QA and validates every cut before persisting); the render dispatch/poll is a
 * bounded-retry loop per variant, with cancellation honored at every await
 * boundary. Replay-safe: every Activity it calls is idempotent on a key derived
 * from `(workflowRunId, specification, attempt)`.
 */
const {
  runVariantGeneratorActivity,
  dispatchVariantRenderActivity,
  pollVariantRenderActivity,
  cancelVariantRenderActivity,
  runVariantFinalQaActivity,
} = proxyActivities<VariantActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '2 seconds', backoffCoefficient: 2, maximumAttempts: 5 },
});

export async function variantWorkflow(input: VariantWorkflowInput): Promise<VariantWorkflowOutput> {
  let state: VariantState = initialVariantState();

  setHandler(cancelVariantsSignal, () => {
    state = applyCancelSignal(state);
  });
  setHandler(getVariantProgressQuery, () => toProgress(state));

  // 1. Variant Generator -> one immutable VariantSpecification per duration.
  //    Also the gate that refuses a master which did not pass Final QA, and
  //    the point every cut is validated against the persisted timeline.
  const generatorResult = await runVariantGeneratorActivity({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    workflowRunId: input.workflowRunId,
    deliveryProfileKey: input.deliveryProfileKey,
    revisionAttempt: input.revisionAttempt,
  });
  state = applyVariantGeneratorResult(state, generatorResult);
  if (state.status !== 'RUNNING' || !generatorResult.ok) {
    return toOutput(state);
  }

  // 2. Per variant: bounded-retry render, then a Final QA re-run.
  for (const specification of generatorResult.specifications) {
    const specId = specification.variantSpecificationId;

    let rendered: { creativeVariantId: string; variantAssetId: string } | undefined;
    let attemptNumber = 0;

    render: for (;;) {
      if (state.cancelled) {
        state = applyCancelled(state);
        return toOutput(state);
      }
      attemptNumber += 1;
      const dispatchResult = await dispatchVariantRenderActivity({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        workflowRunId: input.workflowRunId,
        variantSpecificationId: specId,
        attemptNumber,
        motionGraphicsProviderId: input.motionGraphicsProviderId,
        maxAttempts: input.maxAttempts,
      });
      state = applyDispatchResult(state, specId, attemptNumber, dispatchResult);
      if (!dispatchResult.ok) {
        break render;
      }

      const { attemptId, providerId } = dispatchResult;
      for (;;) {
        if (state.cancelled) {
          await cancelVariantRenderActivity({
            workspaceId: input.workspaceId,
            campaignId: input.campaignId,
            attemptId,
            providerId,
          });
          state = applyCancelled(state);
          return toOutput(state);
        }

        const pollResult = await pollVariantRenderActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          attemptId,
          providerId,
        });

        if (!('terminal' in pollResult)) {
          // ATTEMPT_NOT_FOUND — unexpected; treat as a failed attempt.
          const { state: next, retry } = applyPollFailed(
            state,
            specId,
            attemptNumber,
            input.maxAttempts,
            'PROVIDER_ERROR',
            pollResult.detail,
          );
          state = next;
          if (retry) continue render;
          break render;
        }

        if (!pollResult.terminal) {
          state = applyPolling(state, specId, pollResult.status);
          await sleep(input.pollIntervalMs);
          continue;
        }

        if (pollResult.status === 'SUCCEEDED') {
          rendered = {
            creativeVariantId: pollResult.creativeVariantId,
            variantAssetId: pollResult.variantAssetId,
          };
          state = applyRenderSucceeded(
            state,
            specId,
            pollResult.creativeVariantId,
            pollResult.variantAssetId,
          );
          break render;
        }
        if (pollResult.status === 'CANCELLED') {
          state = applyEntryCancelled(state, specId);
          break render;
        }

        const { state: next, retry } = applyPollFailed(
          state,
          specId,
          attemptNumber,
          input.maxAttempts,
          pollResult.failureReason,
          pollResult.failureMessage,
        );
        state = next;
        if (retry) continue render;
        break render;
      }
    }

    // 3. Final QA re-run — the ONLY path that promotes a variant to READY.
    if (rendered) {
      const qaResult = await runVariantFinalQaActivity({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        workflowRunId: input.workflowRunId,
        variantSpecificationId: specId,
        revisionAttempt: input.revisionAttempt,
      });
      state = applyVariantQaResult(state, specId, qaResult);
    }
  }

  return toOutput(state);
}
