import type { FastifyInstance } from 'fastify';
import {
  getBudgetStatus,
  getLatestScript,
  getLatestShotSpecification,
  getShotGenerationJobForSpecification,
  listGenerationCandidatesForSpecifications,
  listMembershipsForWorkspace,
  listShotGenerationAttempts,
  listShotsForScript,
} from '@combat/database';
import type { ShotGenerationDatabase } from './shot-generation-database';
import { requirePrincipal } from './authentication';

export interface ShotGenerationRouteDeps {
  readonly db: ShotGenerationDatabase;
}

async function authorize(
  db: ShotGenerationDatabase,
  workspaceId: string,
  userId: string,
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
  // Read-only: any workspace member may view generation progress, matching
  // asset-routes.ts's `requiredPermission: null` convention for reads — only
  // mutating routes need a `roleHasPermission` check, and this milestone
  // adds none (M6 requirement 9: read-only support only).
  return { ok: true };
}

/**
 * Never renders real video — the mock `VideoGenerationProvider` never writes
 * binary media anywhere (packages/providers' MockVideoGenerationProvider doc
 * comment), so every SUCCEEDED candidate this route reports carries only
 * metadata (`assetId`, `providerCandidateRef`, `seed`, duration, aspect
 * ratio) and an explicit `hasMedia: false` — the dashboard is expected to
 * render a deterministic placeholder card from that, never a `<video>` tag
 * pointing at bytes that were never produced (M6 requirement 9).
 */
interface CandidateView {
  id: string;
  candidateIndex: number;
  status: string;
  assetId?: string;
  seed?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  hasMedia: false;
}

export function registerShotGenerationRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: ShotGenerationRouteDeps,
): void {
  app.get<{
    Params: { workspaceId: string; campaignId: string };
    Querystring: unknown;
  }>('/workspaces/:workspaceId/campaigns/:campaignId/shot-generation', async (request, reply) => {
    const { workspaceId, campaignId } = request.params;
    const auth = await authorize(deps.db, workspaceId, requirePrincipal(request).userId);
    if (!auth.ok) return reply.status(auth.status).send(auth.body);

    const [script, workspaceBudget, campaignBudget] = await Promise.all([
      getLatestScript(deps.db, workspaceId, campaignId),
      getBudgetStatus(deps.db, workspaceId, 'WORKSPACE', workspaceId),
      getBudgetStatus(deps.db, workspaceId, 'CAMPAIGN', campaignId),
    ]);
    const budget = { workspace: workspaceBudget, campaign: campaignBudget };
    if (!script) {
      return reply.status(200).send({ script: null, shots: [], budget });
    }

    const shots = await listShotsForScript(deps.db, script.id);
    const shotViews = [];
    for (const shot of shots) {
      // eslint-disable-next-line no-await-in-loop -- small, campaign-scoped set; read-only aggregation, not a hot path
      const spec = await getLatestShotSpecification(deps.db, workspaceId, shot.id);
      let generationJob = null;
      let attempts: unknown[] = [];
      let candidates: CandidateView[] = [];
      if (spec) {
        // eslint-disable-next-line no-await-in-loop -- same rationale as above
        generationJob = await getShotGenerationJobForSpecification(deps.db, workspaceId, spec.id);
        if (generationJob) {
          // eslint-disable-next-line no-await-in-loop -- same rationale as above
          attempts = await listShotGenerationAttempts(deps.db, generationJob.id);
        }
        // eslint-disable-next-line no-await-in-loop -- same rationale as above
        const candidateRecords = await listGenerationCandidatesForSpecifications(deps.db, [
          spec.id,
        ]);
        candidates = candidateRecords.map((c) => ({
          id: c.id,
          candidateIndex: c.candidateIndex,
          status: c.status,
          assetId: c.assetId,
          seed: c.seed,
          durationSeconds: c.durationSeconds,
          aspectRatio: c.aspectRatio,
          hasMedia: false,
        }));
      }

      shotViews.push({
        shotId: shot.id,
        index: shot.index,
        description: shot.description,
        durationFrames: shot.durationFrames,
        beat: shot.beat,
        specification: spec
          ? {
              id: spec.id,
              version: spec.version,
              visualObjective: spec.visualObjective,
              action: spec.action,
              subject: spec.subject,
              environment: spec.environment,
              cameraMovement: spec.cameraMovement,
              lensFraming: spec.lensFraming,
              lighting: spec.lighting,
              colorTreatment: spec.colorTreatment,
              motionIntensity: spec.motionIntensity,
              transitionIn: spec.transitionIn,
              transitionOut: spec.transitionOut,
              textSafeAreas: spec.textSafeAreas,
              providerId: spec.providerId,
              generationPrompt: spec.generationPrompt,
              negativePrompt: spec.negativePrompt,
              qualityRubric: spec.qualityRubric,
              licensingConstraints: spec.licensingConstraints,
              referenceAssetIds: spec.referenceAssetIds,
              createdAt: spec.createdAt,
            }
          : null,
        generationJob: generationJob
          ? {
              id: generationJob.id,
              status: generationJob.status,
              requestedCandidateCount: generationJob.requestedCandidateCount,
              maxAttempts: generationJob.maxAttempts,
              attemptCount: generationJob.attemptCount,
              updatedAt: generationJob.updatedAt,
            }
          : null,
        attempts,
        candidates,
      });
    }

    return reply.status(200).send({
      script: {
        id: script.id,
        version: script.version,
        totalDurationFrames: script.totalDurationFrames,
      },
      shots: shotViews,
      budget,
    });
  });
}
