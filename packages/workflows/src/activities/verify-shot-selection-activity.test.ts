import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  approveShotSelectionSet,
  createDraftShotSelectionSet,
  InMemoryCampaignStore,
  setShotSelectionCandidate,
} from '@combat/database';
import { createVerifyShotSelectionActivity } from './verify-shot-selection-activity';

function seedScript(
  store: InMemoryCampaignStore,
  workspaceId: string,
  campaignId: string,
  version = 1,
) {
  const scriptId = randomUUID();
  store.scriptRecords.push({
    id: scriptId,
    workspaceId,
    campaignId,
    creativeConceptId: randomUUID(),
    version,
    totalDurationFrames: 90,
    createdAt: new Date(),
  });
  return scriptId;
}

async function seedApprovedSet(
  store: InMemoryCampaignStore,
  workspaceId: string,
  campaignId: string,
  scriptId: string,
  scriptVersion: number,
) {
  const shotId = randomUUID();
  const candidateId = randomUUID();
  const { set } = await createDraftShotSelectionSet(store, workspaceId, {
    campaignId,
    scriptId,
    scriptVersion,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    version: 1,
    createdByUserId: randomUUID(),
    requiredShots: [
      {
        shotId,
        sequencePosition: 0,
        shotSpecificationId: randomUUID(),
        shotSpecificationVersion: 1,
      },
    ],
  });
  await setShotSelectionCandidate(store, workspaceId, {
    setId: set.id,
    shotId,
    candidateId,
    expectedRevision: 0,
    userId: randomUUID(),
  });
  await approveShotSelectionSet(store, workspaceId, {
    setId: set.id,
    reviewerUserId: randomUUID(),
    expectedRevision: 1,
    eligibleCandidateIds: new Set([candidateId]),
    approvedAt: new Date(),
  });
  return set;
}

describe('verifyShotSelectionActivity', () => {
  function build(store: InMemoryCampaignStore) {
    return createVerifyShotSelectionActivity({ shotSelectionDb: store, scriptDb: store });
  }

  it('is valid for an APPROVED, complete, current set', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const scriptId = seedScript(store, workspaceId, campaignId, 1);
    await seedApprovedSet(store, workspaceId, campaignId, scriptId, 1);

    const result = await build(store)({ workspaceId, campaignId });
    expect(result.valid).toBe(true);
  });

  it('is invalid when no set exists', async () => {
    const store = new InMemoryCampaignStore();
    const result = await build(store)({ workspaceId: randomUUID(), campaignId: randomUUID() });
    expect(result).toMatchObject({ valid: false, reason: 'NO_SET' });
  });

  it('is invalid when the latest set is only a DRAFT', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const scriptId = seedScript(store, workspaceId, campaignId, 1);
    await createDraftShotSelectionSet(store, workspaceId, {
      campaignId,
      scriptId,
      scriptVersion: 1,
      creativeConceptId: randomUUID(),
      creativeConceptVersion: 1,
      version: 1,
      createdByUserId: randomUUID(),
      requiredShots: [
        {
          shotId: randomUUID(),
          sequencePosition: 0,
          shotSpecificationId: randomUUID(),
          shotSpecificationVersion: 1,
        },
      ],
    });
    const result = await build(store)({ workspaceId, campaignId });
    expect(result).toMatchObject({ valid: false, reason: 'NOT_APPROVED' });
  });

  it('is invalid when the set was approved against a superseded script version', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const scriptId = seedScript(store, workspaceId, campaignId, 1);
    await seedApprovedSet(store, workspaceId, campaignId, scriptId, 1);
    // A newer script version supersedes the one the set was built against.
    seedScript(store, workspaceId, campaignId, 2);

    const result = await build(store)({ workspaceId, campaignId });
    expect(result).toMatchObject({ valid: false, reason: 'STALE_SCRIPT' });
  });
});
