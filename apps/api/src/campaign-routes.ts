import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { WorkflowClient } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import {
  CampaignBriefContentSchema,
  DEFAULT_MAX_REVISIONS_PER_GATE,
  DEFAULT_MAX_VARIANT_REPAIR_ATTEMPTS,
  roleHasPermission,
  type RoleName,
} from '@combat/domain';
import {
  createCampaign,
  getCampaign,
  getLatestAcceptedCampaignBrief,
  getLatestCampaignBrief,
  getLatestCreativeConcept,
  getLatestScript,
  getLatestStrategy,
  latestApprovalForGate,
  listCampaignsForWorkspace,
  listHumanApprovals,
  listMembershipsForWorkspace,
  listShotsForScript,
  saveDraftCampaignBrief,
  submitCampaignBrief,
} from '@combat/database';
import { workflows } from '@combat/workflows';
import type { CampaignDatabase } from './campaign-database';
import { campaignProductionWorkflowId } from './campaign-workflow-id';
import { requirePrincipal } from './authentication';

export interface CampaignRouteDeps {
  db: CampaignDatabase;
  workflowClient: WorkflowClient;
  /** Overridable for tests — real production wiring defaults to a fixed name (see DEFAULT_TASK_QUEUE below). */
  taskQueue?: string;
}

const DEFAULT_TASK_QUEUE = 'campaign-production';

/**
 * AAMP-1 step 2: the caller's identity is `request.principal.userId`, set by
 * the authentication hook from a verified Clerk session token. No schema in
 * this file carries a `userId`, and each is `.strict()` — so a client that
 * still sends one gets a 400 rather than having it quietly ignored, which is
 * what makes "no mutating route accepts caller identity from request input"
 * an enforced property rather than a convention.
 */
const CreateCampaignBodySchema = z
  .object({
    name: z.string().min(1),
    idempotencyKey: z.string().min(1).optional(),
  })
  .strict();

const SaveDraftBriefBodySchema = z
  .object({
    content: CampaignBriefContentSchema.partial(),
  })
  .strict();

const SubmitBriefBodySchema = z
  .object({
    content: CampaignBriefContentSchema,
  })
  .strict();

const StartWorkflowBodySchema = z.object({}).strict();

interface AuthorizedRequestOk {
  ok: true;
  role: RoleName;
}
interface AuthorizedRequestFail {
  ok: false;
  status: number;
  body: { error: string; message: string };
}

/** Resolves the caller's role from a persisted Membership row and checks the permission — the same two-step CLAUDE.md security rule approval-routes.ts already enforces, factored out here since every route in this file needs it. `requiredPermission: null` means "any workspace member" (used by the read-only GET routes). */
async function authorize(
  db: CampaignDatabase,
  workspaceId: string,
  userId: string,
  requiredPermission: Parameters<typeof roleHasPermission>[1] | null,
): Promise<AuthorizedRequestOk | AuthorizedRequestFail> {
  const memberships = await listMembershipsForWorkspace(db, workspaceId);
  const membership = memberships.find((m) => m.userId === userId);
  if (!membership) {
    return {
      ok: false,
      status: 403,
      body: { error: 'FORBIDDEN', message: 'caller is not a member of this workspace' },
    };
  }
  const role = membership.role as RoleName;
  if (requiredPermission && !roleHasPermission(role, requiredPermission)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'FORBIDDEN', message: `role ${role} lacks permission ${requiredPermission}` },
    };
  }
  return { ok: true, role };
}

