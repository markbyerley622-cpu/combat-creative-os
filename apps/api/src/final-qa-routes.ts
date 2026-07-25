import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { roleHasPermission, type RoleName } from '@combat/domain';
import {
  getBudgetStatus,
  getCampaign,
  getLatestRoughEditSpecification,
  getLatestSoundDesignPlan,
  getLatestTimeline,
  getQualityAssessmentForAsset,
  listAssetsForCampaign,
  listMembershipsForWorkspace,
  listQualityFailuresForAssessment,
} from '@combat/database';
import type { FinalQaDatabase } from './final-qa-database';

export interface FinalQaRouteDeps {
  readonly db: FinalQaDatabase;
}

const BASE = '/workspaces/:workspaceId/campaigns/:campaignId/final-qa';
const UserIdQuerySchema = z.object({ userId: z.string().uuid() });

/**
 * M11 — the read-only surface behind `apps/dashboard`'s Final Approval screen:
 * the Final QA Controller's persisted verdict over the campaign's FINAL_MASTER,
 * its typed findings, the master's identity, and the campaign's budget.
 *
 * Read-only by design. Approving or rejecting the master goes through
 * `approval-routes.ts`'s existing `POST .../approvals/final`, which is the one
 * place the FINAL gate is ever dispatched from — this route only *reports*
 * whether the caller holds `APPROVE_FINAL_MASTER` so the UI can disable a
 * button it would otherwise be refused for. UI visibility is never
 * authorization (CLAUDE.md): the permission is re-checked server-side on the
 * approval endpoint regardless of what this route says.
 */
export function registerFinalQaRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: FinalQaRouteDeps,
): void {
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    BASE,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = UserIdQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
      }

      const memberships = await listMembershipsForWorkspace(deps.db, workspaceId);
      const membership = memberships.find((m) => m.userId === parsed.data.userId);
      if (!membership) {
        return reply
          .status(403)
          .send({ error: 'FORBIDDEN', message: 'caller is not a member of this workspace' });
      }

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const [spec, timeline, plan, masters, workspaceBudget, campaignBudget] = await Promise.all([
        getLatestRoughEditSpecification(deps.db, workspaceId, campaignId),
        getLatestTimeline(deps.db, workspaceId, campaignId),
        getLatestSoundDesignPlan(deps.db, workspaceId, campaignId),
        listAssetsForCampaign(deps.db, workspaceId, campaignId, 'FINAL_MASTER'),
        getBudgetStatus(deps.db, workspaceId, 'WORKSPACE', workspaceId),
        getBudgetStatus(deps.db, workspaceId, 'CAMPAIGN', campaignId),
      ]);

      const master = masters[0];
      const assessment = master
        ? await getQualityAssessmentForAsset(deps.db, workspaceId, master.id, 'FINAL_QA')
        : undefined;
      const findings = assessment
        ? await listQualityFailuresForAssessment(deps.db, assessment.id)
        : [];

      return reply.status(200).send({
        campaign: {
          currentStage: campaign.currentStage,
          isFinalQaStage: campaign.currentStage === 'FINAL_QA',
          isFinalApprovalStage: campaign.currentStage === 'FINAL_APPROVAL',
        },
        // Reported so the UI can disable an action the caller would be refused
        // for; the approval endpoint enforces this independently.
        caller: {
          role: membership.role,
          canApprove: roleHasPermission(membership.role as RoleName, 'APPROVE_FINAL_MASTER'),
        },
        master: master
          ? {
              id: master.id,
              checksum: master.checksum,
              originalFilename: master.originalFilename,
              // Mock masters carry no real video bytes — the dashboard renders
              // a placeholder rather than a player.
              hasMedia: false as const,
            }
          : null,
        assessment: assessment
          ? {
              id: assessment.id,
              pass: assessment.pass,
              overallScore: assessment.overallScore,
              scores: assessment.scores,
              assessedBy: assessment.assessedBy,
            }
          : null,
        findings: findings.map((f) => ({
          id: f.id,
          category: f.category,
          severity: f.severity,
          description: f.description,
          suggestedAction: f.suggestedAction ?? null,
        })),
        // What the master was judged against — the delivery format the rough
        // edit declared plus the assembled duration (see
        // run-final-qa-controller-activity.ts on why this is derived, not probed).
        deliveryContext:
          spec && timeline
            ? {
                platform: spec.platform,
                aspectRatio: spec.aspectRatio,
                resolutionWidth: spec.resolutionWidth,
                resolutionHeight: spec.resolutionHeight,
                frameRate: timeline.frameRate,
                durationFrames: timeline.durationFrames,
                soundDesignPlanVersion: plan?.version ?? null,
              }
            : null,
        budget: { workspace: workspaceBudget, campaign: campaignBudget },
      });
    },
  );
}
