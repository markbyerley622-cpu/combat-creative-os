import type { ShotGenerationDataSource, ShotSpecificationDataSource } from '@combat/database';
import {
  MAX_SHOT_GENERATION_ATTEMPTS,
  checkAndReserveBudget,
  getOrCreateShotGenerationAttempt,
  getOrCreateShotGenerationJob,
  getShotSpecification,
  releaseBudget,
  type BudgetDataSource,
} from '@combat/database';
import type { BudgetLevel } from '@combat/domain';
import { VideoGenerationError, type VideoGenerationProvider } from '@combat/providers';

/**
 * Estimated cost, in cents, per second of requested footage per candidate —
 * used only to size the pre-dispatch budget RESERVATION (CLAUDE.md: "A
 * budget reservation is written before dispatch"). The real
 * `dispatchShotGenerationActivity` deps let production wiring configure this
 * per-provider; `pollShotGenerationActivity` true-ups the reservation against
 * the provider's own `getUsage()` once the job completes, so this estimate
 * never needs to be exact.
 */
export interface DispatchShotGenerationInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  readonly shotSpecificationId: string;
  /** 1-based. */
  readonly attemptNumber: number;
}

const BUDGET_GATED_LEVELS: readonly BudgetLevel[] = ['WORKSPACE', 'CAMPAIGN', 'SHOT', 'PROVIDER'];

export type DispatchShotGenerationOutput =
  | {
      readonly ok: true;
      readonly attemptId: string;
      readonly providerJobId: string;
      /** Echoed back so the workflow (which never touches the DB itself) can pass the real values into the follow-up poll/cancel Activity calls for this attempt, instead of the `shotSpecificationId` it was given. */
      readonly shotId: string;
      readonly providerId: string;
    }
  | { readonly ok: false; readonly reason: 'SPEC_NOT_FOUND'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'UNSUPPORTED_CAPABILITY';
      readonly detail: string;
      readonly attemptId: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'BUDGET_EXCEEDED';
      readonly level: BudgetLevel;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'PROVIDER_ERROR';
      readonly detail: string;
      readonly attemptId: string;
    };

export interface DispatchShotGenerationActivityDeps {
  readonly videoGenerationProvider: VideoGenerationProvider;
  readonly shotSpecificationDb: ShotSpecificationDataSource;
  readonly shotGenerationDb: ShotGenerationDataSource;
  readonly budgetDb: BudgetDataSource;
  readonly estimatedCostCentsPerSecond: number;
}

function buildIdempotencyKey(
  workflowRunId: string,
  shotSpecificationId: string,
  attemptNumber: number,
): string {
  return `${workflowRunId}:GEN:${shotSpecificationId}:${attemptNumber}`;
}

/**
 * Dispatches one bounded-retry attempt at generating video for one
 * `ShotSpecification` (M6 requirement 5). Applies the provider's capability
 * check and reserves budget at all four levels (WORKSPACE/CAMPAIGN/SHOT/
 * PROVIDER — docs/architecture.md §4.3) before ever calling `submit()`; the
 * attempt's own `idempotencyKey` (embedding `attemptNumber`) is what
 * satisfies the fifth, generation-attempt granularity CLAUDE.md's budget
 * rules ask for — not a fifth `BudgetLevel` enum value (the four-level enum
 * is an explicitly resolved decision, docs/domain-model.md §8).
 *
 * Mode selection: a shot with one or more `referenceAssetIds` is dispatched
 * as IMAGE_TO_VIDEO (seeded by those references); otherwise TEXT_TO_VIDEO.
 * `ShotSpecification` has no explicit mode field at this milestone — this is
 * a documented MVP heuristic, not a real per-shot creative decision.
 */
