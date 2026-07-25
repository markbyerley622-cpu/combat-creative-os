import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  DeliveryPlatformSchema,
  PerformanceSourceSchema,
  roleHasPermission,
  type RoleName,
} from '@combat/domain';
import {
  getAsset,
  getCampaign,
  ingestPerformanceObservation,
  listCreativeVariants,
  InvalidPerformanceMetricsError,
  listLearningRecords,
  listMembershipsForWorkspace,
  listPerformanceObservationsForCampaign,
  OpenReportingWindowError,
  reviewLearningRecord,
} from '@combat/database';
import type { PerformanceDatabase } from './performance-database';
import { assertBelongsToCampaign } from './route-authorization';

export interface PerformanceRouteDeps {
  readonly db: PerformanceDatabase;
}

const CAMPAIGN_BASE = '/workspaces/:workspaceId/campaigns/:campaignId/performance';
const LEARNINGS_BASE = '/workspaces/:workspaceId/learnings';
const UserIdQuerySchema = z.object({ userId: z.string().uuid() });

const RawMetricsSchema = z.object({
  impressions: z.number().int().nonnegative(),
  reach: z.number().int().nonnegative().optional(),
  clicks: z.number().int().nonnegative(),
  completions: z.number().int().nonnegative().optional(),
  conversions: z.number().int().nonnegative(),
  spendCents: z.number().int().nonnegative(),
});

const IngestBodySchema = z.object({
  userId: z.string().uuid(),
  /** FIXTURE or MANUAL_ENTRY only — M13 has no platform connector. */
  source: PerformanceSourceSchema,
  fixtureRef: z.string().min(1).optional(),
  observations: z
    .array(
      z.object({
        platform: DeliveryPlatformSchema,
        externalPostId: z.string().min(1),
        externalAccountId: z.string().min(1).optional(),
        creativeVariantId: z.string().uuid().optional(),
        variantAssetId: z.string().uuid().optional(),
        durationSeconds: z.number().int().positive().optional(),
        periodStart: z.string().datetime(),
        periodEnd: z.string().datetime(),
        raw: RawMetricsSchema,
      }),
    )
    .min(1),
});

const ReviewBodySchema = z.object({
  userId: z.string().uuid(),
  decision: z.enum(['APPROVED', 'REJECTED']),
});

