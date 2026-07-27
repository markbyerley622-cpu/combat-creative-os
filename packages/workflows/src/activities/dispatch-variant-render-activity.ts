import type { SerializableBudgetDataSource, VariantDataSource } from '@combat/database';
import {
  getOrCreateVariantGenerationAttempt,
  getOrCreateVariantGenerationJob,
  getVariantSpecification,
  releaseBudget,
  reserveBudgetAcrossScopes,
  updateVariantGenerationAttempt,
  updateVariantGenerationJob,
} from '@combat/database';
import type { BudgetLevel, VariantSpecification } from '@combat/domain';
import {
  MotionGraphicsProviderError,
  type MotionGraphicsProvider,
  type MotionGraphicsTimeline,
} from '@combat/providers';

/** M12: a variant render is a campaign-level render, gated at workspace/campaign/provider (never per-shot). */
const BUDGET_GATED_LEVELS: readonly BudgetLevel[] = ['WORKSPACE', 'CAMPAIGN', 'PROVIDER'];

export interface DispatchVariantRenderInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  readonly variantSpecificationId: string;
  readonly attemptNumber: number;
  readonly motionGraphicsProviderId: string;
  readonly maxAttempts: number;
}

export type DispatchVariantRenderOutput =
  | {
      readonly ok: true;
      readonly jobId: string;
      readonly attemptId: string;
      readonly providerJobId: string;
      readonly providerId: string;
    }
  | { readonly ok: false; readonly reason: 'SPEC_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'UNSUPPORTED_CAPABILITY'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'BUDGET_EXCEEDED';
      readonly level: BudgetLevel;
      readonly detail: string;
    }
  | { readonly ok: false; readonly reason: 'PROVIDER_ERROR'; readonly detail: string };

export interface DispatchVariantRenderActivityDeps {
  readonly motionGraphicsProvider: MotionGraphicsProvider;
  readonly variantDb: VariantDataSource;
  readonly budgetDb: SerializableBudgetDataSource;
  /** Estimated cost per output frame, in cents. */
  readonly estimatedCostCentsPerFrame: number;
}

function idempotencyKey(workflowRunId: string, specId: string, attemptNumber: number): string {
  return `${workflowRunId}:VARIANT:${specId}:${attemptNumber}`;
}

/**
 * Maps a `VariantSpecification` onto the provider-neutral timeline. The
 * renderer never sees a domain type — same boundary the M9 compositing
 * dispatch keeps. Each retained clip becomes one provider clip pinned to the
 * exact approved source asset; captions become CAPTION overlays.
 */
function toTimeline(spec: VariantSpecification): MotionGraphicsTimeline {
  return {
    aspectRatio: spec.aspectRatio,
    outputFormat: 'mp4',
    durationFrames: spec.targetDurationFrames,
    clips: spec.retainedClips.map((c) => ({
      order: c.order,
      sourceRef: c.sourceAssetId,
      inFrame: c.sourceStartFrame,
      outFrame: c.sourceEndFrame,
      transitionIn: c.transitionIn,
    })),
    overlays: spec.retainedCaptions.map((c) => ({ kind: 'CAPTION', ref: c.safeArea })),
  };
}

/**
 * M12: dispatches one bounded-retry render attempt for a `VariantSpecification`.
 * Reserves budget at WORKSPACE/CAMPAIGN/PROVIDER before creating the provider
 * project and submitting the render; the attempt's own `idempotencyKey`
 * (embedding `attemptNumber`) is what makes a replayed dispatch return the
 * existing attempt rather than double-submitting or double-reserving. A
 * capability rejection or budget failure releases every reservation already
 * made and returns a typed terminal failure.
 *
 * Renders go through the same `MotionGraphicsProvider` the rough edit uses — a
 * variant is the same kind of timeline render over a shorter timeline, so M12
 * adds no provider category. Against the deterministic mock this produces no
 * real video bytes.
 */
