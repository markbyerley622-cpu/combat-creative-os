import {
  CampaignTransitionError,
  type BudgetLedgerEntryType,
  type BudgetLevel,
} from '@combat/domain';
import {
  BudgetReservationRaceError,
  isUniqueConstraintViolation,
  runBudgetTransactionWithRetry,
  type BudgetTransactionRetryOptions,
  type SerializableBudgetDataSource,
} from './budget-transaction';

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

/**
 * The reads and writes budget accounting performs.
 *
 * Reserving needs more than this — it needs a `SERIALIZABLE` transaction, so
 * `reserveBudgetAcrossScopes` takes `SerializableBudgetDataSource` (this plus a
 * `BudgetTransactionRunner`). Status, charge and release stay on the narrower
 * type: each is a single statement or idempotent on the ledger's unique key,
 * and keeping them here means a read-only handle cannot reserve.
 */
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

/** One (level, scopeId) pair a dispatch must clear before it may spend. */
export interface BudgetScope {
  readonly level: BudgetLevel;
  readonly scopeId: string;
}

export interface BudgetReservationRequest {
  readonly workspaceId: string;
  /** Every scope this dispatch is gated on. All of them clear together or none of them do. */
  readonly scopes: readonly BudgetScope[];
  readonly requiredCents: number;
  readonly idempotencyKey: string;
  readonly campaignId?: string;
  readonly shotId?: string;
  readonly generationJobRef?: string;
}

export interface BudgetScopeReservation {
  readonly level: BudgetLevel;
  readonly scopeId: string;
  readonly policy: BudgetPolicyRecord;
  readonly reservation: BudgetLedgerEntryRecord;
}

export type BudgetReservationResult =
  | {
      readonly ok: true;
      readonly reservations: readonly BudgetScopeReservation[];
      /** Scopes with no configured policy. Reported rather than silently dropped, so a caller can tell "uncapped" from "reserved". */
      readonly uncappedScopes: readonly BudgetScope[];
    }
  | {
      readonly ok: false;
      /** The scope that could not be cleared. The rest were never written. */
      readonly level: BudgetLevel;
      readonly scopeId: string;
      readonly error: CampaignTransitionError;
    };

/**
 * A reservation request that is malformed rather than unaffordable.
 *
 * Thrown before the transaction opens, so it can never be retried as
 * contention (requirement 7 of AAMP-1 step 3) and can never leave a partial
 * ledger behind.
 */
export class InvalidBudgetRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBudgetRequestError';
  }
}

/**
 * Deterministic scope ordering for policy lookup.
 *
 * Two concurrent transactions that touch the same policies must touch them in
 * the same order, or they can hold-and-wait on each other's rows and deadlock
 * (40P01) instead of merely conflicting (40001). Ordering by level first gives
 * a stable order for the common four-level dispatch regardless of the order the
 * caller happened to list its scopes in; the final lock order is by policy id
 * (below), which is stable across *every* caller in the system, including ones
 * gated on different level sets.
 */
const BUDGET_LEVEL_LOCK_ORDER: readonly BudgetLevel[] = [
  'WORKSPACE',
  'CAMPAIGN',
  'PROVIDER',
  'SHOT',
];

function compareScopes(a: BudgetScope, b: BudgetScope): number {
  const levelDelta =
    BUDGET_LEVEL_LOCK_ORDER.indexOf(a.level) - BUDGET_LEVEL_LOCK_ORDER.indexOf(b.level);
  if (levelDelta !== 0) return levelDelta;
  return a.scopeId < b.scopeId ? -1 : a.scopeId > b.scopeId ? 1 : 0;
}

function assertValidReservationRequest(request: BudgetReservationRequest): void {
  if (request.workspaceId.length === 0) {
    throw new InvalidBudgetRequestError('workspaceId is required');
  }
  if (request.idempotencyKey.length === 0) {
    throw new InvalidBudgetRequestError('idempotencyKey is required');
  }
  if (!Number.isInteger(request.requiredCents) || request.requiredCents < 0) {
    throw new InvalidBudgetRequestError(
      `requiredCents must be a non-negative integer, received ${String(request.requiredCents)}`,
    );
  }
  if (request.scopes.length === 0) {
    throw new InvalidBudgetRequestError('at least one budget scope is required');
  }
  const seen = new Set<string>();
  for (const scope of request.scopes) {
    if (scope.scopeId.length === 0) {
      throw new InvalidBudgetRequestError(`scopeId is required for level ${scope.level}`);
    }
    const key = `${scope.level}:${scope.scopeId}`;
    if (seen.has(key)) {
      // Two entries for one policy would reserve the amount twice against the
      // same cap while reporting one reservation.
      throw new InvalidBudgetRequestError(`duplicate budget scope ${key}`);
    }
    seen.add(key);
  }
}

