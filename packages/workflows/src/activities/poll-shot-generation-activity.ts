import type { GenerationCandidateRecord, ShotGenerationDataSource } from '@combat/database';
import {
  chargeBudget,
  createAssetWithProvenance,
  createGenerationCandidate,
  getShotGenerationAttemptById,
  getShotGenerationJobById,
  releaseBudget,
  updateGenerationCandidate,
  updateShotGenerationAttempt,
  updateShotGenerationJob,
  type AssetDataSource,
  type BudgetDataSource,
} from '@combat/database';
import type { BudgetLevel } from '@combat/domain';
import type { VideoGenerationProvider } from '@combat/providers';

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);
const CHARGEABLE_LEVELS: readonly BudgetLevel[] = ['WORKSPACE', 'CAMPAIGN', 'SHOT', 'PROVIDER'];

export interface PollShotGenerationInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly shotId: string;
  readonly providerId: string;
  readonly attemptId: string;
}

export type PollShotGenerationOutput =
  | { readonly ok: false; readonly reason: 'ATTEMPT_NOT_FOUND'; readonly detail: string }
  | { readonly terminal: false; readonly status: 'QUEUED' | 'SUBMITTED' | 'POLLING' }
  | {
      readonly terminal: true;
      readonly status: 'SUCCEEDED';
      readonly candidateIds: string[];
      readonly assetIds: string[];
    }
  | {
      readonly terminal: true;
      readonly status: 'FAILED' | 'TIMED_OUT';
      readonly failureReason: string;
      readonly failureRetryable: boolean;
      readonly failureMessage: string;
    }
  | { readonly terminal: true; readonly status: 'CANCELLED' };

export interface PollShotGenerationActivityDeps {
  readonly videoGenerationProvider: VideoGenerationProvider;
  readonly shotGenerationDb: ShotGenerationDataSource;
  readonly assetDb: AssetDataSource;
  readonly budgetDb: BudgetDataSource;
}

