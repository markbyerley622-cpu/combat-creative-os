import { ContinuityControllerResultSchema } from '@combat/agents';
import type {
  CampaignBriefDataSource,
  CampaignDataSource,
  GenerationCandidateRecord,
  QualityAssessmentDataSource,
  QualityFindingInput,
  ScriptDataSource,
  ShotDataSource,
  ShotGenerationDataSource,
  ShotSpecificationDataSource,
} from '@combat/database';
import {
  createQualityAssessmentForCandidate,
  getLatestAcceptedCampaignBrief,
  getLatestScript,
  getLatestShotSpecification,
  getQualityAssessmentForCandidate,
  getShotGenerationJobForSpecification,
  listGenerationCandidatesForSpecifications,
  listShotsForScript,
} from '@combat/database';
import type { ExecuteSpecialistAgentInput, ExecuteSpecialistAgentOutput } from '@combat/domain';

export interface RunContinuityAssessmentInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  readonly providerId: string;
  /** 1-based; distinguishes the idempotency key of each CONTINUITY_QA visit. */
  readonly revisionAttempt: number;
}

export interface ContinuityShotAssessmentResult {
  readonly shotId: string;
  readonly candidateId: string;
  readonly pass: boolean;
  readonly blocking: boolean;
}

export type RunContinuityAssessmentOutput =
  | {
      readonly ok: true;
      readonly allPassed: boolean;
      readonly anyBlocking: boolean;
      readonly shotResults: readonly ContinuityShotAssessmentResult[];
    }
  | { readonly ok: false; readonly reason: 'CAMPAIGN_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'BRIEF_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'SCRIPT_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'SHOT_MISSING_SPECIFICATION'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'NO_ASSESSABLE_CANDIDATE';
      readonly shotId: string;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'VISUAL_QA_INCOMPLETE';
      readonly shotId: string;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'AGENT_FAILED';
      readonly agentName: string;
      readonly detail: string;
    };

export interface RunContinuityAssessmentActivityDeps {
  readonly executeSpecialistAgentActivity: (
    input: ExecuteSpecialistAgentInput,
  ) => Promise<ExecuteSpecialistAgentOutput>;
  readonly campaignDb: CampaignDataSource;
  readonly campaignBriefDb: CampaignBriefDataSource;
  readonly scriptDb: ScriptDataSource & ShotDataSource;
  readonly shotSpecificationDb: ShotSpecificationDataSource;
  readonly shotGenerationDb: ShotGenerationDataSource;
  readonly qualityAssessmentDb: QualityAssessmentDataSource;
}

function agentIdempotencyKey(workflowRunId: string, revisionAttempt: number): string {
  return `${workflowRunId}:AGENT:CONTINUITY_QA:continuity-controller:${revisionAttempt}`;
}

function latestSucceededCandidate(
  candidates: readonly GenerationCandidateRecord[],
): GenerationCandidateRecord | undefined {
  return [...candidates]
    .filter((c) => c.status === 'SUCCEEDED')
    .sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      return byTime !== 0 ? byTime : b.candidateIndex - a.candidateIndex;
    })[0];
}

interface ResolvedShot {
  readonly shotId: string;
  readonly index: number;
  readonly description: string;
  readonly candidate: GenerationCandidateRecord;
  readonly providerId: string;
  readonly visualSummary: string;
  readonly candidateCampaignId: string;
}

/**
 * M7: runs the existing `continuity-controller` agent once over the *ordered*
 * sequence of every shot's selected candidate (each shot's latest SUCCEEDED
 * candidate that already passed VISUAL_QA), then persists an immutable
 * `QualityAssessment` (subjectStage CONTINUITY_QA) per candidate with typed
 * `QualityFailure` children for the shots a blocking continuity conflict
 * implicates. Continuity is inherently cross-shot, so one agent invocation
 * produces every per-candidate record and is the shared `createdByAgentInvocationId`
 * provenance for all of them.
 *
 * Ordered-sequence contract: shots are assessed in ascending `index` order, so
 * the agent sees the timeline as it will actually be cut. The Activity refuses
 * to run until every shot has an eligible (VISUAL_QA-passed) candidate —
 * continuity is only meaningful once the visual gate has cleared each shot.
 * Like the visual Activity, it only records assessments; stage routing (the
 * bounded CONTINUITY_QA -> SHOT_GENERATION AUTO_RETRY) is the workflow's job.
 */
