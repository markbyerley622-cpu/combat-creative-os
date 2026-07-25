import { PerformanceAnalystResultSchema } from '@combat/agents';
import type { AgentDefinition } from '@combat/agent-runtime';
import type {
  CampaignDataSource,
  LearningDataSource,
  PerformanceDataSource,
  PromptDataSource,
} from '@combat/database';
import {
  createLearningRecord,
  getOrCreatePromptVersionForAgent,
  listPerformanceObservationsForCampaign,
} from '@combat/database';
import type {
  ExecuteSpecialistAgentInput,
  ExecuteSpecialistAgentOutput,
  LearningEvidence,
  LearningScope,
  PerformanceObservation,
} from '@combat/domain';
import { deriveLearningConfidence } from '@combat/domain';

/** Maps the agent's lowercase `appliesTo` onto the persisted `LearningScope`. */
const SCOPE_BY_APPLIES_TO: Readonly<Record<string, LearningScope>> = {
  strategy: 'STRATEGY',
  concept: 'CONCEPT',
  prompting: 'PROMPTING',
};

export interface RunPerformanceAnalystInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  readonly windowKey: string;
  readonly minObservations: number;
  /** 1-based; distinguishes the agent idempotency key of a deliberate re-analysis. */
  readonly analysisAttempt: number;
  /** Injected so analysis stays deterministic under test; defaults to now. */
  readonly now?: Date;
}

export interface PersistedLearningSummary {
  readonly learningRecordId: string;
  readonly learningKey: string;
  readonly version: number;
  readonly scope: LearningScope;
  readonly confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly evidenceCount: number;
}

export type RunPerformanceAnalystOutput =
  | {
      readonly ok: true;
      readonly observationsAnalyzed: number;
      readonly learnings: readonly PersistedLearningSummary[];
    }
  | {
      readonly ok: false;
      readonly reason: 'CAMPAIGN_NOT_FOUND';
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'INSUFFICIENT_OBSERVATIONS';
      readonly observationsAvailable: number;
      readonly detail: string;
    }
  | { readonly ok: false; readonly reason: 'AGENT_FAILED'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'UNSUPPORTED_EVIDENCE';
      readonly detail: string;
    };

export interface RunPerformanceAnalystActivityDeps {
  readonly executeSpecialistAgentActivity: (
    input: ExecuteSpecialistAgentInput,
  ) => Promise<ExecuteSpecialistAgentOutput>;
  readonly agentRegistry: Readonly<Record<string, AgentDefinition<unknown, unknown>>>;
  readonly campaignDb: CampaignDataSource;
  readonly performanceDb: PerformanceDataSource;
  readonly learningDb: LearningDataSource;
  readonly promptDb: PromptDataSource;
}

/** Only windows that have already closed may inform a learning. */
function isClosed(observation: PerformanceObservation, now: Date): boolean {
  return observation.periodEnd <= now;
}

/**
 * M13: runs the `performance-analyst` agent over a campaign's **closed**
 * performance observations and persists each proposed insight as a versioned
 * `LearningRecord`.
 *
 * Three properties this Activity enforces, none of which the agent can talk its
 * way past:
 *
 * 1. **Completed data only.** Observations whose window has not elapsed are
 *    filtered out before the agent ever sees them.
 * 2. **Evidence must be real.** Every `evidenceObservationId` the agent cites is
 *    checked against the observations actually supplied; a citation to anything
 *    else is a typed `UNSUPPORTED_EVIDENCE` failure, not a persisted learning.
 * 3. **Confidence is derived, never asserted.** `deriveLearningConfidence`
 *    computes the band from the cited evidence's volume, so a thin sample cannot
 *    produce a confident claim however emphatic the model was.
 *
 * Every learning is written `PROPOSED`. Nothing here approves one, and nothing
 * here touches a campaign stage, an approval, an asset or an export — this
 * Activity's only writes are `LearningRecord` rows.
 */
