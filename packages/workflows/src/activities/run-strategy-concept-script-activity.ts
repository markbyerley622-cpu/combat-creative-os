import {
  CampaignStrategistResultSchema,
  CreativeDirectorResultSchema,
  ScriptTimingDirectorResultSchema,
} from '@combat/agents';
import type {
  CampaignBriefDataSource,
  CreativeConceptDataSource,
  HumanApprovalDataSource,
  ScriptWithShotsDataSource,
  StrategyDataSource,
} from '@combat/database';
import {
  createCreativeConcept,
  createScriptWithShots,
  createStrategy,
  getLatestAcceptedCampaignBrief,
  latestApprovalForGate,
  listHumanApprovals,
} from '@combat/database';
import type { ExecuteSpecialistAgentInput, ExecuteSpecialistAgentOutput } from '@combat/domain';

/**
 * Sequences the three M4 text agents — Campaign Strategist -> Creative
 * Director -> Script & Timing Director — for one STRATEGY_REVIEW "visit",
 * persisting each output as an immutable versioned row before moving to the
 * next agent. This is the orchestrator ADR-0004 describes as still missing
 * ("no CampaignProductionWorkflow calls [execute-specialist-agent-activity]
 * yet — that remains M3/M4's sequencing work"): every agent call here goes
 * through the *same* `executeSpecialistAgentActivity` function production
 * code uses (injected, not re-implemented), so idempotency/budget-check/
 * AgentInvocation-persistence logic is never duplicated (CLAUDE.md
 * "agents never call the database directly... only the orchestrator
 * sequences agents and persists their output").
 *
 * All three agents run within one Activity invocation (rather than the
 * workflow calling each of the six agent+persist steps itself) so
 * `campaign-production-workflow.ts` only gains one new proxied call — see
 * that file's doc comment for why keeping the workflow's own branching
 * surface minimal mattered for this milestone's effort budget.
 */

export interface RunStrategyConceptScriptInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  /** 1-based. Also used as the `version` for every artifact persisted in this call, and as the CONCEPT gate's revision-count read (`state.revisionCounts.CONCEPT + 1` at the call site). */
  readonly revisionAttempt: number;
}

export type RunStrategyConceptScriptOutput =
  | {
      readonly ok: true;
      readonly strategyId: string;
      readonly conceptId: string;
      readonly scriptId: string;
    }
  | { readonly ok: false; readonly reason: 'BRIEF_NOT_FOUND'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'AGENT_FAILED';
      readonly agentName: string;
      readonly detail: string;
    };

export interface RunStrategyConceptScriptActivityDeps {
  readonly executeSpecialistAgentActivity: (
    input: ExecuteSpecialistAgentInput,
  ) => Promise<ExecuteSpecialistAgentOutput>;
  readonly campaignBriefDb: CampaignBriefDataSource;
  readonly strategyDb: StrategyDataSource;
  readonly creativeConceptDb: CreativeConceptDataSource;
  readonly scriptDb: ScriptWithShotsDataSource;
  readonly humanApprovalDb: HumanApprovalDataSource;
}

function agentIdempotencyKey(
  workflowRunId: string,
  agentName: string,
  revisionAttempt: number,
): string {
  return `${workflowRunId}:AGENT:STRATEGY_REVIEW:${agentName}:${revisionAttempt}`;
}

