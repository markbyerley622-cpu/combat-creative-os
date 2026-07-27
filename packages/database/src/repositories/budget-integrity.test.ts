import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';
import {
  InvalidBudgetRequestError,
  chargeBudget,
  checkAndReserveBudget,
  getBudgetStatus,
  releaseBudget,
  reserveBudgetAcrossScopes,
  settleBudgetReservation,
  type BudgetScope,
} from './budget-repository';

/**
 * M14 — budget integrity under concurrency.
 *
 * The ledger is append-only and every amount is derived from it, so the risks
 * are all about *ordering*: two dispatches racing the same headroom, a retried
 * dispatch reserving twice, or a failed dispatch leaving a reservation behind
 * that permanently sterilises budget. These tests drive those races
 * deterministically with `Promise.all` over the in-memory store, which
 * interleaves at exactly the same `await` points the Prisma adapter does.
 */

function seedPolicy(store: InMemoryCampaignStore, limitCents: number) {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const policyId = randomUUID();
  store.budgetPolicies.push({
    id: policyId,
    workspaceId,
    level: 'WORKSPACE',
    scopeId: workspaceId,
    limitCents,
  });
  return { workspaceId, campaignId, policyId };
}

function reserve(
  store: InMemoryCampaignStore,
  ctx: { workspaceId: string; campaignId: string },
  requiredCents: number,
  idempotencyKey: string,
) {
  return checkAndReserveBudget(store, {
    workspaceId: ctx.workspaceId,
    level: 'WORKSPACE',
    scopeId: ctx.workspaceId,
    requiredCents,
    idempotencyKey,
    campaignId: ctx.campaignId,
  });
}

describe('budget integrity — concurrent reservations cannot exceed the limit', () => {
  it('two simultaneous reservations that would both fit alone cannot both succeed', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 1_000);

    // Each needs 600 of a 1,000 limit — exactly one may win.
    const [a, b] = await Promise.all([
      reserve(store, ctx, 600, 'dispatch-a'),
      reserve(store, ctx, 600, 'dispatch-b'),
    ]);

    const succeeded = [a, b].filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);

    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBe(600);
    expect(status!.spentCents).toBeLessThanOrEqual(status!.limitCents);
  });

  it('a burst of concurrent reservations never over-commits the limit', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 1_000);

    // Ten racers at 250 each against a 1,000 limit — at most four may win.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => reserve(store, ctx, 250, `dispatch-${i}`)),
    );

    const succeeded = results.filter((r) => r.ok);
    expect(succeeded.length).toBeLessThanOrEqual(4);

    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBeLessThanOrEqual(1_000);
    expect(status!.remainingCents).toBeGreaterThanOrEqual(0);
  });

  it('a reservation that exactly consumes the remaining headroom is allowed', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 1_000);

    const first = await reserve(store, ctx, 400, 'a');
    const second = await reserve(store, ctx, 600, 'b');

    expect(first.ok && second.ok).toBe(true);
    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.remainingCents).toBe(0);
  });

  it('rejects the reservation that would cross the limit and leaves no ledger row behind', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 1_000);
    await reserve(store, ctx, 900, 'a');

    const rejected = await reserve(store, ctx, 200, 'b');

    expect(rejected.ok).toBe(false);
    // The rejected attempt must not leave a reservation that sterilises budget.
    expect(store.budgetLedgerEntries.filter((e) => e.idempotencyKey === 'b')).toHaveLength(0);
    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBe(900);
  });
});

