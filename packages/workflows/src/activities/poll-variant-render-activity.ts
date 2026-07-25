import type { AssetDataSource, BudgetDataSource, VariantDataSource } from '@combat/database';
import {
  createAssetWithProvenance,
  findAssetByChecksum,
  getOrCreateCreativeVariant,
  getVariantGenerationAttemptById,
  getVariantGenerationJobById,
  getVariantSpecification,
  releaseBudget,
  settleBudgetReservation,
  updateCreativeVariant,
  updateVariantGenerationAttempt,
  updateVariantGenerationJob,
} from '@combat/database';
import type { BudgetLevel, VariantGenerationFailureReason } from '@combat/domain';
import type { MotionGraphicsProvider } from '@combat/providers';

const CHARGEABLE_LEVELS: readonly BudgetLevel[] = ['WORKSPACE', 'CAMPAIGN', 'PROVIDER'];
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);

export interface PollVariantRenderInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly attemptId: string;
  readonly providerId: string;
}

export type PollVariantRenderOutput =
  | { readonly terminal: false; readonly status: 'QUEUED' | 'SUBMITTED' | 'POLLING' }
  | {
      readonly terminal: true;
      readonly status: 'SUCCEEDED';
      readonly variantAssetId: string;
      readonly creativeVariantId: string;
    }
  | { readonly terminal: true; readonly status: 'CANCELLED' }
  | {
      readonly terminal: true;
      readonly status: 'FAILED' | 'TIMED_OUT';
      readonly failureReason: VariantGenerationFailureReason;
      readonly failureMessage: string;
    }
  | { readonly ok: false; readonly reason: 'ATTEMPT_NOT_FOUND'; readonly detail: string };

export interface PollVariantRenderActivityDeps {
  readonly motionGraphicsProvider: MotionGraphicsProvider;
  readonly variantDb: VariantDataSource;
  readonly assetDb: AssetDataSource;
  readonly budgetDb: BudgetDataSource;
}

/**
 * M12: polls one variant render attempt to a terminal state. A non-terminal
 * status is persisted and returned for the workflow to re-poll after a
 * deterministic `sleep`.
 *
 * A terminal outcome is fully resolved here and is idempotent under Activity
 * retry: SUCCEEDED registers the derived `VARIANT` asset (deduped by the
 * provider's deterministic checksum, no real video bytes — the mock renderer
 * returns metadata only) with a real provenance edge back to the parent
 * `FINAL_MASTER` and every retained source asset, creates/updates the
 * `CreativeVariant` row the `variantsGenerated` fact reads, then settles the
 * budget — charging the provider's actual usage and releasing the reservation
 * in full, so `spentCents` reflects the real cost and nothing else.
 * FAILED/TIMED_OUT/CANCELLED release the reservation without a charge and mark
 * the variant FAILED.
 * Re-polling an already-terminal attempt replays its outcome without calling
 * the provider or touching the ledger again.
 *
 * The variant is left `RENDERING` — not `READY` — on success: only the Final QA
 * re-run (`runVariantFinalQaActivity`) may promote it, so `variantQAPassed`
 * can never be satisfied by a render alone.
 */
