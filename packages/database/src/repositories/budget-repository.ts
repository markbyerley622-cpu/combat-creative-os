import { CampaignTransitionError, type BudgetLedgerEntryType, type BudgetLevel } from '@combat/domain';

/**
 * Budget checks happen before every external-generation dispatch, at every
 * applicable level (architecture.md §4.3, CLAUDE.md "Budgets must be checked
 * before external generation"). `BudgetPolicy` rows are configured caps;
 * `BudgetLedgerEntry` is the append-only spend log — a policy's remaining
 * amount is always a computed aggregate over the ledger, never a field
 * mutated in place.
 */
export interface BudgetPolicyRecord {
  id: string;
  workspaceId: string;
  level: BudgetLevel;
  scopeId: string;
  limitCents: number;
}

export interface BudgetLedgerEntryRecord {
  id: string;
  workspaceId: string;
  budgetPolicyId: string;
  entryType: BudgetLedgerEntryType;
  amountCents: number;
  idempotencyKey: string;
  campaignId?: string;
  shotId?: string;
  generationJobRef?: string;
  createdAt: Date;
}

export interface BudgetDataSource {
  budgetPolicy: {
    findFirst(args: {
      where: { workspaceId: string; level: BudgetLevel; scopeId: string };
    }): Promise<BudgetPolicyRecord | null>;
  };
  budgetLedgerEntry: {
    findMany(args: { where: { budgetPolicyId: string } }): Promise<BudgetLedgerEntryRecord[]>;
    findFirst(args: {
      where: { budgetPolicyId: string; idempotencyKey: string };
    }): Promise<BudgetLedgerEntryRecord | null>;
    create(args: {
      data: {
        workspaceId: string;
        budgetPolicyId: string;
        entryType: BudgetLedgerEntryType;
        amountCents: number;
        idempotencyKey: string;
        campaignId?: string;
        shotId?: string;
        generationJobRef?: string;
      };
    }): Promise<BudgetLedgerEntryRecord>;
  };
}

/** Sum of RESERVATION + CHARGE, minus RELEASE — never a stored/decremented field. */
export function computeSpentCents(entries: BudgetLedgerEntryRecord[]): number {
  return entries.reduce((total, entry) => {
    if (entry.entryType === 'RELEASE') return total - entry.amountCents;
    return total + entry.amountCents;
  }, 0);
}

export interface BudgetCheckRequest {
  workspaceId: string;
  level: BudgetLevel;
  scopeId: string;
  requiredCents: number;
  idempotencyKey: string;
  campaignId?: string;
  shotId?: string;
  generationJobRef?: string;
}

export type BudgetCheckResult =
  | { ok: true; policy: BudgetPolicyRecord; reservation: BudgetLedgerEntryRecord }
  | { ok: true; policy: undefined; reservation: undefined } // no policy configured at this level — uncapped
  | { ok: false; error: CampaignTransitionError };

/**
 * Reserves `requiredCents` against the policy at (level, scopeId), if one is
 * configured — a level with no configured BudgetPolicy is treated as
 * uncapped, so a workspace can enforce budgets only where it has chosen to
 * configure them. Idempotent: replaying the same `idempotencyKey` against the
 * same policy returns the existing reservation rather than double-reserving
 * (CLAUDE.md workflow-idempotency rule).
 */
export async function checkAndReserveBudget(
  db: BudgetDataSource,
  request: BudgetCheckRequest,
): Promise<BudgetCheckResult> {
  const policy = await db.budgetPolicy.findFirst({
    where: { workspaceId: request.workspaceId, level: request.level, scopeId: request.scopeId },
  });
  if (!policy) {
    return { ok: true, policy: undefined, reservation: undefined };
  }

  const existingReservation = await db.budgetLedgerEntry.findFirst({
    where: { budgetPolicyId: policy.id, idempotencyKey: request.idempotencyKey },
  });
  if (existingReservation) {
    return { ok: true, policy, reservation: existingReservation };
  }

  const entries = await db.budgetLedgerEntry.findMany({ where: { budgetPolicyId: policy.id } });
  const spent = computeSpentCents(entries);
  const remaining = policy.limitCents - spent;

  if (remaining < request.requiredCents) {
    return {
      ok: false,
      error: new CampaignTransitionError({
        type: 'BUDGET_EXCEEDED',
        level: request.level,
        scopeId: request.scopeId,
        requiredCents: request.requiredCents,
        remainingCents: remaining,
      }),
    };
  }

  const reservation = await db.budgetLedgerEntry.create({
    data: {
      workspaceId: request.workspaceId,
      budgetPolicyId: policy.id,
      entryType: 'RESERVATION',
      amountCents: request.requiredCents,
      idempotencyKey: request.idempotencyKey,
      campaignId: request.campaignId,
      shotId: request.shotId,
      generationJobRef: request.generationJobRef,
    },
  });
  return { ok: true, policy, reservation };
}

/** Closes out a RESERVATION as a confirmed spend — same idempotency key, new ledger row. */
export async function chargeBudget(
  db: BudgetDataSource,
  policyId: string,
  workspaceId: string,
  input: { amountCents: number; idempotencyKey: string; campaignId?: string; shotId?: string },
): Promise<BudgetLedgerEntryRecord> {
  return db.budgetLedgerEntry.create({
    data: {
      workspaceId,
      budgetPolicyId: policyId,
      entryType: 'CHARGE',
      amountCents: input.amountCents,
      idempotencyKey: input.idempotencyKey,
      campaignId: input.campaignId,
      shotId: input.shotId,
    },
  });
}

/** Closes out a RESERVATION on failure/cancellation, freeing the reserved amount. */
export async function releaseBudget(
  db: BudgetDataSource,
  policyId: string,
  workspaceId: string,
  input: { amountCents: number; idempotencyKey: string; campaignId?: string; shotId?: string },
): Promise<BudgetLedgerEntryRecord> {
  return db.budgetLedgerEntry.create({
    data: {
      workspaceId,
      budgetPolicyId: policyId,
      entryType: 'RELEASE',
      amountCents: input.amountCents,
      idempotencyKey: input.idempotencyKey,
      campaignId: input.campaignId,
      shotId: input.shotId,
    },
  });
}
