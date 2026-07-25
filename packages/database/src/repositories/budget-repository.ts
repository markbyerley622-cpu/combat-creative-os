import {
  CampaignTransitionError,
  type BudgetLedgerEntryType,
  type BudgetLevel,
} from '@combat/domain';

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

/**
 * Sum of RESERVATION + CHARGE, minus RELEASE — never a stored/decremented field.
 *
 * The consequence worth stating explicitly, because getting it wrong is what
 * the post-M14 audit caught (finding C-2): a RESERVATION keeps counting
 * against the cap until it is closed out by a RELEASE of **its own full
 * amount**. Charging a completed job without releasing its reservation leaves
 * both rows standing, so `spentCents` reports roughly twice the money actually
 * spent. Every settlement path therefore goes through
 * `settleBudgetReservation` below rather than writing a CHARGE on its own.
 */
export function computeSpentCents(entries: BudgetLedgerEntryRecord[]): number {
  return entries.reduce((total, entry) => {
    if (entry.entryType === 'RELEASE') return total - entry.amountCents;
    return total + entry.amountCents;
  }, 0);
}

export interface BudgetStatus {
  readonly level: BudgetLevel;
  readonly scopeId: string;
  readonly limitCents: number;
  readonly spentCents: number;
  readonly remainingCents: number;
}

