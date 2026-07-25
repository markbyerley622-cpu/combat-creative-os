import type { AgentDefinition } from '@combat/agent-runtime';
import { SoundDirectorResultSchema } from '@combat/agents';
import type {
  AssetDataSource,
  CampaignBriefDataSource,
  CampaignDataSource,
  CreativeConceptDataSource,
  PromptDataSource,
  RoughEditSpecificationDataSource,
  ScriptDataSource,
  SoundDesignDataSource,
  TimelineDataSource,
} from '@combat/database';
import {
  createAssetWithProvenance,
  createSoundCue,
  createSoundDesignPlan,
  createTimeline,
  findAssetByChecksum,
  getLatestAcceptedCampaignBrief,
  getLatestCreativeConcept,
  getLatestRoughEditSpecification,
  getLatestScript,
  getOrCreatePromptVersionForAgent,
  listSoundCuesForTimeline,
} from '@combat/database';
import type { ExecuteSpecialistAgentInput, ExecuteSpecialistAgentOutput } from '@combat/domain';

export interface RunSoundDirectorInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  /** 1-based; distinguishes the agent idempotency key of each SOUND_DESIGN visit. */
  readonly revisionAttempt: number;
}

export type RunSoundDirectorOutput =
  | {
      readonly ok: true;
      readonly soundDesignPlanId: string;
      readonly timelineId: string;
      readonly version: number;
      readonly cueCount: number;
    }
  | { readonly ok: false; readonly reason: 'CAMPAIGN_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ROUGH_EDIT_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'BRIEF_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'AGENT_FAILED'; readonly detail: string };

export interface RunSoundDirectorActivityDeps {
  readonly executeSpecialistAgentActivity: (
    input: ExecuteSpecialistAgentInput,
  ) => Promise<ExecuteSpecialistAgentOutput>;
  readonly agentRegistry: Readonly<Record<string, AgentDefinition<unknown, unknown>>>;
  readonly campaignDb: CampaignDataSource;
  readonly campaignBriefDb: CampaignBriefDataSource;
  readonly creativeConceptDb: CreativeConceptDataSource;
  readonly scriptDb: ScriptDataSource;
  readonly roughEditSpecificationDb: RoughEditSpecificationDataSource;
  readonly timelineDb: TimelineDataSource;
  readonly soundDesignDb: SoundDesignDataSource;
  readonly promptDb: PromptDataSource;
  readonly assetDb: AssetDataSource;
}

/**
 * M10: runs the existing `sound-director` agent through the ADR-0004
 * `executeSpecialistAgentActivity` boundary and persists its output — the
 * versioned `SoundDesignPlan` (music brief + mix notes + provenance), the
 * assembled `Timeline` built from the rough edit, and one `SoundCue` per cue
 * (each with a registered mock `SOUND_STEM` asset). The agent receives only
 * the approved, workspace-scoped rough edit + brand audio guidelines and never
 * touches a repository/provider/other agent. Idempotent under Activity retry:
 * the Timeline/plan are idempotent per (campaign, version) and cue creation is
 * skipped once cues already exist for the timeline.
 */
