import {
  CampaignTransitionError,
  evaluateCampaignTransition,
  type CampaignStage,
  type TransitionAuditResult,
} from '@combat/domain';
import { checkAndReserveBudget, releaseBudget, type BudgetDataSource } from './budget-repository';
import type { CampaignDataSource, CampaignRecord } from './campaign-repository';
import { latestApprovalForGate, type HumanApprovalDataSource } from './human-approval-repository';
import {
  computeTransitionFacts,
  loadTransitionFactInputs,
  type TransitionFactsDataSource,
} from './transition-facts';

export interface CampaignTransitionAuditRecord {
  id: string;
  workspaceId: string;
  campaignId: string;
  idempotencyKey: string;
  fromStage: CampaignStage;
  toStage: CampaignStage;
  result: TransitionAuditResult;
  reason?: string;
  approvalId?: string;
  requestedByUserId?: string;
  createdAt: Date;
}

export interface CampaignTransitionAuditDataSource {
  campaignTransitionAudit: {
    findFirst(args: {
      where: { campaignId: string; idempotencyKey: string };
    }): Promise<CampaignTransitionAuditRecord | null>;
    create(args: {
      data: {
        workspaceId: string;
        campaignId: string;
        idempotencyKey: string;
        fromStage: CampaignStage;
        toStage: CampaignStage;
        result: TransitionAuditResult;
        reason?: string;
        approvalId?: string;
        requestedByUserId?: string;
      };
    }): Promise<CampaignTransitionAuditRecord>;
  };
}

/**
 * The narrow data-source contract for one atomic transition attempt. In
 * production this is satisfied by a Prisma `TransactionClient` passed to
 * `prisma.$transaction(async (tx) => attemptCampaignTransition(tx, ...))` —
 * see `runCampaignTransition` below. In tests it's an in-memory fake (see
 * campaign-transition-service.test.ts) that reproduces the same
 * compare-and-swap and unique-constraint semantics a real Postgres
 * transaction provides, so atomicity/idempotency/concurrency behavior is
 * exercised without a live database.
 */
export type CampaignTransitionDataSource = CampaignDataSource &
  CampaignTransitionAuditDataSource &
  HumanApprovalDataSource &
  TransitionFactsDataSource &
  BudgetDataSource & {
    campaign: CampaignDataSource['campaign'] & {
      updateMany(args: {
        where: { id: string; workspaceId: string; currentStage: CampaignStage; version: number };
        data: { currentStage: CampaignStage; version: { increment: number } };
      }): Promise<{ count: number }>;
    };
  };

export interface CampaignTransitionRequest {
  workspaceId: string;
  campaignId: string;
  toStage: CampaignStage;
  idempotencyKey: string;
  requestedByUserId?: string;
  /** Required-cents to reserve when this transition dispatches paid generation (see SHOT_GENERATION_BUDGET_LEVELS). */
  generationBudgetCents?: number;
}

export type CampaignTransitionResult =
  | { ok: true; campaign: CampaignRecord; audit: CampaignTransitionAuditRecord }
  | { ok: false; error: CampaignTransitionError; audit: CampaignTransitionAuditRecord };

/** Stages a transition *into* which dispatches paid generation work and must clear a budget check first. */
const BUDGET_GATED_STAGES: ReadonlySet<CampaignStage> = new Set(['SHOT_GENERATION']);

async function writeAudit(
  db: CampaignTransitionAuditDataSource,
  workspaceId: string,
  campaignId: string,
  idempotencyKey: string,
  fromStage: CampaignStage,
  toStage: CampaignStage,
  result: TransitionAuditResult,
  extra: { reason?: string; approvalId?: string; requestedByUserId?: string } = {},
): Promise<CampaignTransitionAuditRecord> {
  return db.campaignTransitionAudit.create({
    data: {
      workspaceId,
      campaignId,
      idempotencyKey,
      fromStage,
      toStage,
      result,
      reason: extra.reason,
      approvalId: extra.approvalId,
      requestedByUserId: extra.requestedByUserId,
    },
  });
}

/**
 * Attempts exactly one campaign stage transition, atomically:
 *  1. idempotency check (duplicate requests return the original outcome)
 *  2. pure rule evaluation (CAMPAIGN_TRANSITIONS + gathered facts)
 *  3. budget check + reservation, only for stages that dispatch paid generation
 *  4. compare-and-swap stage update (guards concurrent transition attempts)
 *  5. audit write (every attempt, success or rejection)
 *
 * The caller is responsible for running this inside a real transaction
 * (`runCampaignTransition`) so steps 1-5 commit or roll back together —
 * CLAUDE.md "Transitions must be atomic".
 */
