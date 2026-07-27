import type { PrismaClient } from '@prisma/client';
import type {
  BudgetDataSource,
  BudgetLedgerEntryRecord,
  BudgetPolicyRecord,
} from './repositories/budget-repository';
import type { BudgetTransactionRunner } from './repositories/budget-transaction';

/**
 * The PostgreSQL implementation of the budget transaction seam (AAMP-1
 * step 3).
 *
 * This file, `client.ts` and `prisma-*` adapters are the only places in
 * `packages/database` that know Prisma exists; the repository layer is written
 * against the narrow `*DataSource` interfaces and stays vendor-neutral.
 */

/** Prisma returns `null` for a nullable column; the record types declare those fields optional. */
function toPolicyRecord(row: {
  id: string;
  workspaceId: string;
  level: BudgetPolicyRecord['level'];
  scopeId: string;
  limitCents: number;
}): BudgetPolicyRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    level: row.level,
    scopeId: row.scopeId,
    limitCents: row.limitCents,
  };
}

function toLedgerEntryRecord(row: {
  id: string;
  workspaceId: string;
  budgetPolicyId: string;
  entryType: BudgetLedgerEntryRecord['entryType'];
  amountCents: number;
  idempotencyKey: string;
  campaignId: string | null;
  shotId: string | null;
  generationJobRef: string | null;
  createdAt: Date;
}): BudgetLedgerEntryRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    budgetPolicyId: row.budgetPolicyId,
    entryType: row.entryType,
    amountCents: row.amountCents,
    idempotencyKey: row.idempotencyKey,
    ...(row.campaignId === null ? {} : { campaignId: row.campaignId }),
    ...(row.shotId === null ? {} : { shotId: row.shotId }),
    ...(row.generationJobRef === null ? {} : { generationJobRef: row.generationJobRef }),
    createdAt: row.createdAt,
  };
}

/**
 * The delegates of an interactive Prisma transaction, as this module uses them.
 *
 * `Prisma.TransactionClient` is `PrismaClient` minus the `$`-methods, so this
 * alias exists only to name the callback parameter without importing the
 * generated `Prisma` namespace.
 */
type BudgetTransactionClient = Pick<PrismaClient, 'budgetPolicy' | 'budgetLedgerEntry'>;

function budgetDataSourceOf(tx: BudgetTransactionClient): BudgetDataSource {
  return {
    budgetPolicy: {
      findFirst: async (args) => {
        const row = await tx.budgetPolicy.findFirst({ where: args.where });
        return row === null ? null : toPolicyRecord(row);
      },
    },
    budgetLedgerEntry: {
      findMany: async (args) => {
        const rows = await tx.budgetLedgerEntry.findMany({
          where: args.where,
          // Deterministic order so `computeSpentCents` sees the ledger in the
          // order it was written, whatever plan PostgreSQL picks.
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        return rows.map(toLedgerEntryRecord);
      },
      findFirst: async (args) => {
        const row = await tx.budgetLedgerEntry.findFirst({ where: args.where });
        return row === null ? null : toLedgerEntryRecord(row);
      },
      create: async (args) => toLedgerEntryRecord(await tx.budgetLedgerEntry.create(args)),
    },
  };
}

export interface PrismaBudgetTransactionOptions {
  /**
   * Milliseconds to wait for a free connection before giving up. Raised well
   * above Prisma's 2 s default because a burst of concurrent dispatches queues
   * on the pool, and a pool-wait timeout there would surface as a hard failure
   * rather than the retryable conflict it actually is.
   */
  readonly maxWaitMs?: number;
  /** Milliseconds a single transaction attempt may run before PostgreSQL rolls it back. */
  readonly timeoutMs?: number;
}

const DEFAULT_MAX_WAIT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Builds the `SERIALIZABLE` transaction runner budget reservation requires.
 *
 * `SERIALIZABLE` and not `REPEATABLE READ`: the reservation decision is a
 * read-then-write over an *aggregate* (the ledger sum), and only serializable
 * snapshot isolation detects that two transactions read the same set and each
 * wrote a row that invalidates the other's read. Repeatable read would let both
 * commit, which is exactly the over-commitment this replaces.
 */
export function createPrismaBudgetTransactionRunner(
  prisma: PrismaClient,
  options: PrismaBudgetTransactionOptions = {},
): BudgetTransactionRunner {
  return {
    runSerializable: async <T>(work: (tx: BudgetDataSource) => Promise<T>): Promise<T> =>
      prisma.$transaction(async (tx) => work(budgetDataSourceOf(tx)), {
        isolationLevel: 'Serializable',
        maxWait: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }),
  };
}
