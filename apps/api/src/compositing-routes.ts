import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { WorkflowClient } from '@temporalio/client';
import {
  compositingChildWorkflowId,
  roleHasPermission,
  type Permission,
  type RoleName,
} from '@combat/domain';
import {
  getAsset,
  getBudgetStatus,
  getCampaign,
  getCompositionJobForSpecification,
  getLatestRoughEditSpecification,
  listCompositionAttempts,
  listMembershipsForWorkspace,
} from '@combat/database';
import type { StorageProvider } from '@combat/providers';
import { workflows } from '@combat/workflows';
import type { CompositingDatabase } from './compositing-database';

export interface CompositingRouteDeps {
  readonly db: CompositingDatabase;
  readonly storageProvider: StorageProvider;
  readonly workflowClient: WorkflowClient;
  readonly previewUrlExpirySeconds?: number;
}

const BASE = '/workspaces/:workspaceId/campaigns/:campaignId/compositing';
const UserIdQuerySchema = z.object({ userId: z.string().uuid() });

async function authorize(
  db: CompositingDatabase,
  workspaceId: string,
  userId: string,
  requiredPermission: Permission | null,
): Promise<{ ok: true } | { ok: false; status: number; body: { error: string; message: string } }> {
  const memberships = await listMembershipsForWorkspace(db, workspaceId);
  const membership = memberships.find((m) => m.userId === userId);
  if (!membership) {
    return {
      ok: false,
      status: 403,
      body: { error: 'FORBIDDEN', message: 'caller is not a member of this workspace' },
    };
  }
  if (requiredPermission && !roleHasPermission(membership.role as RoleName, requiredPermission)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'FORBIDDEN',
        message: `role ${membership.role} lacks permission ${requiredPermission}`,
      },
    };
  }
  return { ok: true };
}

