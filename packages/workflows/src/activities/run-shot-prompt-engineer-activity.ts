import type { AgentDefinition } from '@combat/agent-runtime';
import { ShotPromptEngineerResultSchema } from '@combat/agents';
import type {
  AssetDataSource,
  CampaignBriefDataSource,
  CreativeConceptDataSource,
  LicenseDataSource,
  PromptDataSource,
  ScriptDataSource,
  ShotDataSource,
  ShotSpecificationDataSource,
} from '@combat/database';
import {
  createShotSpecification,
  getLatestAcceptedCampaignBrief,
  getLatestCreativeConcept,
  getLatestScript,
  getLicenseRecord,
  getOrCreatePromptVersionForAgent,
  listAssetsForCampaign,
  listShotsForScript,
} from '@combat/database';
import type { ExecuteSpecialistAgentInput, ExecuteSpecialistAgentOutput } from '@combat/domain';

/**
 * Frames-per-second assumed when converting a `Shot.durationFrames` (an
 * integer set by the Script & Timing Director) into `ShotSpecification`'s
 * `intendedDurationSeconds`. No per-campaign frame rate is threaded through
 * the pipeline yet (`Timeline.frameRate` defaults to 30 and nothing upstream
 * of this Activity currently varies it) — documented here rather than
 * silently assumed, so a future campaign-level frame rate becomes an
 * explicit input change, not a hidden constant to rediscover.
 */
const DEFAULT_FRAME_RATE = 30;

export interface RunShotPromptEngineerInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  readonly providerId: string;
  /** 1-based. Also used as the `version` for every ShotSpecification persisted in this call. */
  readonly revisionAttempt: number;
}

export type RunShotPromptEngineerOutput =
  | { readonly ok: true; readonly shotSpecificationIds: string[] }
  | { readonly ok: false; readonly reason: 'BRIEF_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'CONCEPT_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'SCRIPT_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'STALE_SCRIPT_VERSION'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'UNLICENSED_REFERENCE_ASSET';
      readonly detail: string;
      readonly assetId: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'AGENT_FAILED';
      readonly agentName: string;
      readonly shotId: string;
      readonly detail: string;
    };

export interface RunShotPromptEngineerActivityDeps {
  readonly executeSpecialistAgentActivity: (
    input: ExecuteSpecialistAgentInput,
  ) => Promise<ExecuteSpecialistAgentOutput>;
  /** Resolved exclusively through this registry (same convention as `execute-specialist-agent-activity.ts`) — only `promptVersion` (version + systemPrompt) is read from it, to bridge into the DB-level PromptTemplate/PromptVersion rows. */
  readonly agentRegistry: Readonly<Record<string, AgentDefinition<unknown, unknown>>>;
  readonly campaignBriefDb: CampaignBriefDataSource;
  readonly creativeConceptDb: CreativeConceptDataSource;
  readonly scriptDb: ScriptDataSource & ShotDataSource;
  readonly assetDb: AssetDataSource;
  readonly licenseDb: LicenseDataSource;
  readonly promptDb: PromptDataSource;
  readonly shotSpecificationDb: ShotSpecificationDataSource;
}

function agentIdempotencyKey(
  workflowRunId: string,
  shotId: string,
  revisionAttempt: number,
): string {
  return `${workflowRunId}:AGENT:PROMPTING:shot-prompt-engineer:${shotId}:${revisionAttempt}`;
}

