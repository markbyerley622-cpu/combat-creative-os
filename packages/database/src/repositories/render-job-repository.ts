import type { RenderJob } from '@combat/domain';

export type RenderJobRecord = RenderJob;

/**
 * M9 persistence for `RenderJob` (COMPOSITING or EXPORT). The COMPOSITING
 * render this milestone writes is what the `compositingComplete` transition
 * fact reads (a SUCCEEDED COMPOSITING RenderJob), so a completed rough edit
 * lets the campaign advance out of COMPOSITING.
 */
export interface RenderJobDataSource {
  renderJob: {
    create(args: { data: Omit<RenderJobRecord, 'id' | 'createdAt'> }): Promise<RenderJobRecord>;
    findFirst(args: {
      where: { id: string; workspaceId: string };
    }): Promise<RenderJobRecord | null>;
    findMany(args: {
      where: { campaignId: string; workspaceId?: string };
    }): Promise<RenderJobRecord[]>;
  };
}

export async function createRenderJob(
  db: RenderJobDataSource,
  workspaceId: string,
  input: Omit<RenderJobRecord, 'id' | 'createdAt' | 'workspaceId'>,
): Promise<RenderJobRecord> {
  return db.renderJob.create({ data: { workspaceId, ...input } });
}

export async function getRenderJob(
  db: RenderJobDataSource,
  workspaceId: string,
  id: string,
): Promise<RenderJobRecord | null> {
  return db.renderJob.findFirst({ where: { id, workspaceId } });
}

export async function listRenderJobsForCampaign(
  db: RenderJobDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<RenderJobRecord[]> {
  return db.renderJob.findMany({ where: { campaignId, workspaceId } });
}