export function createDispatchShotGenerationActivity(
  deps: DispatchShotGenerationActivityDeps,
): (input: DispatchShotGenerationInput) => Promise<DispatchShotGenerationOutput> {
  return async function dispatchShotGenerationActivity(
    input: DispatchShotGenerationInput,
  ): Promise<DispatchShotGenerationOutput> {
    const { workspaceId, campaignId, workflowRunId, shotSpecificationId, attemptNumber } = input;

    const spec = await getShotSpecification(
      deps.shotSpecificationDb,
      workspaceId,
      shotSpecificationId,
    );
    if (!spec) {
      return {
        ok: false,
        reason: 'SPEC_NOT_FOUND',
        detail: `ShotSpecification ${shotSpecificationId} not found`,
      };
    }

    const job = await getOrCreateShotGenerationJob(deps.shotGenerationDb, workspaceId, {
      campaignId,
      shotSpecificationId,
      requestedCandidateCount: spec.outputRequirements.minCandidateCount,
      maxAttempts: MAX_SHOT_GENERATION_ATTEMPTS,
    });

    const idempotencyKey = buildIdempotencyKey(workflowRunId, shotSpecificationId, attemptNumber);
    const mode = spec.referenceAssetIds.length > 0 ? 'IMAGE_TO_VIDEO' : 'TEXT_TO_VIDEO';
    const estimatedCents = Math.ceil(
      spec.generationParams.durationSeconds *
        job.requestedCandidateCount *
        deps.estimatedCostCentsPerSecond,
    );

    const reservedLevels: BudgetLevel[] = [];
    for (const level of BUDGET_GATED_LEVELS) {
      const scopeId =
        level === 'WORKSPACE'
          ? workspaceId
          : level === 'CAMPAIGN'
            ? campaignId
            : level === 'SHOT'
              ? spec.shotId
              : spec.providerId;
      // eslint-disable-next-line no-await-in-loop -- budget checks are inherently sequential (each reservation depends on the running total the prior one just wrote)
      const budgetResult = await checkAndReserveBudget(deps.budgetDb, {
        workspaceId,
        level,
        scopeId,
        requiredCents: estimatedCents,
        idempotencyKey,
        campaignId,
        shotId: spec.shotId,
        generationJobRef: idempotencyKey,
      });
      if (!budgetResult.ok) {
        // eslint-disable-next-line no-await-in-loop -- releasing already-made reservations before returning, bounded by reservedLevels.length (<= 4)
        await releaseAlreadyReserved(deps, reservedLevels, {
          workspaceId,
          campaignId,
          shotId: spec.shotId,
          providerId: spec.providerId,
          estimatedCents,
          idempotencyKey,
        });
        return { ok: false, reason: 'BUDGET_EXCEEDED', level, detail: budgetResult.error.message };
      }
      if (budgetResult.policy) {
        reservedLevels.push(level);
      }
    }

    try {
      // Capability validation happens inside `submit()` itself (every
      // `VideoGenerationProvider` implementation is required to reject an
      // unsupported combination there, per the interface's doc comment) —
      // the `catch` block below maps a thrown `VideoGenerationError` to the
      // typed `UNSUPPORTED_CAPABILITY` outcome rather than duplicating the
      // check here.
      const handle = await deps.videoGenerationProvider.submit({
        idempotencyKey,
        shotId: spec.shotId,
        mode,
        promptText: spec.generationPrompt,
        negativePrompt: spec.negativePrompt,
        referenceImages:
          spec.referenceAssetIds.length > 0
            ? spec.referenceAssetIds.map((assetId) => ({ assetId }))
            : undefined,
        candidateCount: job.requestedCandidateCount,
        params: {
          durationSeconds: spec.generationParams.durationSeconds,
          aspectRatio: spec.generationParams.aspectRatio,
          resolution: spec.generationParams.resolution,
          frameRate: spec.generationParams.frameRate,
          seed: spec.generationParams.seed,
          providerOptions: spec.generationParams.providerOptions,
        },
      });

      const { attempt, alreadyExisted } = await getOrCreateShotGenerationAttempt(
        deps.shotGenerationDb,
        workspaceId,
        {
          shotGenerationJobId: job.id,
          attemptNumber,
          idempotencyKey,
          providerId: spec.providerId,
          providerJobId: handle.jobId,
          status: 'SUBMITTED',
          requestedCandidateCount: job.requestedCandidateCount,
          seed: spec.generationParams.seed,
          generationParams: spec.generationParams,
          estimatedCostCents: estimatedCents,
          startedAt: new Date(),
        },
      );

      // A replayed/retried call (same idempotencyKey) must not increment
      // attemptCount a second time — only a genuinely new attempt counts.
      if (!alreadyExisted) {
        await deps.shotGenerationDb.shotGenerationJob.update({
          where: { id: job.id },
          data: { status: 'DISPATCHED', attemptCount: job.attemptCount + 1 },
        });
      }

      return {
        ok: true,
        attemptId: attempt.id,
        providerJobId: handle.jobId,
        shotId: spec.shotId,
        providerId: spec.providerId,
      };
    } catch (error) {
      await releaseAlreadyReserved(deps, reservedLevels, {
        workspaceId,
        campaignId,
        shotId: spec.shotId,
        providerId: spec.providerId,
        estimatedCents,
        idempotencyKey,
      });

      const { attempt } = await getOrCreateShotGenerationAttempt(
        deps.shotGenerationDb,
        workspaceId,
        {
          shotGenerationJobId: job.id,
          attemptNumber,
          idempotencyKey,
          providerId: spec.providerId,
          status: 'FAILED',
          requestedCandidateCount: job.requestedCandidateCount,
          seed: spec.generationParams.seed,
          generationParams: spec.generationParams,
          estimatedCostCents: estimatedCents,
          failureReason:
            error instanceof VideoGenerationError ? error.failure.reason : 'PROVIDER_ERROR',
          failureRetryable: error instanceof VideoGenerationError ? error.failure.retryable : true,
          failureMessage: error instanceof Error ? error.message : String(error),
          startedAt: new Date(),
          completedAt: new Date(),
        },
      );

      if (
        error instanceof VideoGenerationError &&
        error.failure.reason === 'UNSUPPORTED_CAPABILITY'
      ) {
        return {
          ok: false,
          reason: 'UNSUPPORTED_CAPABILITY',
          detail: error.failure.message,
          attemptId: attempt.id,
        };
      }
      return {
        ok: false,
        reason: 'PROVIDER_ERROR',
        detail: error instanceof Error ? error.message : String(error),
        attemptId: attempt.id,
      };
    }
  };
}

async function releaseAlreadyReserved(
  deps: DispatchShotGenerationActivityDeps,
  reservedLevels: readonly BudgetLevel[],
  ctx: {
    workspaceId: string;
    campaignId: string;
    shotId: string;
    providerId: string;
    estimatedCents: number;
    idempotencyKey: string;
  },
): Promise<void> {
  for (const level of reservedLevels) {
    const scopeId =
      level === 'WORKSPACE'
        ? ctx.workspaceId
        : level === 'CAMPAIGN'
          ? ctx.campaignId
          : level === 'SHOT'
            ? ctx.shotId
            : ctx.providerId;
    const policy = await deps.budgetDb.budgetPolicy.findFirst({
      where: { workspaceId: ctx.workspaceId, level, scopeId },
    });
    if (!policy) continue;
    // eslint-disable-next-line no-await-in-loop -- bounded by reservedLevels.length (<= 4), and release ordering doesn't matter but must complete before returning
    await releaseBudget(deps.budgetDb, policy.id, ctx.workspaceId, {
      amountCents: ctx.estimatedCents,
      idempotencyKey: `${ctx.idempotencyKey}:release`,
      campaignId: ctx.campaignId,
      shotId: ctx.shotId,
    });
  }
}
