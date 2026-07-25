import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { WorkflowClient } from '@temporalio/client';
import { roleHasPermission, type Permission, type RoleName } from '@combat/domain';
import {
  approveShotSelectionSet,
  createDraftShotSelectionSet,
  gatherCandidateEligibility,
  getAsset,
  getCampaign,
  getLatestCreativeConcept,
  getLatestScript,
  getLatestShotSelectionSet,
  getLatestShotSpecification,
  getShotSelectionSet,
  latestApprovalForGate,
  listGenerationCandidatesForSpecifications,
  listHumanApprovals,
  listMembershipsForWorkspace,
  listQualityFailuresForAssessment,
  listShotSelectionReplacements,
  listShotSelections,
  getQualityAssessmentForCandidate,
  getBudgetStatus,
  listShotsForScript,
  recordHumanApproval,
  rejectShotSelection,
  setShotSelectionCandidate,
  type ShotSelectionSetRecord,
} from '@combat/database';
import type { ReviewProvider, StorageProvider } from '@combat/providers';
import { workflows } from '@combat/workflows';
import { campaignProductionWorkflowId } from './campaign-workflow-id';
import type { ShotReviewDatabase } from './shot-review-database';

export interface ShotReviewRouteDeps {
  readonly db: ShotReviewDatabase;
  readonly storageProvider: StorageProvider;
  readonly reviewProvider: ReviewProvider;
  readonly workflowClient: WorkflowClient;
  /** Signed preview URL lifetime; defaults to 1h. */
  readonly previewUrlExpirySeconds?: number;
}

const BASE = '/workspaces/:workspaceId/campaigns/:campaignId/shot-review';
const UserIdQuerySchema = z.object({ userId: z.string().uuid() });

type AuthResult =
  | { ok: true; role: RoleName }
  | { ok: false; status: number; body: { error: string; message: string } };

async function authorize(
  db: ShotReviewDatabase,
  workspaceId: string,
  userId: string,
  requiredPermission: Permission | null,
): Promise<AuthResult> {
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
  return { ok: true, role: membership.role as RoleName };
}

/** Gathers the eligible candidate id set for every SELECTED shot in a set — the guard the approve path checks. */
async function eligibleSelectedCandidateIds(
  deps: ShotReviewRouteDeps,
  workspaceId: string,
  campaignId: string,
  set: ShotSelectionSetRecord,
  latestScriptVersion: number,
  latestConceptVersion: number,
): Promise<Set<string>> {
  const selections = await listShotSelections(deps.db, set.id);
  const eligible = new Set<string>();
  for (const selection of selections) {
    if (selection.status !== 'SELECTED' || !selection.selectedCandidateId) continue;
    // eslint-disable-next-line no-await-in-loop -- small, per-set set; correctness over micro-parallelism
    const result = await gatherCandidateEligibility(deps.db, workspaceId, {
      campaignId,
      shotId: selection.shotId,
      candidateId: selection.selectedCandidateId,
      latestScriptVersion,
      latestConceptVersion,
    });
    if (result?.eligibility.eligible) eligible.add(selection.selectedCandidateId);
  }
  return eligible;
}

