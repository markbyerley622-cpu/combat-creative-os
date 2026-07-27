import type { BudgetDataSource } from './budget-repository';

/**
 * The transaction seam budget reservation runs inside (AAMP-1 step 3).
 *
 * A reservation is a read-then-write: load the applicable policies, sum the
 * append-only ledger, decide whether the requested amount fits, and only then
 * append RESERVATION rows. Between the read and the write another dispatch can
 * commit, and until AAMP-1 step 3 the repository closed that window with a
 * *compensating* guard — insert, re-read, and release the row that turned out
 * to have crossed the cap. That guard could only ever be approximately right:
 * it briefly committed an over-limit ledger, and a crash between the insert and
 * the compensating release left the over-commitment standing permanently.
 *
 * The durable fix is to run the whole decision inside one `SERIALIZABLE`
 * transaction, so PostgreSQL's serializable snapshot isolation aborts one of
 * two conflicting reservations instead of letting both observe the same
 * headroom. That makes contention a first-class, *retryable* outcome, which is
 * what the rest of this module exists to classify and bound.
 *
 * The seam is deliberately vendor-neutral: `packages/database`'s repository
 * layer never imports `@prisma/client` (only `client.ts` and
 * `prisma-budget-transaction.ts` do), and the in-memory stores implement the
 * same interface so Activity tests keep running with no live database.
 */
export interface BudgetTransactionRunner {
  /**
   * Runs `work` inside one serializable transaction and returns its result.
   *
   * Implementations must either commit every write `work` performed or none of
   * them, and must surface a serialization/deadlock abort as a thrown error
   * `classifyBudgetTransactionFailure` recognises — swallowing it would turn a
   * conflict into a silently lost reservation.
   */
  runSerializable<T>(work: (tx: BudgetDataSource) => Promise<T>): Promise<T>;
}

/**
 * A budget data source that can serialize a reservation.
 *
 * Reservation requires this; reading a status, charging and releasing do not
 * (each is a single statement, or idempotent on the ledger's unique key), so
 * they keep taking the narrower `BudgetDataSource`. The split is what makes it
 * impossible to reserve budget through a handle that cannot serialize —
 * `apps/api`'s read-only budget views, for instance, are typed such that they
 * could not call `reserveBudgetAcrossScopes` even by accident.
 */
export type SerializableBudgetDataSource = BudgetDataSource & {
  readonly budgetTransaction: BudgetTransactionRunner;
};

/**
 * Why a serializable transaction failed, as far as the caller needs to know.
 *
 * Only the first three are retryable, and each is a *transient* statement about
 * concurrency rather than about the request: retrying the identical request
 * later can legitimately succeed. `NOT_RETRYABLE` covers everything else —
 * a constraint violation, a connection failure, a bug — where retrying would
 * at best waste time and at worst hide the real fault.
 */
export type BudgetTransactionFailureKind =
  | 'SERIALIZATION_FAILURE'
  | 'DEADLOCK_DETECTED'
  | 'WRITE_CONFLICT_OR_DEADLOCK'
  | 'UNIQUE_KEY_RACE'
  | 'NOT_RETRYABLE';

/** PostgreSQL `serialization_failure`: SSI aborted this transaction to preserve serializability. */
const SERIALIZATION_FAILURE_SQLSTATE = '40001';
/** PostgreSQL `deadlock_detected`: two transactions took row locks in opposite order. */
const DEADLOCK_DETECTED_SQLSTATE = '40P01';
/** Prisma's own code for "write conflict or deadlock", which does not distinguish the two SQLSTATEs. */
const PRISMA_WRITE_CONFLICT_CODE = 'P2034';
/** PostgreSQL `unique_violation`, and Prisma's code for the same thing. */
const UNIQUE_VIOLATION_SQLSTATE = '23505';
const PRISMA_UNIQUE_VIOLATION_CODE = 'P2002';

function readProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function readStringProperty(value: unknown, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === 'string' ? property : undefined;
}

/**
 * Maps a thrown error to the one thing the retry loop needs to decide.
 *
 * Deliberately structural rather than `instanceof PrismaClientKnownRequestError`:
 * the same abort reaches this code as a Prisma error code, as a driver
 * SQLSTATE on `error.code`, as a SQLSTATE nested under `error.meta.code`, or —
 * when a driver wraps it — as prose in the message. Matching only the class
 * would silently downgrade a retryable abort to a hard failure, which under
 * load looks exactly like a flaky budget system.
 */