export function createRunSoundDirectorActivity(
  deps: RunSoundDirectorActivityDeps,
): (input: RunSoundDirectorInput) => Promise<RunSoundDirectorOutput> {
  return async function runSoundDirectorActivity(
    input: RunSoundDirectorInput,
  ): Promise<RunSoundDirectorOutput> {
    const { workspaceId, campaignId, workflowRunId, revisionAttempt } = input;

    const campaign = await deps.campaignDb.campaign.findFirst({
      where: { id: campaignId, workspaceId },
    });
    if (!campaign) {
      return {
        ok: false,
        reason: 'CAMPAIGN_NOT_FOUND',
        detail: `campaign ${campaignId} not found`,
      };
    }

    const spec = await getLatestRoughEditSpecification(
      deps.roughEditSpecificationDb,
      workspaceId,
      campaignId,
    );
    if (!spec) {
      return {
        ok: false,
        reason: 'ROUGH_EDIT_NOT_FOUND',
        detail: `campaign ${campaignId} has no RoughEditSpecification`,
      };
    }

    const [brief, concept, script] = await Promise.all([
      getLatestAcceptedCampaignBrief(deps.campaignBriefDb, workspaceId, campaignId),
      getLatestCreativeConcept(deps.creativeConceptDb, workspaceId, campaignId),
      getLatestScript(deps.scriptDb, workspaceId, campaignId),
    ]);
    if (!brief || !script) {
      return {
        ok: false,
        reason: 'BRIEF_NOT_FOUND',
        detail: `campaign ${campaignId} missing brief/script`,
      };
    }

    const clips = spec.tracks
      .filter((t) => t.trackType === 'VIDEO')
      .flatMap((t) => t.clips)
      .sort((a, b) => a.order - b.order);
    const brandAudioGuidelines = [brief.brandVoice, ...(concept?.referenceNotes ?? [])].filter(
      (g): g is string => Boolean(g),
    );

    const definition = deps.agentRegistry['sound-director'];
    if (!definition) {
      throw new Error('"sound-director" is not registered in the injected agent registry');
    }
    const promptVersionRecord = await getOrCreatePromptVersionForAgent(deps.promptDb, workspaceId, {
      agentKey: 'sound-director',
      version: definition.promptVersion.version,
      systemPrompt: definition.promptVersion.systemPrompt,
    });

    const agentResult = await deps.executeSpecialistAgentActivity({
      workspaceId,
      campaignId,
      workflowRunId,
      stage: 'SOUND_DESIGN',
      agentName: 'sound-director',
      agentVersion: definition.promptVersion.version,
      idempotencyKey: `${workflowRunId}:AGENT:SOUND_DESIGN:sound-director:${spec.id}:${revisionAttempt}`,
      payload: {
        frameRate: spec.frameRate,
        durationFrames: spec.targetDurationFrames,
        timelineEntries: clips.map((c) => ({
          shotIndex: c.shotIndex,
          startFrame: c.timelineStartFrame,
          durationFrames: c.durationFrames,
        })),
        brandAudioGuidelines,
      },
      context: {
        campaignId,
        priorArtifactRefs: [spec.id],
        budgetRemainingCents: brief.budgetCents,
      },
      correlationId: workflowRunId,
      budgetScope: {},
    });
    if (agentResult.status !== 'SUCCEEDED') {
      return {
        ok: false,
        reason: 'AGENT_FAILED',
        detail: agentResult.failure?.message ?? 'sound-director invocation failed',
      };
    }
    const result = SoundDirectorResultSchema.parse(agentResult.result);

    // Version is stable per rough-edit so retries/replays are idempotent.
    const version = spec.version;
    const timeline = await createTimeline(deps.timelineDb, workspaceId, {
      campaignId,
      scriptId: spec.scriptId,
      version,
      frameRate: spec.frameRate,
      durationFrames: spec.targetDurationFrames,
      entries: clips.map((c) => ({
        shotId: c.shotId,
        order: c.order,
        startFrame: c.timelineStartFrame,
        durationFrames: c.durationFrames,
      })),
    });

    const plan = await createSoundDesignPlan(deps.soundDesignDb, workspaceId, {
      campaignId,
      timelineId: timeline.id,
      roughEditSpecificationId: spec.id,
      version,
      musicBrief: result.musicBrief,
      mixNotes: result.mixNotes,
      brandAudioGuidelines,
      qualityRubric: [],
      promptVersionId: promptVersionRecord.id,
      createdByAgentInvocationId: agentResult.invocationId,
    });

    // Cue + stem creation is skipped once cues already exist for the timeline
    // (idempotent replay). Each cue gets a deterministic mock SOUND_STEM asset.
    const existingCues = await listSoundCuesForTimeline(deps.soundDesignDb, timeline.id);
    if (existingCues.length === 0) {
      for (const [index, cue] of result.cues.entries()) {
        const checksum = `sound-stem-${plan.id}-${index}`;
        // eslint-disable-next-line no-await-in-loop -- small, per-plan set; deterministic ordered stem registration
        let stem = await findAssetByChecksum(deps.assetDb, workspaceId, checksum, 'SOUND_STEM');
        if (!stem) {
          // eslint-disable-next-line no-await-in-loop -- same rationale
          const created = await createAssetWithProvenance(deps.assetDb, workspaceId, {
            campaignId,
            kind: 'SOUND_STEM',
            s3Key: `mock/sound-stem/${plan.id}/${index}.wav`,
            checksum,
            mimeType: 'audio/wav',
            originalFilename: `${cue.type.toLowerCase()}-${index}.wav`,
            sizeBytes: 0,
            ingestionStatus: 'READY',
            generatedByActivity: 'runSoundDirectorActivity',
            producedByInvocationId: agentResult.invocationId,
          });
          stem = created.asset;
        }
        // eslint-disable-next-line no-await-in-loop -- same rationale
        await createSoundCue(deps.soundDesignDb, workspaceId, {
          timelineId: timeline.id,
          type: cue.type,
          startFrame: cue.startFrame,
          durationFrames: cue.durationFrames,
          assetId: stem.id,
          notes: cue.notes,
        });
      }
    }

    const cues = await listSoundCuesForTimeline(deps.soundDesignDb, timeline.id);
    return {
      ok: true,
      soundDesignPlanId: plan.id,
      timelineId: timeline.id,
      version,
      cueCount: cues.length,
    };
  };
}