export function createPollVariantRenderActivity(
  deps: PollVariantRenderActivityDeps,
): (input: PollVariantRenderInput) => Promise<PollVariantRenderOutput> {
  return async function pollVariantRenderActivity(
    input: PollVariantRenderInput,
  ): Promise<PollVariantRenderOutput> {
    const { workspaceId, campaignId, attemptId, providerId } = input;

    const attempt = await getVariantGenerationAttemptById(deps.variantDb, workspaceId, attemptId);
    if (!attempt || !attempt.providerJobId) {
      return {
        ok: false,
        reason: 'ATTEMPT_NOT_FOUND',
        detail: `attempt ${attemptId} not dispatched`,
      };
    }

    const job = await getVariantGenerationJobById(
      deps.variantDb,
      workspaceId,
      attempt.variantGenerationJobId,
    );
    if (!job) {
      return {
        ok: false,
        reason: 'ATTEMPT_NOT_FOUND',
        detail: `job ${attempt.variantGenerationJobId} not found`,
      };
    }

    if (TERMINAL.has(attempt.status)) {
      if (attempt.status === 'SUCCEEDED' && attempt.outputAssetId) {
        const variant = await getOrCreateExistingVariant(deps, workspaceId, job, attempt);
        return {
          terminal: true,
          status: 'SUCCEEDED',
          variantAssetId: attempt.outputAssetId,
          creativeVariantId: variant,
        };
      }
      if (attempt.status === 'CANCELLED') return { terminal: true, status: 'CANCELLED' };
      return {
        terminal: true,
        status: attempt.status === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED',
        failureReason: attempt.failureReason ?? 'PROVIDER_ERROR',
        failureMessage: attempt.failureMessage ?? 'variant render failed',
      };
    }

    const handle = { jobId: attempt.providerJobId };
    const status = await deps.motionGraphicsProvider.getStatus(handle);

    if (!TERMINAL.has(status)) {
      await updateVariantGenerationAttempt(deps.variantDb, attemptId, {
        status: status as 'QUEUED' | 'SUBMITTED' | 'POLLING',
      });
      return { terminal: false, status: status as 'QUEUED' | 'SUBMITTED' | 'POLLING' };
    }

    const spec = await getVariantSpecification(
      deps.variantDb,
      workspaceId,
      job.variantSpecificationId,
    );
    const estimatedCents = attempt.estimatedCostCents ?? 0;

    if (status === 'SUCCEEDED') {
      const output = await deps.motionGraphicsProvider.fetchRenderOutput(handle);
      const usage = await deps.motionGraphicsProvider.getUsage(handle);

      // Provenance: VARIANT -> parent FINAL_MASTER + every retained source asset.
      const derivedFrom = spec
        ? [spec.parentMasterAssetId, ...spec.retainedClips.map((c) => c.sourceAssetId)]
        : [];
      let asset = await findAssetByChecksum(deps.assetDb, workspaceId, output.checksum, 'VARIANT');
      if (!asset) {
        const created = await createAssetWithProvenance(deps.assetDb, workspaceId, {
          campaignId,
          kind: 'VARIANT',
          s3Key: output.s3Key,
          checksum: output.checksum,
          mimeType: 'video/mp4',
          originalFilename: `variant-${spec?.targetDurationSeconds ?? 0}s-${job.variantSpecificationId}.mp4`,
          sizeBytes: 0,
          ingestionStatus: 'READY',
          generatedByActivity: 'pollVariantRenderActivity',
          providerJobRef: handle.jobId,
          derivedFromAssetIds: derivedFrom,
          producedByInvocationId: spec?.createdByAgentInvocationId,
        });
        asset = created.asset;
      }

      const { variant } = await getOrCreateCreativeVariant(deps.variantDb, workspaceId, {
        campaignId,
        deliverySpecificationId: spec?.deliverySpecificationId ?? '',
        variantSpecificationId: job.variantSpecificationId,
        durationSeconds: spec?.targetDurationSeconds ?? 0,
      });
      // Deliberately RENDERING, not READY — only the Final QA re-run promotes it.
      await updateCreativeVariant(deps.variantDb, variant.id, {
        status: 'RENDERING',
        assetId: asset.id,
      });

      await chargeAcrossLevels(
        deps,
        { workspaceId, campaignId, providerId },
        attempt.idempotencyKey,
        { actualCents: usage.costCents, estimatedCents },
      );
      await updateVariantGenerationAttempt(deps.variantDb, attemptId, {
        status: 'SUCCEEDED',
        actualCostCents: usage.costCents,
        outputAssetId: asset.id,
        completedAt: new Date(),
      });
      await updateVariantGenerationJob(deps.variantDb, job.id, { status: 'SUCCEEDED' });

      return {
        terminal: true,
        status: 'SUCCEEDED',
        variantAssetId: asset.id,
        creativeVariantId: variant.id,
      };
    }

    // --- Terminal failure / cancellation: release the whole reservation ----
    await releaseAcrossLevels(
      deps,
      { workspaceId, campaignId, providerId },
      attempt.idempotencyKey,
      estimatedCents,
    );

    if (status === 'CANCELLED') {
      await updateVariantGenerationAttempt(deps.variantDb, attemptId, {
        status: 'CANCELLED',
        completedAt: new Date(),
      });
      await updateVariantGenerationJob(deps.variantDb, job.id, { status: 'CANCELLED' });
      return { terminal: true, status: 'CANCELLED' };
    }

    const failure = await deps.motionGraphicsProvider.getFailure(handle);
    const failureReason: VariantGenerationFailureReason = failure?.reason ?? 'PROVIDER_ERROR';
    const failureMessage = failure?.message ?? 'variant render failed';
    await updateVariantGenerationAttempt(deps.variantDb, attemptId, {
      status: status === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED',
      failureReason,
      failureRetryable: failureReason !== 'UNSUPPORTED_CAPABILITY',
      failureMessage,
      completedAt: new Date(),
    });
    await updateVariantGenerationJob(deps.variantDb, job.id, { status: 'FAILED' });

    // Surface the failure on the variant row so `variantQAFailed` can see it.
    if (spec) {
      const { variant } = await getOrCreateCreativeVariant(deps.variantDb, workspaceId, {
        campaignId,
        deliverySpecificationId: spec.deliverySpecificationId,
        variantSpecificationId: spec.id,
        durationSeconds: spec.targetDurationSeconds,
      });
      await updateCreativeVariant(deps.variantDb, variant.id, { status: 'FAILED' });
    }

    return {
      terminal: true,
      status: status === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED',
      failureReason,
      failureMessage,
    };
  };
}