/** Read-only budget-consumption summary for one (level, scopeId) — `null` when no policy is configured there (an uncapped scope has nothing to report). Used by apps/api's read-only shot-generation views (M6 requirement 9). */
export async function getBudgetStatus(
  db: BudgetDataSource,
  workspaceId: string,
  level: BudgetLevel,
  scopeId: string,
): Promise<BudgetStatus | null> {
  const policy = await db.budgetPolicy.findFirst({ where: { workspaceId, level, scopeId } });
  if (!policy) return null;
  const entries = await db.budgetLedgerEntry.findMany({ where: { budgetPolicyId: policy.id } });
  const spentCents = computeSpentCents(entries);
  return {
    level,
    scopeId,
    limitCents: policy.limitCents,
    spentCents,
    remainingCents: policy.limitCents - spentCents,
  };
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
 *
 * **M14 — concurrency.** The headroom check is a read followed by a write, so
 * two callers can both observe enough budget before either has written. Two
 * guards close that window without requiring a database transaction:
 *
 * 1. *Duplicate keys.* Concurrent retries of the SAME key all pass the
 *    pre-read, so the losers hit the `(budgetPolicyId, idempotencyKey)` unique
 *    constraint. That violation is caught and resolved by re-reading the row
 *    the winner wrote, so a retry storm is idempotent rather than an error.
 * 2. *Over-commitment.* After inserting, the ledger is re-read and the total
 *    re-checked. A reservation that turns out to have crossed the limit is
 *    compensated — released immediately and reported as `BUDGET_EXCEEDED` — so
 *    the committed total can never exceed the configured cap even when several
 *    distinct dispatches race.
 *
 * The durable fix under Postgres is a `SERIALIZABLE` transaction (or a
 * `SELECT ... FOR UPDATE` on the policy row) around the read-and-insert; that
 * cannot be exercised in this environment, which has no live database, so the
 * compensating guard above is what is actually tested. See
 * docs/architecture.md §8's M14 entry.
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

  let reservation: BudgetLedgerEntryRecord;
  try {
    reservation = await db.budgetLedgerEntry.create({
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
  } catch (error) {
    // Guard 1: a concurrent retry of the same key won the race. The unique
    // constraint is the authority — resolve to the row it wrote.
    const winner = await db.budgetLedgerEntry.findFirst({
      where: { budgetPolicyId: policy.id, idempotencyKey: request.idempotencyKey },
    });
    if (winner) return { ok: true, policy, reservation: winner };
    throw error;
  }

  // Guard 2: re-read and re-check, first-writer-wins. Another dispatch may
  // have committed between this call's read and its write, so the ledger
  // prefix up to and including this reservation is re-summed: if THIS row is
  // the one that crossed the cap it is compensated, while everything written
  // before it stands. Without the prefix rule every racer would see the
  // over-commit and all of them would back out, wasting headroom that one of
  // them was entitled to.
  const committed = await db.budgetLedgerEntry.findMany({ where: { budgetPolicyId: policy.id } });
  const ownIndex = committed.findIndex((e) => e.id === reservation.id);
  const prefix = ownIndex >= 0 ? committed.slice(0, ownIndex + 1) : committed;
  if (computeSpentCents(prefix) > policy.limitCents) {
    await db.budgetLedgerEntry.create({
      data: {
        workspaceId: request.workspaceId,
        budgetPolicyId: policy.id,
        entryType: 'RELEASE',
        amountCents: request.requiredCents,
        idempotencyKey: `${request.idempotencyKey}:overcommit-release`,
        campaignId: request.campaignId,
        shotId: request.shotId,
        generationJobRef: request.generationJobRef,
      },
    });
    return {
      ok: false,
      error: new CampaignTransitionError({
        type: 'BUDGET_EXCEEDED',
        level: request.level,
        scopeId: request.scopeId,
        requiredCents: request.requiredCents,
        remainingCents: Math.max(0, policy.limitCents - spent),
      }),
    };
  }

  return { ok: true, policy, reservation };
}

export interface BudgetLedgerWriteInput {
  amountCents: number;
  idempotencyKey: string;
  campaignId?: string;
  shotId?: string;
}

/**
 * Writes one ledger row, resolving to the existing row when its
 * `(budgetPolicyId, idempotencyKey)` pair has already been written.
 *
 * Activity retries and workflow replays re-run settlement from the top, so a
 * CHARGE or RELEASE can legitimately be attempted twice for the same job. The
 * unique constraint is the authority on which write won; this resolves to it
 * rather than propagating the violation, exactly as `checkAndReserveBudget`
 * does for RESERVATION. The pre-read is the common path and the catch handles
 * the concurrent-writer race the pre-read cannot.
 */
async function writeLedgerEntryOnce(
  db: BudgetDataSource,
  policyId: string,
  workspaceId: string,
  entryType: BudgetLedgerEntryType,
  input: BudgetLedgerWriteInput,
): Promise<BudgetLedgerEntryRecord> {
  const existing = await db.budgetLedgerEntry.findFirst({
    where: { budgetPolicyId: policyId, idempotencyKey: input.idempotencyKey },
  });
  if (existing) return existing;

  try {
    return await db.budgetLedgerEntry.create({
      data: {
        workspaceId,
        budgetPolicyId: policyId,
        entryType,
        amountCents: input.amountCents,
        idempotencyKey: input.idempotencyKey,
        campaignId: input.campaignId,
        shotId: input.shotId,
      },
    });
  } catch (error) {
    const winner = await db.budgetLedgerEntry.findFirst({
      where: { budgetPolicyId: policyId, idempotencyKey: input.idempotencyKey },
    });
    if (winner) return winner;
    throw error;
  }
}

/**
 * Records a confirmed spend. Idempotent on `(policyId, idempotencyKey)`.
 *
 * This does **not** on its own close out the RESERVATION it corresponds to —
 * see `computeSpentCents`. Prefer `settleBudgetReservation`, which pairs the
 * charge with the matching release; this remains exported for the ledger-level
 * tests and for a charge that never had a reservation behind it.
 */
export async function chargeBudget(
  db: BudgetDataSource,
  policyId: string,
  workspaceId: string,
  input: BudgetLedgerWriteInput,
): Promise<BudgetLedgerEntryRecord> {
  return writeLedgerEntryOnce(db, policyId, workspaceId, 'CHARGE', input);
}

/** Closes out a RESERVATION, freeing the reserved amount. Idempotent on `(policyId, idempotencyKey)`. */
export async function releaseBudget(
  db: BudgetDataSource,
  policyId: string,
  workspaceId: string,
  input: BudgetLedgerWriteInput,
): Promise<BudgetLedgerEntryRecord> {
  return writeLedgerEntryOnce(db, policyId, workspaceId, 'RELEASE', input);
}

export interface BudgetSettlementInput {
  /** The amount the pre-dispatch RESERVATION put on the ledger, which this settlement must fully close out. */
  readonly reservedCents: number;
  /** The provider's actual reported cost. May exceed `reservedCents` when the estimate was low. */
  readonly actualCents: number;
  /** The reservation's own key; the CHARGE and RELEASE rows derive their keys from it. */
  readonly reservationIdempotencyKey: string;
  readonly campaignId?: string;
  readonly shotId?: string;
}

export interface BudgetSettlement {
  readonly charge?: BudgetLedgerEntryRecord;
  readonly release?: BudgetLedgerEntryRecord;
}

/**
 * The single settlement path for a job that reached a terminal provider
 * outcome: charge what was actually spent, and release the reservation in
 * **full**.
 *
 * Post-M14 audit finding C-2. The three poll Activities each charged the
 * actual cost and released only `estimated − actual`, leaving the original
 * RESERVATION row standing alongside its CHARGE. Because `computeSpentCents`
 * counts both, a successful job inflated `spentCents` to roughly twice its
 * real cost — under-estimated jobs inflated it further still (no remainder
 * meant no release at all), so a workspace could be locked out of budget it
 * had never spent. Releasing the whole reservation nets the ledger to exactly
 * `actualCents`, which is the accounting invariant `budget-integrity.test.ts`
 * now asserts directly.
 *
 * Both writes are idempotent, so a retried Activity that already settled
 * observes the same ledger rather than double-charging. A zero-amount row is
 * skipped rather than written — an uncapped level never reaches here (its
 * caller finds no policy), but a job with no estimate or no cost otherwise
 * would litter the ledger with meaningless rows.
 */
export async function settleBudgetReservation(
  db: BudgetDataSource,
  policyId: string,
  workspaceId: string,
  input: BudgetSettlementInput,
): Promise<BudgetSettlement> {
  const common = { campaignId: input.campaignId, shotId: input.shotId };

  const charge =
    input.actualCents > 0
      ? await chargeBudget(db, policyId, workspaceId, {
          amountCents: input.actualCents,
          idempotencyKey: `${input.reservationIdempotencyKey}:charge`,
          ...common,
        })
      : undefined;

  const release =
    input.reservedCents > 0
      ? await releaseBudget(db, policyId, workspaceId, {
          amountCents: input.reservedCents,
          idempotencyKey: `${input.reservationIdempotencyKey}:release`,
          ...common,
        })
      : undefined;

  return { charge, release };
}
