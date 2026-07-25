import type { BudgetDataSource, VariantDataSource } from '@combat/database';
import {
  getVariantGenerationAttemptById,
  getVariantGenerationJobById,
  releaseBudget,
  updateVariantGenerationAttempt,
  updateVariantGenerationJob,
} from '@combat/database';
import type { BudgetLevel } from '@combat/domain';
import type { MotionGraphicsProvider } from '@combat/providers';

const CHARGEABLE_LEVELS: readonly BudgetLevel[] = ['WORKSPACE', 'CAMPAIGN', 'PROVIDER'];

export interface CancelVariantRenderInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly attemptId: string;
  readonly providerId: string;
}

export interface CancelVariantRenderActivityDeps {
  readonly motionGraphicsProvider: MotionGraphicsProvider;
  readonly variantDb: VariantDataSource;
  readonly budgetDb: BudgetDataSource;
}

/**
 * M12: cancels an in-flight variant render — cancels the provider job, releases
 * the full budget reservation, and marks the attempt (and its job) CANCELLED.
 * Idempotent: cancelling an already-terminal attempt is a no-op that neither
 * calls the provider nor touches the ledger a second time.
 */
export function createCancelVariantRenderActivity(
  deps: CancelVariantRenderActivityDeps,
): (input: CancelVariantRenderInput) => Promise<{ cancelled: boolean }> {
  return async function cancelVariantRenderActivity(
    input: CancelVariantRenderInput,
  ): Promise<{ cancelled: boolean }> {
    const { workspaceId, campaignId, attemptId, providerId } = input;
    const attempt = await getVariantGenerationAttemptById(deps.variantDb, workspaceId, attemptId);
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

    await updateVariantGenerationAttempt(deps.variantDb, attemptId, {
      status: 'CANCELLED',
      completedAt: new Date(),
    });
    const job = await getVariantGenerationJobById(
      deps.variantDb,
      workspaceId,
      attempt.variantGenerationJobId,
    );
    if (job) await updateVariantGenerationJob(deps.variantDb, job.id, { status: 'CANCELLED' });
    return { cancelled: true };
  };
}
