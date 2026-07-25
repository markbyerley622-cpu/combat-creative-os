import { VisualQualityControllerResultSchema } from '@combat/agents';
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
  getShotGenerationJobForSpecification,
  listGenerationCandidatesForSpecifications,
  listShotsForScript,
} from '@combat/database';
import type { ExecuteSpecialistAgentInput, ExecuteSpecialistAgentOutput } from '@combat/domain';

/**
 * How many extracted frames the Visual QC agent is told it reviewed. No frame
 * extraction runs in this milestone (the deterministic mock provider never
 * writes real media — CLAUDE.md M6/M7), so this is a fixed, documented
 * placeholder feeding the agent's `frameCount` input rather than a real count.
 */
const FRAME_SAMPLE_COUNT = 3;

export interface RunVisualQualityAssessmentsInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  /** Campaign-wide video provider — used only as a fallback when a spec omits its own providerId. */
  readonly providerId: string;
  /** 1-based; distinguishes the idempotency key of each VISUAL_QA visit (a revision revisit re-assesses freshly regenerated candidates). */
  readonly revisionAttempt: number;
}

export interface VisualShotAssessmentResult {
  readonly shotId: string;
  readonly candidateId: string;
  /** Derived from the AND of every rubric criterion — false means this shot must be regenerated. */
  readonly pass: boolean;
  /** True when at least one persisted QualityFailure carries BLOCKING severity. */
  readonly blocking: boolean;
}

export type RunVisualQualityAssessmentsOutput =
  | {
      readonly ok: true;
      readonly allPassed: boolean;
      readonly anyBlocking: boolean;
      readonly shotResults: readonly VisualShotAssessmentResult[];
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
      readonly reason: 'AGENT_FAILED';
      readonly agentName: string;
      readonly shotId: string;
      readonly detail: string;
    };

