import type { ShotGenerationDataSource } from '@combat/database';
import {
  getShotGenerationAttemptById,
  releaseBudget,
  updateShotGenerationAttempt,
  updateShotGenerationJob,
  type BudgetDataSource,
} from '@combat/database';
import type { BudgetLevel } from '@combat/domain';
import type { VideoGenerationProvider } from '@combat/providers';

const CANCELLABLE_LEVELS: readonly BudgetLevel[] = ['WORKSPACE', 'CAMPAIGN', 'SHOT', 'PROVIDER'];
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);

export interface CancelShotGenerationInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly shotId: string;
  readonly providerId: string;
  readonly attemptId: string;
}

export type CancelShotGenerationOutput =
  | { readonly ok: true; readonly alreadyTerminal: boolean }
  | { readonly ok: false; readonly reason: 'ATTEMPT_NOT_FOUND'; readonly detail: string };

export interface CancelShotGenerationActivityDeps {
  readonly videoGenerationProvider: VideoGenerationProvider;
  readonly shotGenerationDb: ShotGenerationDataSource;
  readonly budgetDb: BudgetDataSource;
}

/**
 * Cancels one in-flight generation attempt (M6 requirement 5: "supports
 * cancellation") and releases its full budget reservation across every
 * level a reservation was made at. A no-op, not an error, against an attempt
 * that has already reached a terminal state — cancellation racing a
 * just-completed poll is expected, not a failure.
 */
export function createCancelShotGenerationActivity(
  deps: CancelShotGenerationActivityDeps,
): (input: CancelShotGenerationInput) => Promise<CancelShotGenerationOutput> {
  return async function cancelShotGenerationActivity(
    input: CancelShotGenerationInput,
  ): Promise<CancelShotGenerationOutput> {
    const { workspaceId, campaignId, shotId, providerId, attemptId } = input;

    const attempt = await getShotGenerationAttemptById(
      deps.shotGenerationDb,
      workspaceId,
      attemptId,
    );
    if (!attempt) {
      return {
        ok: false,
        reason: 'ATTEMPT_NOT_FOUND',
        detail: `ShotGenerationAttempt ${attemptId} not found`,
      };
    }
    if (TERMINAL_STATUSES.has(attempt.status)) {
      return { ok: true, alreadyTerminal: true };
    }

    if (attempt.providerJobId) {
      await deps.videoGenerationProvider.cancel({ jobId: attempt.providerJobId, shotId });
    }

    for (const level of CANCELLABLE_LEVELS) {
      const scopeId =
        level === 'WORKSPACE'
          ? workspaceId
          : level === 'CAMPAIGN'
            ? campaignId
            : level === 'SHOT'
              ? shotId
              : providerId;
      // eslint-disable-next-line no-await-in-loop -- bounded by CANCELLABLE_LEVELS.length (4)
      const policy = await deps.budgetDb.budgetPolicy.findFirst({
        where: { workspaceId, level, scopeId },
      });
      if (!policy) continue;
      // eslint-disable-next-line no-await-in-loop -- same rationale as above
      await releaseBudget(deps.budgetDb, policy.id, workspaceId, {
        amountCents: attempt.estimatedCostCents ?? 0,
        idempotencyKey: `${attempt.idempotencyKey}:release`,
        campaignId,
        shotId,
      });
    }

    await updateShotGenerationAttempt(deps.shotGenerationDb, attemptId, {
      status: 'CANCELLED',
      completedAt: new Date(),
    });
    await updateShotGenerationJob(deps.shotGenerationDb, attempt.shotGenerationJobId, {
      status: 'CANCELLED',
    });

    return { ok: true, alreadyTerminal: false };
  };
}
