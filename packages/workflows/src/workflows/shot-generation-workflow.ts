import { proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type { ShotGenerationWorkflowInput, ShotGenerationWorkflowOutput } from '@combat/domain';
import type { ShotGenerationActivities } from './shot-generation-workflow-activities';
import {
  cancelShotGenerationSignal,
  getShotGenerationProgressQuery,
} from './shot-generation-workflow-signals';
import {
  allShotsSucceeded,
  anyShotFailed,
  applyAttemptFailed,
  applyCancelSignal,
  applyCancelled,
  applyDispatchResult,
  applyPolling,
  applySucceeded,
  initialShotGenerationState,
  toProgress,
  type ShotGenerationState,
} from './shot-generation-workflow-state';

/**
 * Deterministic workflow code only — no I/O, no fetch, no Date.now(), no
 * Math.random(), no imports outside @temporalio/workflow and type-only
 * activity/domain imports (CLAUDE.md "Architecture boundaries"). Every
 * branching decision lives in shot-generation-workflow-state.ts's pure
 * functions; this file is only the Temporal-SDK plumbing (proxyActivities/
 * setHandler/sleep) and the async orchestration loop around them — the loop
 * itself has to live here rather than in the pure-function file because it
 * genuinely interleaves `await`s on Activity calls and `sleep`, which the
 * pure-reducer file (by design, so it stays unit-testable without any
 * Temporal runtime at all) never does.
 *
 * A child workflow of `CampaignProductionWorkflow` (M6 requirement 5), one
 * instance per PROMPTING/SHOT_GENERATION visit, covering every shot in that
 * visit's script — not one child workflow per shot, despite this
 * milestone's requirement wording being read literally ("a deterministic
 * child workflow that ... dispatches independent shot generations in
 * bounded parallel batches" is naturally one workflow instance managing
 * many shots, not many single-shot workflow instances).
 *
 * Per shot: dispatch an attempt, poll it to a terminal state (sleeping
 * between polls — never busy-polling), and on a retryable terminal failure,
 * dispatch a new attempt up to `input.maxAttempts` (CLAUDE.md: "Bound
 * retries explicitly ... escalate to a human state rather than retrying
 * forever"). Shots run in bounded parallel batches of `input.batchSize`
 * (M6 requirement 5), not all at once and not strictly sequentially.
 *
 * A dispatch-time failure (SPEC_NOT_FOUND, UNSUPPORTED_CAPABILITY,
 * BUDGET_EXCEEDED, PROVIDER_ERROR before any provider job existed) is
 * treated as terminal for that shot with no retry — retrying an unsupported
 * capability or a not-found spec cannot succeed, and a budget/provider
 * failure at dispatch time is surfaced for a human/operator to act on rather
 * than blindly resubmitted. The bounded-retry loop this milestone's
 * requirement 5 asks for applies to the poll-time terminal FAILED/TIMED_OUT
 * case, which is the realistic "the provider job itself failed" scenario.
 */
const { dispatchShotGenerationActivity, pollShotGenerationActivity, cancelShotGenerationActivity } =
  proxyActivities<ShotGenerationActivities>({
    startToCloseTimeout: '1 minute',
    retry: {
      initialInterval: '2 seconds',
      backoffCoefficient: 2,
      maximumAttempts: 5,
    },
  });

export async function shotGenerationWorkflow(
  input: ShotGenerationWorkflowInput,
): Promise<ShotGenerationWorkflowOutput> {
  let state: ShotGenerationState = initialShotGenerationState(input.shotSpecificationIds);

  setHandler(cancelShotGenerationSignal, () => {
    state = applyCancelSignal(state);
  });
  setHandler(getShotGenerationProgressQuery, () => toProgress(state));

  async function runShotToTerminal(shotSpecificationId: string): Promise<void> {
    let attemptNumber = 0;

    for (;;) {
      if (state.cancelled) {
        state = applyCancelled(state, shotSpecificationId);
        return;
      }

      attemptNumber += 1;
      const dispatchResult = await dispatchShotGenerationActivity({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        workflowRunId: input.workflowRunId,
        shotSpecificationId,
        attemptNumber,
      });
      state = applyDispatchResult(state, shotSpecificationId, attemptNumber, dispatchResult);
      if (!dispatchResult.ok) {
        return;
      }

      const { attemptId, shotId, providerId } = dispatchResult;
      for (;;) {
        if (state.cancelled) {
          await cancelShotGenerationActivity({
            workspaceId: input.workspaceId,
            campaignId: input.campaignId,
            shotId,
            providerId,
            attemptId,
          });
          state = applyCancelled(state, shotSpecificationId);
          return;
        }

        const pollResult = await pollShotGenerationActivity({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          shotId,
          providerId,
          attemptId,
        });

        if (!('terminal' in pollResult)) {
          const { state: nextState } = applyAttemptFailed(
            state,
            shotSpecificationId,
            attemptNumber,
            input.maxAttempts,
            'ATTEMPT_NOT_FOUND',
            pollResult.detail,
          );
          state = nextState;
          return;
        }

        if (!pollResult.terminal) {
          state = applyPolling(state, shotSpecificationId);
          await sleep(input.pollIntervalMs);
          continue;
        }

        if (pollResult.status === 'SUCCEEDED') {
          state = applySucceeded(state, shotSpecificationId, pollResult.assetIds);
          return;
        }
        if (pollResult.status === 'CANCELLED') {
          state = applyCancelled(state, shotSpecificationId);
          return;
        }

        // FAILED or TIMED_OUT
        const { state: nextState, retry } = applyAttemptFailed(
          state,
          shotSpecificationId,
          attemptNumber,
          input.maxAttempts,
          pollResult.failureReason,
          pollResult.failureMessage,
        );
        state = nextState;
        if (retry) {
          break; // back to the outer loop -> dispatch a new attempt
        }
        return;
      }
    }
  }

  const batches = chunk(input.shotSpecificationIds, input.batchSize);
  for (const batch of batches) {
    // eslint-disable-next-line no-await-in-loop -- batches must run one at a time (that's the "bounded" in "bounded parallel batches"); shots within a batch already run concurrently via Promise.all
    await Promise.all(batch.map((id) => runShotToTerminal(id)));
  }

  return {
    status: state.cancelled
      ? 'CANCELLED'
      : anyShotFailed(state)
        ? 'BLOCKED'
        : allShotsSucceeded(state)
          ? 'COMPLETED'
          : 'BLOCKED',
    shotResults: Object.values(state.perShot).map((shot) => ({
      shotSpecificationId: shot.shotSpecificationId,
      status:
        shot.status === 'SUCCEEDED' ||
        shot.status === 'CANCELLED' ||
        shot.status === 'RETRY_EXHAUSTED'
          ? shot.status
          : 'FAILED',
      candidateAssetIds: [...(shot.candidateAssetIds ?? [])],
      failureReason: shot.lastFailureReason,
      failureMessage: shot.lastFailureMessage,
    })),
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
