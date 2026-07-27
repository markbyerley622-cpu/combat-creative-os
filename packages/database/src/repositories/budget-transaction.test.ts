import { describe, expect, it, vi } from 'vitest';
import {
  BUDGET_TRANSACTION_MAX_ATTEMPTS,
  BudgetReservationRaceError,
  BudgetTransactionContentionError,
  classifyBudgetTransactionFailure,
  createSerializedBudgetTransactionRunner,
  isRetryableBudgetTransactionFailure,
  isUniqueConstraintViolation,
  runBudgetTransactionWithRetry,
  type BudgetTransactionRunner,
} from './budget-transaction';
import type { BudgetDataSource } from './budget-repository';

/**
 * AAMP-1 step 3 — the retry bound and its classification, exercised without a
 * database.
 *
 * These prove the *policy*: which failures are retried, how many times, and
 * what a caller sees when the bound is exhausted. They prove nothing about
 * PostgreSQL's serializable snapshot isolation itself — that is
 * `budget-postgres-concurrency.test.ts`, against a live database.
 */

const NEVER_CALLED: BudgetDataSource = {
  budgetPolicy: {
    findFirst: () => {
      throw new Error('unexpected read');
    },
  },
  budgetLedgerEntry: {
    findMany: () => {
      throw new Error('unexpected read');
    },
    findFirst: () => {
      throw new Error('unexpected read');
    },
    create: () => {
      throw new Error('unexpected write');
    },
  },
};

/** A runner whose transaction body always fails with `error`, counting attempts. */
function failingRunner(error: unknown): BudgetTransactionRunner & { attempts: () => number } {
  let attempts = 0;
  return {
    attempts: () => attempts,
    runSerializable: async () => {
      attempts += 1;
      throw error;
    },
  };
}

/** Keeps the retry-policy tests free of wall-clock delay; the default backoff is exercised separately. */
const immediately = async (): Promise<void> => undefined;

function postgresError(code: string): Error & { code: string } {
  return Object.assign(new Error(`postgres said ${code}`), { code });
}

describe('budget transaction — failure classification', () => {
  it('recognises a PostgreSQL serialization failure by SQLSTATE', () => {
    expect(classifyBudgetTransactionFailure(postgresError('40001'))).toBe('SERIALIZATION_FAILURE');
  });

  it('recognises a PostgreSQL deadlock by SQLSTATE', () => {
    expect(classifyBudgetTransactionFailure(postgresError('40P01'))).toBe('DEADLOCK_DETECTED');
  });

  it('recognises a SQLSTATE carried under Prisma`s meta', () => {
    const error = Object.assign(new Error('driver failure'), { meta: { code: '40001' } });
    expect(classifyBudgetTransactionFailure(error)).toBe('SERIALIZATION_FAILURE');
  });

  it('recognises Prisma P2034 as a write conflict or deadlock', () => {
    expect(classifyBudgetTransactionFailure(postgresError('P2034'))).toBe(
      'WRITE_CONFLICT_OR_DEADLOCK',
    );
  });

  it('recognises PostgreSQL`s own wording when only a message survives', () => {
    expect(
      classifyBudgetTransactionFailure(
        new Error('could not serialize access due to read/write dependencies among transactions'),
      ),
    ).toBe('SERIALIZATION_FAILURE');
    expect(classifyBudgetTransactionFailure(new Error('deadlock detected'))).toBe(
      'DEADLOCK_DETECTED',
    );
  });

  it('treats a lost idempotency-key race as retryable — the winner is invisible to this snapshot', () => {
    const race = new BudgetReservationRaceError('run-1:GEN:shot-1:1', postgresError('23505'));
    expect(classifyBudgetTransactionFailure(race)).toBe('UNIQUE_KEY_RACE');
    expect(isRetryableBudgetTransactionFailure('UNIQUE_KEY_RACE')).toBe(true);
  });

  it('classifies everything else as not retryable', () => {
    expect(classifyBudgetTransactionFailure(new Error('connection refused'))).toBe('NOT_RETRYABLE');
    expect(classifyBudgetTransactionFailure(postgresError('23503'))).toBe('NOT_RETRYABLE');
    expect(classifyBudgetTransactionFailure(undefined)).toBe('NOT_RETRYABLE');
    expect(isRetryableBudgetTransactionFailure('NOT_RETRYABLE')).toBe(false);
  });

  it('recognises a unique violation from either the SQLSTATE, Prisma`s code or the fakes` message', () => {
    expect(isUniqueConstraintViolation(postgresError('23505'))).toBe(true);
    expect(isUniqueConstraintViolation(postgresError('P2002'))).toBe(true);
    expect(
      isUniqueConstraintViolation(
        new Error('unique constraint violation on budget_ledger_entries (…)'),
      ),
    ).toBe(true);
    expect(isUniqueConstraintViolation(postgresError('40001'))).toBe(false);
  });
});