export async function attemptCampaignTransition(
  db: CampaignTransitionDataSource,
  request: CampaignTransitionRequest,
): Promise<CampaignTransitionResult> {
  const { workspaceId, campaignId, toStage, idempotencyKey } = request;

  const existingAudit = await db.campaignTransitionAudit.findFirst({
    where: { campaignId, idempotencyKey },
  });
  if (existingAudit) {
    if (existingAudit.result === 'APPLIED') {
      const campaign = await db.campaign.findFirst({ where: { id: campaignId, workspaceId } });
      if (!campaign) {
        throw new Error(`campaign ${campaignId} not found after a previously-applied transition`);
      }
      return { ok: true, campaign, audit: existingAudit };
    }
    return {
      ok: false,
      error: new CampaignTransitionError({ type: 'DUPLICATE_REQUEST', idempotencyKey }),
      audit: existingAudit,
    };
  }

  const campaign = await db.campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!campaign) {
    throw new Error(`campaign ${campaignId} not found in workspace ${workspaceId}`);
  }
  const fromStage = campaign.currentStage;

  const inputs = await loadTransitionFactInputs(db, workspaceId, campaignId);
  const approvals = inputs.approvals;

  // Facts for *any* transition out of fromStage are gathered generically by
  // computeTransitionFacts (it derives only the keys it's asked for); we ask
  // for every key relevant to this specific (from, to) pair, which
  // evaluateCampaignTransition tells us about implicitly by returning
  // MISSING_PREREQUISITE with the exact missing keys if we under-supply.
  // To avoid a second round-trip, gather the full fact set once — the
  // in-memory computation is cheap relative to the queries already made.
  const allFactKeys = [
    'briefAccepted',
    'conceptDrafted',
    'conceptApproved',
    'scriptDrafted',
    'allShotsHaveRequiredAssets',
    'allShotsHavePrompts',
    'allShotsHaveCandidate',
    'allShotsPassedVisualQA',
    'allShotsPassedContinuityQA',
    'allShotsSelected',
    'compositingComplete',
    'roughCutAssembled',
    'soundDesignComplete',
    'finalQAPassed',
    'finalApproved',
    'variantsGenerated',
    'variantQAPassed',
    'exportRenderComplete',
    'deliverySpecMet',
    'conceptRevisionRequested',
    'visualQARetryAllowed',
    'continuityQARetryAllowed',
    'shotSelectionRegenerateRequested',
    'compositingRepairTargetIsShotSelection',
    'compositingRepairTargetIsCompositingRetry',
    'roughCutFailureRequiresRecompositing',
    'soundDesignRepairTargetIsRoughCut',
    'soundDesignRepairTargetIsSoundDesignRetry',
    'finalQARepairTargetIsCompositing',
    'finalQARepairTargetIsRoughCut',
    'finalQAAudioFailure',
    'finalApprovalRepairTargetIsCompositing',
    'finalApprovalRepairTargetIsRoughCut',
    'finalApprovalRepairTargetIsSoundDesign',
    'variantQAFailed',
    'exportTechnicalFailureRetry',
    'distributionFailureDetected',
  ] as const;
  const facts = computeTransitionFacts(inputs, allFactKeys);

  const evaluation = evaluateCampaignTransition(fromStage, toStage, facts);
  if (!evaluation.ok) {
    const result: TransitionAuditResult =
      evaluation.reason.type === 'INVALID_TRANSITION'
        ? 'REJECTED_INVALID_TRANSITION'
        : 'REJECTED_MISSING_PREREQUISITE';
    const error = new CampaignTransitionError(evaluation.reason);
    const audit = await writeAudit(
      db,
      workspaceId,
      campaignId,
      idempotencyKey,
      fromStage,
      toStage,
      result,
      {
        reason: error.message,
        requestedByUserId: request.requestedByUserId,
      },
    );
    return { ok: false, error, audit };
  }

  const approvalId = evaluation.definition.requiredApprovalGate
    ? latestApprovalForGate(approvals, evaluation.definition.requiredApprovalGate)?.id
    : undefined;

  let reservedBudget: { policyId: string; amountCents: number } | undefined;
  if (BUDGET_GATED_STAGES.has(toStage) && request.generationBudgetCents !== undefined) {
    for (const level of ['WORKSPACE', 'CAMPAIGN'] as const) {
      const scopeId = level === 'WORKSPACE' ? workspaceId : campaignId;
      const budgetResult = await checkAndReserveBudget(db, {
        workspaceId,
        level,
        scopeId,
        requiredCents: request.generationBudgetCents,
        idempotencyKey,
        campaignId,
      });
      if (!budgetResult.ok) {
        const audit = await writeAudit(
          db,
          workspaceId,
          campaignId,
          idempotencyKey,
          fromStage,
          toStage,
          'REJECTED_BUDGET_EXCEEDED',
          { reason: budgetResult.error.message, requestedByUserId: request.requestedByUserId },
        );
        if (reservedBudget) {
          await releaseBudget(db, reservedBudget.policyId, workspaceId, {
            amountCents: reservedBudget.amountCents,
            idempotencyKey: `${idempotencyKey}:release`,
            campaignId,
          });
        }
        return { ok: false, error: budgetResult.error, audit };
      }
      if (budgetResult.policy) {
        reservedBudget = {
          policyId: budgetResult.policy.id,
          amountCents: request.generationBudgetCents,
        };
      }
    }
  }

  const updateResult = await db.campaign.updateMany({
    where: { id: campaignId, workspaceId, currentStage: fromStage, version: campaign.version },
    data: { currentStage: toStage, version: { increment: 1 } },
  });

  if (updateResult.count === 0) {
    if (reservedBudget) {
      await releaseBudget(db, reservedBudget.policyId, workspaceId, {
        amountCents: reservedBudget.amountCents,
        idempotencyKey: `${idempotencyKey}:release`,
        campaignId,
      });
    }
    const error = new CampaignTransitionError({
      type: 'CONCURRENT_MODIFICATION',
      campaignId,
      expectedVersion: campaign.version,
    });
    const audit = await writeAudit(
      db,
      workspaceId,
      campaignId,
      idempotencyKey,
      fromStage,
      toStage,
      'REJECTED_CONCURRENT_MODIFICATION',
      { reason: error.message, requestedByUserId: request.requestedByUserId },
    );
    return { ok: false, error, audit };
  }

  const updatedCampaign = await db.campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!updatedCampaign) {
    throw new Error(`campaign ${campaignId} disappeared immediately after a successful update`);
  }

  const audit = await writeAudit(
    db,
    workspaceId,
    campaignId,
    idempotencyKey,
    fromStage,
    toStage,
    'APPLIED',
    {
      approvalId,
      requestedByUserId: request.requestedByUserId,
    },
  );

  return { ok: true, campaign: updatedCampaign, audit };
}