export function registerShotReviewRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: ShotReviewRouteDeps,
): void {
  const previewExpiry = deps.previewUrlExpirySeconds ?? 3600;

  // --- GET: the ordered shot-review workspace ---
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    BASE,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = UserIdQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, parsed.data.userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const [script, concept, workspaceBudget, campaignBudget] = await Promise.all([
        getLatestScript(deps.db, workspaceId, campaignId),
        getLatestCreativeConcept(deps.db, workspaceId, campaignId),
        getBudgetStatus(deps.db, workspaceId, 'WORKSPACE', workspaceId),
        getBudgetStatus(deps.db, workspaceId, 'CAMPAIGN', campaignId),
      ]);
      const budget = { workspace: workspaceBudget, campaign: campaignBudget };
      const campaignView = {
        currentStage: campaign.currentStage,
        isSelectionStage: campaign.currentStage === 'HUMAN_SHOT_SELECTION',
      };
      if (!script) {
        return reply
          .status(200)
          .send({ campaign: campaignView, script: null, shots: [], selectionSet: null, budget });
      }

      const set = await getLatestShotSelectionSet(deps.db, workspaceId, campaignId);
      const selections = set ? await listShotSelections(deps.db, set.id) : [];
      const shots = await listShotsForScript(deps.db, script.id);
      const latestConceptVersion = concept?.version ?? 1;

      const shotViews = [];
      for (const shot of shots) {
        // eslint-disable-next-line no-await-in-loop -- small, campaign-scoped set; read-only aggregation
        const spec = await getLatestShotSpecification(deps.db, workspaceId, shot.id);
        const candidateViews = [];
        if (spec) {
          // eslint-disable-next-line no-await-in-loop -- see note above
          const candidates = await listGenerationCandidatesForSpecifications(deps.db, [spec.id]);
          for (const candidate of candidates) {
            // eslint-disable-next-line no-await-in-loop -- see note above
            const eligibility = await gatherCandidateEligibility(deps.db, workspaceId, {
              campaignId,
              shotId: shot.id,
              candidateId: candidate.id,
              latestScriptVersion: script.version,
              latestConceptVersion,
            });
            // eslint-disable-next-line no-await-in-loop -- see note above
            const visual = await getQualityAssessmentForCandidate(
              deps.db,
              workspaceId,
              candidate.id,
              'VISUAL_QA',
            );
            // eslint-disable-next-line no-await-in-loop -- see note above
            const continuity = await getQualityAssessmentForCandidate(
              deps.db,
              workspaceId,
              candidate.id,
              'CONTINUITY_QA',
            );
            let defects: {
              category: string;
              severity: string;
              description: string;
              suggestedAction?: string;
            }[] = [];
            if (visual) {
              // eslint-disable-next-line no-await-in-loop -- see note above
              const failures = await listQualityFailuresForAssessment(deps.db, visual.id);
              defects = failures.map((f) => ({
                category: f.category,
                severity: f.severity,
                description: f.description,
                suggestedAction: f.suggestedAction,
              }));
            }
            candidateViews.push({
              id: candidate.id,
              candidateIndex: candidate.candidateIndex,
              status: candidate.status,
              assetId: candidate.assetId,
              seed: candidate.seed,
              durationSeconds: candidate.durationSeconds,
              aspectRatio: candidate.aspectRatio,
              providerId: spec.providerId,
              // The mock provider writes no bytes; the dashboard renders a
              // deterministic placeholder from this, never a <video> element.
              hasMedia: false as const,
              eligibility: eligibility
                ? {
                    eligible: eligibility.eligibility.eligible,
                    reasons: eligibility.eligibility.reasons,
                  }
                : { eligible: false, reasons: ['NOT_SUCCEEDED'] },
              visualQa: visual
                ? {
                    pass: visual.pass,
                    overallScore: visual.overallScore,
                    scores: visual.scores,
                    defects,
                  }
                : null,
              continuityQa: continuity
                ? { pass: continuity.pass, overallScore: continuity.overallScore }
                : null,
            });
          }
        }
        const selection = selections.find((s) => s.shotId === shot.id) ?? null;
        shotViews.push({
          shotId: shot.id,
          index: shot.index,
          description: shot.description,
          durationFrames: shot.durationFrames,
          beat: shot.beat,
          specification: spec
            ? { id: spec.id, version: spec.version, providerId: spec.providerId }
            : null,
          candidates: candidateViews,
          selection: selection
            ? {
                status: selection.status,
                selectedCandidateId: selection.selectedCandidateId ?? null,
                rationale: selection.rationale ?? null,
                regenerationFeedback: selection.regenerationFeedback ?? null,
              }
            : null,
        });
      }

      return reply.status(200).send({
        campaign: campaignView,
        script: { id: script.id, version: script.version },
        shots: shotViews,
        selectionSet: set
          ? {
              id: set.id,
              version: set.version,
              status: set.status,
              revision: set.revision,
              reviewerUserId: set.reviewerUserId ?? null,
              approvedAt: set.approvedAt ?? null,
            }
          : null,
        budget,
      });
    },
  );

  // --- GET: a signed, time-limited candidate preview URL (never the s3Key) ---
  app.get<{
    Params: { workspaceId: string; campaignId: string; candidateId: string };
    Querystring: unknown;
  }>(`${BASE}/candidates/:candidateId/preview`, async (request, reply) => {
    const { workspaceId, campaignId, candidateId } = request.params;
    const parsed = UserIdQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
    }
    const auth = await authorize(deps.db, workspaceId, parsed.data.userId, null);
    if (!auth.ok) return reply.status(auth.status).send(auth.body);
    const campaign = await getCampaign(deps.db, workspaceId, campaignId);
    if (!campaign) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
    }

    // The candidate's asset carries the s3Key; a signed URL is the ONLY way a
    // caller reaches bytes (the s3Key itself is never returned). Mock
    // candidates have no READY media, so this returns hasMedia:false and the
    // dashboard renders a placeholder.
    const asset = await resolveCandidateAsset(deps.db, workspaceId, campaignId, candidateId);
    if (!asset || asset.ingestionStatus !== 'READY') {
      return reply.status(200).send({ hasMedia: false, url: null });
    }
    const url = await deps.storageProvider.getPresignedUrl(asset.s3Key, previewExpiry);
    return reply.status(200).send({ hasMedia: true, url });
  });

  // --- POST: create/ensure the current draft selection set ---
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    `${BASE}/draft`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const body = z.object({ userId: z.string().uuid() }).safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: body.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, body.data.userId, 'SELECT_SHOTS');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const [script, concept] = await Promise.all([
        getLatestScript(deps.db, workspaceId, campaignId),
        getLatestCreativeConcept(deps.db, workspaceId, campaignId),
      ]);
      if (!script || !concept) {
        return reply
          .status(409)
          .send({ error: 'NOT_READY', message: 'no script/concept to review' });
      }
      const existing = await getLatestShotSelectionSet(deps.db, workspaceId, campaignId);
      if (existing && existing.status === 'DRAFT' && existing.scriptVersion === script.version) {
        const selections = await listShotSelections(deps.db, existing.id);
        return reply
          .status(200)
          .send({ set: serializeSet(existing), selections: selections.map(serializeSelection) });
      }

      const shots = await listShotsForScript(deps.db, script.id);
      const requiredShots = [];
      for (const shot of shots) {
        // eslint-disable-next-line no-await-in-loop -- small, campaign-scoped set
        const spec = await getLatestShotSpecification(deps.db, workspaceId, shot.id);
        if (!spec) {
          return reply
            .status(409)
            .send({ error: 'NOT_READY', message: `shot ${shot.id} has no specification` });
        }
        requiredShots.push({
          shotId: shot.id,
          sequencePosition: shot.index,
          shotSpecificationId: spec.id,
          shotSpecificationVersion: spec.version,
        });
      }

      const { set } = await createDraftShotSelectionSet(deps.db, workspaceId, {
        campaignId,
        scriptId: script.id,
        scriptVersion: script.version,
        creativeConceptId: concept.id,
        creativeConceptVersion: concept.version,
        version: (existing?.version ?? 0) + 1,
        createdByUserId: body.data.userId,
        requiredShots,
      });
      const selections = await listShotSelections(deps.db, set.id);
      return reply
        .status(201)
        .send({ set: serializeSet(set), selections: selections.map(serializeSelection) });
    },
  );

  // --- POST: select an eligible candidate for a shot ---
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    `${BASE}/select`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const body = z
        .object({
          userId: z.string().uuid(),
          setId: z.string().uuid(),
          shotId: z.string().uuid(),
          candidateId: z.string().uuid(),
          expectedRevision: z.number().int().nonnegative(),
          rationale: z.string().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: body.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, body.data.userId, 'SELECT_SHOTS');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const [script, concept] = await Promise.all([
        getLatestScript(deps.db, workspaceId, campaignId),
        getLatestCreativeConcept(deps.db, workspaceId, campaignId),
      ]);
      const eligibility = await gatherCandidateEligibility(deps.db, workspaceId, {
        campaignId,
        shotId: body.data.shotId,
        candidateId: body.data.candidateId,
        latestScriptVersion: script?.version ?? 1,
        latestConceptVersion: concept?.version ?? 1,
      });
      if (!eligibility) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'candidate not found' });
      }
      if (!eligibility.eligibility.eligible) {
        return reply
          .status(409)
          .send({ error: 'INELIGIBLE_CANDIDATE', reasons: eligibility.eligibility.reasons });
      }

      const result = await setShotSelectionCandidate(deps.db, workspaceId, {
        setId: body.data.setId,
        shotId: body.data.shotId,
        candidateId: body.data.candidateId,
        expectedRevision: body.data.expectedRevision,
        userId: body.data.userId,
        rationale: body.data.rationale,
        visualQaAssessmentId: eligibility.visualQaAssessmentId,
        continuityQaAssessmentId: eligibility.continuityQaAssessmentId,
      });
      if (!result.ok) {
        return reply.status(409).send({ error: result.reason });
      }
      return reply.status(200).send({ set: serializeSet(result.set) });
    },
  );

  // --- POST: reject a shot for regeneration ---
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    `${BASE}/reject-shot`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const body = z
        .object({
          userId: z.string().uuid(),
          setId: z.string().uuid(),
          shotId: z.string().uuid(),
          regenerationFeedback: z.string().min(1),
          expectedRevision: z.number().int().nonnegative(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: body.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, body.data.userId, 'SELECT_SHOTS');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const result = await rejectShotSelection(deps.db, workspaceId, {
        setId: body.data.setId,
        shotId: body.data.shotId,
        regenerationFeedback: body.data.regenerationFeedback,
        expectedRevision: body.data.expectedRevision,
        userId: body.data.userId,
      });
      if (!result.ok) return reply.status(409).send({ error: result.reason });
      return reply.status(200).send({ set: serializeSet(result.set) });
    },
  );

  // --- POST: a review comment (plain / timecoded / annotated) via the ReviewProvider ---
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    `${BASE}/comment`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const body = z
        .object({
          userId: z.string().uuid(),
          shotId: z.string().uuid().optional(),
          candidateId: z.string().uuid().optional(),
          body: z.string().min(1),
          timecodeSeconds: z.number().nonnegative().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: body.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, body.data.userId, 'SELECT_SHOTS');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const session = await deps.reviewProvider.createReviewSession({
        idempotencyKey: `campaign:${campaignId}`,
        campaignId,
      });
      let versionId: string | undefined;
      if (body.data.shotId && body.data.candidateId) {
        const version = await deps.reviewProvider.registerCandidateVersion({
          idempotencyKey: `campaign:${campaignId}:candidate:${body.data.candidateId}`,
          sessionId: session.id,
          shotId: body.data.shotId,
          candidateId: body.data.candidateId,
        });
        versionId = version.id;
      }
      const comment = await deps.reviewProvider.postComment({
        idempotencyKey: `campaign:${campaignId}:comment:${body.data.userId}:${body.data.body}:${body.data.timecodeSeconds ?? 'na'}`,
        sessionId: session.id,
        versionId,
        authorId: body.data.userId,
        body: body.data.body,
        timecodeSeconds: body.data.timecodeSeconds,
      });
      return reply.status(201).send({
        comment: {
          id: comment.id,
          authorId: comment.authorId,
          body: comment.body,
          timecodeSeconds: comment.timecodeSeconds ?? null,
        },
      });
    },
  );

  // --- POST: approve a complete ShotSelectionSet (the SHOT_SELECTION gate) ---
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    `${BASE}/approve`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const body = z
        .object({
          userId: z.string().uuid(),
          setId: z.string().uuid(),
          expectedRevision: z.number().int().nonnegative(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: body.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, body.data.userId, 'SELECT_SHOTS');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }
      const set = await getShotSelectionSet(deps.db, workspaceId, body.data.setId);
      if (!set) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'selection set not found' });
      }

      const [script, concept] = await Promise.all([
        getLatestScript(deps.db, workspaceId, campaignId),
        getLatestCreativeConcept(deps.db, workspaceId, campaignId),
      ]);
      const eligible = await eligibleSelectedCandidateIds(
        deps,
        workspaceId,
        campaignId,
        set,
        script?.version ?? 1,
        concept?.version ?? 1,
      );

      // Freeze the set FIRST — a malformed/incomplete/ineligible/stale set is
      // refused here, so no HumanApproval is recorded and no signal fires.
      const approved = await approveShotSelectionSet(deps.db, workspaceId, {
        setId: set.id,
        reviewerUserId: body.data.userId,
        expectedRevision: body.data.expectedRevision,
        eligibleCandidateIds: eligible,
        approvedAt: new Date(),
      });
      if (!approved.ok) {
        return reply.status(409).send({ error: approved.reason, message: approved.detail });
      }

      // Persist the immutable HumanApproval BEFORE signalling (dedup an exact retry).
      const approvals = await listHumanApprovals(deps.db, workspaceId, campaignId);
      const latest = latestApprovalForGate(approvals, 'SHOT_SELECTION');
      const isRetry =
        latest !== undefined &&
        latest.stageAtDecision === campaign.currentStage &&
        latest.decidedByUserId === body.data.userId &&
        latest.decision === 'APPROVED';
      const approval = isRetry
        ? latest
        : await recordHumanApproval(deps.db, workspaceId, {
            campaignId,
            gate: 'SHOT_SELECTION',
            decision: 'APPROVED',
            stageAtDecision: campaign.currentStage,
            decidedByUserId: body.data.userId,
          });

      try {
        const handle = deps.workflowClient.getHandle(campaignProductionWorkflowId(campaignId));
        await handle.signal(workflows.selectShotsSignal, {
          approvalId: approval.id,
          workspaceId,
          campaignId,
          gate: 'SHOT_SELECTION',
          decision: 'APPROVED',
          decidedByUserId: body.data.userId,
        });
      } catch (error) {
        request.log.error({ err: error, campaignId }, 'failed to signal campaign workflow');
        return reply.status(502).send({
          error: 'WORKFLOW_SIGNAL_FAILED',
          message: 'the approval was recorded but the workflow could not be signalled',
          approvalId: approval.id,
        });
      }
      return reply
        .status(202)
        .send({ approvalId: approval.id, replayed: isRetry, set: serializeSet(approved.set) });
    },
  );

  // --- POST: request regeneration (gate CHANGES_REQUESTED) ---
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    `${BASE}/request-regeneration`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const body = z
        .object({
          userId: z.string().uuid(),
          setId: z.string().uuid(),
          comments: z.string().optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: body.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, body.data.userId, 'SELECT_SHOTS');
      if (!auth.ok) return reply.status(auth.status).send(auth.body);
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }
      const set = await getShotSelectionSet(deps.db, workspaceId, body.data.setId);
      if (!set) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'selection set not found' });
      }
      const selections = await listShotSelections(deps.db, set.id);
      const rejected = selections.filter((s) => s.status === 'REJECTED' && s.regenerationFeedback);
      if (rejected.length === 0) {
        return reply.status(409).send({
          error: 'NO_REJECTED_SHOTS',
          message:
            'reject at least one shot with regeneration feedback before requesting regeneration',
        });
      }

      const approvals = await listHumanApprovals(deps.db, workspaceId, campaignId);
      const latest = latestApprovalForGate(approvals, 'SHOT_SELECTION');
      const isRetry =
        latest !== undefined &&
        latest.stageAtDecision === campaign.currentStage &&
        latest.decidedByUserId === body.data.userId &&
        latest.decision === 'CHANGES_REQUESTED';
      const approval = isRetry
        ? latest
        : await recordHumanApproval(deps.db, workspaceId, {
            campaignId,
            gate: 'SHOT_SELECTION',
            decision: 'CHANGES_REQUESTED',
            stageAtDecision: campaign.currentStage,
            decidedByUserId: body.data.userId,
            comments: body.data.comments,
          });

      try {
        const handle = deps.workflowClient.getHandle(campaignProductionWorkflowId(campaignId));
        await handle.signal(workflows.selectShotsSignal, {
          approvalId: approval.id,
          workspaceId,
          campaignId,
          gate: 'SHOT_SELECTION',
          decision: 'CHANGES_REQUESTED',
          decidedByUserId: body.data.userId,
        });
      } catch (error) {
        request.log.error({ err: error, campaignId }, 'failed to signal campaign workflow');
        return reply.status(502).send({
          error: 'WORKFLOW_SIGNAL_FAILED',
          message: 'the decision was recorded but the workflow could not be signalled',
          approvalId: approval.id,
        });
      }
      return reply.status(202).send({ approvalId: approval.id, replayed: isRetry });
    },
  );

  // --- GET: selection + replacement history ---
  app.get<{ Params: { workspaceId: string; campaignId: string }; Querystring: unknown }>(
    `${BASE}/history`,
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = UserIdQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
      }
      const auth = await authorize(deps.db, workspaceId, parsed.data.userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);
      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }
      const set = await getLatestShotSelectionSet(deps.db, workspaceId, campaignId);
      const replacements = set ? await listShotSelectionReplacements(deps.db, set.id) : [];
      const approvals = (await listHumanApprovals(deps.db, workspaceId, campaignId)).filter(
        (a) => a.gate === 'SHOT_SELECTION',
      );
      return reply.status(200).send({
        replacements: replacements.map((r) => ({
          shotId: r.shotId,
          previousCandidateId: r.previousCandidateId ?? null,
          newCandidateId: r.newCandidateId ?? null,
          replacedByUserId: r.replacedByUserId,
          reason: r.reason ?? null,
          createdAt: r.createdAt,
        })),
        approvals: approvals.map((a) => ({
          id: a.id,
          decision: a.decision,
          decidedByUserId: a.decidedByUserId,
          stageAtDecision: a.stageAtDecision,
          decidedAt: a.decidedAt,
        })),
      });
    },
  );
}