describe('budget integrity — idempotency', () => {
  it('a duplicate idempotency key never double-reserves', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 10_000);

    const first = await reserve(store, ctx, 500, 'same-key');
    const second = await reserve(store, ctx, 500, 'same-key');

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.reservation!.id).toBe(first.reservation!.id);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'RESERVATION')).toHaveLength(1);
  });

  it('concurrent retries of the SAME key reserve exactly once', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 10_000);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserve(store, ctx, 500, 'retried-dispatch')),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'RESERVATION')).toHaveLength(1);
    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBe(500);
  });

  it('a retried charge on the same key resolves to the first row instead of throwing', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 10_000);
    await reserve(store, ctx, 500, 'k');

    const first = await chargeBudget(store, ctx.policyId, ctx.workspaceId, {
      amountCents: 480,
      idempotencyKey: 'k:charge',
      campaignId: ctx.campaignId,
    });
    // An Activity retry re-runs settlement from the top. The unique constraint
    // is the authority on which write won, and the retry resolves to it rather
    // than crashing the Activity mid-settlement (post-M14 audit finding C-2).
    const retried = await chargeBudget(store, ctx.policyId, ctx.workspaceId, {
      amountCents: 480,
      idempotencyKey: 'k:charge',
      campaignId: ctx.campaignId,
    });

    expect(retried.id).toBe(first.id);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'CHARGE')).toHaveLength(1);
  });

  it('concurrent retries of the SAME charge key write exactly one row', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 10_000);
    await reserve(store, ctx, 500, 'k');

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        chargeBudget(store, ctx.policyId, ctx.workspaceId, {
          amountCents: 480,
          idempotencyKey: 'k:charge',
          campaignId: ctx.campaignId,
        }),
      ),
    );

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'CHARGE')).toHaveLength(1);
  });
});

describe('budget integrity — reconciliation after dispatch outcomes', () => {
  it('a failed dispatch releases its reservation, restoring the headroom', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 1_000);
    await reserve(store, ctx, 900, 'doomed');

    await releaseBudget(store, ctx.policyId, ctx.workspaceId, {
      amountCents: 900,
      idempotencyKey: 'doomed:release',
      campaignId: ctx.campaignId,
    });

    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBe(0);
    // The freed headroom is genuinely reusable.
    const next = await reserve(store, ctx, 900, 'retry');
    expect(next.ok).toBe(true);
  });

  /**
   * Post-M14 audit finding C-2. This test previously asserted 1,400 for a job
   * that really cost 700: it released only the `estimated − actual` remainder,
   * so the RESERVATION row stayed on the ledger beside its CHARGE and both
   * were counted. The invariant is now stated directly — once a job settles,
   * `spentCents` equals what the provider actually charged.
   */
  it('one successful job leaves spentCents equal to the actual provider cost', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 10_000);
    await reserve(store, ctx, 1_000, 'k');

    // Actual usage came in under the estimate.
    await settleBudgetReservation(store, ctx.policyId, ctx.workspaceId, {
      reservedCents: 1_000,
      actualCents: 700,
      reservationIdempotencyKey: 'k',
      campaignId: ctx.campaignId,
    });

    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBe(700);
    expect(status!.remainingCents).toBe(9_300);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'CHARGE')).toHaveLength(1);
  });

  it('an over-estimate does not sterilise the headroom it never used', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 1_000);
    await reserve(store, ctx, 900, 'k');

    await settleBudgetReservation(store, ctx.policyId, ctx.workspaceId, {
      reservedCents: 900,
      actualCents: 100,
      reservationIdempotencyKey: 'k',
      campaignId: ctx.campaignId,
    });

    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBe(100);
    // The 800 reserved but never spent is genuinely reusable.
    const next = await reserve(store, ctx, 850, 'next');
    expect(next.ok).toBe(true);
  });

  it('an under-estimate settles to the higher actual cost, not to the estimate', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 10_000);
    await reserve(store, ctx, 500, 'k');

    // The provider came in over the estimate, so there is no remainder to
    // release — precisely the case the old remainder-only logic left
    // permanently uncorrected.
    await settleBudgetReservation(store, ctx.policyId, ctx.workspaceId, {
      reservedCents: 500,
      actualCents: 800,
      reservationIdempotencyKey: 'k',
      campaignId: ctx.campaignId,
    });

    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBe(800);
  });

  it('a retried settlement neither charges nor releases twice', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 10_000);
    await reserve(store, ctx, 1_000, 'k');
    // The same key replayed: a duplicate reservation attempt, then repeated
    // settlement runs as an Activity retry after a mid-settlement crash does.
    await reserve(store, ctx, 1_000, 'k');

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential replay is the point
      await settleBudgetReservation(store, ctx.policyId, ctx.workspaceId, {
        reservedCents: 1_000,
        actualCents: 700,
        reservationIdempotencyKey: 'k',
        campaignId: ctx.campaignId,
      });
    }

    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBe(700);
    expect(store.budgetLedgerEntries).toHaveLength(3);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'RESERVATION')).toHaveLength(1);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'CHARGE')).toHaveLength(1);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'RELEASE')).toHaveLength(1);
  });

  it('a settled job frees exactly its unspent reservation for a concurrent job', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 1_000);

    // Two distinct jobs each reserve 500 — the cap is exactly consumed.
    const [a, b] = await Promise.all([
      reserve(store, ctx, 500, 'job-a'),
      reserve(store, ctx, 500, 'job-b'),
    ]);
    expect(a!.ok && b!.ok).toBe(true);
    const blocked = await reserve(store, ctx, 1, 'job-c');
    expect(blocked.ok).toBe(false);

    // Job A completes for 100. Only its unspent 400 comes back.
    await settleBudgetReservation(store, ctx.policyId, ctx.workspaceId, {
      reservedCents: 500,
      actualCents: 100,
      reservationIdempotencyKey: 'job-a',
      campaignId: ctx.campaignId,
    });

    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBe(600);
    expect(status!.remainingCents).toBe(400);
    const nowFits = await reserve(store, ctx, 400, 'job-c-retry');
    expect(nowFits.ok).toBe(true);
    const stillTooBig = await reserve(store, ctx, 1, 'job-d');
    expect(stillTooBig.ok).toBe(false);
  });

  it('a provider failure after dispatch leaves no charge and no reservation', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 1_000);
    await reserve(store, ctx, 900, 'k');

    // The failure path releases the reservation and writes no CHARGE at all.
    await releaseBudget(store, ctx.policyId, ctx.workspaceId, {
      amountCents: 900,
      idempotencyKey: 'k:release',
      campaignId: ctx.campaignId,
    });

    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    expect(status!.spentCents).toBe(0);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'CHARGE')).toHaveLength(0);
  });

  it('a rejected reservation produces no ledger row of any type', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 100);

    const rejected = await reserve(store, ctx, 500, 'too-big');

    expect(rejected.ok).toBe(false);
    expect(store.budgetLedgerEntries).toHaveLength(0);
  });
});

