import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVerifyHumanApprovalActivity } from './verify-human-approval-activity';
import { InMemoryTransitionStore } from './test-helpers/in-memory-transition-store';

describe('verifyHumanApprovalActivity', () => {
  it('confirms a matching, persisted approval', async () => {
    const store = new InMemoryTransitionStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const approval = store.seedApproval({
      workspaceId,
      campaignId,
      gate: 'CONCEPT',
      decision: 'APPROVED',
      stageAtDecision: 'CONCEPT_REVIEW',
      decidedByUserId: randomUUID(),
    });
    const activity = createVerifyHumanApprovalActivity({ humanApprovalDb: store });

    const result = await activity({
      workspaceId,
      campaignId,
      approvalId: approval.id,
      expectedGate: 'CONCEPT',
    });

    expect(result).toEqual({
      found: true,
      matchesGate: true,
      approval: {
        id: approval.id,
        gate: 'CONCEPT',
        decision: 'APPROVED',
        decidedByUserId: approval.decidedByUserId,
        repairTarget: undefined,
        decidedAt: approval.decidedAt.toISOString(),
      },
    });
  });

  it('reports not found for an unknown approvalId', async () => {
    const store = new InMemoryTransitionStore();
    const activity = createVerifyHumanApprovalActivity({ humanApprovalDb: store });

    const result = await activity({
      workspaceId: randomUUID(),
      campaignId: randomUUID(),
      approvalId: randomUUID(),
      expectedGate: 'CONCEPT',
    });

    expect(result).toEqual({ found: false });
  });

  it('reports not found (never leaking existence) for an approval that belongs to a different campaign', async () => {
    const store = new InMemoryTransitionStore();
    const workspaceId = randomUUID();
    const approval = store.seedApproval({
      workspaceId,
      campaignId: randomUUID(),
      gate: 'CONCEPT',
      decision: 'APPROVED',
      stageAtDecision: 'CONCEPT_REVIEW',
      decidedByUserId: randomUUID(),
    });

    const activity = createVerifyHumanApprovalActivity({ humanApprovalDb: store });
    const result = await activity({
      workspaceId,
      campaignId: randomUUID(),
      approvalId: approval.id,
      expectedGate: 'CONCEPT',
    });

    expect(result).toEqual({ found: false });
  });

  it('reports not found for an approval that belongs to a different workspace', async () => {
    const store = new InMemoryTransitionStore();
    const campaignId = randomUUID();
    const approval = store.seedApproval({
      workspaceId: randomUUID(),
      campaignId,
      gate: 'CONCEPT',
      decision: 'APPROVED',
      stageAtDecision: 'CONCEPT_REVIEW',
      decidedByUserId: randomUUID(),
    });

    const activity = createVerifyHumanApprovalActivity({ humanApprovalDb: store });
    const result = await activity({
      workspaceId: randomUUID(),
      campaignId,
      approvalId: approval.id,
      expectedGate: 'CONCEPT',
    });

    expect(result).toEqual({ found: false });
  });

  it('reports a gate mismatch for an approval that exists but was decided at a different gate', async () => {
    const store = new InMemoryTransitionStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const approval = store.seedApproval({
      workspaceId,
      campaignId,
      gate: 'SHOT_SELECTION',
      decision: 'APPROVED',
      stageAtDecision: 'HUMAN_SHOT_SELECTION',
      decidedByUserId: randomUUID(),
    });

    const activity = createVerifyHumanApprovalActivity({ humanApprovalDb: store });
    const result = await activity({
      workspaceId,
      campaignId,
      approvalId: approval.id,
      expectedGate: 'CONCEPT',
    });

    expect(result).toEqual({ found: true, matchesGate: false });
  });
});
