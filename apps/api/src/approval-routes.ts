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
import { requirePrincipal } from './authentication';
import { campaignProductionWorkflowId } from './campaign-workflow-id';

export interface ApprovalRouteDeps {
  db: ApprovalDatabase;
  workflowClient: WorkflowClient;
}

/**
 * AAMP-1 step 2: `userId` is gone from every schema in this file. The caller's
 * identity is `request.principal.userId`, set by the authentication hook from a
 * verified session token — a body field named `userId` is now simply an unknown
 * key, and `.strict()` rejects it outright so an attempt to supply one is a 400
 * rather than silently ignored.
 */
const ConceptOrShotSelectionBodySchema = z
  .object({
    decision: ApprovalDecisionSchema,
    comments: z.string().optional(),
  })
  .strict();

const FinalApprovalBodySchema = z
  .object({
    decision: ApprovalDecisionSchema,
    comments: z.string().optional(),
    repairTarget: z.enum(FINAL_APPROVAL_REPAIR_TARGETS).optional(),
  })
  .strict()
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
  // SHOT_SELECTION is NOT a generic gate route (M8): the shot-selection gate is
  // driven exclusively by `shot-review-routes.ts`, whose approve/
  // request-regeneration endpoints validate + freeze the persisted
  // ShotSelectionSet before recording the HumanApproval and signalling. Keeping
  // exactly one shot-selection approval path is what makes "exactly one
  // SHOT_SELECTION gate" true at the API surface, not just the workflow.
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
  decision: ApprovalDecision;
  comments?: string;
  repairTarget?: FinalRepairTarget;
}

/**
 * Registers the human-approval-gate endpoints. Every route, in order:
 * 0. Has already been authenticated by the instance-wide `onRequest` hook
 *    (AAMP-1 step 2) — `requirePrincipal` returns the verified caller, whose
 *    `userId` is a local `User.id` proven by a Clerk session token rather than
 *    asserted in the request.
 * 1. Resolves the caller's role from a persisted `Membership` row and checks it
 *    against `roleHasPermission` before doing anything else (CLAUDE.md security
 *    rule). Identity is now verified; *authorization* is unchanged and still
 *    read from PostgreSQL.
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
        const callerUserId = requirePrincipal(request).userId;
        const parsedBody = route.bodySchema.safeParse(request.body);
        if (!parsedBody.success) {
          return reply.status(400).send({ error: 'INVALID_BODY', issues: parsedBody.error.issues });
        }
        const body = parsedBody.data as ApprovalRequestBody;

        const memberships = await listMembershipsForWorkspace(deps.db, workspaceId);
        const membership = memberships.find((m) => m.userId === callerUserId);
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
          latest.decidedByUserId === callerUserId &&
          latest.decision === body.decision &&
          latest.repairTarget === body.repairTarget;

        const approval = isRetryOfLatest
          ? latest
          : await recordHumanApproval(deps.db, workspaceId, {
              campaignId,
              gate: route.gate,
              decision: body.decision,
              stageAtDecision: campaign.currentStage,
              decidedByUserId: callerUserId,
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
            decidedByUserId: callerUserId,
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
