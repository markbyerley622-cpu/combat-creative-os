import type { CampaignStage } from '@combat/domain';

export interface CampaignRecord {
  id: string;
  workspaceId: string;
  name: string;
  currentStage: CampaignStage;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignDataSource {
  campaign: {
    create(args: { data: { workspaceId: string; name: string } }): Promise<CampaignRecord>;
    findFirst(args: { where: { id: string; workspaceId: string } }): Promise<CampaignRecord | null>;
  };
}

export async function createCampaign(
  db: CampaignDataSource,
  workspaceId: string,
  input: { name: string },
): Promise<CampaignRecord> {
  return db.campaign.create({ data: { workspaceId, name: input.name } });
}

export async function getCampaign(
  db: CampaignDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<CampaignRecord | null> {
  return db.campaign.findFirst({ where: { id: campaignId, workspaceId } });
}