describe('budget integrity — tenant isolation', () => {
  it('one workspace budget is invisible to another', async () => {
    const store = new InMemoryCampaignStore();
    const a = seedPolicy(store, 1_000);
    const b = seedPolicy(store, 1_000);
    await reserve(store, a, 900, 'a-spend');

    // B's status is unaffected by A's spend.
    const bStatus = await getBudgetStatus(store, b.workspaceId, 'WORKSPACE', b.workspaceId);
    expect(bStatus!.spentCents).toBe(0);
    expect(bStatus!.remainingCents).toBe(1_000);

    // And A's policy is not reachable under B's workspace id.
    const missing = await getBudgetStatus(store, b.workspaceId, 'WORKSPACE', a.workspaceId);
    expect(missing ?? undefined).toBeUndefined();
  });

  it('exhausting one workspace budget never blocks another', async () => {
    const store = new InMemoryCampaignStore();
    const a = seedPolicy(store, 100);
    const b = seedPolicy(store, 10_000);
    await reserve(store, a, 100, 'a-full');

    const aBlocked = await reserve(store, a, 50, 'a-next');
    const bFine = await reserve(store, b, 5_000, 'b-next');

    expect(aBlocked.ok).toBe(false);
    expect(bFine.ok).toBe(true);
  });

  it('workspace and campaign budgets settle independently for the same job', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignA = randomUUID();
    const campaignB = randomUUID();
    const workspacePolicyId = randomUUID();
    const campaignAPolicyId = randomUUID();
    const campaignBPolicyId = randomUUID();
    store.budgetPolicies.push(
      {
        id: workspacePolicyId,
        workspaceId,
        level: 'WORKSPACE',
        scopeId: workspaceId,
        limitCents: 10_000,
      },
      {
        id: campaignAPolicyId,
        workspaceId,
        level: 'CAMPAIGN',
        scopeId: campaignA,
        limitCents: 5_000,
      },
      {
        id: campaignBPolicyId,
        workspaceId,
        level: 'CAMPAIGN',
        scopeId: campaignB,
        limitCents: 5_000,
      },
    );

    // One job in campaign A reserves and settles at both applicable levels,
    // exactly as a dispatch/poll Activity pair does.
    for (const [level, scopeId] of [
      ['WORKSPACE', workspaceId],
      ['CAMPAIGN', campaignA],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- ledger writes are sequential by design
      await checkAndReserveBudget(store, {
        workspaceId,
        level,
        scopeId,
        requiredCents: 1_000,
        idempotencyKey: 'job',
        campaignId: campaignA,
      });
    }
    for (const policyId of [workspacePolicyId, campaignAPolicyId]) {
      // eslint-disable-next-line no-await-in-loop -- same rationale
      await settleBudgetReservation(store, policyId, workspaceId, {
        reservedCents: 1_000,
        actualCents: 640,
        reservationIdempotencyKey: 'job',
        campaignId: campaignA,
      });
    }

    const workspaceStatus = await getBudgetStatus(store, workspaceId, 'WORKSPACE', workspaceId);
    const aStatus = await getBudgetStatus(store, workspaceId, 'CAMPAIGN', campaignA);
    const bStatus = await getBudgetStatus(store, workspaceId, 'CAMPAIGN', campaignB);

    // The spend lands once on each applicable level and nowhere else — the
    // workspace roll-up is not double-counted, and campaign B is untouched.
    expect(workspaceStatus!.spentCents).toBe(640);
    expect(aStatus!.spentCents).toBe(640);
    expect(bStatus!.spentCents).toBe(0);
    expect(bStatus!.remainingCents).toBe(5_000);
  });

  it('an uncapped scope (no policy) reserves without creating a ledger row', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();

    const result = await checkAndReserveBudget(store, {
      workspaceId,
      level: 'WORKSPACE',
      scopeId: workspaceId,
      requiredCents: 1_000_000,
      idempotencyKey: 'uncapped',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy).toBeUndefined();
    expect(store.budgetLedgerEntries).toHaveLength(0);
  });
});