export function classifyBudgetTransactionFailure(error: unknown): BudgetTransactionFailureKind {
  if (error instanceof BudgetReservationRaceError) return 'UNIQUE_KEY_RACE';

  const code = readStringProperty(error, 'code');
  const metaCode = readStringProperty(readProperty(error, 'meta'), 'code');

  for (const candidate of [code, metaCode]) {
    if (candidate === SERIALIZATION_FAILURE_SQLSTATE) return 'SERIALIZATION_FAILURE';
    if (candidate === DEADLOCK_DETECTED_SQLSTATE) return 'DEADLOCK_DETECTED';
    if (candidate === PRISMA_WRITE_CONFLICT_CODE) return 'WRITE_CONFLICT_OR_DEADLOCK';
  }

  const message = error instanceof Error ? error.message : '';
  // PostgreSQL's own wording for the two aborts, as re-emitted by every driver
  // in this path. Matched on the full phrase so an unrelated message mentioning
  // "deadlock" in prose cannot be mistaken for one.
  if (message.includes('could not serialize access')) return 'SERIALIZATION_FAILURE';
  if (message.includes('deadlock detected')) return 'DEADLOCK_DETECTED';
  if (message.includes('Transaction failed due to a write conflict or a deadlock')) {
    return 'WRITE_CONFLICT_OR_DEADLOCK';
  }

  return 'NOT_RETRYABLE';
}

export function isRetryableBudgetTransactionFailure(kind: BudgetTransactionFailureKind): boolean {
  return kind !== 'NOT_RETRYABLE';
}

/** True for a violation of `budget_ledger_entries (budgetPolicyId, idempotencyKey)` — or of any unique index, which on this table is the same thing. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  const code = readStringProperty(error, 'code');
  if (code === UNIQUE_VIOLATION_SQLSTATE || code === PRISMA_UNIQUE_VIOLATION_CODE) return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('unique constraint') || message.includes('Unique constraint');
}

/**
 * A concurrent transaction already wrote this reservation's idempotency key.
 *
 * Inside a `SERIALIZABLE` transaction the winner's row is invisible to this
 * snapshot, so the losing transaction cannot resolve idempotently by re-reading
 * it — the only correct move is to abort and start again against a fresh
 * snapshot, where the row *is* visible and the existing-reservation branch
 * returns it. Hence: retryable, not fatal, and bounded like every other
 * contention outcome.
 */
export class BudgetReservationRaceError extends Error {
  constructor(idempotencyKey: string, cause: unknown) {
    super(`Concurrent transaction already reserved idempotency key ${idempotencyKey}`);
    this.name = 'BudgetReservationRaceError';
    this.cause = cause;
  }
}

/**
 * Attempts allowed for one reservation before contention is reported as a
 * failure. Bounded on purpose (CLAUDE.md workflow-idempotency rule: "Bound
 * retries explicitly"); an unbounded retry loop against a saturated policy
 * would spin a worker slot forever instead of surfacing the pressure.
 *
 * Ten rather than a handful, because every reservation against one policy reads
 * that policy's whole ledger and then writes to it — so under SSI *every* pair
 * of concurrent reservations on the same policy conflicts, and one of each pair
 * is aborted. Measured against live PostgreSQL, eight simultaneous dispatches
 * on one campaign policy exhausted a five-attempt bound outright; with the
 * backoff below they settle well inside ten. See
 * `budget-postgres-concurrency.test.ts`.
 */
export const BUDGET_TRANSACTION_MAX_ATTEMPTS = 10;

const BACKOFF_BASE_MS = 5;
const BACKOFF_CAP_MS = 250;

/**
 * Exponential backoff with full jitter, the default between contention
 * retries.
 *
 * The jitter is the load-bearing part. Aborted transactions that retry
 * immediately and in lockstep simply collide again — that is precisely how the
 * five-attempt bound was exhausted before this existed. Spreading the retries
 * over a widening window lets them commit one after another instead.
 */