export interface RunVisualQualityAssessmentsActivityDeps {
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

function agentIdempotencyKey(
  workflowRunId: string,
  candidateId: string,
  revisionAttempt: number,
): string {
  return `${workflowRunId}:AGENT:VISUAL_QA:visual-quality-controller:${candidateId}:${revisionAttempt}`;
}

/** The latest SUCCEEDED candidate for a spec — the one to assess (anything older is a superseded/stale candidate). */
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

/**
 * M7: runs the existing `visual-quality-controller` agent once per shot in the
 * campaign's latest script — assessing each shot's latest SUCCEEDED candidate —
 * and persists each result as an immutable `QualityAssessment` (subjectStage
 * VISUAL_QA) plus typed `QualityFailure` children. Every agent call goes
 * through the injected `executeSpecialistAgentActivity` (the one ADR-0004
 * Activity boundary for agent execution), so idempotency / budget / RBAC /
 * `AgentInvocation` persistence is never duplicated here, and the agent never
 * touches a repository directly (CLAUDE.md architecture boundaries).
 *
 * This Activity only records assessments; it never advances a stage or fires a
 * human approval signal. Routing a failing shot back to SHOT_GENERATION is the
 * workflow's job (via `advanceCampaignStageActivity` AUTO_RETRY), gated by the
 * bounded `visualQARetryAllowed` fact — so no automated revision can outrun the
 * shot-generation attempt cap or bypass a human gate.
 */
export function createRunVisualQualityAssessmentsActivity(
  deps: RunVisualQualityAssessmentsActivityDeps,
): (input: RunVisualQualityAssessmentsInput) => Promise<RunVisualQualityAssessmentsOutput> {
  return async function runVisualQualityAssessmentsActivity(
    input: RunVisualQualityAssessmentsInput,
  ): Promise<RunVisualQualityAssessmentsOutput> {
    const { workspaceId, campaignId, workflowRunId, providerId, revisionAttempt } = input;

    // Workspace + campaign ownership: a campaign not found under this
    // workspace is unreachable, never leaked (CLAUDE.md workspace scoping).
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

    const shots = await listShotsForScript(deps.scriptDb, script.id);
    const shotResults: VisualShotAssessmentResult[] = [];

    for (const shot of shots) {
      // eslint-disable-next-line no-await-in-loop -- small, campaign-scoped set; each shot's agent call + persistence must complete before the next idempotency key is safe to replay (same sequencing rationale as run-shot-prompt-engineer-activity)
      const spec = await getLatestShotSpecification(deps.shotSpecificationDb, workspaceId, shot.id);
      if (!spec) {
        return {
          ok: false,
          reason: 'SHOT_MISSING_SPECIFICATION',
          detail: `Shot ${shot.id} has no ShotSpecification`,
        };
      }

      // eslint-disable-next-line no-await-in-loop -- see sequencing note above
      const candidates = await listGenerationCandidatesForSpecifications(deps.shotGenerationDb, [
        spec.id,
      ]);
      const candidate = latestSucceededCandidate(candidates);
      if (!candidate) {
        return {
          ok: false,
          reason: 'NO_ASSESSABLE_CANDIDATE',
          shotId: shot.id,
          detail: `Shot ${shot.id} (spec ${spec.id}) has no SUCCEEDED GenerationCandidate to assess`,
        };
      }

      // eslint-disable-next-line no-await-in-loop -- see sequencing note above
      const job = await getShotGenerationJobForSpecification(
        deps.shotGenerationDb,
        workspaceId,
        spec.id,
      );
      const candidateCampaignId = job?.campaignId ?? campaignId;

      // eslint-disable-next-line no-await-in-loop -- see sequencing note above
      const agentResult = await deps.executeSpecialistAgentActivity({
        workspaceId,
        campaignId,
        workflowRunId,
        stage: 'VISUAL_QA',
        agentName: 'visual-quality-controller',
        agentVersion: 1,
        idempotencyKey: agentIdempotencyKey(workflowRunId, candidate.id, revisionAttempt),
        payload: {
          shot: {
            index: shot.index,
            description: shot.description,
            durationFrames: shot.durationFrames,
          },
          providerId: spec.providerId ?? providerId,
          candidateRef: candidate.providerCandidateRef ?? candidate.id,
          frameCount: FRAME_SAMPLE_COUNT,
        },
        context: {
          campaignId,
          priorArtifactRefs: [spec.id, candidate.id],
          budgetRemainingCents: brief.budgetCents,
        },
        correlationId: workflowRunId,
        budgetScope: {},
      });

      if (agentResult.status !== 'SUCCEEDED') {
        return {
          ok: false,
          reason: 'AGENT_FAILED',
          agentName: 'visual-quality-controller',
          shotId: shot.id,
          detail: agentResult.failure?.message ?? 'visual-quality-controller invocation failed',
        };
      }

      const result = VisualQualityControllerResultSchema.parse(agentResult.result);
      const pass = result.criterionScores.every((c) => c.pass);
      const scores = Object.fromEntries(
        result.criterionScores.map((c) => [c.criterionId, c.score]),
      );
      const overallScore =
        result.criterionScores.reduce((sum, c) => sum + c.score, 0) / result.criterionScores.length;
      const failures: QualityFindingInput[] = result.findings.map((f) => ({
        category: f.category,
        severity: f.severity,
        description: f.description,
        suggestedAction: f.suggestedAction,
      }));

      // eslint-disable-next-line no-await-in-loop -- see sequencing note above
      await createQualityAssessmentForCandidate(deps.qualityAssessmentDb, {
        workspaceId,
        campaignId,
        candidate,
        candidateCampaignId,
        latestCandidateId: candidate.id,
        subjectStage: 'VISUAL_QA',
        pass,
        overallScore,
        scores,
        assessedBy: 'AGENT',
        createdByAgentInvocationId: agentResult.invocationId,
        failures,
      });

      shotResults.push({
        shotId: shot.id,
        candidateId: candidate.id,
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
