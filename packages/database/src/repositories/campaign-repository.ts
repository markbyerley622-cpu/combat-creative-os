import type { CampaignStage } from '@combat/domain';

export interface CampaignRecord {
  id: string;
  workspaceId: string;
  name: string;
  idempotencyKey?: string;
  currentStage: CampaignStage;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignDataSource {
  campaign: {
    create(args: {
      data: { workspaceId: string; name: string; idempotencyKey?: string };
    }): Promise<CampaignRecord>;
    findFirst(args: {
      where: { id: string; workspaceId: string } | { workspaceId: string; idempotencyKey: string };
    }): Promise<CampaignRecord | null>;
    findMany(args: { where: { workspaceId: string } }): Promise<CampaignRecord[]>;
  };
}

/**
 * Idempotent by `(workspaceId, idempotencyKey)` when a key is supplied
 * (CLAUDE.md workflow-idempotency rule, applied here to campaign creation
 * rather than a provider/DB call inside an Activity): a duplicate POST
 * /campaigns request with the same key returns the original campaign
 * instead of creating a second one. Omitting the key (existing test
 * fixtures, seed scripts) always creates a new row, matching pre-M4
 * behavior exactly.
 */
export async function createCampaign(
  db: CampaignDataSource,
  workspaceId: string,
  input: { name: string; idempotencyKey?: string },
): Promise<CampaignRecord> {
  if (input.idempotencyKey) {
    const existing = await db.campaign.findFirst({
      where: { workspaceId, idempotencyKey: input.idempotencyKey },
    });
    if (existing) return existing;
  }
  return db.campaign.create({
    data: { workspaceId, name: input.name, idempotencyKey: input.idempotencyKey },
  });
}

export async function getCampaign(
  db: CampaignDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<CampaignRecord | null> {
  return db.campaign.findFirst({ where: { id: campaignId, workspaceId } });
}

export async function listCampaignsForWorkspace(
  db: CampaignDataSource,
  workspaceId: string,
): Promise<CampaignRecord[]> {
  return db.campaign.findMany({ where: { workspaceId } });
}