async function authorize(
  db: PerformanceDatabase,
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
 * M13 — the internal performance/learning surface.
 *
 * **No platform integration exists here.** Ingestion accepts a deterministic
 * fixture batch or a manual entry only; there is no OAuth flow, no connector,
 * no scraper, no credential and no outbound call to any ad platform. A real
 * connector is explicitly deferred (docs/architecture.md §8's M13 entry).
 *
 * Nothing in this file can touch campaign production: it reads campaigns only
 * to scope and validate, and its writes are confined to `PerformanceObservation`
 * and the review status of a `LearningRecord`.
 */
export function registerPerformanceRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: PerformanceRouteDeps,
): void {
  // --- POST: ingest a fixture/manual batch (authorized) ---
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    `${CAMPAIGN_BASE}/observations`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = IngestBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: parsed.error.issues });
      }
      // Performance data is reporting data — gated on VIEW_REPORTING's
      // write-side counterpart, MANAGE_CAMPAIGNS, so an ANALYST can read
      // history but not fabricate it.
      const auth = await authorize(deps.db, workspaceId, parsed.data.userId, 'MANAGE_CAMPAIGNS');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      // M14: a supplied variant/asset id becomes this observation's provenance,
      // so it is verified to belong to the path campaign before it is pinned —
      // workspace scoping alone would let one campaign's data cite another's
      // creative. Variant ids are resolved once for the whole batch.
      const campaignVariantIds = new Set(
        (await listCreativeVariants(deps.db, workspaceId, campaignId)).map((v) => v.id),
      );
      for (const entry of parsed.data.observations) {
        if (entry.creativeVariantId && !campaignVariantIds.has(entry.creativeVariantId)) {
          return reply.status(404).send({
            error: 'NOT_FOUND',
            message: 'creative variant not found for this campaign',
          });
        }
        if (entry.variantAssetId) {
          // eslint-disable-next-line no-await-in-loop -- bounded by the batch; only runs when an asset id was supplied
          const asset = await getAsset(deps.db, workspaceId, entry.variantAssetId);
          const owned = assertBelongsToCampaign(asset, campaignId, 'variant asset');
          if (!owned.ok) return reply.status(owned.status).send(owned.body);
        }
      }

      const summaries: {
        observationId: string;
        externalPostId: string;
        alreadyExisted: boolean;
      }[] = [];
      for (const entry of parsed.data.observations) {
        try {
          // eslint-disable-next-line no-await-in-loop -- small, per-batch set; sequential keeps dedup deterministic
          const { observation, alreadyExisted } = await ingestPerformanceObservation(
            deps.db,
            workspaceId,
            {
              subject: {
                platform: entry.platform,
                externalPostId: entry.externalPostId,
                externalAccountId: entry.externalAccountId,
                campaignId,
                creativeVariantId: entry.creativeVariantId,
                variantAssetId: entry.variantAssetId,
                durationSeconds: entry.durationSeconds,
              },
              source: parsed.data.source,
              periodStart: new Date(entry.periodStart),
              periodEnd: new Date(entry.periodEnd),
              raw: entry.raw,
              ingestedByUserId: parsed.data.userId,
              fixtureRef: parsed.data.fixtureRef,
            },
          );
          summaries.push({
            observationId: observation.id,
            externalPostId: entry.externalPostId,
            alreadyExisted,
          });
        } catch (error) {
          if (error instanceof OpenReportingWindowError) {
            return reply.status(422).send({
              error: 'OPEN_WINDOW',
              externalPostId: entry.externalPostId,
              message: error.message,
            });
          }
          if (error instanceof InvalidPerformanceMetricsError) {
            return reply.status(422).send({
              error: 'INVALID_METRICS',
              externalPostId: entry.externalPostId,
              message: error.message,
              violations: error.violations,
            });
          }
          throw error;
        }
      }

      return reply.status(202).send({
        ingested: summaries.filter((s) => !s.alreadyExisted).length,
        deduplicated: summaries.filter((s) => s.alreadyExisted).length,
        observations: summaries,
      });
    },
  );

  // --- GET: a campaign's performance history ---
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    CAMPAIGN_BASE,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = UserIdQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, parsed.data.userId, 'VIEW_REPORTING');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const observations = await listPerformanceObservationsForCampaign(
        deps.db,
        workspaceId,
        campaignId,
      );
      return reply.status(200).send({
        campaign: { currentStage: campaign.currentStage },
        caller: {
          role: auth.role,
          canIngest: roleHasPermission(auth.role, 'MANAGE_CAMPAIGNS'),
        },
        observations: observations.map((o) => ({
          id: o.id,
          platform: o.subject.platform,
          externalPostId: o.subject.externalPostId,
          creativeVariantId: o.subject.creativeVariantId ?? null,
          durationSeconds: o.subject.durationSeconds ?? null,
          source: o.source,
          fixtureRef: o.fixtureRef ?? null,
          periodStart: o.periodStart.toISOString(),
          periodEnd: o.periodEnd.toISOString(),
          raw: o.raw,
          normalized: o.normalized,
        })),
      });
    },
  );

  // --- GET: the workspace's learning records, with evidence and applicability ---
  app.get<{ Params: { workspaceId: string }; Querystring: unknown }>(
    LEARNINGS_BASE,
    async (request, reply) => {
      const { workspaceId } = request.params;
      const parsed = UserIdQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, parsed.data.userId, 'VIEW_REPORTING');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const records = await listLearningRecords(deps.db, workspaceId);
      return reply.status(200).send({
        caller: {
          role: auth.role,
          // Approving a learning is a creative-governance decision, not a
          // reporting one.
          canReview: roleHasPermission(auth.role, 'APPROVE_CONCEPT'),
        },
        learnings: records.map((r) => ({
          id: r.id,
          learningKey: r.learningKey,
          version: r.version,
          insight: r.insight,
          scope: r.scope,
          confidence: r.confidence,
          status: r.status,
          applicability: r.applicability,
          totalImpressions: r.totalImpressions,
          evidence: r.evidence,
          sourceCampaignId: r.sourceCampaignId,
          createdByAgentInvocationId: r.createdByAgentInvocationId,
          reviewedByUserId: r.reviewedByUserId ?? null,
          superseded: r.supersededAt !== undefined,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    },
  );

  // --- POST: approve or reject a proposed learning (authorized) ---
  app.post<{ Params: { workspaceId: string; learningId: string }; Body: unknown }>(
    `${LEARNINGS_BASE}/:learningId/review`,
    async (request, reply) => {
      const { workspaceId, learningId } = request.params;
      const parsed = ReviewBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: parsed.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, parsed.data.userId, 'APPROVE_CONCEPT');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      try {
        const record = await reviewLearningRecord(deps.db, workspaceId, learningId, {
          status: parsed.data.decision,
          reviewedByUserId: parsed.data.userId,
        });
        return reply
          .status(200)
          .send({ id: record.id, status: record.status, version: record.version });
      } catch {
        // A learning in another workspace is unreachable, never leaked.
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'learning not found' });
      }
    },
  );
}
