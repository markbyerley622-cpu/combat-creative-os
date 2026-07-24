import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { WorkflowClient } from '@temporalio/client';
import {
  ApprovalDecisionSchema,
  FINAL_APPROVAL_REPAIR_TARGETS,
  roleHasPermission,
  type ApprovalDecision,
  type ApprovalGate,
  type Permission,
  type RoleName,
} from '@combat/domain';
import {
  getCampaign,
  latestApprovalForGate,
  listHumanApprovals,
  listMembershipsForWorkspace,
  recordHumanApproval,
} from '@combat/database';
import { workflows } from '@combat/workflows';
import type { ApprovalDatabase } from './approval-database';
import { campaignProductionWorkflowId } from './campaign-workflow-id';

export interface ApprovalRouteDeps {
  db: ApprovalDatabase;
  workflowClient: WorkflowClient;
}

const ConceptOrShotSelectionBodySchema = z.object({
  userId: z.string().uuid(),
  decision: ApprovalDecisionSchema,
  comments: z.string().optional(),
});

const FinalApprovalBodySchema = z
  .object({
    userId: z.string().uuid(),
    decision: ApprovalDecisionSchema,
    comments: z.string().optional(),
    repairTarget: z.enum(FINAL_APPROVAL_REPAIR_TARGETS).optional(),
  })
  .refine(
    (body) =>
      body.decision !== 'APPROVED'
        ? body.repairTarget !== undefined
        : body.repairTarget === undefined,
    {
      message:
        'repairTarget is required for a non-approved FINAL decision, and must be absent otherwise',
    },
  );

interface GateRouteConfig {
  path: string;
  gate: ApprovalGate;
  permission: Permission;
  signal: typeof workflows.approveConceptSignal;
  bodySchema: typeof ConceptOrShotSelectionBodySchema | typeof FinalApprovalBodySchema;
}

const GATE_ROUTES: GateRouteConfig[] = [
  {
    path: '/workspaces/:workspaceId/campaigns/:campaignId/approvals/concept',
    gate: 'CONCEPT',
    permission: 'APPROVE_CONCEPT',
    signal: workflows.approveConceptSignal,
    bodySchema: ConceptOrShotSelectionBodySchema,
  },
  {
    path: '/workspaces/:workspaceId/campaigns/:campaignId/approvals/shot-selection',
    gate: 'SHOT_SELECTION',
    permission: 'SELECT_SHOTS',
    signal: workflows.selectShotsSignal,
    bodySchema: ConceptOrShotSelectionBodySchema,
  },
  {
    path: '/workspaces/:workspaceId/campaigns/:campaignId/approvals/final',
    gate: 'FINAL',
    permission: 'APPROVE_FINAL_MASTER',
    signal: workflows.approveFinalSignal,
    bodySchema: FinalApprovalBodySchema,
  },
];

type FinalRepairTarget = (typeof FINAL_APPROVAL_REPAIR_TARGETS)[number];

interface ApprovalRequestBody {
  userId: string;
  decision: ApprovalDecision;
  comments?: string;
  repairTarget?: FinalRepairTarget;
}

/**
 * Registers the three human-approval-gate endpoints. Every route, in order:
 * 1. Resolves the caller's role from a persisted `Membership` row (there is
 *    no session/auth layer yet — see the limitation noted in the milestone
 *    report this change ships with) and checks it against
 *    `roleHasPermission` before doing anything else (CLAUDE.md security rule).
 * 2. Looks up the campaign scoped to `workspaceId`; a wrong workspace or
 *    unknown campaign 404s rather than leaking existence.
 * 3. Persists the decision as an immutable `HumanApproval` row *before*
 *    signalling — deduping an exact retry (same gate/stage/user/decision)
 *    against the latest recorded approval so a resent HTTP request can't
 *    create two rows or double-signal.
 * 4. Signals `CampaignProductionWorkflow`, which independently re-verifies
 *    the approval via `verifyHumanApprovalActivity` before ever trusting it —
 *    this endpoint dispatching the signal is not what makes the decision
 *    authoritative, the persisted row and the workflow's own verification are.
 */
/**
 * `app` is typed loosely (not the default-generic `FastifyInstance`)
 * because `buildServer` constructs Fastify with a concrete pino `Logger`
 * (see server.ts's own doc comment on why its return type is inferred for
 * the same reason) — that specializes the instance's logger generic beyond
 * `FastifyBaseLogger`, which a strict `FastifyInstance` parameter here
 * wouldn't accept.
 */
export function registerApprovalRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: ApprovalRouteDeps,
): void {
  for (const route of GATE_ROUTES) {
    app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
      route.path,
      async (request, reply) => {
        const { workspaceId, campaignId } = request.params;
        const parsedBody = route.bodySchema.safeParse(request.body);
        if (!parsedBody.success) {
          return reply.status(400).send({ error: 'INVALID_BODY', issues: parsedBody.error.issues });
        }
        const body = parsedBody.data as ApprovalRequestBody;

        const memberships = await listMembershipsForWorkspace(deps.db, workspaceId);
        const membership = memberships.find((m) => m.userId === body.userId);
        if (!membership) {
          return reply.status(403).send({
            error: 'FORBIDDEN',
            message: 'caller is not a member of this workspace',
          });
        }
        if (!roleHasPermission(membership.role as RoleName, route.permission)) {
          return reply.status(403).send({
            error: 'FORBIDDEN',
            message: `role ${membership.role} lacks permission ${route.permission}`,
          });
        }

        const campaign = await getCampaign(deps.db, workspaceId, campaignId);
        if (!campaign) {
          return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
        }

        const existingApprovals = await listHumanApprovals(deps.db, workspaceId, campaignId);
        const latest = latestApprovalForGate(existingApprovals, route.gate);
        const isRetryOfLatest =
          latest !== undefined &&
          latest.stageAtDecision === campaign.currentStage &&
          latest.decidedByUserId === body.userId &&
          latest.decision === body.decision &&
          latest.repairTarget === body.repairTarget;

        const approval = isRetryOfLatest
          ? latest
          : await recordHumanApproval(deps.db, workspaceId, {
              campaignId,
              gate: route.gate,
              decision: body.decision,
              stageAtDecision: campaign.currentStage,
              decidedByUserId: body.userId,
              comments: body.comments,
              repairTarget: body.repairTarget,
            });

        try {
          const handle = deps.workflowClient.getHandle(campaignProductionWorkflowId(campaignId));
          await handle.signal(route.signal, {
            approvalId: approval.id,
            workspaceId,
            campaignId,
            gate: route.gate,
            decision: body.decision,
            decidedByUserId: body.userId,
            repairTarget: body.repairTarget,
          });
        } catch (error) {
          request.log.error(
            { err: error, campaignId, gate: route.gate },
            'failed to signal campaign workflow',
          );
          return reply.status(502).send({
            error: 'WORKFLOW_SIGNAL_FAILED',
            message: 'the decision was recorded but the campaign workflow could not be signalled',
            approvalId: approval.id,
          });
        }

        return reply.status(202).send({ approvalId: approval.id, replayed: isRetryOfLatest });
      },
    );
  }
}