/**
 * Reserves `requiredCents` against every configured policy in `scopes`, inside
 * one `SERIALIZABLE` transaction (AAMP-1 step 3).
 *
 * A scope with no configured `BudgetPolicy` is uncapped: a workspace enforces
 * budgets only where it has chosen to configure them. Idempotent — replaying
 * the same `idempotencyKey` returns the reservations already written rather
 * than double-reserving (CLAUDE.md workflow-idempotency rule).
 *
 * Three properties this shape buys that a per-level loop could not:
 *
 * 1. *All or nothing.* Every applicable policy is checked before any row is
 *    written, and the transaction commits both or neither. The old loop
 *    reserved level by level and unwound its earlier reservations with
 *    compensating RELEASE rows when a later level refused — correct only if the
 *    process survived long enough to write them.
 * 2. *No read-then-write window.* PostgreSQL's serializable snapshot isolation
 *    aborts one of two transactions that read the same ledger and both write to
 *    it, so two dispatches can never both observe the same headroom. The
 *    aborted one is retried by `runBudgetTransactionWithRetry`.
 * 3. *One lock order.* Policies are locked by id, so two dispatches gated on
 *    overlapping scope sets cannot deadlock by approaching them from opposite
 *    ends.
 *
 * `BUDGET_EXCEEDED` is returned, never thrown: it is an expected business
 * outcome the caller must branch on. Contention that outlives the retry bound
 * *is* thrown (`BudgetTransactionContentionError`), because it says nothing
 * about the workspace's money — see that class's doc comment.
 */
export async function reserveBudgetAcrossScopes(
  db: SerializableBudgetDataSource,
  request: BudgetReservationRequest,
  retryOptions?: BudgetTransactionRetryOptions,
): Promise<BudgetReservationResult> {
  assertValidReservationRequest(request);

  const orderedScopes = [...request.scopes].sort(compareScopes);

  return runBudgetTransactionWithRetry(
    db.budgetTransaction,
    async (tx) => {
      const configured: { scope: BudgetScope; policy: BudgetPolicyRecord }[] = [];
      const uncappedScopes: BudgetScope[] = [];

      for (const scope of orderedScopes) {
        // eslint-disable-next-line no-await-in-loop -- deterministic order is the deadlock guard; parallel lookups would surrender it
        const policy = await tx.budgetPolicy.findFirst({
          where: { workspaceId: request.workspaceId, level: scope.level, scopeId: scope.scopeId },
        });
        if (policy) configured.push({ scope, policy });
        else uncappedScopes.push(scope);
      }

      // Final lock order: policy id, stable across every caller in the system.
      configured.sort((a, b) =>
        a.policy.id < b.policy.id ? -1 : a.policy.id > b.policy.id ? 1 : 0,
      );

      // Decide for every policy before writing to any of them, so a refusal at
      // the last scope leaves no row behind to be compensated.
      const planned: {
        scope: BudgetScope;
        policy: BudgetPolicyRecord;
        existing?: BudgetLedgerEntryRecord;
      }[] = [];

      for (const { scope, policy } of configured) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design (see lock order above)
        const existing = await tx.budgetLedgerEntry.findFirst({
          where: { budgetPolicyId: policy.id, idempotencyKey: request.idempotencyKey },
        });
        if (existing) {
          planned.push({ scope, policy, existing });
          continue;
        }

        // eslint-disable-next-line no-await-in-loop -- sequential by design (see lock order above)
        const entries = await tx.budgetLedgerEntry.findMany({
          where: { budgetPolicyId: policy.id },
        });
        const remaining = policy.limitCents - computeSpentCents(entries);
        if (remaining < request.requiredCents) {
          return {
            ok: false as const,
            level: scope.level,
            scopeId: scope.scopeId,
            error: new CampaignTransitionError({
              type: 'BUDGET_EXCEEDED',
              level: scope.level,
              scopeId: scope.scopeId,
              requiredCents: request.requiredCents,
              remainingCents: remaining,
            }),
          };
        }
        planned.push({ scope, policy });
      }

      const reservations: BudgetScopeReservation[] = [];
      for (const { scope, policy, existing } of planned) {
        let reservation = existing;
        if (!reservation) {
          try {
            // eslint-disable-next-line no-await-in-loop -- sequential by design (see lock order above)
            reservation = await tx.budgetLedgerEntry.create({
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
            if (isUniqueConstraintViolation(error)) {
              // A concurrent retry of the same key won. Its row is invisible to
              // this snapshot, so retry the transaction rather than re-reading.
              throw new BudgetReservationRaceError(request.idempotencyKey, error);
            }
            throw error;
          }
        }
        reservations.push({ level: scope.level, scopeId: scope.scopeId, policy, reservation });
      }

      return { ok: true as const, reservations, uncappedScopes };
    },
    retryOptions,
  );
}

/**
 * Reserves against the single policy at (level, scopeId).
 *
 * Retained as the one-scope spelling of `reserveBudgetAcrossScopes` — the
 * shape most call sites and the whole existing test suite are written against.
 * A caller gated on several levels should use the plural form, so the levels
 * clear atomically instead of level by level.
 */
export async function checkAndReserveBudget(
  db: SerializableBudgetDataSource,
  request: BudgetCheckRequest,
): Promise<BudgetCheckResult> {
  const result = await reserveBudgetAcrossScopes(db, {
    workspaceId: request.workspaceId,
    scopes: [{ level: request.level, scopeId: request.scopeId }],
    requiredCents: request.requiredCents,
    idempotencyKey: request.idempotencyKey,
    campaignId: request.campaignId,
    shotId: request.shotId,
    generationJobRef: request.generationJobRef,
  });

  if (!result.ok) return { ok: false, error: result.error };

  const reserved = result.reservations[0];
  if (!reserved) return { ok: true, policy: undefined, reservation: undefined };
  return { ok: true, policy: reserved.policy, reservation: reserved.reservation };
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