function defaultBackoff(attempt: number): Promise<void> {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  const delayMs = Math.random() * ceiling;
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Contention outlived the retry bound.
 *
 * Thrown rather than returned as a `{ ok: false }` reservation outcome, and the
 * distinction is load-bearing: every caller treats a returned failure as
 * `BUDGET_EXCEEDED`, a terminal business decision that fails the campaign stage
 * and is never retried. Exhausted contention is the opposite — the budget may
 * be entirely intact and the identical request may succeed a second later — so
 * it propagates as an error, where Temporal's Activity retry policy is the
 * right thing to handle it. Reporting it as "budget exceeded" would be a lie
 * about the workspace's money.
 */
export class BudgetTransactionContentionError extends Error {
  public readonly attempts: number;
  public readonly lastFailureKind: BudgetTransactionFailureKind;

  constructor(attempts: number, lastFailureKind: BudgetTransactionFailureKind, cause: unknown) {
    super(
      `Budget transaction could not be serialized after ${attempts} attempt(s); last failure: ${lastFailureKind}`,
    );
    this.name = 'BudgetTransactionContentionError';
    this.attempts = attempts;
    this.lastFailureKind = lastFailureKind;
    this.cause = cause;
  }
}

export interface BudgetTransactionRetryOptions {
  /** Defaults to `BUDGET_TRANSACTION_MAX_ATTEMPTS`. Must be >= 1. */
  readonly maxAttempts?: number;
  /** Observability hook, called once per retried attempt. Never used for control flow. */
  readonly onRetry?: (attempt: number, kind: BudgetTransactionFailureKind) => void;
  /** Backoff between attempts. Defaults to exponential-with-full-jitter; pass `() => Promise.resolve()` to retry immediately (tests that drive contention deterministically). */
  readonly delayBeforeRetry?: (attempt: number) => Promise<void>;
}

/**
 * Runs `work` in a serializable transaction, retrying only a serialization or
 * deadlock abort, at most `maxAttempts` times.
 *
 * Note what is *not* retried, because that is the whole point of classifying:
 * a budget-exceeded decision never reaches here (it is a returned value, so its
 * transaction commits normally), and an invalid request is rejected before the
 * first attempt. Only the database's own "you two conflicted, one of you must
 * go again" is retried.
 */
export async function runBudgetTransactionWithRetry<T>(
  runner: BudgetTransactionRunner,
  work: (tx: BudgetDataSource) => Promise<T>,
  options: BudgetTransactionRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? BUDGET_TRANSACTION_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, received ${String(maxAttempts)}`);
  }

  let lastKind: BudgetTransactionFailureKind = 'NOT_RETRYABLE';
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- retries are inherently sequential
      return await runner.runSerializable(work);
    } catch (error) {
      const kind = classifyBudgetTransactionFailure(error);
      if (!isRetryableBudgetTransactionFailure(kind)) throw error;
      lastKind = kind;
      lastError = error;
      options.onRetry?.(attempt, kind);
      if (attempt < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop -- backoff between sequential retries
        await (options.delayBeforeRetry ?? defaultBackoff)(attempt);
      }
    }
  }

  throw new BudgetTransactionContentionError(maxAttempts, lastKind, lastError);
}

export interface SerializedBudgetTransactionRunnerOptions<TRow> {
  /** The store's own data source — the same object the repository functions read and write outside a transaction. */
  readonly dataSource: BudgetDataSource;
  /** Captures the ledger rows that exist now, so a failed body can be undone. */
  readonly snapshot: () => readonly TRow[];
  /** Restores a previously captured snapshot, discarding everything written since. */
  readonly restore: (rows: readonly TRow[]) => void;
}

/**
 * The in-process analogue of a `SERIALIZABLE` transaction, used by the
 * in-memory stores.
 *
 * It takes the strictest possible reading — bodies run strictly one at a time,
 * via a promise chain — because an in-memory store has no snapshot isolation to
 * emulate and a *stricter* fake cannot let a race through that PostgreSQL would
 * have caught. A failed body is undone from the snapshot, so partial writes
 * never survive, matching rollback.
 *
 * Being stricter also means it never produces a serialization abort, so it can
 * never demonstrate that the retry path works: that is exercised separately
 * against a fake runner, and against live PostgreSQL in
 * `budget-postgres-concurrency.test.ts`. An in-memory pass is not evidence
 * about PostgreSQL concurrency (CLAUDE.md, AAMP-1 step 3).
 */
export function createSerializedBudgetTransactionRunner<TRow>(
  options: SerializedBudgetTransactionRunnerOptions<TRow>,
): BudgetTransactionRunner {
  let queue: Promise<unknown> = Promise.resolve();

  return {
    runSerializable<T>(work: (tx: BudgetDataSource) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const before = options.snapshot();
        try {
          return await work(options.dataSource);
        } catch (error) {
          options.restore(before);
          throw error;
        }
      });
      // The chain must advance even when this body threw, or one failure would
      // wedge every later transaction behind a rejected promise.
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
