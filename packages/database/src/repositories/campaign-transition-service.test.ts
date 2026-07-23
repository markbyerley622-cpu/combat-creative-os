import { randomUUID } from 'node:crypto';
import { CAMPAIGN_STAGES, CAMPAIGN_TRANSITIONS, type CampaignStage } from '@combat/domain';
import { describe, expect, it } from 'vitest';
import { attemptCampaignTransition } from './campaign-transition-service';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';

/**
 * Seeds a store such that every DB-derived transition fact evaluates true —
 * used for exercising the *valid transitions* half of the exhaustive sweep.
 * Mirrors the real shape the fact-derivation logic in transition-facts.ts
 * expects (see that file's tests for direct coverage of the derivation
 * rules); here we only care that the service applies the CAS update,
 * writes an APPLIED audit row, and advances `currentStage`/`version`.
 */
function seedAllFactsTrue(store: InMemoryCampaignStore, campaign: ReturnType<InMemoryCampaignStore['seedCampaign']>) {
  const { id: campaignId, workspaceId } = campaign;

  store.briefs.push({ id: randomUUID(), campaignId, version: 1, acceptedAt: new Date() });

  for (const gate of ['STRATEGY', 'CONCEPT', 'SCRIPT', 'SHOT_SELECTION', 'FINAL'] as const) {
    store.approvals.push({
      id: randomUUID(),
      workspaceId,
      campaignId,
      gate,
      decision: 'APPROVED',
      stageAtDecision: 'DRAFT',
      decidedByUserId: randomUUID(),
      decidedAt: new Date(),
    });
  }

  const scriptId = randomUUID();
  store.scripts.push({ id: scriptId, campaignId, version: 1 });
  const shotId = randomUUID();
  store.shots.push({ id: shotId, scriptId });
  const promptId = randomUUID();
  store.generationPrompts.push({ id: promptId, shotId });
  const candidateId = randomUUID();
  store.generationCandidates.push({ id: candidateId, generationPromptId: promptId, status: 'SUCCEEDED', attempt: 1 });
  store.qualityAssessments.push({ id: randomUUID(), generationCandidateId: candidateId, assetId: null, pass: true });
  store.qualityAssessments.push({ id: randomUUID(), generationCandidateId: null, assetId: randomUUID(), pass: true });

  store.renderJobs.push({ id: randomUUID(), kind: 'COMPOSITING', status: 'SUCCEEDED' });
  store.renderJobs.push({ id: randomUUID(), kind: 'EXPORT', status: 'SUCCEEDED' });
  store.editDecisionLists.push({ id: randomUUID(), version: 1 });
  store.deliverySpecifications.push({ id: randomUUID() });
  const variantId = randomUUID();
  store.creativeVariants.push({ id: variantId, assetId: randomUUID(), status: 'READY' });
  store.performanceMetricsRows.push({ id: randomUUID(), creativeVariantId: variantId });
}

/** Seeds facts so that every *revision-loop* transition's required fact is true (rejections/changes-requested). */
function seedAllRevisionFactsTrue(
  store: InMemoryCampaignStore,
  campaign: ReturnType<InMemoryCampaignStore['seedCampaign']>,
) {
  const { id: campaignId, workspaceId } = campaign;
  for (const gate of ['STRATEGY', 'CONCEPT', 'SCRIPT', 'SHOT_SELECTION', 'FINAL'] as const) {
    store.approvals.push({
      id: randomUUID(),
      workspaceId,
      campaignId,
      gate,
      decision: 'CHANGES_REQUESTED',
      stageAtDecision: 'DRAFT',
      decidedByUserId: randomUUID(),
      decidedAt: new Date(),
    });
  }
  const scriptId = randomUUID();
  store.scripts.push({ id: scriptId, campaignId, version: 1 });
  const shotId = randomUUID();
  store.shots.push({ id: shotId, scriptId });
  const promptId = randomUUID();
  store.generationPrompts.push({ id: promptId, shotId });
  const candidateId = randomUUID();
  store.generationCandidates.push({ id: candidateId, generationPromptId: promptId, status: 'FAILED', attempt: 1 });
  store.qualityAssessments.push({ id: randomUUID(), generationCandidateId: null, assetId: randomUUID(), pass: false });
  const variantId = randomUUID();
  store.creativeVariants.push({ id: variantId, assetId: null, status: 'READY' });
  store.performanceMetricsRows.push({ id: randomUUID(), creativeVariantId: variantId });
}

