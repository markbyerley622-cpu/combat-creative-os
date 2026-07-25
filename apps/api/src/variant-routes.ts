import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { WorkflowClient } from '@temporalio/client';
import { roleHasPermission, variantChildWorkflowId, type RoleName } from '@combat/domain';
import {
  getAsset,
  getBudgetStatus,
  getCampaign,
  getQualityAssessmentForAsset,
  getVariantGenerationJobForSpecification,
  listCreativeVariants,
  listMembershipsForWorkspace,
  listQualityFailuresForAssessment,
  listVariantGenerationAttempts,
  listVariantSpecifications,
} from '@combat/database';
import { workflows } from '@combat/workflows';
import type { StorageProvider } from '@combat/providers';
import type { VariantDatabase } from './variant-database';

export interface VariantRouteDeps {
  readonly db: VariantDatabase;
  readonly storageProvider: StorageProvider;
  readonly workflowClient: WorkflowClient;
  readonly previewUrlExpirySeconds?: number;
}

const BASE = '/workspaces/:workspaceId/campaigns/:campaignId/variants';
const UserIdQuerySchema = z.object({ userId: z.string().uuid() });

async function authorize(
  db: VariantDatabase,
  workspaceId: string,
  userId: string,
  permission?: Parameters<typeof roleHasPermission>[1],
): Promise<
  { ok: true; role: RoleName } | { ok: false; status: number; body: Record<string, unknown> }
> {
  const memberships = await listMembershipsForWorkspace(db, workspaceId);
  const membership = memberships.find((m) => m.userId === userId);
  if (!membership) {
    return {
      ok: false,
      status: 403,
      body: { error: 'FORBIDDEN', message: 'caller is not a member of this workspace' },
    };
  }
  if (permission && !roleHasPermission(membership.role as RoleName, permission)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'FORBIDDEN',
        message: `role ${membership.role} lacks permission ${permission}`,
      },
    };
  }
  return { ok: true, role: membership.role as RoleName };
}

/**
 * M12 — the read surface behind `apps/dashboard`'s variant screen, plus the one
 * authorized cancel action.
 *
 * **Read-only by design, and deliberately export-free**: there is no download,
 * export, or publish endpoint here. The preview endpoint returns a signed,
 * time-limited URL only when real bytes exist (they never do against the
 * deterministic mock renderer), never the `s3Key` itself — exactly the M9
 * compositing-preview contract. Export and distribution are out of M12 scope.
 */