/** Re-resolves the CreativeVariant for an already-terminal SUCCEEDED attempt (replay path). */
async function getOrCreateExistingVariant(
  deps: PollVariantRenderActivityDeps,
  workspaceId: string,
  job: { id: string; campaignId: string; variantSpecificationId: string },
  attempt: { outputAssetId?: string },
): Promise<string> {
  const spec = await getVariantSpecification(
    deps.variantDb,
    workspaceId,
    job.variantSpecificationId,
  );
  const { variant } = await getOrCreateCreativeVariant(deps.variantDb, workspaceId, {
    campaignId: job.campaignId,
    deliverySpecificationId: spec?.deliverySpecificationId ?? '',
    variantSpecificationId: job.variantSpecificationId,
    durationSeconds: spec?.targetDurationSeconds ?? 0,
  });
  if (attempt.outputAssetId && !variant.assetId) {
    await updateCreativeVariant(deps.variantDb, variant.id, {
      status: 'RENDERING',
      assetId: attempt.outputAssetId,
    });
  }
  return variant.id;
}

async function chargeAcrossLevels(
  deps: PollVariantRenderActivityDeps,
  ctx: { workspaceId: string; campaignId: string; providerId: string },
  reservationKey: string,
  amounts: { actualCents: number; estimatedCents: number },
): Promise<void> {
  for (const level of CHARGEABLE_LEVELS) {
    const scopeId =
      level === 'WORKSPACE'
        ? ctx.workspaceId
        : level === 'CAMPAIGN'
          ? ctx.campaignId
          : ctx.providerId;
    // eslint-disable-next-line no-await-in-loop -- bounded by CHARGEABLE_LEVELS.length
    const policy = await deps.budgetDb.budgetPolicy.findFirst({
      where: { workspaceId: ctx.workspaceId, level, scopeId },
    });
    if (!policy) continue;
    // Charge the real cost AND release the whole reservation — see
    // settleBudgetReservation's doc comment (post-M14 audit finding C-2).
    // eslint-disable-next-line no-await-in-loop -- sequential ledger writes
    await settleBudgetReservation(deps.budgetDb, policy.id, ctx.workspaceId, {
      reservedCents: amounts.estimatedCents,
      actualCents: amounts.actualCents,
      reservationIdempotencyKey: reservationKey,
      campaignId: ctx.campaignId,
    });
  }
}

async function releaseAcrossLevels(
  deps: PollVariantRenderActivityDeps,
  ctx: { workspaceId: string; campaignId: string; providerId: string },
  reservationKey: string,
  amountCents: number,
): Promise<void> {
  for (const level of CHARGEABLE_LEVELS) {
    const scopeId =
      level === 'WORKSPACE'
        ? ctx.workspaceId
        : level === 'CAMPAIGN'
          ? ctx.campaignId
          : ctx.providerId;
    // eslint-disable-next-line no-await-in-loop -- bounded by CHARGEABLE_LEVELS.length
    const policy = await deps.budgetDb.budgetPolicy.findFirst({
      where: { workspaceId: ctx.workspaceId, level, scopeId },
    });
    if (!policy) continue;
    // eslint-disable-next-line no-await-in-loop -- sequential ledger writes
    await releaseBudget(deps.budgetDb, policy.id, ctx.workspaceId, {
      amountCents,
      idempotencyKey: `${reservationKey}:release`,
      campaignId: ctx.campaignId,
    });
  }
}
