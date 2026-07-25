import type {
  AssetDataSource,
  BudgetDataSource,
  CompositionDataSource,
  EditDecisionListDataSource,
  RenderJobDataSource,
  RoughEditSpecificationDataSource,
} from '@combat/database';
import {
  createAssetWithProvenance,
  createEditDecisionList,
  createRenderJob,
  findAssetByChecksum,
  getCompositionAttemptById,
  getCompositionJobById,
  getRoughEditSpecification,
  listRenderJobsForCampaign,
  releaseBudget,
  settleBudgetReservation,
  updateCompositionAttempt,
  updateCompositionJob,
} from '@combat/database';
import type { BudgetLevel, CompositionFailureReason } from '@combat/domain';
import type { MotionGraphicsProvider } from '@combat/providers';

const CHARGEABLE_LEVELS: readonly BudgetLevel[] = ['WORKSPACE', 'CAMPAIGN', 'PROVIDER'];
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);

export interface PollCompositionRenderInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly attemptId: string;
  readonly providerId: string;
}

export type PollCompositionRenderOutput =
  | { readonly terminal: false; readonly status: 'QUEUED' | 'SUBMITTED' | 'POLLING' }
  | { readonly terminal: true; readonly status: 'SUCCEEDED'; readonly roughEditAssetId: string }
  | { readonly terminal: true; readonly status: 'CANCELLED' }
  | {
      readonly terminal: true;
      readonly status: 'FAILED' | 'TIMED_OUT';
      readonly failureReason: CompositionFailureReason;
      readonly failureMessage: string;
    }
  | { readonly ok: false; readonly reason: 'ATTEMPT_NOT_FOUND'; readonly detail: string };

export interface PollCompositionRenderActivityDeps {
  readonly motionGraphicsProvider: MotionGraphicsProvider;
  readonly compositionDb: CompositionDataSource;
  readonly roughEditSpecificationDb: RoughEditSpecificationDataSource;
  readonly assetDb: AssetDataSource;
  readonly renderJobDb: RenderJobDataSource;
  readonly editDecisionListDb: EditDecisionListDataSource;
  readonly budgetDb: BudgetDataSource;
}

/**
 * M9: polls one composition render attempt to a terminal state. A non-terminal
 * status is persisted and returned for the workflow to re-poll after a
 * deterministic `sleep`. A terminal outcome is fully resolved here and is
 * idempotent under Activity retry: SUCCEEDED registers the rough-edit asset
 * (`AssetKind.ROUGH_CUT`, deduped by checksum), a SUCCEEDED COMPOSITING
 * `RenderJob` (deduped by providerJobRef — this is what `compositingComplete`
 * reads), and the derived `EditDecisionList` (idempotent per spec version —
 * what `roughCutAssembled` reads), then settles the budget — charging the
 * provider's actual usage and releasing the reservation in full, so
 * `spentCents` reflects the real cost and nothing else; FAILED/TIMED_OUT/
 * CANCELLED release the reservation without a charge. Re-polling an already-terminal attempt replays its outcome
 * without calling the provider or touching the ledger again.
 */