export function registerVariantRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: VariantRouteDeps,
): void {
  const previewExpiry = deps.previewUrlExpirySeconds ?? 3600;

  // --- GET: every variant specification + status + QA verdict ---
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    BASE,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = UserIdQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, parsed.data.userId);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const [specifications, variants, workspaceBudget, campaignBudget] = await Promise.all([
        listVariantSpecifications(deps.db, workspaceId, campaignId),
        listCreativeVariants(deps.db, workspaceId, campaignId),
        getBudgetStatus(deps.db, workspaceId, 'WORKSPACE', workspaceId),
        getBudgetStatus(deps.db, workspaceId, 'CAMPAIGN', campaignId),
      ]);
      const variantBySpecId = new Map(
        variants.filter((v) => v.variantSpecificationId).map((v) => [v.variantSpecificationId, v]),
      );

      const rows = [];
      for (const spec of specifications) {
        const variant = variantBySpecId.get(spec.id);
        // eslint-disable-next-line no-await-in-loop -- bounded by the profile's duration count (3)
        const job = await getVariantGenerationJobForSpecification(deps.db, workspaceId, spec.id);
        const attempts = job
          ? // eslint-disable-next-line no-await-in-loop -- same rationale
            await listVariantGenerationAttempts(deps.db, job.id)
          : [];
        // The VARIANT_QA verdict is the asset-based assessment over the
        // variant's own asset — read through the repository, never by id alone.
        const assessment = variant?.assetId
          ? // eslint-disable-next-line no-await-in-loop -- same rationale
            await getQualityAssessmentForAsset(deps.db, workspaceId, variant.assetId, 'VARIANT_QA')
          : undefined;
        const findings = assessment
          ? // eslint-disable-next-line no-await-in-loop -- same rationale
            await listQualityFailuresForAssessment(deps.db, assessment.id)
          : [];

        rows.push({
          specification: {
            id: spec.id,
            version: spec.version,
            targetDurationSeconds: spec.targetDurationSeconds,
            targetDurationFrames: spec.targetDurationFrames,
            platform: spec.platform,
            aspectRatio: spec.aspectRatio,
            resolutionWidth: spec.resolutionWidth,
            resolutionHeight: spec.resolutionHeight,
            frameRate: spec.frameRate,
            deliveryProfileKey: spec.deliveryProfileKey,
            deliveryProfileVersion: spec.deliveryProfileVersion,
            parentMasterAssetId: spec.parentMasterAssetId,
            cutPoints: spec.cutPoints,
            retainedClips: spec.retainedClips,
            retainedCues: spec.retainedCues,
            retainedCaptions: spec.retainedCaptions,
            ctaPlacement: spec.ctaPlacement,
            captionBurnRequired: spec.captionBurnRequired,
            safeAreas: spec.safeAreas,
            cutRationale: spec.cutRationale,
            removedRationale: spec.removedRationale,
            approvedForExport: spec.approvedForExportAt !== undefined,
            superseded: spec.supersededAt !== undefined,
          },
          variant: variant
            ? {
                id: variant.id,
                status: variant.status,
                assetId: variant.assetId ?? null,
                // Mock renders carry no bytes — the dashboard shows a placeholder.
                hasMedia: false as const,
              }
            : null,
          qa: assessment
            ? {
                id: assessment.id,
                pass: assessment.pass,
                overallScore: assessment.overallScore,
                scores: assessment.scores,
                findings: findings.map((f) => ({
                  id: f.id,
                  category: f.category,
                  severity: f.severity,
                  description: f.description,
                  suggestedAction: f.suggestedAction ?? null,
                })),
              }
            : null,
          job: job
            ? {
                id: job.id,
                status: job.status,
                attemptCount: job.attemptCount,
                maxAttempts: job.maxAttempts,
              }
            : null,
          attempts: attempts.map((a) => ({
            attemptNumber: a.attemptNumber,
            status: a.status,
            estimatedCostCents: a.estimatedCostCents ?? null,
            actualCostCents: a.actualCostCents ?? null,
            failureReason: a.failureReason ?? null,
            failureMessage: a.failureMessage ?? null,
          })),
        });
      }

      return reply.status(200).send({
        campaign: {
          currentStage: campaign.currentStage,
          isVariantStage:
            campaign.currentStage === 'VARIANT_GENERATION' ||
            campaign.currentStage === 'VARIANT_QA',
        },
        caller: {
          role: auth.role,
          canCancel: roleHasPermission(auth.role, 'TRIGGER_GENERATION'),
        },
        variants: rows,
        budget: { workspace: workspaceBudget, campaign: campaignBudget },
      });
    },
  );

  // --- GET: signed variant preview URL (never the s3Key) ---
  app.get<{
    Params: { workspaceId: string; campaignId: string; assetId: string };
    Querystring: unknown;
  }>(`${BASE}/:assetId/preview`, async (request, reply) => {
    const { workspaceId, campaignId, assetId } = request.params;
    const parsed = UserIdQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
    }
    const auth = await authorize(deps.db, workspaceId, parsed.data.userId);
    if (!auth.ok) return reply.status(auth.status).send(auth.body);

    const campaign = await getCampaign(deps.db, workspaceId, campaignId);
    if (!campaign) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
    }
    const asset = await getAsset(deps.db, workspaceId, assetId);
    if (!asset || asset.campaignId !== campaignId || asset.kind !== 'VARIANT') {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'variant asset not found' });
    }

    // The mock render writes no real bytes, so no object exists to sign — the
    // dashboard renders a deterministic placeholder. A real render worker's
    // output would exist here and yield a signed, time-limited URL.
    const hasMedia = await deps.storageProvider.objectExists(asset.s3Key);
    const url = hasMedia
      ? await deps.storageProvider.getPresignedUrl(asset.s3Key, previewExpiry)
      : null;
    return reply.status(200).send({ hasMedia, url });
  });

  // --- POST: cancel the active variant run (authorized) ---
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    `${BASE}/cancel`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const body = z.object({ userId: z.string().uuid() }).safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: body.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, body.data.userId, 'TRIGGER_GENERATION');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      // Signal the VariantWorkflow child (targeted by the campaign-derived
      // deterministic id — apps/api never advances the workflow itself). The
      // cancellation outcome is auditable via the CANCELLED attempt status the
      // cancel Activity writes.
      try {
        const handle = deps.workflowClient.getHandle(variantChildWorkflowId(campaignId));
        await handle.signal(workflows.cancelVariantsSignal);
      } catch (error) {
        request.log.error({ err: error, campaignId }, 'failed to signal variant cancel');
        return reply.status(502).send({
          error: 'WORKFLOW_SIGNAL_FAILED',
          message: 'could not signal the variant workflow',
        });
      }
      return reply.status(202).send({ cancelRequested: true });
    },
  );
}