describe('budget transaction — bounded retry', () => {
  it('retries a serialization failure and returns the first success', async () => {
    let attempts = 0;
    const runner: BudgetTransactionRunner = {
      runSerializable: async (work) => {
        attempts += 1;
        if (attempts < 3) throw postgresError('40001');
        return work(NEVER_CALLED) as Promise<never>;
      },
    };
    const onRetry = vi.fn();

    const result = await runBudgetTransactionWithRetry(runner, async () => 'reserved', {
      onRetry,
      delayBeforeRetry: immediately,
    });

    expect(result).toBe('reserved');
    expect(attempts).toBe(3);
    expect(onRetry.mock.calls).toEqual([
      [1, 'SERIALIZATION_FAILURE'],
      [2, 'SERIALIZATION_FAILURE'],
    ]);
  });

  it('throws a typed contention error once the bound is exhausted, having tried exactly that many times', async () => {
    const runner = failingRunner(postgresError('40001'));

    await expect(
      runBudgetTransactionWithRetry(runner, async () => 'unreachable', {
        maxAttempts: 3,
        delayBeforeRetry: immediately,
      }),
    ).rejects.toBeInstanceOf(BudgetTransactionContentionError);
    expect(runner.attempts()).toBe(3);
  });

  it('reports the attempt count and last failure kind on the typed error', async () => {
    const runner = failingRunner(postgresError('40P01'));

    const error = await runBudgetTransactionWithRetry(runner, async () => 'unreachable', {
      maxAttempts: 2,
      delayBeforeRetry: immediately,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BudgetTransactionContentionError);
    const contention = error as BudgetTransactionContentionError;
    expect(contention.attempts).toBe(2);
    expect(contention.lastFailureKind).toBe('DEADLOCK_DETECTED');
    expect(contention.cause).toMatchObject({ code: '40P01' });
  });

  it('never retries a failure that is not contention — it propagates unchanged, first time', async () => {
    const fault = new Error('column does not exist');
    const runner = failingRunner(fault);

    await expect(
      runBudgetTransactionWithRetry(runner, async () => 'unreachable', {
        delayBeforeRetry: immediately,
      }),
    ).rejects.toBe(fault);
    expect(runner.attempts()).toBe(1);
  });

  it('defaults to the documented attempt bound, and to backing off between attempts', async () => {
    const runner = failingRunner(postgresError('40001'));

    // No `delayBeforeRetry`: this exercises the default jittered backoff, which
    // is what stops aborted transactions from re-colliding in lockstep.
    await expect(
      runBudgetTransactionWithRetry(runner, async () => 'unreachable'),
    ).rejects.toBeInstanceOf(BudgetTransactionContentionError);
    expect(runner.attempts()).toBe(BUDGET_TRANSACTION_MAX_ATTEMPTS);
  });

  it('calls the supplied backoff once per retry, never after the final attempt', async () => {
    const runner = failingRunner(postgresError('40001'));
    const delayBeforeRetry = vi.fn(immediately);

    await expect(
      runBudgetTransactionWithRetry(runner, async () => 'unreachable', {
        maxAttempts: 3,
        delayBeforeRetry,
      }),
    ).rejects.toBeInstanceOf(BudgetTransactionContentionError);
    expect(delayBeforeRetry.mock.calls).toEqual([[1], [2]]);
  });

  it('refuses a non-positive attempt bound rather than running zero attempts', async () => {
    const runner = failingRunner(postgresError('40001'));

    await expect(
      runBudgetTransactionWithRetry(runner, async () => 'unreachable', {
        maxAttempts: 0,
        delayBeforeRetry: immediately,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(runner.attempts()).toBe(0);
  });
});

describe('budget transaction — the in-process serialized runner', () => {
  function buildRunner() {
    const rows: string[] = [];
    const runner = createSerializedBudgetTransactionRunner({
      dataSource: NEVER_CALLED,
      snapshot: () => [...rows],
      restore: (restored) => {
        rows.length = 0;
        rows.push(...restored);
      },
    });
    return { rows, runner };
  }

  it('runs bodies strictly one at a time', async () => {
    const { runner } = buildRunner();
    const observed: string[] = [];

    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runner.runSerializable(async () => {
          observed.push(`${id}:enter`);
          await Promise.resolve();
          observed.push(`${id}:exit`);
        }),
      ),
    );

    expect(observed).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit', 'c:enter', 'c:exit']);
  });

  it('undoes everything a failed body wrote', async () => {
    const { rows, runner } = buildRunner();
    await runner.runSerializable(async () => {
      rows.push('committed');
    });

    await expect(
      runner.runSerializable(async () => {
        rows.push('partial');
        throw new Error('refused after writing');
      }),
    ).rejects.toThrow('refused after writing');

    expect(rows).toEqual(['committed']);
  });

  it('keeps serving later transactions after one fails', async () => {
    const { rows, runner } = buildRunner();

    await expect(
      runner.runSerializable(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await runner.runSerializable(async () => {
      rows.push('after');
    });

    expect(rows).toEqual(['after']);
  });
});