describe('attemptCampaignTransition — every valid transition applies atomically', () => {
  it.each(CAMPAIGN_TRANSITIONS.filter((t) => t.kind === 'FORWARD').map((t) => [t.from, t.to] as const))(
    'forward: %s -> %s',
    async (from, to) => {
      const store = new InMemoryCampaignStore();
      const campaign = store.seedCampaign({ currentStage: from });
      const initialVersion = campaign.version;
      seedAllFactsTrue(store, campaign);

      const result = await attemptCampaignTransition(store, {
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        toStage: to,
        idempotencyKey: randomUUID(),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.campaign.currentStage).toBe(to);
        expect(result.campaign.version).toBe(initialVersion + 1);
        expect(result.audit.result).toBe('APPLIED');
      }
    },
  );

  it.each(CAMPAIGN_TRANSITIONS.filter((t) => t.kind === 'REVISION').map((t) => [t.from, t.to] as const))(
    'revision: %s -> %s',
    async (from, to) => {
      const store = new InMemoryCampaignStore();
      const campaign = store.seedCampaign({ currentStage: from });
      seedAllRevisionFactsTrue(store, campaign);

      const result = await attemptCampaignTransition(store, {
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        toStage: to,
        idempotencyKey: randomUUID(),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.campaign.currentStage).toBe(to);
      }
    },
  );
});

describe('attemptCampaignTransition — every invalid transition is rejected', () => {
  const validPairs = new Set(CAMPAIGN_TRANSITIONS.map((t) => `${t.from}->${t.to}`));
  const invalidPairs: Array<[CampaignStage, CampaignStage]> = [];
  for (const from of CAMPAIGN_STAGES) {
    for (const to of CAMPAIGN_STAGES) {
      if (from === to || validPairs.has(`${from}->${to}`)) continue;
      invalidPairs.push([from, to]);
    }
  }

  it.each(invalidPairs)('%s -> %s is rejected and still audited', async (from, to) => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: from });
    seedAllFactsTrue(store, campaign);

    const result = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: to,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason.type).toBe('INVALID_TRANSITION');
      expect(result.audit.result).toBe('REJECTED_INVALID_TRANSITION');
    }
    // The campaign must not have moved.
    const reloaded = await store.campaign.findFirst({ where: { id: campaign.id, workspaceId: campaign.workspaceId } });
    expect(reloaded?.currentStage).toBe(from);
  });
});

describe('attemptCampaignTransition — missing prerequisites', () => {
  it('rejects a valid-shaped transition when its required fact is false', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'DRAFT' });
    // No CampaignBrief seeded at all -> briefAccepted is false.

    const result = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: 'STRATEGY_REVIEW',
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason.type).toBe('MISSING_PREREQUISITE');
      expect(result.audit.result).toBe('REJECTED_MISSING_PREREQUISITE');
    }
  });

  it('does not advance the stage when a human gate has not been approved', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'STRATEGY_REVIEW' });
    // No HumanApproval seeded for the STRATEGY gate.

    const result = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: 'CONCEPT_REVIEW',
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    const reloaded = await store.campaign.findFirst({ where: { id: campaign.id, workspaceId: campaign.workspaceId } });
    expect(reloaded?.currentStage).toBe('STRATEGY_REVIEW');
  });

  it('advances past a human gate once an APPROVED HumanApproval is recorded, and records its id on the audit', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'STRATEGY_REVIEW' });
    const approval = await store.humanApproval.create({
      data: {
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        gate: 'STRATEGY',
        decision: 'APPROVED',
        stageAtDecision: 'STRATEGY_REVIEW',
        decidedByUserId: randomUUID(),
      },
    });

    const result = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: 'CONCEPT_REVIEW',
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.audit.approvalId).toBe(approval.id);
    }
  });

  it('a REJECTED decision does not satisfy the approval gate', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'STRATEGY_REVIEW' });
    await store.humanApproval.create({
      data: {
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        gate: 'STRATEGY',
        decision: 'REJECTED',
        stageAtDecision: 'STRATEGY_REVIEW',
        decidedByUserId: randomUUID(),
      },
    });

    const result = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: 'CONCEPT_REVIEW',
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
  });
});

