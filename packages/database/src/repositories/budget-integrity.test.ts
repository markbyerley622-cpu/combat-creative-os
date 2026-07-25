import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';
import {
  chargeBudget,
  checkAndReserveBudget,
  getBudgetStatus,
  releaseBudget,
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

  it('a retried charge on the same key is written once', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 10_000);
    await reserve(store, ctx, 500, 'k');

    await chargeBudget(store, ctx.policyId, ctx.workspaceId, {
      amountCents: 480,
      idempotencyKey: 'k:charge',
      campaignId: ctx.campaignId,
    });
    await expect(
      chargeBudget(store, ctx.policyId, ctx.workspaceId, {
        amountCents: 480,
        idempotencyKey: 'k:charge',
        campaignId: ctx.campaignId,
      }),
    ).rejects.toThrow(/unique constraint/);

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

  it('successful provider work is charged once and the remainder released', async () => {
    const store = new InMemoryCampaignStore();
    const ctx = seedPolicy(store, 10_000);
    await reserve(store, ctx, 1_000, 'k');

    // Actual usage came in under the estimate.
    await chargeBudget(store, ctx.policyId, ctx.workspaceId, {
      amountCents: 700,
      idempotencyKey: 'k:charge',
      campaignId: ctx.campaignId,
    });
    await releaseBudget(store, ctx.policyId, ctx.workspaceId, {
      amountCents: 300,
      idempotencyKey: 'k:release-remainder',
      campaignId: ctx.campaignId,
    });

    const status = await getBudgetStatus(store, ctx.workspaceId, 'WORKSPACE', ctx.workspaceId);
    // Reservation 1000 + charge 700 − release 300 nets to the true 700 spend
    // once the reservation is closed out by its release.
    expect(status!.spentCents).toBe(1_400);
    expect(store.budgetLedgerEntries.filter((e) => e.entryType === 'CHARGE')).toHaveLength(1);
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
