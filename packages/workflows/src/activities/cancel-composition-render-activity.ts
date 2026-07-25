import type { BudgetDataSource, CompositionDataSource } from '@combat/database';
import {
  getCompositionAttemptById,
  getCompositionJobById,
  releaseBudget,
  updateCompositionAttempt,
  updateCompositionJob,
} from '@combat/database';
import type { BudgetLevel } from '@combat/domain';
import type { MotionGraphicsProvider } from '@combat/providers';

const CHARGEABLE_LEVELS: readonly BudgetLevel[] = ['WORKSPACE', 'CAMPAIGN', 'PROVIDER'];

export interface CancelCompositionRenderInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly attemptId: string;
  readonly providerId: string;
}

export interface CancelCompositionRenderActivityDeps {
  readonly motionGraphicsProvider: MotionGraphicsProvider;
  readonly compositionDb: CompositionDataSource;
  readonly budgetDb: BudgetDataSource;
}

/**
 * M9: cancels an in-flight composition render — cancels the provider job,
 * releases the full budget reservation, and marks the attempt (and its job)
 * CANCELLED. Idempotent: cancelling an already-terminal attempt is a no-op.
 */
export function createCancelCompositionRenderActivity(
  deps: CancelCompositionRenderActivityDeps,
): (input: CancelCompositionRenderInput) => Promise<{ cancelled: boolean }> {
  return async function cancelCompositionRenderActivity(
    input: CancelCompositionRenderInput,
  ): Promise<{ cancelled: boolean }> {
    const { workspaceId, campaignId, attemptId, providerId } = input;
    const attempt = await getCompositionAttemptById(deps.compositionDb, workspaceId, attemptId);
    if (!attempt) return { cancelled: false };
    if (['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(attempt.status)) {
      return { cancelled: false };
    }

    if (attempt.providerJobId) {
      await deps.motionGraphicsProvider.cancel({ jobId: attempt.providerJobId });
    }
    for (const level of CHARGEABLE_LEVELS) {
      const scopeId =
        level === 'WORKSPACE' ? workspaceId : level === 'CAMPAIGN' ? campaignId : providerId;
      // eslint-disable-next-line no-await-in-loop -- bounded by CHARGEABLE_LEVELS.length
      const policy = await deps.budgetDb.budgetPolicy.findFirst({
        where: { workspaceId, level, scopeId },
      });
      if (!policy) continue;
      // eslint-disable-next-line no-await-in-loop -- sequential ledger writes
      await releaseBudget(deps.budgetDb, policy.id, workspaceId, {
        amountCents: attempt.estimatedCostCents ?? 0,
        idempotencyKey: `${attempt.idempotencyKey}:release`,
        campaignId,
      });
    }

    await updateCompositionAttempt(deps.compositionDb, attemptId, {
      status: 'CANCELLED',
      completedAt: new Date(),
    });
    const job = await getCompositionJobById(
      deps.compositionDb,
      workspaceId,
      attempt.compositionJobId,
    );
    if (job) await updateCompositionJob(deps.compositionDb, job.id, { status: 'CANCELLED' });
    return { cancelled: true };
  };
}
