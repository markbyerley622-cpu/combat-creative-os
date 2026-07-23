import type { ApprovalDecision, ApprovalGate, CampaignStage } from '@combat/domain';

/**
 * Human approval records are immutable once created (architecture.md §0
 * guiding constraint 3 / CLAUDE.md "Human gates must require immutable
 * approval records"). This repository intentionally exposes only `record`
 * (insert) and read helpers — there is no `update`/`delete` function here,
 * and none should be added. A revised decision is always a new row.
 */
export interface HumanApprovalRecord {
  id: string;
  workspaceId: string;
  campaignId: string;
  gate: ApprovalGate;
  decision: ApprovalDecision;
  stageAtDecision: CampaignStage;
  decidedByUserId: string;
  comments?: string;
  /** The human-selected repair target for a rejected FINAL decision — see HumanApprovalSchema's refine in packages/domain. */
  repairTarget?: CampaignStage;
  decidedAt: Date;
}

export interface HumanApprovalDataSource {
  humanApproval: {
    create(args: {
      data: {
        workspaceId: string;
        campaignId: string;
        gate: ApprovalGate;
        decision: ApprovalDecision;
        stageAtDecision: CampaignStage;
        decidedByUserId: string;
        comments?: string;
        repairTarget?: CampaignStage;
      };
    }): Promise<HumanApprovalRecord>;
    findMany(args: {
      where: { campaignId: string; workspaceId: string };
    }): Promise<HumanApprovalRecord[]>;
  };
}

export async function recordHumanApproval(
  db: HumanApprovalDataSource,
  workspaceId: string,
  input: {
    campaignId: string;
    gate: ApprovalGate;
    decision: ApprovalDecision;
    stageAtDecision: CampaignStage;
    decidedByUserId: string;
    comments?: string;
    repairTarget?: CampaignStage;
  },
): Promise<HumanApprovalRecord> {
  return db.humanApproval.create({
    data: {
      workspaceId,
      campaignId: input.campaignId,
      gate: input.gate,
      decision: input.decision,
      stageAtDecision: input.stageAtDecision,
      decidedByUserId: input.decidedByUserId,
      comments: input.comments,
      repairTarget: input.repairTarget,
    },
  });
}

export async function listHumanApprovals(
  db: HumanApprovalDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<HumanApprovalRecord[]> {
  return db.humanApproval.findMany({ where: { campaignId, workspaceId } });
}

/** Most recent decision at a gate, by `decidedAt` — later rows supersede earlier ones. */
export function latestApprovalForGate(
  approvals: HumanApprovalRecord[],
  gate: ApprovalGate,
): HumanApprovalRecord | undefined {
  return approvals
    .filter((a) => a.gate === gate)
    .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime())[0];
}