/** See approval-routes.ts's identical doc comment for why `app`'s type is this loose. */
export function registerCampaignRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: CampaignRouteDeps,
): void {
  const taskQueue = deps.taskQueue ?? DEFAULT_TASK_QUEUE;

  // --- Create campaign ------------------------------------------------
  app.post<{ Params: { workspaceId: string }; Body: unknown }>(
    '/workspaces/:workspaceId/campaigns',
    async (request, reply) => {
      const { workspaceId } = request.params;
      const parsed = CreateCampaignBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: parsed.error.issues });
      }
      const auth = await authorize(
        deps.db,
        workspaceId,
        requirePrincipal(request).userId,
        'MANAGE_CAMPAIGNS',
      );
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await createCampaign(deps.db, workspaceId, {
        name: parsed.data.name,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return reply.status(201).send({ campaign });
    },
  );

  // --- List campaigns ---------------------------------------------------
  app.get<{ Params: { workspaceId: string }; Querystring: unknown }>(
    '/workspaces/:workspaceId/campaigns',
    async (request, reply) => {
      const { workspaceId } = request.params;
      const auth = await authorize(deps.db, workspaceId, requirePrincipal(request).userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaigns = await listCampaignsForWorkspace(deps.db, workspaceId);
      return reply.status(200).send({ campaigns });
    },
  );

  // --- Save draft brief ---------------------------------------------------
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/brief/draft',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = SaveDraftBriefBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: parsed.error.issues });
      }
      const auth = await authorize(
        deps.db,
        workspaceId,
        requirePrincipal(request).userId,
        'MANAGE_CAMPAIGNS',
      );
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const brief = await saveDraftCampaignBrief(deps.db, workspaceId, {
        campaignId,
        content: parsed.data.content as never,
      });
      return reply.status(201).send({ brief });
    },
  );

  // --- Submit brief ---------------------------------------------------
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/brief/submit',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = SubmitBriefBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: parsed.error.issues });
      }
      const auth = await authorize(
        deps.db,
        workspaceId,
        requirePrincipal(request).userId,
        'MANAGE_CAMPAIGNS',
      );
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }
      if (campaign.currentStage !== 'DRAFT') {
        return reply.status(409).send({
          error: 'ALREADY_SUBMITTED',
          message: `campaign is at stage ${campaign.currentStage}, past brief submission`,
        });
      }

      const brief = await submitCampaignBrief(deps.db, workspaceId, {
        campaignId,
        content: parsed.data.content,
      });
      return reply.status(201).send({ brief });
    },
  );

  // --- Start workflow ---------------------------------------------------
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/workflow/start',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = StartWorkflowBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: parsed.error.issues });
      }
      const auth = await authorize(
        deps.db,
        workspaceId,
        requirePrincipal(request).userId,
        'MANAGE_CAMPAIGNS',
      );
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }
      const acceptedBrief = await getLatestAcceptedCampaignBrief(deps.db, workspaceId, campaignId);
      if (!acceptedBrief) {
        return reply.status(409).send({
          error: 'BRIEF_NOT_SUBMITTED',
          message: 'campaign has no submitted brief yet',
        });
      }

      const workflowId = campaignProductionWorkflowId(campaignId);
      try {
        await deps.workflowClient.start(workflows.campaignProductionWorkflow, {
          workflowId,
          taskQueue,
          args: [
            {
              workspaceId,
              campaignId,
              workflowRunId: randomUUID(),
              initialStage: campaign.currentStage,
              maxRevisionsPerGate: DEFAULT_MAX_REVISIONS_PER_GATE,
              // M6: no provider-selection mechanism exists yet (see
              // campaign-production-workflow-contracts.ts's doc comment) —
              // every campaign targets the deterministic mock provider.
              videoProviderId: 'mock-video-generation',
              // M12: the resolved delivery profile drives which variant
              // durations VARIANT_GENERATION cuts (docs/architecture.md §7.2
              // open question 5, resolved in M12).
              deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
              maxVariantRepairAttempts: DEFAULT_MAX_VARIANT_REPAIR_ATTEMPTS,
            },
          ],
        });
        return reply.status(202).send({ workflowId, alreadyRunning: false });
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
          // Duplicate-start protection: the deterministic workflow ID means a
          // retried/duplicate request always collides with the original
          // execution rather than starting a second one — treated as success.
          return reply.status(202).send({ workflowId, alreadyRunning: true });
        }
        request.log.error({ err: error, campaignId }, 'failed to start campaign workflow');
        return reply.status(502).send({
          error: 'WORKFLOW_START_FAILED',
          message: 'could not start the campaign workflow',
        });
      }
    },
  );

  // --- Campaign status (DB stage + live workflow state, best-effort) ------
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/status',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const auth = await authorize(deps.db, workspaceId, requirePrincipal(request).userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const workflow = await queryWorkflowState(deps.workflowClient, campaignId);
      return reply.status(200).send({
        campaignId,
        currentStage: campaign.currentStage,
        workflow,
      });
    },
  );

  // --- Strategy / concept / script retrieval ------------------------------
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/strategy',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const auth = await authorize(deps.db, workspaceId, requirePrincipal(request).userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }
      const strategy = await getLatestStrategy(deps.db, workspaceId, campaignId);
      return reply.status(200).send({ strategy: strategy ?? null });
    },
  );

  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/concept',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const auth = await authorize(deps.db, workspaceId, requirePrincipal(request).userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }
      const concept = await getLatestCreativeConcept(deps.db, workspaceId, campaignId);
      return reply.status(200).send({ concept: concept ?? null });
    },
  );

  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/script',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const auth = await authorize(deps.db, workspaceId, requirePrincipal(request).userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }
      const script = await getLatestScript(deps.db, workspaceId, campaignId);
      const shots = script ? await listShotsForScript(deps.db, script.id) : [];
      return reply
        .status(200)
        .send({ script: script ?? null, shots: shots.sort((a, b) => a.index - b.index) });
    },
  );

  // --- Brief (latest version, for the editor to resume from) -------------
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/brief',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const auth = await authorize(deps.db, workspaceId, requirePrincipal(request).userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }
      const brief = await getLatestCampaignBrief(deps.db, workspaceId, campaignId);
      return reply.status(200).send({ brief: brief ?? null });
    },
  );

  // --- Concept Approval gate state -----------------------------------
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/approvals/concept/state',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const auth = await authorize(deps.db, workspaceId, requirePrincipal(request).userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const approvals = await listHumanApprovals(deps.db, workspaceId, campaignId);
      const latest = latestApprovalForGate(approvals, 'CONCEPT');
      const workflow = await queryWorkflowState(deps.workflowClient, campaignId);

      return reply.status(200).send({
        currentStage: campaign.currentStage,
        isPending: workflow?.pendingGate === 'CONCEPT',
        revisionCount: workflow?.revisionCounts?.CONCEPT ?? 0,
        latestDecision: latest ?? null,
      });
    },
  );
}

interface WorkflowStateSnapshot {
  status: string;
  pendingGate: string | null;
  revisionCounts: { CONCEPT: number };
}

/**
 * Best-effort read of live workflow state — `null` (never a thrown error to
 * the caller) when the workflow hasn't started yet or the query fails, since
 * a not-yet-started campaign is a normal, expected state for these GET
 * routes to describe, not a failure.
 */
async function queryWorkflowState(
  workflowClient: WorkflowClient,
  campaignId: string,
): Promise<WorkflowStateSnapshot | null> {
  try {
    const handle = workflowClient.getHandle(campaignProductionWorkflowId(campaignId));
    const [status, pendingGate, conceptRevisionCount] = await Promise.all([
      handle.query(workflows.getStatusQuery),
      handle.query(workflows.getPendingGateQuery),
      handle.query(workflows.getRevisionCountQuery, 'CONCEPT'),
    ]);
    return { status, pendingGate, revisionCounts: { CONCEPT: conceptRevisionCount } };
  } catch {
    return null;
  }
}
