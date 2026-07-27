import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaBudgetTransactionRunner } from '../prisma-budget-transaction';
import {
  chargeBudget,
  computeSpentCents,
  getBudgetStatus,
  releaseBudget,
  reserveBudgetAcrossScopes,
  settleBudgetReservation,
  type BudgetDataSource,
  type BudgetLedgerEntryRecord,
  type BudgetPolicyRecord,
  type BudgetScope,
} from './budget-repository';
import type {
  BudgetTransactionFailureKind,
  SerializableBudgetDataSource,
} from './budget-transaction';

/**
 * AAMP-1 step 3 — the acceptance evidence, against a live PostgreSQL.
 *
 * Everything else in this package proves *policy*: which failures retry, what a
 * refusal writes, how the ledger nets out. None of it can prove that two
 * genuinely simultaneous dispatches cannot both observe the same headroom,
 * because the in-memory store has no snapshot isolation to get wrong — its
 * runner serializes strictly, which is a *stricter* fake than the real thing
 * and therefore no evidence at all. Only this file exercises PostgreSQL's
 * serializable snapshot isolation, real connections, real conflicts and real
 * `40001` aborts.
 *
 * Opt-in, and skipped loudly otherwise, because CI has no database:
 *
 *   docker compose -f infrastructure/docker-compose.yml up -d postgres
 *   pnpm --filter @combat/database test:postgres
 *
 * It creates its own `Workspace` rows and deletes them afterwards. It never
 * truncates a table, resets the database or touches a row it did not create.
 */

const ENABLED = process.env.BUDGET_POSTGRES_INTEGRATION === '1';
const DATABASE_URL = process.env.DATABASE_URL;

if (!ENABLED) {
  // eslint-disable-next-line no-console -- a silent skip here would read as a pass
  console.warn(
    '[budget-postgres-concurrency] SKIPPED: set BUDGET_POSTGRES_INTEGRATION=1 and DATABASE_URL to run this against a live PostgreSQL.',
  );
}

/**
 * A pool wide enough that the burst below is genuinely simultaneous. Prisma
 * defaults to `cpus * 2 + 1`; with fewer connections than racers the test would
 * still pass, but it would be measuring queueing rather than conflict.
 */