export function createRunPerformanceAnalystActivity(
  deps: RunPerformanceAnalystActivityDeps,
): (input: RunPerformanceAnalystInput) => Promise<RunPerformanceAnalystOutput> {
  return async function runPerformanceAnalystActivity(
    input: RunPerformanceAnalystInput,
  ): Promise<RunPerformanceAnalystOutput> {
    const { workspaceId, campaignId, workflowRunId, windowKey, analysisAttempt } = input;
    const now = input.now ?? new Date();

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

    const all = await listPerformanceObservationsForCampaign(
      deps.performanceDb,
      workspaceId,
      campaignId,
    );
    const observations = all.filter((o) => isClosed(o, now));
    if (observations.length < input.minObservations) {
      return {
        ok: false,
        reason: 'INSUFFICIENT_OBSERVATIONS',
        observationsAvailable: observations.length,
        detail: `campaign ${campaignId} has ${observations.length} closed observation(s), fewer than the required ${input.minObservations}`,
      };
    }

    const definition = deps.agentRegistry['performance-analyst'];
    if (!definition) {
      throw new Error('"performance-analyst" is not registered in the injected agent registry');
    }
    const promptVersionRecord = await getOrCreatePromptVersionForAgent(deps.promptDb, workspaceId, {
      agentKey: 'performance-analyst',
      version: definition.promptVersion.version,
      systemPrompt: definition.promptVersion.systemPrompt,
    });

    const byId = new Map(observations.map((o) => [o.id, o]));
    const agentResult = await deps.executeSpecialistAgentActivity({
      workspaceId,
      campaignId,
      workflowRunId,
      // Performance analysis runs after the campaign has finished, so the
      // campaign's own stage is what `executeSpecialistAgentActivity` checks
      // against — a campaign still in production is not analyzable.
      stage: campaign.currentStage,
      agentName: 'performance-analyst',
      agentVersion: definition.promptVersion.version,
      idempotencyKey: `${workflowRunId}:AGENT:PERFORMANCE_ANALYSIS:performance-analyst:${windowKey}:${analysisAttempt}`,
      payload: {
        observations: observations.map((o) => ({
          observationId: o.id,
          platform: o.subject.platform,
          durationSeconds: o.subject.durationSeconds,
          periodStart: o.periodStart.toISOString(),
          periodEnd: o.periodEnd.toISOString(),
          impressions: o.normalized.impressions,
          clicks: o.normalized.clicks,
          conversions: o.normalized.conversions,
          spendCents: o.normalized.spendCents,
          clickThroughRate: o.normalized.clickThroughRate,
          completionRate: o.normalized.completionRate,
          conversionRate: o.normalized.conversionRate,
          costPerClickCents: o.normalized.costPerClickCents,
          costPerConversionCents: o.normalized.costPerConversionCents,
        })),
      },
      context: {
        campaignId,
        priorArtifactRefs: observations.map((o) => o.id),
        budgetRemainingCents: 0,
      },
      correlationId: workflowRunId,
      budgetScope: {},
    });
    if (agentResult.status !== 'SUCCEEDED') {
      return {
        ok: false,
        reason: 'AGENT_FAILED',
        detail: agentResult.failure?.message ?? 'performance-analyst invocation failed',
      };
    }

    const result = PerformanceAnalystResultSchema.parse(agentResult.result);

    // --- Every citation must resolve to a supplied observation --------------
    for (const proposed of result.learnings) {
      const unknownIds = proposed.evidenceObservationIds.filter((id) => !byId.has(id));
      if (unknownIds.length > 0) {
        return {
          ok: false,
          reason: 'UNSUPPORTED_EVIDENCE',
          detail: `learning "${proposed.learningKey}" cites observation(s) that were not supplied: ${unknownIds.join(', ')}`,
        };
      }
    }

    const learnings: PersistedLearningSummary[] = [];
    for (const proposed of result.learnings) {
      const evidence: LearningEvidence[] = proposed.evidenceObservationIds.map((id) => {
        const observation = byId.get(id)!;
        return {
          performanceObservationId: observation.id,
          campaignId: observation.subject.campaignId,
          creativeVariantId: observation.subject.creativeVariantId,
          platform: observation.subject.platform,
          impressions: observation.normalized.impressions,
        };
      });
      // Confidence is computed here from the cited evidence, never taken from
      // the agent — the schema has no field for it to assert one.
      const derivation = deriveLearningConfidence(evidence);

      // eslint-disable-next-line no-await-in-loop -- small, per-analysis set; sequential keeps version assignment deterministic
      const { record } = await createLearningRecord(deps.learningDb, workspaceId, {
        learningKey: proposed.learningKey,
        insight: proposed.insight,
        scope: SCOPE_BY_APPLIES_TO[proposed.appliesTo] ?? 'STRATEGY',
        applicability: {
          platforms: proposed.platforms,
          durationsSeconds: proposed.durationsSeconds,
          tags: proposed.tags,
        },
        confidence: derivation.confidence,
        evidence,
        totalImpressions: derivation.totalImpressions,
        sourceCampaignId: campaignId,
        createdByAgentInvocationId: agentResult.invocationId,
        promptVersionId: promptVersionRecord.id,
      });

      learnings.push({
        learningRecordId: record.id,
        learningKey: record.learningKey,
        version: record.version,
        scope: record.scope,
        confidence: record.confidence,
        evidenceCount: record.evidence.length,
      });
    }

    return { ok: true, observationsAnalyzed: observations.length, learnings };
  };
}