/**
 * Runs the existing `shot-prompt-engineer` agent once per shot in the
 * campaign's latest script, persisting each result as an immutable versioned
 * `ShotSpecification` (M6 requirement 4). Every agent call goes through the
 * injected `executeSpecialistAgentActivity` — the one Activity boundary
 * ADR-0004 designates for agent execution — so idempotency/budget-check/
 * `AgentInvocation`-persistence logic is never duplicated here (CLAUDE.md:
 * "Specialist agents never call other agents or the database directly").
 *
 * All shots run within one Activity invocation, mirroring
 * `run-strategy-concept-script-activity.ts`'s "one new proxied call per
 * workflow stage visit" precedent — sequential (not `Promise.all`), matching
 * `createScriptWithShots`'s established sequencing rationale, since each
 * `executeSpecialistAgentActivity` call and its DB write must complete
 * before the next shot's idempotency key is safe to construct/replay.
 *
 * Revision feedback: `priorRevisionFeedback` is always omitted at this
 * milestone — no QC agent exists yet to produce the `QualityFailure` rows a
 * real feedback source would read from (Visual/Continuity QC is M7 scope).
 * The field is threaded through the agent's input schema and ready for a
 * future Activity revision to populate it once that data exists.
 */
export function createRunShotPromptEngineerActivity(
  deps: RunShotPromptEngineerActivityDeps,
): (input: RunShotPromptEngineerInput) => Promise<RunShotPromptEngineerOutput> {
  return async function runShotPromptEngineerActivity(
    input: RunShotPromptEngineerInput,
  ): Promise<RunShotPromptEngineerOutput> {
    const { workspaceId, campaignId, workflowRunId, providerId, revisionAttempt } = input;

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

    const concept = await getLatestCreativeConcept(deps.creativeConceptDb, workspaceId, campaignId);
    if (!concept) {
      return {
        ok: false,
        reason: 'CONCEPT_NOT_FOUND',
        detail: `Campaign ${campaignId} has no CreativeConcept`,
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
    // A script generated against an older concept than what's now latest is
    // stale — proceeding would build shot specifications for a superseded
    // visual direction (M6 requirement 4: "rejects stale concept/script
    // versions").
    if (script.creativeConceptId !== concept.id) {
      return {
        ok: false,
        reason: 'STALE_SCRIPT_VERSION',
        detail: `Script ${script.id} (v${script.version}) was generated against concept ${script.creativeConceptId}, but the latest concept is ${concept.id} (v${concept.version})`,
      };
    }

    const shots = await listShotsForScript(deps.scriptDb, script.id);

    // Reference-asset pool: every UPLOADED_SOURCE asset collected for this
    // campaign, offered to every shot. Every one must carry a LicenseRecord
    // (CLAUDE.md: never weaken licensing) — a single unlicensed asset fails
    // the whole batch rather than silently omitting it.
    const referenceAssets = await listAssetsForCampaign(
      deps.assetDb,
      workspaceId,
      campaignId,
      'UPLOADED_SOURCE',
    );
    const licenseRecords = new Map<string, Awaited<ReturnType<typeof getLicenseRecord>>>();
    for (const asset of referenceAssets) {
      // eslint-disable-next-line no-await-in-loop -- small, campaign-scoped set; sequential keeps the fail-fast unlicensed-asset check simple
      const license = await getLicenseRecord(deps.licenseDb, workspaceId, asset.id);
      if (!license) {
        return {
          ok: false,
          reason: 'UNLICENSED_REFERENCE_ASSET',
          detail: `Asset ${asset.id} has no LicenseRecord and cannot be offered as a shot reference`,
          assetId: asset.id,
        };
      }
      licenseRecords.set(asset.id, license);
    }
    const referenceAssetIds = referenceAssets.map((a) => a.id);
    const licensingConstraints = Array.from(
      new Set(referenceAssets.flatMap((a) => licenseRecords.get(a.id)?.restrictions ?? [])),
    );

    // A missing registry entry here is an orchestrator wiring bug, not a
    // business outcome — `executeSpecialistAgentActivity` (called per-shot
    // below) already surfaces AGENT_NOT_FOUND as a typed failure against its
    // own registry; this one is only consulted for prompt-version metadata,
    // so failing loudly rather than persisting a `ShotSpecification` with a
    // fabricated `promptVersionId` is the correct behavior.
    const definition = deps.agentRegistry['shot-prompt-engineer'];
    if (!definition) {
      throw new Error('"shot-prompt-engineer" is not registered in the injected agent registry');
    }
    const promptVersionRecord = await getOrCreatePromptVersionForAgent(deps.promptDb, workspaceId, {
      agentKey: 'shot-prompt-engineer',
      version: definition.promptVersion.version,
      systemPrompt: definition.promptVersion.systemPrompt,
    });

    // `aspectRatios` is schema-guaranteed non-empty (CampaignBriefContentSchema: `.min(1)`) — the fallback below only guards TypeScript's static array-index typing, never a real runtime gap.
    const aspectRatio = brief.aspectRatios[0] ?? '9:16';
    const shotSpecificationIds: string[] = [];

    for (const shot of shots) {
      const intendedDurationSeconds = shot.durationFrames / DEFAULT_FRAME_RATE;

      // eslint-disable-next-line no-await-in-loop -- each shot's idempotency key/DB write must complete before the next is safe to construct (same sequencing rationale as createScriptWithShots)
      const agentResult = await deps.executeSpecialistAgentActivity({
        workspaceId,
        campaignId,
        workflowRunId,
        stage: 'PROMPTING',
        agentName: 'shot-prompt-engineer',
        agentVersion: 1,
        idempotencyKey: agentIdempotencyKey(workflowRunId, shot.id, revisionAttempt),
        payload: {
          shot: {
            index: shot.index,
            description: shot.description,
            durationFrames: shot.durationFrames,
          },
          visualDirection: concept.visualDirection,
          providerId,
        },
        context: {
          campaignId,
          priorArtifactRefs: [script.id],
          budgetRemainingCents: brief.budgetCents,
        },
        correlationId: workflowRunId,
        budgetScope: {},
      });

      if (agentResult.status !== 'SUCCEEDED') {
        return {
          ok: false,
          reason: 'AGENT_FAILED',
          agentName: 'shot-prompt-engineer',
          shotId: shot.id,
          detail: agentResult.failure?.message ?? 'shot-prompt-engineer invocation failed',
        };
      }

      const result = ShotPromptEngineerResultSchema.parse(agentResult.result);

      // eslint-disable-next-line no-await-in-loop -- sequential for the same reason as the agent call above
      const record = await createShotSpecification(deps.shotSpecificationDb, workspaceId, {
        campaignId,
        creativeConceptId: concept.id,
        creativeConceptVersion: concept.version,
        scriptId: script.id,
        scriptVersion: script.version,
        shotId: shot.id,
        version: revisionAttempt,
        shotNumber: shot.index,
        sequencePosition: shot.index,
        intendedDurationSeconds,
        visualObjective: result.visualObjective,
        action: result.action,
        subject: result.subject,
        environment: result.environment,
        cameraMovement: result.cameraMovement,
        lensFraming: result.lensFraming,
        lighting: result.lighting,
        colorTreatment: result.colorTreatment,
        motionIntensity: result.motionIntensity,
        transitionIn: result.transitionIn,
        transitionOut: result.transitionOut,
        textSafeAreas: result.textSafeAreas,
        appInterfaceRequirements: result.appInterfaceRequirements,
        referenceAssetIds,
        continuityRequirements: result.continuityRequirements,
        providerId: result.providerId,
        promptVersionId: promptVersionRecord.id,
        generationPrompt: result.promptText,
        negativePrompt: result.negativePrompt,
        generationParams: {
          durationSeconds: intendedDurationSeconds,
          aspectRatio,
          providerOptions: result.params,
        },
        outputRequirements: {
          durationSeconds: intendedDurationSeconds,
          aspectRatio,
          minCandidateCount: 1,
        },
        qualityRubric: result.qualityRubric,
        licensingConstraints,
        createdByAgentInvocationId: agentResult.invocationId,
      });

      shotSpecificationIds.push(record.id);
    }

    return { ok: true, shotSpecificationIds };
  };
}