/**
 * AAMP-1 step 3 — the multi-level reservation, which is now one decision rather
 * than a loop of independent ones. These run against the in-memory store, whose
 * runner serializes strictly; the PostgreSQL behaviour they mirror is proven in
 * `budget-postgres-concurrency.test.ts`.
 */
describe('budget integrity — atomic reservation across competing levels', () => {
  function seedLevels(store: InMemoryCampaignStore, limits: Record<string, number>) {
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const shotId = randomUUID();
    const providerId = 'provider-x';
    const scopes: BudgetScope[] = [
      { level: 'WORKSPACE', scopeId: workspaceId },
      { level: 'CAMPAIGN', scopeId: campaignId },
      { level: 'SHOT', scopeId: shotId },
      { level: 'PROVIDER', scopeId: providerId },
    ];
    for (const scope of scopes) {
      const limitCents = limits[scope.level];
      if (limitCents === undefined) continue;
      store.budgetPolicies.push({
        id: randomUUID(),
        workspaceId,
        level: scope.level,
        scopeId: scope.scopeId,
        limitCents,
      });
    }
    return { workspaceId, campaignId, shotId, providerId, scopes };
  }

  it('reserves at every configured level and reports the unconfigured ones as uncapped', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedLevels(store, { WORKSPACE: 10_000, CAMPAIGN: 10_000 });

    const result = await reserveBudgetAcrossScopes(store, {
      workspaceId: ctx.workspaceId,
      scopes: ctx.scopes,
      requiredCents: 900,
      idempotencyKey: 'job-1',
      campaignId: ctx.campaignId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reservations.map((r) => r.level).sort()).toEqual(['CAMPAIGN', 'WORKSPACE']);
    expect(result.uncappedScopes.map((s) => s.level).sort()).toEqual(['PROVIDER', 'SHOT']);
    expect(store.budgetLedgerEntries).toHaveLength(2);
  });

  it.each(['WORKSPACE', 'CAMPAIGN', 'SHOT', 'PROVIDER'] as const)(
    'a %s policy with no headroom refuses the whole reservation and writes nothing anywhere',
    async (tightLevel) => {
      const store = new InMemoryCampaignStore();
      const ctx = seedLevels(store, {
        WORKSPACE: 10_000,
        CAMPAIGN: 10_000,
        SHOT: 10_000,
        PROVIDER: 10_000,
        [tightLevel]: 100,
      });

      const result = await reserveBudgetAcrossScopes(store, {
        workspaceId: ctx.workspaceId,
        scopes: ctx.scopes,
        requiredCents: 500,
        idempotencyKey: 'job-1',
        campaignId: ctx.campaignId,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.level).toBe(tightLevel);
      // The defining property: no level was left holding a reservation that a
      // compensating RELEASE would have had to unwind.
      expect(store.budgetLedgerEntries).toHaveLength(0);
    },
  );

  it('a replayed key resolves to the same reservations without writing new rows', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedLevels(store, { WORKSPACE: 10_000, CAMPAIGN: 10_000 });
    const request = {
      workspaceId: ctx.workspaceId,
      scopes: ctx.scopes,
      requiredCents: 900,
      idempotencyKey: 'job-1',
      campaignId: ctx.campaignId,
    };

    const first = await reserveBudgetAcrossScopes(store, request);
    const replay = await reserveBudgetAcrossScopes(store, request);

    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(store.budgetLedgerEntries).toHaveLength(2);
    expect(replay.reservations.map((r) => r.reservation.id).sort()).toEqual(
      first.reservations.map((r) => r.reservation.id).sort(),
    );
  });

  it('concurrent multi-level dispatches never collectively exceed the tightest limit', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedLevels(store, { WORKSPACE: 10_000, CAMPAIGN: 1_000 });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reserveBudgetAcrossScopes(store, {
          workspaceId: ctx.workspaceId,
          scopes: ctx.scopes,
          requiredCents: 300,
          idempotencyKey: `job-${i}`,
          campaignId: ctx.campaignId,
        }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const campaignStatus = await getBudgetStatus(
      store,
      ctx.workspaceId,
      'CAMPAIGN',
      ctx.campaignId,
    );
    const workspaceStatus = await getBudgetStatus(
      store,
      ctx.workspaceId,
      'WORKSPACE',
      ctx.workspaceId,
    );
    expect(campaignStatus!.spentCents).toBe(900);
    // Whatever the campaign refused was never charged to the workspace either.
    expect(workspaceStatus!.spentCents).toBe(900);
  });

  it('refuses a malformed request before opening a transaction, so nothing can be retried into existence', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedLevels(store, { WORKSPACE: 10_000 });

    await expect(
      reserveBudgetAcrossScopes(store, {
        workspaceId: ctx.workspaceId,
        scopes: [],
        requiredCents: 100,
        idempotencyKey: 'job-1',
      }),
    ).rejects.toBeInstanceOf(InvalidBudgetRequestError);

    await expect(
      reserveBudgetAcrossScopes(store, {
        workspaceId: ctx.workspaceId,
        scopes: [
          { level: 'WORKSPACE', scopeId: ctx.workspaceId },
          { level: 'WORKSPACE', scopeId: ctx.workspaceId },
        ],
        requiredCents: 100,
        idempotencyKey: 'job-1',
      }),
    ).rejects.toBeInstanceOf(InvalidBudgetRequestError);

    await expect(
      reserveBudgetAcrossScopes(store, {
        workspaceId: ctx.workspaceId,
        scopes: [{ level: 'WORKSPACE', scopeId: ctx.workspaceId }],
        requiredCents: -1,
        idempotencyKey: 'job-1',
      }),
    ).rejects.toBeInstanceOf(InvalidBudgetRequestError);

    expect(store.budgetLedgerEntries).toHaveLength(0);
  });

  it('a policy in another workspace is invisible — the scope reads as uncapped, not as someone else`s cap', async () => {
    const store = new InMemoryCampaignStore();
    const owner = seedLevels(store, { WORKSPACE: 1_000 });
    const intruderWorkspaceId = randomUUID();

    const result = await reserveBudgetAcrossScopes(store, {
      workspaceId: intruderWorkspaceId,
      // The *other* workspace's scope id, from a caller scoped to this one.
      scopes: [{ level: 'WORKSPACE', scopeId: owner.workspaceId }],
      requiredCents: 5_000,
      idempotencyKey: 'intruder',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reservations).toHaveLength(0);
    expect(result.uncappedScopes).toHaveLength(1);
    // Nothing was written against the owner's policy, and its status is unchanged.
    expect(store.budgetLedgerEntries).toHaveLength(0);
    const ownerStatus = await getBudgetStatus(
      store,
      owner.workspaceId,
      'WORKSPACE',
      owner.workspaceId,
    );
    expect(ownerStatus!.spentCents).toBe(0);
  });
});