async function releaseOrChargeAcrossLevels(
  deps: PollShotGenerationActivityDeps,
  ctx: { workspaceId: string; campaignId: string; shotId: string; providerId: string },
  idempotencyKey: string,
  outcome:
    | { kind: 'RELEASE'; amountCents: number }
    | { kind: 'CHARGE_THEN_RELEASE'; actualCents: number; estimatedCents: number },
): Promise<void> {
  for (const level of CHARGEABLE_LEVELS) {
    const scopeId =
      level === 'WORKSPACE'
        ? ctx.workspaceId
        : level === 'CAMPAIGN'
          ? ctx.campaignId
          : level === 'SHOT'
            ? ctx.shotId
            : ctx.providerId;
    // eslint-disable-next-line no-await-in-loop -- bounded by CHARGEABLE_LEVELS.length (4)
    const policy = await deps.budgetDb.budgetPolicy.findFirst({
      where: { workspaceId: ctx.workspaceId, level, scopeId },
    });
    if (!policy) continue;

    if (outcome.kind === 'RELEASE') {
      // eslint-disable-next-line no-await-in-loop -- same rationale as dispatch-shot-generation-activity.ts
      await releaseBudget(deps.budgetDb, policy.id, ctx.workspaceId, {
        amountCents: outcome.amountCents,
        idempotencyKey: `${idempotencyKey}:release`,
        campaignId: ctx.campaignId,
        shotId: ctx.shotId,
      });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- same rationale as above
    await chargeBudget(deps.budgetDb, policy.id, ctx.workspaceId, {
      amountCents: outcome.actualCents,
      idempotencyKey: `${idempotencyKey}:charge`,
      campaignId: ctx.campaignId,
      shotId: ctx.shotId,
    });
    const remainder = outcome.estimatedCents - outcome.actualCents;
    if (remainder > 0) {
      // eslint-disable-next-line no-await-in-loop -- same rationale as above
      await releaseBudget(deps.budgetDb, policy.id, ctx.workspaceId, {
        amountCents: remainder,
        idempotencyKey: `${idempotencyKey}:release`,
        campaignId: ctx.campaignId,
        shotId: ctx.shotId,
      });
    }
  }
}

/**
 * Polls one in-flight generation attempt (M6 requirement 5). Non-terminal
 * statuses are persisted and returned as-is for the workflow to re-poll
 * (after a deterministic `sleep`, not a real wall-clock wait — see
 * `shot-generation-workflow.ts`). A terminal outcome is fully resolved here:
 * SUCCEEDED registers every candidate through the asset lifecycle
 * (`createAssetWithProvenance`, `AssetKind.VIDEO_CANDIDATE`) and true-ups the
 * budget reservation against the provider's actual `getUsage()`; FAILED/
 * TIMED_OUT/CANCELLED release the full reservation. Re-polling an
 * already-terminal attempt is safe and idempotent — it returns the persisted
 * outcome without calling the provider or touching the budget ledger again.
 */
export function createPollShotGenerationActivity(
  deps: PollShotGenerationActivityDeps,
): (input: PollShotGenerationInput) => Promise<PollShotGenerationOutput> {
  return async function pollShotGenerationActivity(
    input: PollShotGenerationInput,
  ): Promise<PollShotGenerationOutput> {
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
    if (!attempt.providerJobId) {
      return {
        ok: false,
        reason: 'ATTEMPT_NOT_FOUND',
        detail: `Attempt ${attemptId} has no providerJobId yet`,
      };
    }

    if (TERMINAL_STATUSES.has(attempt.status)) {
      return replayTerminalOutcome(deps, attempt);
    }

    const handle = { jobId: attempt.providerJobId, shotId };
    const status = await deps.videoGenerationProvider.getStatus(handle);

    if (!TERMINAL_STATUSES.has(status)) {
      await updateShotGenerationAttempt(deps.shotGenerationDb, attemptId, {
        status: status as 'QUEUED' | 'SUBMITTED' | 'POLLING',
      });
      return { terminal: false, status: status as 'QUEUED' | 'SUBMITTED' | 'POLLING' };
    }

    if (status === 'SUCCEEDED') {
      const job = await getShotGenerationJobById(
        deps.shotGenerationDb,
        workspaceId,
        attempt.shotGenerationJobId,
      );
      if (!job) {
        return {
          ok: false,
          reason: 'ATTEMPT_NOT_FOUND',
          detail: `ShotGenerationJob ${attempt.shotGenerationJobId} not found`,
        };
      }
      const candidateRefs = await deps.videoGenerationProvider.fetchResult(handle);
      const usage = await deps.videoGenerationProvider.getUsage(handle);

      const candidateIds: string[] = [];
      const assetIds: string[] = [];
      for (const ref of candidateRefs) {
        // eslint-disable-next-line no-await-in-loop -- candidates must be persisted in order for deterministic candidateIndex-based idempotency
        const candidate: GenerationCandidateRecord = await createGenerationCandidate(
          deps.shotGenerationDb,
          workspaceId,
          {
            shotSpecificationId: job.shotSpecificationId,
            shotGenerationAttemptId: attemptId,
            candidateIndex: ref.candidateIndex,
            providerCandidateRef: ref.assetId,
            seed: ref.seed,
            durationSeconds: ref.durationSeconds,
            aspectRatio: ref.aspectRatio as GenerationCandidateRecord['aspectRatio'],
            status: 'SUCCEEDED',
          },
        );

        // eslint-disable-next-line no-await-in-loop -- sequential to keep candidate <-> asset registration order deterministic
        const { asset } = await createAssetWithProvenance(deps.assetDb, workspaceId, {
          campaignId,
          kind: 'VIDEO_CANDIDATE',
          s3Key: ref.s3Key,
          checksum: ref.assetId,
          mimeType: 'video/mp4',
          originalFilename: `${shotId}-${ref.candidateIndex}.mp4`,
          sizeBytes: 0,
          ingestionStatus: 'READY',
          generatedByActivity: 'pollShotGenerationActivity',
          providerJobRef: handle.jobId,
        });

        // eslint-disable-next-line no-await-in-loop -- same rationale as above
        await updateGenerationCandidate(deps.shotGenerationDb, candidate.id, { assetId: asset.id });
        candidateIds.push(candidate.id);
        assetIds.push(asset.id);
      }

      await releaseOrChargeAcrossLevels(
        deps,
        { workspaceId, campaignId, shotId, providerId },
        attempt.idempotencyKey,
        {
          kind: 'CHARGE_THEN_RELEASE',
          actualCents: usage.costCents,
          estimatedCents: attempt.estimatedCostCents ?? usage.costCents,
        },
      );

      await updateShotGenerationAttempt(deps.shotGenerationDb, attemptId, {
        status: 'SUCCEEDED',
        actualCostCents: usage.costCents,
        completedAt: new Date(),
      });
      await updateShotGenerationJob(deps.shotGenerationDb, attempt.shotGenerationJobId, {
        status: 'SUCCEEDED',
      });

      return { terminal: true, status: 'SUCCEEDED', candidateIds, assetIds };
    }

    if (status === 'CANCELLED') {
      await releaseOrChargeAcrossLevels(
        deps,
        { workspaceId, campaignId, shotId, providerId },
        attempt.idempotencyKey,
        { kind: 'RELEASE', amountCents: attempt.estimatedCostCents ?? 0 },
      );
      await updateShotGenerationAttempt(deps.shotGenerationDb, attemptId, {
        status: 'CANCELLED',
        completedAt: new Date(),
      });
      await updateShotGenerationJob(deps.shotGenerationDb, attempt.shotGenerationJobId, {
        status: 'CANCELLED',
      });
      return { terminal: true, status: 'CANCELLED' };
    }

    // Only FAILED/TIMED_OUT remain: SUCCEEDED and CANCELLED were handled
    // above, and the non-terminal statuses already returned earlier.
    const failedStatus = status as 'FAILED' | 'TIMED_OUT';
    const failure = await deps.videoGenerationProvider.getFailure(handle);
    await releaseOrChargeAcrossLevels(
      deps,
      { workspaceId, campaignId, shotId, providerId },
      attempt.idempotencyKey,
      { kind: 'RELEASE', amountCents: attempt.estimatedCostCents ?? 0 },
    );
    await updateShotGenerationAttempt(deps.shotGenerationDb, attemptId, {
      status: failedStatus,
      failureReason: (failure?.reason ?? 'PROVIDER_ERROR') as never,
      failureRetryable: failure?.retryable ?? true,
      failureMessage: failure?.message ?? `Provider job ended in status ${failedStatus}`,
      completedAt: new Date(),
    });

    return {
      terminal: true,
      status: failedStatus,
      failureReason: failure?.reason ?? 'PROVIDER_ERROR',
      failureRetryable: failure?.retryable ?? true,
      failureMessage: failure?.message ?? `Provider job ended in status ${status}`,
    };
  };
}

async function replayTerminalOutcome(
  deps: PollShotGenerationActivityDeps,
  attempt: NonNullable<Awaited<ReturnType<typeof getShotGenerationAttemptById>>>,
): Promise<PollShotGenerationOutput> {
  if (attempt.status === 'SUCCEEDED') {
    const candidates = await deps.shotGenerationDb.generationCandidate.findMany({
      where: { shotGenerationAttemptId: attempt.id },
    });
    return {
      terminal: true,
      status: 'SUCCEEDED',
      candidateIds: candidates.map((c) => c.id),
      assetIds: candidates.map((c) => c.assetId).filter((id): id is string => id !== undefined),
    };
  }
  if (attempt.status === 'CANCELLED') {
    return { terminal: true, status: 'CANCELLED' };
  }
  // TERMINAL_STATUSES.has(attempt.status) was already checked by the caller and SUCCEEDED/CANCELLED are handled above, so only FAILED/TIMED_OUT remain.
  const status = attempt.status as 'FAILED' | 'TIMED_OUT';
  return {
    terminal: true,
    status,
    failureReason: attempt.failureReason ?? 'PROVIDER_ERROR',
    failureRetryable: attempt.failureRetryable ?? true,
    failureMessage: attempt.failureMessage ?? `Provider job ended in status ${attempt.status}`,
  };
}