export function createPollCompositionRenderActivity(
  deps: PollCompositionRenderActivityDeps,
): (input: PollCompositionRenderInput) => Promise<PollCompositionRenderOutput> {
  return async function pollCompositionRenderActivity(
    input: PollCompositionRenderInput,
  ): Promise<PollCompositionRenderOutput> {
    const { workspaceId, campaignId, attemptId, providerId } = input;

    const attempt = await getCompositionAttemptById(deps.compositionDb, workspaceId, attemptId);
    if (!attempt || !attempt.providerJobId) {
      return {
        ok: false,
        reason: 'ATTEMPT_NOT_FOUND',
        detail: `attempt ${attemptId} not dispatched`,
      };
    }
    if (TERMINAL.has(attempt.status)) {
      if (attempt.status === 'SUCCEEDED' && attempt.outputAssetId) {
        return { terminal: true, status: 'SUCCEEDED', roughEditAssetId: attempt.outputAssetId };
      }
      if (attempt.status === 'CANCELLED') return { terminal: true, status: 'CANCELLED' };
      return {
        terminal: true,
        status: attempt.status === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED',
        failureReason: attempt.failureReason ?? 'PROVIDER_ERROR',
        failureMessage: attempt.failureMessage ?? 'render failed',
      };
    }

    const handle = { jobId: attempt.providerJobId };
    const status = await deps.motionGraphicsProvider.getStatus(handle);

    if (!TERMINAL.has(status)) {
      await updateCompositionAttempt(deps.compositionDb, attemptId, {
        status: status as 'QUEUED' | 'SUBMITTED' | 'POLLING',
      });
      return { terminal: false, status: status as 'QUEUED' | 'SUBMITTED' | 'POLLING' };
    }

    const job = await getCompositionJobById(
      deps.compositionDb,
      workspaceId,
      attempt.compositionJobId,
    );
    const estimatedCents = attempt.estimatedCostCents ?? 0;

    if (status === 'SUCCEEDED') {
      const output = await deps.motionGraphicsProvider.fetchRenderOutput(handle);
      const usage = await deps.motionGraphicsProvider.getUsage(handle);
      const spec = job
        ? await getRoughEditSpecification(
            deps.roughEditSpecificationDb,
            workspaceId,
            job.roughEditSpecificationId,
          )
        : null;

      // Register the rough-edit asset (deduped by deterministic checksum so an
      // Activity retry mid-registration never creates a second asset).
      const sourceAssetIds =
        spec?.tracks
          .filter((t) => t.trackType === 'VIDEO')
          .flatMap((t) => t.clips.map((c) => c.sourceAssetId)) ?? [];
      let asset = await findAssetByChecksum(
        deps.assetDb,
        workspaceId,
        output.checksum,
        'ROUGH_CUT',
      );
      if (!asset) {
        const created = await createAssetWithProvenance(deps.assetDb, workspaceId, {
          campaignId,
          kind: 'ROUGH_CUT',
          s3Key: output.s3Key,
          checksum: output.checksum,
          mimeType: 'video/mp4',
          originalFilename: `rough-edit-${attempt.compositionJobId}.mp4`,
          sizeBytes: 0,
          ingestionStatus: 'READY',
          generatedByActivity: 'pollCompositionRenderActivity',
          providerJobRef: handle.jobId,
          derivedFromAssetIds: sourceAssetIds,
          producedByInvocationId: spec?.createdByAgentInvocationId,
        });
        asset = created.asset;
      }

      // COMPOSITING RenderJob (deduped by providerJobRef) -> compositingComplete.
      const existingJobs = await listRenderJobsForCampaign(
        deps.renderJobDb,
        workspaceId,
        campaignId,
      );
      if (!existingJobs.some((r) => r.providerJobRef === handle.jobId)) {
        await createRenderJob(deps.renderJobDb, workspaceId, {
          campaignId,
          kind: 'COMPOSITING',
          status: 'SUCCEEDED',
          inputAssetIds: sourceAssetIds,
          outputAssetId: asset.id,
          providerJobRef: handle.jobId,
          completedAt: new Date(),
        });
      }

      // Derived EditDecisionList (idempotent per spec version) -> roughCutAssembled.
      if (spec) {
        await createEditDecisionList(deps.editDecisionListDb, workspaceId, {
          campaignId,
          version: spec.version,
          entries: spec.tracks
            .filter((t) => t.trackType === 'VIDEO')
            .flatMap((t) => t.clips)
            .sort((a, b) => a.order - b.order)
            .map((c) => ({
              assetId: c.sourceAssetId,
              sourceInFrame: c.sourceInFrame,
              sourceOutFrame: c.sourceOutFrame,
              timelinePosition: c.timelineStartFrame,
              trackType: 'VIDEO' as const,
              order: c.order,
            })),
        });
      }

      await chargeAcrossLevels(
        deps,
        { workspaceId, campaignId, providerId },
        attempt.idempotencyKey,
        {
          actualCents: usage.costCents,
          estimatedCents,
        },
      );
      await updateCompositionAttempt(deps.compositionDb, attemptId, {
        status: 'SUCCEEDED',
        outputAssetId: asset.id,
        actualCostCents: usage.costCents,
        completedAt: new Date(),
      });
      if (job) await updateCompositionJob(deps.compositionDb, job.id, { status: 'SUCCEEDED' });
      return { terminal: true, status: 'SUCCEEDED', roughEditAssetId: asset.id };
    }

    // FAILED / TIMED_OUT / CANCELLED — release the reservation.
    await releaseAcrossLevels(
      deps,
      { workspaceId, campaignId, providerId },
      attempt.idempotencyKey,
      estimatedCents,
    );

    if (status === 'CANCELLED') {
      await updateCompositionAttempt(deps.compositionDb, attemptId, {
        status: 'CANCELLED',
        completedAt: new Date(),
      });
      if (job) await updateCompositionJob(deps.compositionDb, job.id, { status: 'CANCELLED' });
      return { terminal: true, status: 'CANCELLED' };
    }

    const failure = await deps.motionGraphicsProvider.getFailure(handle);
    const failureReason: CompositionFailureReason =
      status === 'TIMED_OUT' ? 'PROVIDER_TIMEOUT' : (failure?.reason ?? 'PROVIDER_ERROR');
    await updateCompositionAttempt(deps.compositionDb, attemptId, {
      status: status as 'FAILED' | 'TIMED_OUT',
      failureReason,
      failureRetryable: true,
      failureMessage: failure?.message ?? 'render failed',
      completedAt: new Date(),
    });
    return {
      terminal: true,
      status: status as 'FAILED' | 'TIMED_OUT',
      failureReason,
      failureMessage: failure?.message ?? 'render failed',
    };
  };
}

async function chargeAcrossLevels(
  deps: PollCompositionRenderActivityDeps,
  ctx: { workspaceId: string; campaignId: string; providerId: string },
  idempotencyKey: string,
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
      reservationIdempotencyKey: idempotencyKey,
      campaignId: ctx.campaignId,
    });
  }
}

async function releaseAcrossLevels(
  deps: PollCompositionRenderActivityDeps,
  ctx: { workspaceId: string; campaignId: string; providerId: string },
  idempotencyKey: string,
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
      idempotencyKey: `${idempotencyKey}:release`,
      campaignId: ctx.campaignId,
    });
  }
}