export function createRunContinuityAssessmentActivity(
  deps: RunContinuityAssessmentActivityDeps,
): (input: RunContinuityAssessmentInput) => Promise<RunContinuityAssessmentOutput> {
  return async function runContinuityAssessmentActivity(
    input: RunContinuityAssessmentInput,
  ): Promise<RunContinuityAssessmentOutput> {
    const { workspaceId, campaignId, workflowRunId, providerId, revisionAttempt } = input;

    const campaign = await deps.campaignDb.campaign.findFirst({
      where: { id: campaignId, workspaceId },
    });
    if (!campaign) {
      return {
        ok: false,
        reason: 'CAMPAIGN_NOT_FOUND',
        detail: `Campaign ${campaignId} not found in workspace ${workspaceId}`,
      };
    }

    const brief = await getLatestAcceptedCampaignBrief(
      deps.campaignBriefDb,
      workspaceId,
      campaignId,
    );
    if (!brief) {
      return {
        ok: false,
        reason: 'BRIEF_NOT_FOUND',
        detail: `Campaign ${campaignId} has no accepted CampaignBrief`,
      };
    }

    const script = await getLatestScript(deps.scriptDb, workspaceId, campaignId);
    if (!script) {
      return {
        ok: false,
        reason: 'SCRIPT_NOT_FOUND',
        detail: `Campaign ${campaignId} has no Script`,
      };
    }

    const shots = [...(await listShotsForScript(deps.scriptDb, script.id))].sort(
      (a, b) => a.index - b.index,
    );

    // Resolve the eligible candidate for every shot first — continuity is only
    // assessed once every shot has a VISUAL_QA-passed candidate (requirement:
    // "run continuity assessment only after eligible visual results exist").
    const resolved: ResolvedShot[] = [];
    for (const shot of shots) {
      // eslint-disable-next-line no-await-in-loop -- small, campaign-scoped set; deterministic ordered resolution
      const spec = await getLatestShotSpecification(deps.shotSpecificationDb, workspaceId, shot.id);
      if (!spec) {
        return {
          ok: false,
          reason: 'SHOT_MISSING_SPECIFICATION',
          detail: `Shot ${shot.id} has no ShotSpecification`,
        };
      }
      // eslint-disable-next-line no-await-in-loop -- see note above
      const candidates = await listGenerationCandidatesForSpecifications(deps.shotGenerationDb, [
        spec.id,
      ]);
      const candidate = latestSucceededCandidate(candidates);
      if (!candidate) {
        return {
          ok: false,
          reason: 'NO_ASSESSABLE_CANDIDATE',
          shotId: shot.id,
          detail: `Shot ${shot.id} (spec ${spec.id}) has no SUCCEEDED GenerationCandidate`,
        };
      }
      // eslint-disable-next-line no-await-in-loop -- see note above
      const visual = await getQualityAssessmentForCandidate(
        deps.qualityAssessmentDb,
        workspaceId,
        candidate.id,
        'VISUAL_QA',
      );
      if (!visual || !visual.pass) {
        return {
          ok: false,
          reason: 'VISUAL_QA_INCOMPLETE',
          shotId: shot.id,
          detail: `Candidate ${candidate.id} for shot ${shot.id} has no passing VISUAL_QA assessment`,
        };
      }
      // eslint-disable-next-line no-await-in-loop -- see note above
      const job = await getShotGenerationJobForSpecification(
        deps.shotGenerationDb,
        workspaceId,
        spec.id,
      );
      resolved.push({
        shotId: shot.id,
        index: shot.index,
        description: shot.description,
        candidate,
        providerId: spec.providerId ?? providerId,
        visualSummary: spec.visualObjective,
        candidateCampaignId: job?.campaignId ?? campaignId,
      });
    }

    const agentResult = await deps.executeSpecialistAgentActivity({
      workspaceId,
      campaignId,
      workflowRunId,
      stage: 'CONTINUITY_QA',
      agentName: 'continuity-controller',
      agentVersion: 1,
      idempotencyKey: agentIdempotencyKey(workflowRunId, revisionAttempt),
      payload: {
        scriptShots: resolved.map((r) => ({ index: r.index, description: r.description })),
        selectedCandidateSummaries: resolved.map((r) => ({
          shotIndex: r.index,
          providerId: r.providerId,
          visualSummary: r.visualSummary,
        })),
      },
      context: {
        campaignId,
        priorArtifactRefs: resolved.map((r) => r.candidate.id),
        budgetRemainingCents: brief.budgetCents,
      },
      correlationId: workflowRunId,
      budgetScope: {},
    });

    if (agentResult.status !== 'SUCCEEDED') {
      return {
        ok: false,
        reason: 'AGENT_FAILED',
        agentName: 'continuity-controller',
        detail: agentResult.failure?.message ?? 'continuity-controller invocation failed',
      };
    }

    const result = ContinuityControllerResultSchema.parse(agentResult.result);
    const scores = Object.fromEntries(result.criterionScores.map((c) => [c.criterionId, c.score]));
    const overallScore =
      result.criterionScores.reduce((sum, c) => sum + c.score, 0) / result.criterionScores.length;
    const failedCriteria = result.criterionScores.filter((c) => !c.pass);
    const blockingShotIndices = new Set(
      result.conflicts.filter((c) => c.severity === 'BLOCKING').flatMap((c) => c.shotIndices),
    );
    // A failed sequence criterion with no blocking conflict named still fails
    // the whole sequence — a genuine continuity failure is cross-shot, so it
    // must not slip past when the agent doesn't attribute it to specific shots.
    const failAll = failedCriteria.length > 0 && blockingShotIndices.size === 0;

    const shotResults: ContinuityShotAssessmentResult[] = [];
    for (const r of resolved) {
      const implicating = result.conflicts.filter((c) => c.shotIndices.includes(r.index));
      const isBlocked = blockingShotIndices.has(r.index) || failAll;
      const pass = !isBlocked;
      const failures: QualityFindingInput[] = implicating.map((c) => ({
        category: 'CONTINUITY',
        severity: c.severity,
        description: c.issue,
      }));
      if (failAll) {
        failures.push({
          category: 'CONTINUITY',
          severity: 'BLOCKING',
          description: `Sequence continuity criteria failed: ${failedCriteria
            .map((c) => `${c.criterionId}${c.note ? ` (${c.note})` : ''}`)
            .join('; ')}`,
        });
      }

      // eslint-disable-next-line no-await-in-loop -- per-candidate idempotent persistence; sequential keeps ordering deterministic
      await createQualityAssessmentForCandidate(deps.qualityAssessmentDb, {
        workspaceId,
        campaignId,
        candidate: r.candidate,
        candidateCampaignId: r.candidateCampaignId,
        latestCandidateId: r.candidate.id,
        subjectStage: 'CONTINUITY_QA',
        pass,
        overallScore,
        scores,
        assessedBy: 'AGENT',
        createdByAgentInvocationId: agentResult.invocationId,
        failures,
      });

      shotResults.push({
        shotId: r.shotId,
        candidateId: r.candidate.id,
        pass,
        blocking: failures.some((f) => f.severity === 'BLOCKING'),
      });
    }

    return {
      ok: true,
      allPassed: shotResults.every((r) => r.pass),
      anyBlocking: shotResults.some((r) => r.blocking),
      shotResults,
    };
  };
}
