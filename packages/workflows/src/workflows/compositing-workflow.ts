import { proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type { CompositingWorkflowInput, CompositingWorkflowOutput } from '@combat/domain';
import type { CompositingActivities } from './compositing-workflow-activities';
import {
  cancelCompositingSignal,
  getCompositingProgressQuery,
} from './compositing-workflow-signals';
import {
  applyCancelSignal,
  applyCancelled,
  applyDispatchResult,
  applyEditDirectorResult,
  applyPollFailed,
  applyPolling,
  applySucceeded,
  initialCompositingState,
  toProgress,
  type CompositingState,
} from './compositing-workflow-state';

/**
 * M9 CompositingWorkflow — a deterministic child of `CampaignProductionWorkflow`
 * (one per COMPOSITING visit). Turns a human-approved `ShotSelectionSet` into a
 * versioned `RoughEditSpecification` (Edit Director) and a rough-edit asset
 * (motion-graphics render). No I/O, no wall-clock, no Math.random here — every
 * decision lives in `compositing-workflow-state.ts`; this file is the
 * `proxyActivities`/`sleep` loop. The Edit Director runs once (it also
 * re-verifies the selection is APPROVED/complete/current and every source is
 * still eligible + licensed); the render dispatch/poll is the bounded-retry
 * loop, with cancellation honored at every await boundary.
 */
const {
  runEditDirectorActivity,
  dispatchCompositionRenderActivity,
  pollCompositionRenderActivity,
  cancelCompositionRenderActivity,
} = proxyActivities<CompositingActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '2 seconds', backoffCoefficient: 2, maximumAttempts: 5 },
});

export async function compositingWorkflow(
  input: CompositingWorkflowInput,
): Promise<CompositingWorkflowOutput> {
  let state: CompositingState = initialCompositingState();

  setHandler(cancelCompositingSignal, () => {
    state = applyCancelSignal(state);
  });
  setHandler(getCompositingProgressQuery, () => toProgress(state));

  // 1. Edit Director -> RoughEditSpecification (also revalidates the selection).
  const editResult = await runEditDirectorActivity({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    workflowRunId: input.workflowRunId,
    shotSelectionSetId: input.shotSelectionSetId,
    attempt: 1,
  });
  state = applyEditDirectorResult(state, editResult);
  if (state.status !== 'RUNNING' || !editResult.ok) {
    return toOutput(state);
  }
  const roughEditSpecificationId = editResult.roughEditSpecificationId;

  // 2. Bounded-retry render dispatch/poll loop.
  let attemptNumber = 0;
  outer: for (;;) {
    if (state.cancelled) {
      state = applyCancelled(state);
      return toOutput(state);
    }
    attemptNumber += 1;
    const dispatchResult = await dispatchCompositionRenderActivity({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      workflowRunId: input.workflowRunId,
      roughEditSpecificationId,
      attemptNumber,
      motionGraphicsProviderId: input.motionGraphicsProviderId,
      maxAttempts: input.maxAttempts,
    });
    state = applyDispatchResult(state, attemptNumber, dispatchResult);
    if (!dispatchResult.ok) {
      return toOutput(state);
    }

    const { attemptId, providerId } = dispatchResult;
    for (;;) {
      if (state.cancelled) {
        await cancelCompositionRenderActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          attemptId,
          providerId,
        });
        state = applyCancelled(state);
        return toOutput(state);
      }

      const pollResult = await pollCompositionRenderActivity({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        attemptId,
        providerId,
      });

      if (!('terminal' in pollResult)) {
        // ATTEMPT_NOT_FOUND — unexpected; treat as a failed attempt.
        const { state: next, retry } = applyPollFailed(
          state,
          attemptNumber,
          input.maxAttempts,
          'PROVIDER_ERROR',
          pollResult.detail,
        );
        state = next;
        if (retry) continue outer;
        return toOutput(state);
      }

      if (!pollResult.terminal) {
        state = applyPolling(state, pollResult.status);
        await sleep(input.pollIntervalMs);
        continue;
      }

      if (pollResult.status === 'SUCCEEDED') {
        state = applySucceeded(state, pollResult.roughEditAssetId);
        return toOutput(state);
      }
      if (pollResult.status === 'CANCELLED') {
        state = applyCancelled(state);
        return toOutput(state);
      }

      const { state: next, retry } = applyPollFailed(
        state,
        attemptNumber,
        input.maxAttempts,
        pollResult.failureReason,
        pollResult.failureMessage,
      );
      state = next;
      if (retry) continue outer;
      return toOutput(state);
    }
  }
}

function toOutput(state: CompositingState): CompositingWorkflowOutput {
  return {
    status:
      state.status === 'COMPLETED'
        ? 'COMPLETED'
        : state.status === 'CANCELLED'
          ? 'CANCELLED'
          : 'BLOCKED',
    roughEditSpecificationId: state.roughEditSpecificationId,
    roughEditAssetId: state.roughEditAssetId,
    failureReason: state.lastFailureReason,
    failureMessage: state.lastFailureMessage ?? state.blockedReason,
  };
}