describe('attemptCampaignTransition — idempotency', () => {
  it('a duplicate request with the same idempotency key returns the original APPLIED outcome without re-mutating', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'DRAFT' });
    seedAllFactsTrue(store, campaign);
    const idempotencyKey = randomUUID();

    const first = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: 'STRATEGY_REVIEW',
      idempotencyKey,
    });
    const second = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: 'STRATEGY_REVIEW',
      idempotencyKey,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.audit.id).toBe(first.audit.id);
    }
    // Only ever incremented once, not twice.
    expect(store.campaigns[0]?.version).toBe(1);
    expect(store.audits).toHaveLength(1);
  });

  it('a duplicate request for a previously-rejected attempt returns DUPLICATE_REQUEST rather than re-evaluating', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'DRAFT' });
    const idempotencyKey = randomUUID();

    const first = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: 'CONCEPT_REVIEW', // invalid from DRAFT
      idempotencyKey,
    });
    const second = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: 'CONCEPT_REVIEW',
      idempotencyKey,
    });

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.reason.type).toBe('DUPLICATE_REQUEST');
    }
    expect(store.audits).toHaveLength(1);
  });
});

describe('attemptCampaignTransition — concurrent transition attempts', () => {
  it('only one of two concurrent attempts targeting the same stage succeeds; the loser sees CONCURRENT_MODIFICATION', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'DRAFT' });
    seedAllFactsTrue(store, campaign);

    // Two callers race to apply the *same* transition with *different*
    // idempotency keys (e.g. two independent workflow activity retries that
    // didn't share a key) — the CAS guard, not the idempotency table, is
    // what must prevent a double-apply here.
    const [first, second] = await Promise.all([
      attemptCampaignTransition(store, {
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        toStage: 'STRATEGY_REVIEW',
        idempotencyKey: randomUUID(),
      }),
      attemptCampaignTransition(store, {
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        toStage: 'STRATEGY_REVIEW',
        idempotencyKey: randomUUID(),
      }),
    ]);

    const outcomes = [first, second];
    const successes = outcomes.filter((r) => r.ok);
    const failures = outcomes.filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const failure = failures[0];
    if (failure && !failure.ok) {
      expect(failure.error.reason.type).toBe('CONCURRENT_MODIFICATION');
      expect(failure.audit.result).toBe('REJECTED_CONCURRENT_MODIFICATION');
    }
    expect(store.campaigns[0]?.version).toBe(1);
  });
});

describe('attemptCampaignTransition — budget rejection', () => {
  it('rejects entry into SHOT_GENERATION when the campaign-level budget is exhausted', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'ASSET_COLLECTION' });
    seedAllFactsTrue(store, campaign);

    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: campaign.workspaceId,
      level: 'CAMPAIGN',
      scopeId: campaign.id,
      limitCents: 1000,
    });

    const result = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: 'SHOT_GENERATION',
      idempotencyKey: randomUUID(),
      generationBudgetCents: 5000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason.type).toBe('BUDGET_EXCEEDED');
      expect(result.audit.result).toBe('REJECTED_BUDGET_EXCEEDED');
    }
    const reloaded = await store.campaign.findFirst({ where: { id: campaign.id, workspaceId: campaign.workspaceId } });
    expect(reloaded?.currentStage).toBe('ASSET_COLLECTION');
    // No reservation should have been left dangling.
    expect(store.budgetLedgerEntries).toHaveLength(0);
  });

  it('reserves budget and advances the stage when funds are sufficient', async () => {
    const store = new InMemoryCampaignStore();
    const campaign = store.seedCampaign({ currentStage: 'ASSET_COLLECTION' });
    seedAllFactsTrue(store, campaign);

    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: campaign.workspaceId,
      level: 'CAMPAIGN',
      scopeId: campaign.id,
      limitCents: 10_000,
    });

    const result = await attemptCampaignTransition(store, {
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      toStage: 'SHOT_GENERATION',
      idempotencyKey: randomUUID(),
      generationBudgetCents: 5000,
    });

    expect(result.ok).toBe(true);
    expect(store.budgetLedgerEntries.some((e) => e.entryType === 'RESERVATION' && e.amountCents === 5000)).toBe(
      true,
    );
  });
});
