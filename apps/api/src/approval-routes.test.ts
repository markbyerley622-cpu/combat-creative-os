import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { WorkflowClient } from '@temporalio/client';
import type { CampaignRecord, HumanApprovalRecord, MembershipRecord } from '@combat/database';
import type { ApprovalDatabase } from './approval-database';
import { registerApprovalRoutes } from './approval-routes';

class InMemoryApprovalDatabase implements ApprovalDatabase {
  campaigns: CampaignRecord[] = [];
  approvals: HumanApprovalRecord[] = [];
  memberships: MembershipRecord[] = [];

  campaign: ApprovalDatabase['campaign'] = {
    create: async ({ data }) => {
      const now = new Date();
      const campaign: CampaignRecord = {
        id: randomUUID(),
        currentStage: 'DRAFT',
        version: 0,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.campaigns.push(campaign);
      return campaign;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.campaigns.find((c) => c.id === where.id && c.workspaceId === where.workspaceId) ??
          null
        );
      }
      return (
        this.campaigns.find(
          (c) => c.workspaceId === where.workspaceId && c.idempotencyKey === where.idempotencyKey,
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.campaigns.filter((c) => c.workspaceId === where.workspaceId),
  };

  humanApproval: ApprovalDatabase['humanApproval'] = {
    create: async ({ data }) => {
      const approval: HumanApprovalRecord = { id: randomUUID(), decidedAt: new Date(), ...data };
      this.approvals.push(approval);
      return approval;
    },
    findMany: async ({ where }) =>
      this.approvals.filter(
        (a) => a.campaignId === where.campaignId && a.workspaceId === where.workspaceId,
      ),
  };

  membership: ApprovalDatabase['membership'] = {
    findFirst: async ({ where }) =>
      this.memberships.find((m) => m.id === where.id && m.workspaceId === where.workspaceId) ??
      null,
    findMany: async ({ where }) =>
      this.memberships.filter((m) => m.workspaceId === where.workspaceId),
    create: async ({ data }) => {
      const membership: MembershipRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.memberships.push(membership);
      return membership;
    },
  };

  seedCampaign(overrides: Partial<CampaignRecord> = {}): CampaignRecord {
    const now = new Date();
    const campaign: CampaignRecord = {
      id: randomUUID(),
      workspaceId: randomUUID(),
      name: 'Test Campaign',
      currentStage: 'CONCEPT_REVIEW',
      version: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.campaigns.push(campaign);
    return campaign;
  }

  seedMembership(
    overrides: Partial<MembershipRecord> &
      Pick<MembershipRecord, 'workspaceId' | 'userId' | 'role'>,
  ): MembershipRecord {
    const membership: MembershipRecord = { id: randomUUID(), createdAt: new Date(), ...overrides };
    this.memberships.push(membership);
    return membership;
  }
}

function buildFakeWorkflowClient(): {
  workflowClient: WorkflowClient;
  signal: ReturnType<typeof vi.fn>;
} {
  const signal = vi.fn().mockResolvedValue(undefined);
  const getHandle = vi.fn().mockReturnValue({ signal });
  return { workflowClient: { getHandle } as unknown as WorkflowClient, signal };
}

function buildApp(db: InMemoryApprovalDatabase, workflowClient: WorkflowClient) {
  const app = Fastify();
  registerApprovalRoutes(app, { db, workflowClient });
  return app;
}

describe('POST /workspaces/:workspaceId/campaigns/:campaignId/approvals/concept', () => {
  it('rejects a caller whose role lacks APPROVE_CONCEPT before touching the database', async () => {
    const db = new InMemoryApprovalDatabase();
    const campaign = db.seedCampaign();
    const userId = randomUUID();
    db.seedMembership({ workspaceId: campaign.workspaceId, userId, role: 'PRODUCTION_OPERATOR' });
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(db, workflowClient);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/approvals/concept`,
      payload: { userId, decision: 'APPROVED' },
    });

    expect(response.statusCode).toBe(403);
    expect(db.approvals).toHaveLength(0);
    expect(signal).not.toHaveBeenCalled();
  });

  it('rejects a caller with no membership in the workspace', async () => {
    const db = new InMemoryApprovalDatabase();
    const campaign = db.seedCampaign();
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(db, workflowClient);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/approvals/concept`,
      payload: { userId: randomUUID(), decision: 'APPROVED' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('404s a campaign scoped to a different workspace rather than leaking existence', async () => {
    const db = new InMemoryApprovalDatabase();
    const campaign = db.seedCampaign();
    const otherWorkspaceId = randomUUID();
    const userId = randomUUID();
    db.seedMembership({ workspaceId: otherWorkspaceId, userId, role: 'OWNER_ADMIN' });
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(db, workflowClient);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${otherWorkspaceId}/campaigns/${campaign.id}/approvals/concept`,
      payload: { userId, decision: 'APPROVED' },
    });

    expect(response.statusCode).toBe(404);
    expect(signal).not.toHaveBeenCalled();
  });

  it('persists the HumanApproval row before signalling the workflow', async () => {
    const db = new InMemoryApprovalDatabase();
    const campaign = db.seedCampaign();
    const userId = randomUUID();
    db.seedMembership({ workspaceId: campaign.workspaceId, userId, role: 'CREATIVE_DIRECTOR' });
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(db, workflowClient);

    const callOrder: string[] = [];
    const originalCreate = db.humanApproval.create.bind(db.humanApproval);
    db.humanApproval.create = (async (args) => {
      const result = await originalCreate(args);
      callOrder.push('persist');
      return result;
    }) as ApprovalDatabase['humanApproval']['create'];
    signal.mockImplementation(async () => {
      callOrder.push('signal');
    });

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/approvals/concept`,
      payload: { userId, decision: 'APPROVED', comments: 'looks great' },
    });

    expect(response.statusCode).toBe(202);
    expect(db.approvals).toHaveLength(1);
    expect(db.approvals[0]).toMatchObject({
      gate: 'CONCEPT',
      decision: 'APPROVED',
      decidedByUserId: userId,
      stageAtDecision: 'CONCEPT_REVIEW',
    });
    expect(callOrder).toEqual(['persist', 'signal']);
    expect(signal).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'approveConceptSignal' }),
      expect.objectContaining({
        approvalId: db.approvals[0]!.id,
        gate: 'CONCEPT',
        decision: 'APPROVED',
        decidedByUserId: userId,
      }),
    );
  });

  it('does not create a second row or re-decide on an exact retry, but still re-signals', async () => {
    const db = new InMemoryApprovalDatabase();
    const campaign = db.seedCampaign();
    const userId = randomUUID();
    db.seedMembership({ workspaceId: campaign.workspaceId, userId, role: 'OWNER_ADMIN' });
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(db, workflowClient);

    const payload = { userId, decision: 'APPROVED' as const };
    const first = await app.inject({
      method: 'POST',
      url: `/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/approvals/concept`,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/approvals/concept`,
      payload,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(db.approvals).toHaveLength(1);
    expect(first.json().approvalId).toBe(second.json().approvalId);
    expect(first.json().replayed).toBe(false);
    expect(second.json().replayed).toBe(true);
    expect(signal).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed body (invalid decision enum) with 400', async () => {
    const db = new InMemoryApprovalDatabase();
    const campaign = db.seedCampaign();
    const userId = randomUUID();
    db.seedMembership({ workspaceId: campaign.workspaceId, userId, role: 'OWNER_ADMIN' });
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(db, workflowClient);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/approvals/concept`,
      payload: { userId, decision: 'MAYBE' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /workspaces/:workspaceId/campaigns/:campaignId/approvals/final', () => {
  it('requires a repairTarget for a non-approved decision', async () => {
    const db = new InMemoryApprovalDatabase();
    const campaign = db.seedCampaign({ currentStage: 'FINAL_APPROVAL' });
    const userId = randomUUID();
    db.seedMembership({ workspaceId: campaign.workspaceId, userId, role: 'CREATIVE_DIRECTOR' });
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(db, workflowClient);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/approvals/final`,
      payload: { userId, decision: 'REJECTED' },
    });

    expect(response.statusCode).toBe(400);
    expect(db.approvals).toHaveLength(0);
  });

  it('accepts a rejected FINAL decision with a valid repairTarget', async () => {
    const db = new InMemoryApprovalDatabase();
    const campaign = db.seedCampaign({ currentStage: 'FINAL_APPROVAL' });
    const userId = randomUUID();
    db.seedMembership({ workspaceId: campaign.workspaceId, userId, role: 'CREATIVE_DIRECTOR' });
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(db, workflowClient);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/approvals/final`,
      payload: { userId, decision: 'REJECTED', repairTarget: 'SOUND_DESIGN' },
    });

    expect(response.statusCode).toBe(202);
    expect(db.approvals[0]).toMatchObject({ gate: 'FINAL', repairTarget: 'SOUND_DESIGN' });
    expect(signal).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'approveFinalSignal' }),
      expect.objectContaining({ repairTarget: 'SOUND_DESIGN' }),
    );
  });

  it('rejects a REVIEWER, who lacks APPROVE_FINAL_MASTER', async () => {
    const db = new InMemoryApprovalDatabase();
    const campaign = db.seedCampaign({ currentStage: 'FINAL_APPROVAL' });
    const userId = randomUUID();
    db.seedMembership({ workspaceId: campaign.workspaceId, userId, role: 'REVIEWER' });
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(db, workflowClient);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/approvals/final`,
      payload: { userId, decision: 'APPROVED' },
    });

    expect(response.statusCode).toBe(403);
    expect(signal).not.toHaveBeenCalled();
  });
});

// The SHOT_SELECTION gate is no longer a generic approval route (M8): it is
// driven exclusively by shot-review-routes.ts (see shot-review-routes.test.ts),
// which validates + freezes the persisted ShotSelectionSet before recording the
// approval. This keeps exactly one shot-selection approval path.

describe('workflow signal failure handling', () => {
  it('still reports the persisted approvalId when the workflow signal itself fails', async () => {
    const db = new InMemoryApprovalDatabase();
    const campaign = db.seedCampaign();
    const userId = randomUUID();
    db.seedMembership({ workspaceId: campaign.workspaceId, userId, role: 'OWNER_ADMIN' });
    const { workflowClient, signal } = buildFakeWorkflowClient();
    signal.mockRejectedValue(new Error('workflow not found'));
    const app = buildApp(db, workflowClient);

    const response = await app.inject({
      method: 'POST',
      url: `/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/approvals/concept`,
      payload: { userId, decision: 'APPROVED' },
    });

    expect(response.statusCode).toBe(502);
    expect(db.approvals).toHaveLength(1);
    expect(response.json().approvalId).toBe(db.approvals[0]!.id);
  });
});
