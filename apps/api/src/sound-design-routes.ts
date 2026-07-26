import type { FastifyInstance } from 'fastify';
import {
  getBudgetStatus,
  getCampaign,
  getLatestSoundDesignPlan,
  getLatestTimeline,
  listMembershipsForWorkspace,
  listSoundCuesForTimeline,
  listTimelineEntries,
} from '@combat/database';
import type { SoundDesignDatabase } from './sound-design-database';
import { requirePrincipal } from './authentication';

export interface SoundDesignRouteDeps {
  readonly db: SoundDesignDatabase;
}

const BASE = '/workspaces/:workspaceId/campaigns/:campaignId/sound-design';

async function authorizeMember(
  db: SoundDesignDatabase,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const memberships = await listMembershipsForWorkspace(db, workspaceId);
  return memberships.some((m) => m.userId === userId);
}

export function registerSoundDesignRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: SoundDesignRouteDeps,
): void {
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    BASE,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      if (!(await authorizeMember(deps.db, workspaceId, requirePrincipal(request).userId))) {
        return reply
          .status(403)
          .send({ error: 'FORBIDDEN', message: 'caller is not a member of this workspace' });
      }
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const [plan, timeline, workspaceBudget, campaignBudget] = await Promise.all([
        getLatestSoundDesignPlan(deps.db, workspaceId, campaignId),
        getLatestTimeline(deps.db, workspaceId, campaignId),
        getBudgetStatus(deps.db, workspaceId, 'WORKSPACE', workspaceId),
        getBudgetStatus(deps.db, workspaceId, 'CAMPAIGN', campaignId),
      ]);
      const budget = { workspace: workspaceBudget, campaign: campaignBudget };

      const entries = timeline ? await listTimelineEntries(deps.db, timeline.id) : [];
      const cues = timeline ? await listSoundCuesForTimeline(deps.db, timeline.id) : [];

      return reply.status(200).send({
        campaign: {
          currentStage: campaign.currentStage,
          isSoundDesignStage: campaign.currentStage === 'SOUND_DESIGN',
        },
        plan: plan
          ? {
              id: plan.id,
              version: plan.version,
              musicBrief: plan.musicBrief,
              mixNotes: plan.mixNotes,
              brandAudioGuidelines: plan.brandAudioGuidelines,
              qualityRubric: plan.qualityRubric,
              roughEditSpecificationId: plan.roughEditSpecificationId,
            }
          : null,
        timeline: timeline
          ? {
              id: timeline.id,
              version: timeline.version,
              frameRate: timeline.frameRate,
              durationFrames: timeline.durationFrames,
              entries: entries.map((e) => ({
                order: e.order,
                shotId: e.shotId,
                startFrame: e.startFrame,
                durationFrames: e.durationFrames,
              })),
            }
          : null,
        cues: cues.map((c) => ({
          id: c.id,
          type: c.type,
          startFrame: c.startFrame,
          durationFrames: c.durationFrames,
          notes: c.notes ?? null,
          // Mock stems carry no real audio bytes — the dashboard renders a placeholder.
          hasMedia: false as const,
          assetId: c.assetId ?? null,
        })),
        budget,
      });
    },
  );
}
