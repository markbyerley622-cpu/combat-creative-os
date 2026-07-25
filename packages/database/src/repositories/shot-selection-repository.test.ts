import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';
import {
  approveShotSelectionSet,
  createDraftShotSelectionSet,
  getLatestShotSelectionSet,
  listShotSelectionReplacements,
  listShotSelections,
  rejectShotSelection,
  setShotSelectionCandidate,
  type RequiredShotInput,
} from './shot-selection-repository';

function requiredShots(count = 2): RequiredShotInput[] {
  return Array.from({ length: count }, (_, i) => ({
    shotId: randomUUID(),
    sequencePosition: i,
    shotSpecificationId: randomUUID(),
    shotSpecificationVersion: 1,
  }));
}

async function seedDraft(
  store: InMemoryCampaignStore,
  workspaceId: string,
  campaignId: string,
  shots: RequiredShotInput[],
  version = 1,
) {
  return createDraftShotSelectionSet(store, workspaceId, {
    campaignId,
    scriptId: randomUUID(),
    scriptVersion: 1,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    version,
    createdByUserId: randomUUID(),
    requiredShots: shots,
  });
}

describe('shot-selection-repository', () => {
  it('creates a draft set with a PENDING selection per required shot, idempotent per (campaign, version)', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const shots = requiredShots(2);

    const first = await seedDraft(store, workspaceId, campaignId, shots);
    const retry = await seedDraft(store, workspaceId, campaignId, shots);

    expect(first.alreadyExisted).toBe(false);
    expect(retry.alreadyExisted).toBe(true);
    expect(retry.set.id).toBe(first.set.id);
    expect(store.shotSelectionSetRecords).toHaveLength(1);
    const selections = await listShotSelections(store, first.set.id);
    expect(selections).toHaveLength(2);
    expect(selections.every((s) => s.status === 'PENDING')).toBe(true);
    // Deterministic sequence ordering.
    expect(selections.map((s) => s.sequencePosition)).toEqual([0, 1]);
  });

  it('selects a candidate and bumps the optimistic-concurrency revision', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const shots = requiredShots(1);
    const { set } = await seedDraft(store, workspaceId, randomUUID(), shots);
    const candidateId = randomUUID();

    const result = await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      candidateId,
      expectedRevision: 0,
      userId: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.set.revision).toBe(1);
    const [selection] = await listShotSelections(store, set.id);
    expect(selection?.status).toBe('SELECTED');
    expect(selection?.selectedCandidateId).toBe(candidateId);
  });

  it('records replacement history when a selected candidate is swapped', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const shots = requiredShots(1);
    const { set } = await seedDraft(store, workspaceId, randomUUID(), shots);
    const userId = randomUUID();
    const candA = randomUUID();
    const candB = randomUUID();

    await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      candidateId: candA,
      expectedRevision: 0,
      userId,
    });
    await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      candidateId: candB,
      expectedRevision: 1,
      userId,
    });

    const history = await listShotSelectionReplacements(store, set.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ previousCandidateId: candA, newCandidateId: candB });
  });

  it('rejects a stale revision (optimistic concurrency)', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const shots = requiredShots(1);
    const { set } = await seedDraft(store, workspaceId, randomUUID(), shots);

    // First select bumps revision to 1; a second call still using expectedRevision 0 is stale.
    await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      candidateId: randomUUID(),
      expectedRevision: 0,
      userId: randomUUID(),
    });
    const stale = await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      candidateId: randomUUID(),
      expectedRevision: 0,
      userId: randomUUID(),
    });

    expect(stale).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
  });

  it('rejects a shot with regeneration feedback and clears its candidate', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const shots = requiredShots(1);
    const { set } = await seedDraft(store, workspaceId, randomUUID(), shots);
    await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      candidateId: randomUUID(),
      expectedRevision: 0,
      userId: randomUUID(),
    });

    const result = await rejectShotSelection(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      regenerationFeedback: 'Subject morphs; regenerate with lower motion.',
      expectedRevision: 1,
      userId: randomUUID(),
    });

    expect(result.ok).toBe(true);
    const [selection] = await listShotSelections(store, set.id);
    expect(selection?.status).toBe('REJECTED');
    expect(selection?.selectedCandidateId).toBeUndefined();
    expect(selection?.regenerationFeedback).toContain('morphs');
  });

  it('approves a complete, all-eligible set and freezes it (immutable)', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const shots = requiredShots(2);
    const { set } = await seedDraft(store, workspaceId, randomUUID(), shots);
    const candA = randomUUID();
    const candB = randomUUID();
    await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      candidateId: candA,
      expectedRevision: 0,
      userId: randomUUID(),
    });
    await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[1]!.shotId,
      candidateId: candB,
      expectedRevision: 1,
      userId: randomUUID(),
    });

    const reviewer = randomUUID();
    const approved = await approveShotSelectionSet(store, workspaceId, {
      setId: set.id,
      reviewerUserId: reviewer,
      expectedRevision: 2,
      eligibleCandidateIds: new Set([candA, candB]),
      approvedAt: new Date(),
    });

    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.set.status).toBe('APPROVED');
    expect(approved.set.reviewerUserId).toBe(reviewer);

    // Immutable: any further mutation is refused.
    const mutate = await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      candidateId: randomUUID(),
      expectedRevision: 3,
      userId: randomUUID(),
    });
    expect(mutate).toMatchObject({ ok: false, reason: 'NOT_DRAFT' });
  });

  it('refuses to approve an incomplete set', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const shots = requiredShots(2);
    const { set } = await seedDraft(store, workspaceId, randomUUID(), shots);
    const candA = randomUUID();
    await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      candidateId: candA,
      expectedRevision: 0,
      userId: randomUUID(),
    });

    const approved = await approveShotSelectionSet(store, workspaceId, {
      setId: set.id,
      reviewerUserId: randomUUID(),
      expectedRevision: 1,
      eligibleCandidateIds: new Set([candA]),
      approvedAt: new Date(),
    });
    expect(approved).toMatchObject({ ok: false, reason: 'INCOMPLETE' });
  });

  it('refuses to approve when a selected candidate is no longer eligible', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const shots = requiredShots(1);
    const { set } = await seedDraft(store, workspaceId, randomUUID(), shots);
    const candA = randomUUID();
    await setShotSelectionCandidate(store, workspaceId, {
      setId: set.id,
      shotId: shots[0]!.shotId,
      candidateId: candA,
      expectedRevision: 0,
      userId: randomUUID(),
    });

    const approved = await approveShotSelectionSet(store, workspaceId, {
      setId: set.id,
      reviewerUserId: randomUUID(),
      expectedRevision: 1,
      eligibleCandidateIds: new Set(), // candA has since become ineligible
      approvedAt: new Date(),
    });
    expect(approved).toMatchObject({ ok: false, reason: 'INELIGIBLE_CANDIDATE' });
  });

  it('scopes sets by workspace — another workspace cannot reach the set', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const { set } = await seedDraft(store, workspaceId, campaignId, requiredShots(1));

    const otherWorkspace = randomUUID();
    const viaOther = await getLatestShotSelectionSet(store, otherWorkspace, campaignId);
    expect(viaOther).toBeUndefined();
    const mutate = await setShotSelectionCandidate(store, otherWorkspace, {
      setId: set.id,
      shotId: randomUUID(),
      candidateId: randomUUID(),
      expectedRevision: 0,
      userId: randomUUID(),
    });
    expect(mutate).toMatchObject({ ok: false, reason: 'SET_NOT_FOUND' });
  });
});