export function createRunStrategyConceptScriptActivity(
  deps: RunStrategyConceptScriptActivityDeps,
): (input: RunStrategyConceptScriptInput) => Promise<RunStrategyConceptScriptOutput> {
  return async function runStrategyConceptScriptActivity(
    input: RunStrategyConceptScriptInput,
  ): Promise<RunStrategyConceptScriptOutput> {
    const { workspaceId, campaignId, workflowRunId, revisionAttempt } = input;

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

    // Revision feedback comes from the most recent CONCEPT-gate decision,
    // not from the workflow — this activity has DB access and the workflow
    // itself never does I/O (CLAUDE.md architecture boundary), so reading it
    // here (rather than threading it through the workflow) keeps that file free
    // of an extra parameter it would otherwise have to fetch nowhere itself.
    const approvals = await listHumanApprovals(deps.humanApprovalDb, workspaceId, campaignId);
    const latestConceptDecision = latestApprovalForGate(approvals, 'CONCEPT');
    const revisionFeedback =
      revisionAttempt > 1 && latestConceptDecision?.decision !== 'APPROVED'
        ? latestConceptDecision?.comments
        : undefined;

    // Field mapping from the M4 CampaignBriefContent shape (packages/domain)
    // to CampaignStrategistInputSchema (packages/agents), which predates the
    // full M4 brief contract and only has room for the fields it originally
    // scoped: brandName <- brief.productName (closest concept available —
    // the brief doesn't separately capture an advertiser/brand name distinct
    // from the product being advertised), mandatories <- brief.productFeatures
    // (features that must be represented, standing in for "mandatory
    // creative inclusions" — brief.prohibitedClaims is the opposite polarity
    // and intentionally not used here).
    const strategyAgentResult = await deps.executeSpecialistAgentActivity({
      workspaceId,
      campaignId,
      workflowRunId,
      stage: 'STRATEGY_REVIEW',
      agentName: 'campaign-strategist',
      agentVersion: 1,
      idempotencyKey: agentIdempotencyKey(workflowRunId, 'campaign-strategist', revisionAttempt),
      payload: {
        brandName: brief.productName,
        objective: brief.objective,
        targetPlatforms: brief.targetPlatforms,
        durationsSeconds: brief.durationsSeconds,
        budgetCents: brief.budgetCents,
        keyMessages: brief.requiredMessaging,
        mandatories: brief.productFeatures,
        priorLearnings: [],
        revisionFeedback,
      },
      context: { campaignId, priorArtifactRefs: [], budgetRemainingCents: brief.budgetCents },
      correlationId: workflowRunId,
      budgetScope: {},
    });
    if (strategyAgentResult.status !== 'SUCCEEDED') {
      return {
        ok: false,
        reason: 'AGENT_FAILED',
        agentName: 'campaign-strategist',
        detail: strategyAgentResult.failure?.message ?? 'campaign-strategist invocation failed',
      };
    }
    const strategyResult = CampaignStrategistResultSchema.parse(strategyAgentResult.result);
    const strategyRecord = await createStrategy(deps.strategyDb, workspaceId, {
      campaignId,
      version: revisionAttempt,
      positioning: strategyResult.strategy.positioning,
      targetAudienceSummary: strategyResult.strategy.targetAudienceSummary,
      keyMessages: strategyResult.strategy.keyMessages,
      toneGuidelines: strategyResult.strategy.toneGuidelines,
      audienceProfile: strategyResult.audienceProfile,
    });

    const conceptAgentResult = await deps.executeSpecialistAgentActivity({
      workspaceId,
      campaignId,
      workflowRunId,
      stage: 'STRATEGY_REVIEW',
      agentName: 'creative-director',
      agentVersion: 1,
      idempotencyKey: agentIdempotencyKey(workflowRunId, 'creative-director', revisionAttempt),
      payload: {
        brandName: brief.productName,
        strategy: strategyResult.strategy,
        mandatories: brief.productFeatures,
        durationsSeconds: brief.durationsSeconds,
        revisionFeedback,
      },
      context: {
        campaignId,
        priorArtifactRefs: [strategyRecord.id],
        budgetRemainingCents: brief.budgetCents,
      },
      correlationId: workflowRunId,
      causationId: strategyAgentResult.invocationId,
      budgetScope: {},
    });
    if (conceptAgentResult.status !== 'SUCCEEDED') {
      return {
        ok: false,
        reason: 'AGENT_FAILED',
        agentName: 'creative-director',
        detail: conceptAgentResult.failure?.message ?? 'creative-director invocation failed',
      };
    }
    const conceptResult = CreativeDirectorResultSchema.parse(conceptAgentResult.result);
    const conceptRecord = await createCreativeConcept(deps.creativeConceptDb, workspaceId, {
      campaignId,
      version: revisionAttempt,
      logline: conceptResult.logline,
      visualDirection: conceptResult.visualDirection,
      narrativeArc: conceptResult.narrativeArc,
      referenceNotes: conceptResult.referenceNotes,
    });

    const scriptAgentResult = await deps.executeSpecialistAgentActivity({
      workspaceId,
      campaignId,
      workflowRunId,
      stage: 'STRATEGY_REVIEW',
      agentName: 'script-timing-director',
      agentVersion: 1,
      idempotencyKey: agentIdempotencyKey(workflowRunId, 'script-timing-director', revisionAttempt),
      payload: {
        logline: conceptResult.logline,
        visualDirection: conceptResult.visualDirection,
        narrativeArc: conceptResult.narrativeArc,
        targetDurationsSeconds: brief.durationsSeconds,
        keyMessages: brief.requiredMessaging,
        callToAction: brief.callToAction,
        revisionFeedback,
      },
      context: {
        campaignId,
        priorArtifactRefs: [conceptRecord.id],
        budgetRemainingCents: brief.budgetCents,
      },
      correlationId: workflowRunId,
      causationId: conceptAgentResult.invocationId,
      budgetScope: {},
    });
    if (scriptAgentResult.status !== 'SUCCEEDED') {
      return {
        ok: false,
        reason: 'AGENT_FAILED',
        agentName: 'script-timing-director',
        detail: scriptAgentResult.failure?.message ?? 'script-timing-director invocation failed',
      };
    }
    const scriptResult = ScriptTimingDirectorResultSchema.parse(scriptAgentResult.result);
    const { script } = await createScriptWithShots(deps.scriptDb, workspaceId, {
      campaignId,
      creativeConceptId: conceptRecord.id,
      version: revisionAttempt,
      totalDurationFrames: scriptResult.totalDurationFrames,
      shots: scriptResult.shots.map((shot) => ({
        index: shot.index,
        description: shot.description,
        durationFrames: shot.durationFrames,
        beat: shot.beat,
        dependsOnShotIndices: shot.dependsOnShotIndices,
      })),
    });

    return {
      ok: true,
      strategyId: strategyRecord.id,
      conceptId: conceptRecord.id,
      scriptId: script.id,
    };
  };
}