/**
 * Resolves a candidate's asset by walking the campaign's latest script ->
 * shots -> latest specs -> candidates (there is no by-id candidate lookup in
 * the narrow `ShotGenerationDataSource`). Workspace-scoped throughout, so a
 * candidate from another workspace is never resolved.
 */
async function resolveCandidateAsset(
  db: ShotReviewDatabase,
  workspaceId: string,
  campaignId: string,
  candidateId: string,
): Promise<{ s3Key: string; ingestionStatus: string } | null> {
  const script = await getLatestScript(db, workspaceId, campaignId);
  if (!script) return null;
  const shots = await listShotsForScript(db, script.id);
  const specIds: string[] = [];
  for (const shot of shots) {
    // eslint-disable-next-line no-await-in-loop -- small, campaign-scoped set
    const spec = await getLatestShotSpecification(db, workspaceId, shot.id);
    if (spec) specIds.push(spec.id);
  }
  const candidates = await listGenerationCandidatesForSpecifications(db, specIds);
  const candidate = candidates.find((c) => c.id === candidateId);
  if (!candidate?.assetId) return null;
  const asset = await getAsset(db, workspaceId, candidate.assetId);
  return asset ? { s3Key: asset.s3Key, ingestionStatus: asset.ingestionStatus } : null;
}

function serializeSet(set: ShotSelectionSetRecord) {
  return {
    id: set.id,
    campaignId: set.campaignId,
    version: set.version,
    status: set.status,
    revision: set.revision,
    reviewerUserId: set.reviewerUserId ?? null,
    approvedAt: set.approvedAt ?? null,
  };
}

function serializeSelection(selection: {
  shotId: string;
  sequencePosition: number;
  status: string;
  selectedCandidateId?: string;
  rationale?: string;
  regenerationFeedback?: string;
}) {
  return {
    shotId: selection.shotId,
    sequencePosition: selection.sequencePosition,
    status: selection.status,
    selectedCandidateId: selection.selectedCandidateId ?? null,
    rationale: selection.rationale ?? null,
    regenerationFeedback: selection.regenerationFeedback ?? null,
  };
}