function testClient(): PrismaClient {
  const url = new URL(DATABASE_URL ?? '');
  url.searchParams.set('connection_limit', '30');
  url.searchParams.set('pool_timeout', '30');
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

describe.skipIf(!ENABLED || !DATABASE_URL)('budget reservations against live PostgreSQL', () => {
  let prisma: PrismaClient;
  let db: SerializableBudgetDataSource;
  const createdWorkspaceIds: string[] = [];

  /** The non-transactional half of the data source — what charge/release/status use outside a reservation. */
  function directDataSource(client: PrismaClient): BudgetDataSource {
    return {
      budgetPolicy: {
        findFirst: async (args) =>
          (await client.budgetPolicy.findFirst({
            where: args.where,
          })) as BudgetPolicyRecord | null,
      },
      budgetLedgerEntry: {
        findMany: async (args) =>
          (await client.budgetLedgerEntry.findMany({
            where: args.where,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })) as BudgetLedgerEntryRecord[],
        findFirst: async (args) =>
          (await client.budgetLedgerEntry.findFirst({
            where: args.where,
          })) as BudgetLedgerEntryRecord | null,
        create: async (args) =>
          (await client.budgetLedgerEntry.create({ data: args.data })) as BudgetLedgerEntryRecord,
      },
    };
  }

  beforeAll(async () => {
    prisma = testClient();
    await prisma.$connect();
    db = {
      ...directDataSource(prisma),
      budgetTransaction: createPrismaBudgetTransactionRunner(prisma),
    };
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  afterEach(async () => {
    // Cascades to budget_policies and budget_ledger_entries. Only rows this
    // suite created are ever named.
    if (createdWorkspaceIds.length > 0) {
      await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
      createdWorkspaceIds.length = 0;
    }
  });

  async function seedWorkspace(): Promise<string> {
    const id = randomUUID();
    await prisma.workspace.create({
      data: { id, name: `budget-concurrency-${id}`, slug: `budget-concurrency-${id}` },
    });
    createdWorkspaceIds.push(id);
    return id;
  }

  async function seedPolicy(
    workspaceId: string,
    level: BudgetScope['level'],
    scopeId: string,
    limitCents: number,
  ): Promise<string> {
    const policy = await prisma.budgetPolicy.create({
      data: { workspaceId, level, scopeId, limitCents },
    });
    return policy.id;
  }

  /**
   * PostgreSQL's own deadlock tally for this database. Read-only, and the only
   * way to tell a serializable conflict from a deadlock through Prisma, which
   * collapses both into P2034.
   */
  async function countDeadlocks(): Promise<number> {
    const rows = await prisma.$queryRaw<{ deadlocks: bigint }[]>`
      SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()
    `;
    return Number(rows[0]?.deadlocks ?? 0n);
  }

  function retryRecorder() {
    const kinds: BudgetTransactionFailureKind[] = [];
    return {
      kinds,
      options: {
        maxAttempts: 40,
        onRetry: (_attempt: number, kind: BudgetTransactionFailureKind) => {
          kinds.push(kind);
        },
      },
    };
  }

  it('a burst of concurrent distinct-key reservations never exceeds the limit', async () => {
    const workspaceId = await seedWorkspace();
    const policyId = await seedPolicy(workspaceId, 'WORKSPACE', workspaceId, 1_000);
    const recorder = retryRecorder();
    const RACERS = 20;
    const AMOUNT = 250; // exactly four of twenty may win

    const results = await Promise.all(
      Array.from({ length: RACERS }, (_, i) =>
        reserveBudgetAcrossScopes(
          db,
          {
            workspaceId,
            scopes: [{ level: 'WORKSPACE', scopeId: workspaceId }],
            requiredCents: AMOUNT,
            idempotencyKey: `burst-${i}`,
          },
          recorder.options,
        ),
      ),
    );

    const accepted = results.filter((result) => result.ok);
    expect(accepted).toHaveLength(4);

    const status = await getBudgetStatus(db, workspaceId, 'WORKSPACE', workspaceId);
    expect(status!.spentCents).toBe(accepted.length * AMOUNT);
    expect(status!.spentCents).toBeLessThanOrEqual(status!.limitCents);
    expect(status!.remainingCents).toBeGreaterThanOrEqual(0);

    const rows = await prisma.budgetLedgerEntry.findMany({ where: { budgetPolicyId: policyId } });
    // Every row is a RESERVATION: nothing was written and then compensated.
    expect(rows.map((row) => row.entryType)).toEqual(
      Array.from({ length: 4 }, () => 'RESERVATION'),
    );

    // Contention is expected here and must have been absorbed by the retry
    // loop, not surfaced. Reported rather than asserted as a fixed number:
    // how many aborts occur depends on the machine.
    // eslint-disable-next-line no-console -- the observed retry profile is the point of this test
    console.info(
      `[budget-postgres-concurrency] ${RACERS} racers → ${recorder.kinds.length} retried attempt(s): ` +
        JSON.stringify(
          recorder.kinds.reduce<Record<string, number>>(
            (counts, kind) => ({ ...counts, [kind]: (counts[kind] ?? 0) + 1 }),
            {},
          ),
        ),
    );
    expect(recorder.kinds).not.toContain('NOT_RETRYABLE');
  });

  it('concurrent retries of the SAME key produce exactly one reservation and one result', async () => {
    const workspaceId = await seedWorkspace();
    const policyId = await seedPolicy(workspaceId, 'WORKSPACE', workspaceId, 10_000);
    const recorder = retryRecorder();

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        reserveBudgetAcrossScopes(
          db,
          {
            workspaceId,
            scopes: [{ level: 'WORKSPACE', scopeId: workspaceId }],
            requiredCents: 700,
            idempotencyKey: 'one-and-only',
          },
          recorder.options,
        ),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const reservationIds = new Set(
      results.flatMap((result) =>
        result.ok ? result.reservations.map((r) => r.reservation.id) : [],
      ),
    );
    expect(reservationIds.size).toBe(1);

    const rows = await prisma.budgetLedgerEntry.findMany({ where: { budgetPolicyId: policyId } });
    expect(rows).toHaveLength(1);
    expect(computeSpentCents(rows as BudgetLedgerEntryRecord[])).toBe(700);
  });

  it('workspace, campaign, provider and shot policies each enforce their own limit', async () => {
    const workspaceId = await seedWorkspace();
    const campaignId = randomUUID();
    const shotId = randomUUID();
    const providerId = `provider-${randomUUID()}`;
    const scopes: BudgetScope[] = [
      { level: 'WORKSPACE', scopeId: workspaceId },
      { level: 'CAMPAIGN', scopeId: campaignId },
      { level: 'PROVIDER', scopeId: providerId },
      { level: 'SHOT', scopeId: shotId },
    ];

    for (const scope of scopes) {
      // The SHOT policy is the tight one; the rest are generous.
      // eslint-disable-next-line no-await-in-loop -- fixture setup
      await seedPolicy(
        workspaceId,
        scope.level,
        scope.scopeId,
        scope.level === 'SHOT' ? 400 : 50_000,
      );
    }

    const accepted = await reserveBudgetAcrossScopes(db, {
      workspaceId,
      scopes,
      requiredCents: 400,
      idempotencyKey: 'fits-everywhere',
      campaignId,
      shotId,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.reservations).toHaveLength(4);

    // The shot policy is now exhausted; the other three still have room.
    const refused = await reserveBudgetAcrossScopes(db, {
      workspaceId,
      scopes,
      requiredCents: 400,
      idempotencyKey: 'shot-exhausted',
      campaignId,
      shotId,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.level).toBe('SHOT');

    // And the refusal wrote nothing at the three levels that would have fitted.
    for (const scope of scopes) {
      // eslint-disable-next-line no-await-in-loop -- assertion loop over four levels
      const status = await getBudgetStatus(db, workspaceId, scope.level, scope.scopeId);
      expect(status!.spentCents).toBe(400);
    }
  });

  it('opposing scope orders converge on one lock order instead of deadlocking', async () => {
    const workspaceId = await seedWorkspace();
    const campaignId = randomUUID();
    await seedPolicy(workspaceId, 'WORKSPACE', workspaceId, 100_000);
    await seedPolicy(workspaceId, 'CAMPAIGN', campaignId, 100_000);
    const recorder = retryRecorder();
    // Prisma reports every serializable abort as P2034 without distinguishing
    // 40001 from 40P01, so the retry kinds cannot tell a conflict from a
    // deadlock. PostgreSQL's own counter can, and it is the binding
    // measurement here.
    const deadlocksBefore = await countDeadlocks();

    const forward: BudgetScope[] = [
      { level: 'WORKSPACE', scopeId: workspaceId },
      { level: 'CAMPAIGN', scopeId: campaignId },
    ];
    const reversed = [...forward].reverse();

    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        reserveBudgetAcrossScopes(
          db,
          {
            workspaceId,
            // Half the callers declare their scopes in the opposite order —
            // which is exactly how a hold-and-wait deadlock is provoked when
            // each transaction locks in the order it was handed.
            scopes: i % 2 === 0 ? forward : reversed,
            requiredCents: 100,
            idempotencyKey: `ordered-${i}`,
            campaignId,
          },
          recorder.options,
        ),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(recorder.kinds).not.toContain('DEADLOCK_DETECTED');
    expect(await countDeadlocks()).toBe(deadlocksBefore);

    const workspaceStatus = await getBudgetStatus(db, workspaceId, 'WORKSPACE', workspaceId);
    const campaignStatus = await getBudgetStatus(db, workspaceId, 'CAMPAIGN', campaignId);
    expect(workspaceStatus!.spentCents).toBe(1_600);
    expect(campaignStatus!.spentCents).toBe(1_600);
  });

  it('resolves a same-key race within the default retry bound', async () => {
    const workspaceId = await seedWorkspace();
    await seedPolicy(workspaceId, 'WORKSPACE', workspaceId, 100_000);

    // No maxAttempts override: this is the production bound.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        reserveBudgetAcrossScopes(db, {
          workspaceId,
          scopes: [{ level: 'WORKSPACE', scopeId: workspaceId }],
          requiredCents: 250,
          idempotencyKey: 'default-bound',
        }),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const status = await getBudgetStatus(db, workspaceId, 'WORKSPACE', workspaceId);
    expect(status!.spentCents).toBe(250);
  });

  it('absorbs realistic dispatch concurrency within the default retry bound', async () => {
    const workspaceId = await seedWorkspace();
    const campaignId = randomUUID();
    await seedPolicy(workspaceId, 'WORKSPACE', workspaceId, 1_000_000);
    await seedPolicy(workspaceId, 'CAMPAIGN', campaignId, 1_000_000);

    // One campaign's shots dispatching together — the realistic shape, at the
    // production bound with no override. Exhaustion would throw
    // `BudgetTransactionContentionError` and fail this outright, which is the
    // signal that the bound is too low for the load the system actually sees.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        reserveBudgetAcrossScopes(db, {
          workspaceId,
          scopes: [
            { level: 'WORKSPACE', scopeId: workspaceId },
            { level: 'CAMPAIGN', scopeId: campaignId },
          ],
          requiredCents: 500,
          idempotencyKey: `shot-${i}`,
          campaignId,
        }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(8);
    const status = await getBudgetStatus(db, workspaceId, 'CAMPAIGN', campaignId);
    expect(status!.spentCents).toBe(4_000);
  });

  it('settlement leaves spentCents equal to the actual cost, and repeats idempotently', async () => {
    const workspaceId = await seedWorkspace();
    const campaignId = randomUUID();
    const policyId = await seedPolicy(workspaceId, 'WORKSPACE', workspaceId, 10_000);

    const reserved = await reserveBudgetAcrossScopes(db, {
      workspaceId,
      scopes: [{ level: 'WORKSPACE', scopeId: workspaceId }],
      requiredCents: 1_000,
      idempotencyKey: 'settled-job',
      campaignId,
    });
    expect(reserved.ok).toBe(true);

    const settlement = {
      reservedCents: 1_000,
      actualCents: 640,
      reservationIdempotencyKey: 'settled-job',
      campaignId,
    };
    await settleBudgetReservation(db, policyId, workspaceId, settlement);
    // A retried Activity settles again; the unique key must absorb it.
    await settleBudgetReservation(db, policyId, workspaceId, settlement);
    await chargeBudget(db, policyId, workspaceId, {
      amountCents: 640,
      idempotencyKey: 'settled-job:charge',
      campaignId,
    });
    await releaseBudget(db, policyId, workspaceId, {
      amountCents: 1_000,
      idempotencyKey: 'settled-job:release',
      campaignId,
    });

    const rows = await prisma.budgetLedgerEntry.findMany({ where: { budgetPolicyId: policyId } });
    expect(rows.filter((row) => row.entryType === 'RESERVATION')).toHaveLength(1);
    expect(rows.filter((row) => row.entryType === 'CHARGE')).toHaveLength(1);
    expect(rows.filter((row) => row.entryType === 'RELEASE')).toHaveLength(1);

    const status = await getBudgetStatus(db, workspaceId, 'WORKSPACE', workspaceId);
    expect(status!.spentCents).toBe(640);
    expect(status!.remainingCents).toBe(9_360);
  });

  it('an Activity replay re-reserves nothing and re-charges nothing', async () => {
    const workspaceId = await seedWorkspace();
    const campaignId = randomUUID();
    const shotId = randomUUID();
    const policyId = await seedPolicy(workspaceId, 'WORKSPACE', workspaceId, 10_000);
    // The real key shape: (workflowRunId, stage, entityId, attempt).
    const idempotencyKey = `${randomUUID()}:GEN:${shotId}:1`;

    const dispatchTwice = async () =>
      reserveBudgetAcrossScopes(db, {
        workspaceId,
        scopes: [{ level: 'WORKSPACE', scopeId: workspaceId }],
        requiredCents: 800,
        idempotencyKey,
        campaignId,
        shotId,
        generationJobRef: idempotencyKey,
      });

    await dispatchTwice();
    await dispatchTwice();
    const settle = async () =>
      settleBudgetReservation(db, policyId, workspaceId, {
        reservedCents: 800,
        actualCents: 512,
        reservationIdempotencyKey: idempotencyKey,
        campaignId,
        shotId,
      });
    await settle();
    await settle();

    const rows = await prisma.budgetLedgerEntry.findMany({ where: { budgetPolicyId: policyId } });
    expect(rows).toHaveLength(3);
    const status = await getBudgetStatus(db, workspaceId, 'WORKSPACE', workspaceId);
    expect(status!.spentCents).toBe(512);
  });

  it('a cross-workspace reservation neither writes nor reveals that the policy exists', async () => {
    const ownerWorkspaceId = await seedWorkspace();
    const intruderWorkspaceId = await seedWorkspace();
    const ownerPolicyId = await seedPolicy(ownerWorkspaceId, 'WORKSPACE', ownerWorkspaceId, 1_000);

    // The intruder names the owner's scope id from its own workspace.
    const result = await reserveBudgetAcrossScopes(db, {
      workspaceId: intruderWorkspaceId,
      scopes: [{ level: 'WORKSPACE', scopeId: ownerWorkspaceId }],
      requiredCents: 999_999,
      idempotencyKey: 'intruder',
    });

    // Reported exactly as an unconfigured scope is: no policy, no reservation,
    // no error that would distinguish "not yours" from "not configured".
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reservations).toHaveLength(0);
      expect(result.uncappedScopes).toHaveLength(1);
    }
    expect(
      await getBudgetStatus(db, intruderWorkspaceId, 'WORKSPACE', ownerWorkspaceId),
    ).toBeNull();

    const ownerRows = await prisma.budgetLedgerEntry.findMany({
      where: { budgetPolicyId: ownerPolicyId },
    });
    expect(ownerRows).toHaveLength(0);
    const ownerStatus = await getBudgetStatus(db, ownerWorkspaceId, 'WORKSPACE', ownerWorkspaceId);
    expect(ownerStatus!.spentCents).toBe(0);
  });

  it('a failed dispatch releases its reservation exactly once, restoring the headroom', async () => {
    const workspaceId = await seedWorkspace();
    const policyId = await seedPolicy(workspaceId, 'WORKSPACE', workspaceId, 1_000);

    await reserveBudgetAcrossScopes(db, {
      workspaceId,
      scopes: [{ level: 'WORKSPACE', scopeId: workspaceId }],
      requiredCents: 900,
      idempotencyKey: 'doomed',
    });
    // The dispatch failed; both the failure handler and its retry release.
    await releaseBudget(db, policyId, workspaceId, {
      amountCents: 900,
      idempotencyKey: 'doomed:release',
    });
    await releaseBudget(db, policyId, workspaceId, {
      amountCents: 900,
      idempotencyKey: 'doomed:release',
    });

    const status = await getBudgetStatus(db, workspaceId, 'WORKSPACE', workspaceId);
    expect(status!.spentCents).toBe(0);
    expect(status!.remainingCents).toBe(1_000);

    // The freed headroom is genuinely available to the next dispatch.
    const next = await reserveBudgetAcrossScopes(db, {
      workspaceId,
      scopes: [{ level: 'WORKSPACE', scopeId: workspaceId }],
      requiredCents: 1_000,
      idempotencyKey: 'next',
    });
    expect(next.ok).toBe(true);
  });
});
