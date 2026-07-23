import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkAndReserveBudget, chargeBudget, computeSpentCents, releaseBudget } from './budget-repository';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';

describe('budget checks — reservation, charge, release, idempotency', () => {
  it('reserves against a configured policy when funds are sufficient', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    store.budgetPolicies.push({ id: randomUUID(), workspaceId, level: 'CAMPAIGN', scopeId: campaignId, limitCents: 10_000 });

    const result = await checkAndReserveBudget(store, {
      workspaceId,
      level: 'CAMPAIGN',
      scopeId: campaignId,
      requiredCents: 3000,
      idempotencyKey: randomUUID(),
      campaignId,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.reservation) {
      expect(result.reservation.entryType).toBe('RESERVATION');
      expect(result.reservation.amountCents).toBe(3000);
    }
  });

  it('rejects with BUDGET_EXCEEDED when the required amount exceeds what remains', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const policyId = randomUUID();
    store.budgetPolicies.push({ id: policyId, workspaceId, level: 'CAMPAIGN', scopeId: campaignId, limitCents: 1000 });
    store.budgetLedgerEntries.push({
      id: randomUUID(),
      workspaceId,
      budgetPolicyId: policyId,
      entryType: 'CHARGE',
      amountCents: 900,
      idempotencyKey: randomUUID(),
      createdAt: new Date(),
    });

    const result = await checkAndReserveBudget(store, {
      workspaceId,
      level: 'CAMPAIGN',
      scopeId: campaignId,
      requiredCents: 200,
      idempotencyKey: randomUUID(),
      campaignId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason.type).toBe('BUDGET_EXCEEDED');
    }
  });

  it('treats a level with no configured policy as uncapped', async () => {
    const store = new InMemoryCampaignStore();
    const result = await checkAndReserveBudget(store, {
      workspaceId: randomUUID(),
      level: 'PROVIDER',
      scopeId: 'veo',
      requiredCents: 1_000_000,
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(true);
  });

  it('a retried reservation with the same idempotency key does not double-reserve', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    store.budgetPolicies.push({ id: randomUUID(), workspaceId, level: 'CAMPAIGN', scopeId: campaignId, limitCents: 10_000 });
    const idempotencyKey = randomUUID();

    const first = await checkAndReserveBudget(store, {
      workspaceId,
      level: 'CAMPAIGN',
      scopeId: campaignId,
      requiredCents: 3000,
      idempotencyKey,
      campaignId,
    });
    const second = await checkAndReserveBudget(store, {
      workspaceId,
      level: 'CAMPAIGN',
      scopeId: campaignId,
      requiredCents: 3000,
      idempotencyKey,
      campaignId,
    });

    expect(first.ok && second.ok).toBe(true);
    expect(store.budgetLedgerEntries).toHaveLength(1);
    if (first.ok && second.ok) {
      expect(second.reservation?.id).toBe(first.reservation?.id);
    }
  });

  it('computeSpentCents nets RESERVATION+CHARGE against RELEASE, never mutating a stored field', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const policyId = randomUUID();

    await store.budgetLedgerEntry.create({
      data: { workspaceId, budgetPolicyId: policyId, entryType: 'RESERVATION', amountCents: 500, idempotencyKey: randomUUID() },
    });
    await chargeBudget(store, policyId, workspaceId, { amountCents: 500, idempotencyKey: randomUUID() });
    await releaseBudget(store, policyId, workspaceId, { amountCents: 200, idempotencyKey: randomUUID() });

    const entries = await store.budgetLedgerEntry.findMany({ where: { budgetPolicyId: policyId } });
    expect(entries).toHaveLength(3);
    expect(computeSpentCents(entries)).toBe(500 + 500 - 200);
  });
});
