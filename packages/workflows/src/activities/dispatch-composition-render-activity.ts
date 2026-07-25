import type {
  BudgetDataSource,
  CompositionDataSource,
  RoughEditSpecificationDataSource,
} from '@combat/database';
import {
  checkAndReserveBudget,
  getOrCreateCompositionAttempt,
  getOrCreateCompositionJob,
  getRoughEditSpecification,
  releaseBudget,
  updateCompositionAttempt,
  updateCompositionJob,
} from '@combat/database';
import type { BudgetLevel } from '@combat/domain';
import {
  MotionGraphicsProviderError,
  type MotionGraphicsProvider,
  type MotionGraphicsTimeline,
} from '@combat/providers';

/** M9: composition budget is enforced at workspace/campaign/provider (a rough edit is a campaign-level render, not per-shot). */
const BUDGET_GATED_LEVELS: readonly BudgetLevel[] = ['WORKSPACE', 'CAMPAIGN', 'PROVIDER'];

export interface DispatchCompositionRenderInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  readonly roughEditSpecificationId: string;
  readonly attemptNumber: number;
  readonly motionGraphicsProviderId: string;
  readonly maxAttempts: number;
}

export type DispatchCompositionRenderOutput =
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

export interface DispatchCompositionRenderActivityDeps {
  readonly motionGraphicsProvider: MotionGraphicsProvider;
  readonly roughEditSpecificationDb: RoughEditSpecificationDataSource;
  readonly compositionDb: CompositionDataSource;
  readonly budgetDb: BudgetDataSource;
  /** Estimated cost per output frame, in cents. */
  readonly estimatedCostCentsPerFrame: number;
}

function idempotencyKey(workflowRunId: string, specId: string, attemptNumber: number): string {
  return `${workflowRunId}:COMP:${specId}:${attemptNumber}`;
}

function toTimeline(spec: {
  aspectRatio: string;
  outputFormat: string;
  targetDurationFrames: number;
  tracks: readonly {
    trackType: string;
    clips: readonly {
      order: number;
      sourceAssetId: string;
      sourceInFrame: number;
      sourceOutFrame: number;
      transitionIn?: string;
    }[];
  }[];
  overlays: readonly { kind: string; designAssetRef?: string }[];
}): MotionGraphicsTimeline {
  const videoClips = spec.tracks
    .filter((t) => t.trackType === 'VIDEO')
    .flatMap((t) => t.clips)
    .sort((a, b) => a.order - b.order)
    .map((c) => ({
      order: c.order,
      sourceRef: c.sourceAssetId,
      inFrame: c.sourceInFrame,
      outFrame: c.sourceOutFrame,
      transitionIn: c.transitionIn,
    }));
  return {
    aspectRatio: spec.aspectRatio,
    outputFormat: spec.outputFormat,
    durationFrames: spec.targetDurationFrames,
    clips: videoClips,
    overlays: spec.overlays.map((o) => ({ kind: o.kind, ref: o.designAssetRef })),
  };
}

/**
 * M9: dispatches one bounded-retry render attempt for a `RoughEditSpecification`.
 * Reserves budget at WORKSPACE/CAMPAIGN/PROVIDER before creating the provider
 * composition project and submitting the render; the attempt's own
 * `idempotencyKey` (embedding `attemptNumber`) is what makes a replayed dispatch
 * return the existing attempt rather than double-submitting or double-reserving.
 * A capability rejection or budget failure releases every reservation already
 * made and returns a typed terminal failure (no retry).
 */
export function createDispatchCompositionRenderActivity(
  deps: DispatchCompositionRenderActivityDeps,
): (input: DispatchCompositionRenderInput) => Promise<DispatchCompositionRenderOutput> {
  return async function dispatchCompositionRenderActivity(
    input: DispatchCompositionRenderInput,
  ): Promise<DispatchCompositionRenderOutput> {
    const { workspaceId, campaignId, workflowRunId, roughEditSpecificationId, attemptNumber } =
      input;

    const spec = await getRoughEditSpecification(
      deps.roughEditSpecificationDb,
      workspaceId,
      roughEditSpecificationId,
    );
    if (!spec) {
      return {
        ok: false,
        reason: 'SPEC_NOT_FOUND',
        detail: `RoughEditSpecification ${roughEditSpecificationId} not found`,
      };
    }

    const job = await getOrCreateCompositionJob(deps.compositionDb, workspaceId, {
      campaignId,
      roughEditSpecificationId,
      maxAttempts: input.maxAttempts,
    });

    const key = idempotencyKey(workflowRunId, roughEditSpecificationId, attemptNumber);
    const existing = await getOrCreateCompositionAttempt(deps.compositionDb, workspaceId, {
      compositionJobId: job.id,
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
    const reservedLevels: BudgetLevel[] = [];
    for (const level of BUDGET_GATED_LEVELS) {
      const scopeId =
        level === 'WORKSPACE'
          ? workspaceId
          : level === 'CAMPAIGN'
            ? campaignId
            : input.motionGraphicsProviderId;
      // eslint-disable-next-line no-await-in-loop -- budget reservations are inherently sequential
      const result = await checkAndReserveBudget(deps.budgetDb, {
        workspaceId,
        level,
        scopeId,
        requiredCents: estimatedCents,
        idempotencyKey: key,
        campaignId,
      });
      if (!result.ok) {
        await releaseReserved(deps, reservedLevels, {
          workspaceId,
          campaignId,
          providerId: input.motionGraphicsProviderId,
          estimatedCents,
          key,
        });
        await updateCompositionAttempt(deps.compositionDb, attemptId, {
          status: 'FAILED',
          failureReason: 'BUDGET_EXCEEDED',
          failureRetryable: false,
          failureMessage: result.error.message,
          completedAt: new Date(),
        });
        await updateCompositionJob(deps.compositionDb, job.id, { status: 'BUDGET_EXCEEDED' });
        return { ok: false, reason: 'BUDGET_EXCEEDED', level, detail: result.error.message };
      }
      if (result.policy) reservedLevels.push(level);
    }

    try {
      const project = await deps.motionGraphicsProvider.createProject({
        idempotencyKey: key,
        campaignId,
        name: `rough-edit-${roughEditSpecificationId}`,
      });
      const handle = await deps.motionGraphicsProvider.submitRender({
        idempotencyKey: key,
        projectId: project.projectId,
        timeline: toTimeline(spec),
      });

      await updateCompositionAttempt(deps.compositionDb, attemptId, {
        status: 'SUBMITTED',
        providerProjectId: project.projectId,
        providerJobId: handle.jobId,
        budgetReservationId: key,
        estimatedCostCents: estimatedCents,
      });
      await updateCompositionJob(deps.compositionDb, job.id, {
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
      await updateCompositionAttempt(deps.compositionDb, attemptId, {
        status: 'FAILED',
        failureReason: isCapability ? 'UNSUPPORTED_CAPABILITY' : 'PROVIDER_ERROR',
        failureRetryable: !isCapability,
        failureMessage: error instanceof Error ? error.message : String(error),
        completedAt: new Date(),
      });
      await updateCompositionJob(deps.compositionDb, job.id, { status: 'FAILED' });
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

async function releaseReserved(
  deps: DispatchCompositionRenderActivityDeps,
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
    const scopeId =
      level === 'WORKSPACE'
        ? ctx.workspaceId
        : level === 'CAMPAIGN'
          ? ctx.campaignId
          : ctx.providerId;
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