export function createDispatchVariantRenderActivity(
  deps: DispatchVariantRenderActivityDeps,
): (input: DispatchVariantRenderInput) => Promise<DispatchVariantRenderOutput> {
  return async function dispatchVariantRenderActivity(
    input: DispatchVariantRenderInput,
  ): Promise<DispatchVariantRenderOutput> {
    const { workspaceId, campaignId, workflowRunId, variantSpecificationId, attemptNumber } = input;

    const spec = await getVariantSpecification(deps.variantDb, workspaceId, variantSpecificationId);
    if (!spec) {
      return {
        ok: false,
        reason: 'SPEC_NOT_FOUND',
        detail: `VariantSpecification ${variantSpecificationId} not found in workspace ${workspaceId}`,
      };
    }

    const job = await getOrCreateVariantGenerationJob(deps.variantDb, workspaceId, {
      campaignId,
      variantSpecificationId,
      maxAttempts: input.maxAttempts,
    });

    const key = idempotencyKey(workflowRunId, variantSpecificationId, attemptNumber);
    const existing = await getOrCreateVariantGenerationAttempt(deps.variantDb, workspaceId, {
      variantGenerationJobId: job.id,
      attemptNumber,
      idempotencyKey: key,
      providerId: input.motionGraphicsProviderId,
      status: 'QUEUED',
      startedAt: new Date(),
    });
    if (existing.alreadyExisted && existing.attempt.providerJobId) {
      return {
        ok: true,
        jobId: job.id,
        attemptId: existing.attempt.id,
        providerJobId: existing.attempt.providerJobId,
        providerId: existing.attempt.providerId,
      };
    }
    const attemptId = existing.attempt.id;

    const estimatedCents = Math.max(
      1,
      Math.ceil(spec.targetDurationFrames * deps.estimatedCostCentsPerFrame),
    );
    // One SERIALIZABLE transaction across every gated level (AAMP-1 step 3):
    // a refusal writes nothing, so there is no partial reservation to unwind.
    const result = await reserveBudgetAcrossScopes(deps.budgetDb, {
      workspaceId,
      scopes: BUDGET_GATED_LEVELS.map((level) => ({
        level,
        scopeId: budgetScopeId(level, {
          workspaceId,
          campaignId,
          providerId: input.motionGraphicsProviderId,
        }),
      })),
      requiredCents: estimatedCents,
      idempotencyKey: key,
      campaignId,
    });
    if (!result.ok) {
      await updateVariantGenerationAttempt(deps.variantDb, attemptId, {
        status: 'FAILED',
        failureReason: 'BUDGET_EXCEEDED',
        failureRetryable: false,
        failureMessage: result.error.message,
        completedAt: new Date(),
      });
      await updateVariantGenerationJob(deps.variantDb, job.id, { status: 'BUDGET_EXCEEDED' });
      return {
        ok: false,
        reason: 'BUDGET_EXCEEDED',
        level: result.level,
        detail: result.error.message,
      };
    }
    const reservedLevels: BudgetLevel[] = result.reservations.map(
      (reservation) => reservation.level,
    );

    try {
      const project = await deps.motionGraphicsProvider.createProject({
        idempotencyKey: key,
        campaignId,
        name: `variant-${spec.targetDurationSeconds}s-${variantSpecificationId}`,
      });
      const handle = await deps.motionGraphicsProvider.submitRender({
        idempotencyKey: key,
        projectId: project.projectId,
        timeline: toTimeline(spec),
      });

      await updateVariantGenerationAttempt(deps.variantDb, attemptId, {
        status: 'SUBMITTED',
        providerProjectId: project.projectId,
        providerJobId: handle.jobId,
        budgetReservationId: key,
        estimatedCostCents: estimatedCents,
      });
      await updateVariantGenerationJob(deps.variantDb, job.id, {
        status: 'DISPATCHED',
        attemptCount: attemptNumber,
      });
      return {
        ok: true,
        jobId: job.id,
        attemptId,
        providerJobId: handle.jobId,
        providerId: input.motionGraphicsProviderId,
      };
    } catch (error) {
      await releaseReserved(deps, reservedLevels, {
        workspaceId,
        campaignId,
        providerId: input.motionGraphicsProviderId,
        estimatedCents,
        key,
      });
      const isCapability =
        error instanceof MotionGraphicsProviderError && error.reason === 'UNSUPPORTED_CAPABILITY';
      await updateVariantGenerationAttempt(deps.variantDb, attemptId, {
        status: 'FAILED',
        failureReason: isCapability ? 'UNSUPPORTED_CAPABILITY' : 'PROVIDER_ERROR',
        failureRetryable: !isCapability,
        failureMessage: error instanceof Error ? error.message : String(error),
        completedAt: new Date(),
      });
      await updateVariantGenerationJob(deps.variantDb, job.id, { status: 'FAILED' });
      return isCapability
        ? { ok: false, reason: 'UNSUPPORTED_CAPABILITY', detail: error.message }
        : {
            ok: false,
            reason: 'PROVIDER_ERROR',
            detail: error instanceof Error ? error.message : String(error),
          };
    }
  };
}

/** The scope a budget level is keyed by for this render. One definition shared by the reservation and release paths. */
function budgetScopeId(
  level: BudgetLevel,
  ctx: { workspaceId: string; campaignId: string; providerId: string },
): string {
  return level === 'WORKSPACE'
    ? ctx.workspaceId
    : level === 'CAMPAIGN'
      ? ctx.campaignId
      : ctx.providerId;
}

async function releaseReserved(
  deps: DispatchVariantRenderActivityDeps,
  levels: readonly BudgetLevel[],
  ctx: {
    workspaceId: string;
    campaignId: string;
    providerId: string;
    estimatedCents: number;
    key: string;
  },
): Promise<void> {
  for (const level of levels) {
    const scopeId = budgetScopeId(level, ctx);
    // eslint-disable-next-line no-await-in-loop -- bounded by levels.length (<=3)
    const policy = await deps.budgetDb.budgetPolicy.findFirst({
      where: { workspaceId: ctx.workspaceId, level, scopeId },
    });
    if (!policy) continue;
    // eslint-disable-next-line no-await-in-loop -- same rationale
    await releaseBudget(deps.budgetDb, policy.id, ctx.workspaceId, {
      amountCents: ctx.estimatedCents,
      idempotencyKey: `${ctx.key}:release`,
      campaignId: ctx.campaignId,
    });
  }
}