export function registerCompositingRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: CompositingRouteDeps,
): void {
  const previewExpiry = deps.previewUrlExpirySeconds ?? 3600;

  // --- GET: rough-edit status (spec, attempts, budget, workflow stage) ---
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    BASE,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = UserIdQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.status(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
      const auth = await authorize(deps.db, workspaceId, parsed.data.userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign)
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });

      const [spec, workspaceBudget, campaignBudget] = await Promise.all([
        getLatestRoughEditSpecification(deps.db, workspaceId, campaignId),
        getBudgetStatus(deps.db, workspaceId, 'WORKSPACE', workspaceId),
        getBudgetStatus(deps.db, workspaceId, 'CAMPAIGN', campaignId),
      ]);
      const budget = { workspace: workspaceBudget, campaign: campaignBudget };

      let job = null;
      let attempts: unknown[] = [];
      let roughEditAssetId: string | null = null;
      if (spec) {
        job = await getCompositionJobForSpecification(deps.db, workspaceId, spec.id);
        if (job) {
          const rows = await listCompositionAttempts(deps.db, job.id);
          attempts = rows.map((a) => ({
            id: a.id,
            attemptNumber: a.attemptNumber,
            status: a.status,
            providerId: a.providerId,
            estimatedCostCents: a.estimatedCostCents ?? null,
            actualCostCents: a.actualCostCents ?? null,
            failureReason: a.failureReason ?? null,
            failureMessage: a.failureMessage ?? null,
            startedAt: a.startedAt,
            completedAt: a.completedAt ?? null,
          }));
          roughEditAssetId = rows.find((a) => a.status === 'SUCCEEDED')?.outputAssetId ?? null;
        }
      }

      return reply.status(200).send({
        campaign: {
          currentStage: campaign.currentStage,
          isCompositingStage: campaign.currentStage === 'COMPOSITING',
        },
        roughEditSpecification: spec
          ? {
              id: spec.id,
              version: spec.version,
              outputFormat: spec.outputFormat,
              aspectRatio: spec.aspectRatio,
              resolutionWidth: spec.resolutionWidth,
              resolutionHeight: spec.resolutionHeight,
              frameRate: spec.frameRate,
              targetDurationFrames: spec.targetDurationFrames,
              shotSelectionSetId: spec.shotSelectionSetId,
              shotSelectionSetVersion: spec.shotSelectionSetVersion,
              // Source selection: one clip per shot with its pinned source asset.
              clips: spec.tracks
                .filter((t) => t.trackType === 'VIDEO')
                .flatMap((t) => t.clips)
                .map((c) => ({
                  order: c.order,
                  shotIndex: c.shotIndex,
                  sourceAssetId: c.sourceAssetId,
                  durationFrames: c.durationFrames,
                  transitionIn: c.transitionIn ?? null,
                })),
              overlays: spec.overlays,
              pacingNotes: spec.pacingNotes,
              continuityNotes: spec.continuityNotes,
              captionPlaceholder: spec.captionPlaceholder,
              musicPlaceholder: spec.musicPlaceholder,
              sfxPlaceholder: spec.sfxPlaceholder,
              editRationale: spec.editRationale,
              qualityRubric: spec.qualityRubric,
              platform: spec.platform,
            }
          : null,
        compositionJob: job
          ? {
              id: job.id,
              status: job.status,
              attemptCount: job.attemptCount,
              maxAttempts: job.maxAttempts,
            }
          : null,
        attempts,
        // The mock render writes no bytes — the dashboard renders a placeholder, never a <video>.
        roughEdit: { assetId: roughEditAssetId, hasMedia: false as const },
        budget,
      });
    },
  );

  // --- GET: signed rough-edit preview URL (never the s3Key) ---
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    `${BASE}/preview`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = UserIdQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.status(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
      const auth = await authorize(deps.db, workspaceId, parsed.data.userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign)
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });

      const spec = await getLatestRoughEditSpecification(deps.db, workspaceId, campaignId);
      const job = spec
        ? await getCompositionJobForSpecification(deps.db, workspaceId, spec.id)
        : null;
      const attempts = job ? await listCompositionAttempts(deps.db, job.id) : [];
      const assetId = attempts.find((a) => a.status === 'SUCCEEDED')?.outputAssetId;
      if (!assetId) return reply.status(200).send({ hasMedia: false, url: null });
      const asset = await getAsset(deps.db, workspaceId, assetId);
      if (!asset || asset.ingestionStatus !== 'READY')
        return reply.status(200).send({ hasMedia: false, url: null });
      // The mock render writes no real bytes, so no object exists to sign — the
      // dashboard renders a deterministic placeholder. A real render worker's
      // output would exist here and yield a signed, time-limited URL (never the
      // s3Key itself).
      const hasMedia = await deps.storageProvider.objectExists(asset.s3Key);
      const url = hasMedia
        ? await deps.storageProvider.getPresignedUrl(asset.s3Key, previewExpiry)
        : null;
      return reply.status(200).send({ hasMedia, url });
    },
  );

  // --- POST: cancel the active render (authorized) ---
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    `${BASE}/cancel`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const body = z.object({ userId: z.string().uuid() }).safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: 'INVALID_BODY', issues: body.error.issues });
      const auth = await authorize(deps.db, workspaceId, body.data.userId, 'TRIGGER_GENERATION');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign)
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });

      // Signal the CompositingWorkflow child (targeted by the campaign-derived
      // deterministic id — apps/api never advances the workflow itself). The
      // cancellation outcome is auditable via the CompositionAttempt CANCELLED
      // status the poll Activity writes.
      try {
        const handle = deps.workflowClient.getHandle(compositingChildWorkflowId(campaignId));
        await handle.signal(workflows.cancelCompositingSignal);
      } catch (error) {
        request.log.error({ err: error, campaignId }, 'failed to signal compositing cancel');
        return reply.status(502).send({
          error: 'WORKFLOW_SIGNAL_FAILED',
          message: 'could not signal the compositing workflow',
        });
      }
      return reply.status(202).send({ cancelRequested: true });
    },
  );
}
