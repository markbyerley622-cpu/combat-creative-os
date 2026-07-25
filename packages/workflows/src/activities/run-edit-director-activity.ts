import type { AgentDefinition } from '@combat/agent-runtime';
import { EditDirectorResultSchema } from '@combat/agents';
import type {
  CampaignBriefDataSource,
  CampaignDataSource,
  CandidateEligibilityDataSource,
  CreativeConceptDataSource,
  PromptDataSource,
  RoughEditSpecificationDataSource,
  ScriptDataSource,
  ShotDataSource,
  ShotSelectionDataSource,
} from '@combat/database';
import {
  createRoughEditSpecification,
  gatherCandidateEligibility,
  getLatestAcceptedCampaignBrief,
  getLatestCreativeConcept,
  getLatestRoughEditSpecification,
  getLatestScript,
  getOrCreatePromptVersionForAgent,
  getShotSelectionSet,
  listShotSelections,
  listShotsForScript,
} from '@combat/database';
import type {
  ExecuteSpecialistAgentInput,
  ExecuteSpecialistAgentOutput,
  RoughEditClip,
  RoughEditOverlay,
} from '@combat/domain';

/** Maps an aspect ratio to a vertical-first resolution (documented MVP mapping; no per-campaign resolution field exists yet). */
function resolutionFor(aspectRatio: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '1:1':
      return { width: 1080, height: 1080 };
    case '16:9':
      return { width: 1920, height: 1080 };
    case '4:5':
      return { width: 1080, height: 1350 };
    case '9:16':
    default:
      return { width: 1080, height: 1920 };
  }
}

export interface RunEditDirectorInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  readonly shotSelectionSetId: string;
  /** 1-based; also the RoughEditSpecification version and the agent idempotency-key discriminator for this COMPOSITING visit. */
  readonly attempt: number;
}

export type RunEditDirectorOutput =
  | {
      readonly ok: true;
      readonly roughEditSpecificationId: string;
      readonly version: number;
    }
  | { readonly ok: false; readonly reason: 'CAMPAIGN_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'SELECTION_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'SELECTION_NOT_APPROVED'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'STALE_SELECTION'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'INCOMPLETE_SELECTION'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'BRIEF_NOT_FOUND'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'INELIGIBLE_SOURCE';
      readonly shotId: string;
      readonly detail: string;
      readonly reasons: string[];
    }
  | { readonly ok: false; readonly reason: 'AGENT_FAILED'; readonly detail: string };

export interface RunEditDirectorActivityDeps {
  readonly executeSpecialistAgentActivity: (
    input: ExecuteSpecialistAgentInput,
  ) => Promise<ExecuteSpecialistAgentOutput>;
  readonly agentRegistry: Readonly<Record<string, AgentDefinition<unknown, unknown>>>;
  readonly campaignDb: CampaignDataSource;
  readonly campaignBriefDb: CampaignBriefDataSource;
  readonly creativeConceptDb: CreativeConceptDataSource;
  readonly scriptDb: ScriptDataSource & ShotDataSource;
  readonly shotSelectionDb: ShotSelectionDataSource;
  readonly eligibilityDb: CandidateEligibilityDataSource;
  readonly promptDb: PromptDataSource;
  readonly roughEditSpecificationDb: RoughEditSpecificationDataSource;
}

/**
 * M9: runs the existing `edit-director` agent through the ADR-0004
 * `executeSpecialistAgentActivity` boundary and persists its output — combined
 * with the approved, revalidated selection + delivery context — as the
 * canonical, versioned `RoughEditSpecification`. The agent receives ONLY
 * approved, workspace-scoped, licensed, eligible, current inputs; it never
 * touches a repository, provider, or another agent. The selection is
 * re-verified here (APPROVED + complete + current) and every selected
 * candidate is re-checked for eligibility + licensing before the agent runs,
 * so a stale/ineligible/unlicensed source can never produce a rough edit.
 */
export function createRunEditDirectorActivity(
  deps: RunEditDirectorActivityDeps,
): (input: RunEditDirectorInput) => Promise<RunEditDirectorOutput> {
  return async function runEditDirectorActivity(
    input: RunEditDirectorInput,
  ): Promise<RunEditDirectorOutput> {
    const { workspaceId, campaignId, workflowRunId, shotSelectionSetId, attempt } = input;

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

    const set = await getShotSelectionSet(deps.shotSelectionDb, workspaceId, shotSelectionSetId);
    if (!set) {
      return {
        ok: false,
        reason: 'SELECTION_NOT_FOUND',
        detail: `set ${shotSelectionSetId} not found`,
      };
    }
    if (set.status !== 'APPROVED') {
      return { ok: false, reason: 'SELECTION_NOT_APPROVED', detail: `set is ${set.status}` };
    }

    const [brief, concept, script] = await Promise.all([
      getLatestAcceptedCampaignBrief(deps.campaignBriefDb, workspaceId, campaignId),
      getLatestCreativeConcept(deps.creativeConceptDb, workspaceId, campaignId),
      getLatestScript(deps.scriptDb, workspaceId, campaignId),
    ]);
    if (!brief) {
      return {
        ok: false,
        reason: 'BRIEF_NOT_FOUND',
        detail: `campaign ${campaignId} has no accepted brief`,
      };
    }
    if (!concept || !script) {
      return {
        ok: false,
        reason: 'STALE_SELECTION',
        detail: 'campaign has no current concept/script',
      };
    }
    if (set.scriptVersion !== script.version) {
      return {
        ok: false,
        reason: 'STALE_SELECTION',
        detail: `selection built against script v${set.scriptVersion}, latest is v${script.version}`,
      };
    }

    const selections = await listShotSelections(deps.shotSelectionDb, set.id);
    const unresolved = selections.filter((s) => s.status !== 'SELECTED' || !s.selectedCandidateId);
    if (selections.length === 0 || unresolved.length > 0) {
      return {
        ok: false,
        reason: 'INCOMPLETE_SELECTION',
        detail: `${unresolved.length} of ${selections.length} shots unresolved`,
      };
    }

    const shots = await listShotsForScript(deps.scriptDb, script.id);
    const shotById = new Map(shots.map((s) => [s.id, s]));

    // Revalidate every selected candidate's eligibility (SUCCEEDED, READY, QA
    // passed, licensing valid, not superseded) before the rough edit is built.
    const selectedShots: {
      shotIndex: number;
      beat: (typeof shots)[number]['beat'];
      description: string;
      durationFrames: number;
      sourceAssetRef: string;
      shotId: string;
    }[] = [];
    for (const selection of [...selections].sort(
      (a, b) => a.sequencePosition - b.sequencePosition,
    )) {
      const shot = shotById.get(selection.shotId);
      if (!shot) {
        return {
          ok: false,
          reason: 'STALE_SELECTION',
          detail: `shot ${selection.shotId} not in latest script`,
        };
      }
      // eslint-disable-next-line no-await-in-loop -- small, per-selection set; each revalidation is independent read work
      const eligibility = await gatherCandidateEligibility(deps.eligibilityDb, workspaceId, {
        campaignId,
        shotId: selection.shotId,
        candidateId: selection.selectedCandidateId!,
        latestScriptVersion: script.version,
        latestConceptVersion: concept.version,
      });
      if (!eligibility || !eligibility.eligibility.eligible) {
        return {
          ok: false,
          reason: 'INELIGIBLE_SOURCE',
          shotId: selection.shotId,
          detail: `selected candidate is no longer eligible`,
          reasons: eligibility?.eligibility.reasons ?? ['NOT_SUCCEEDED'],
        };
      }
      if (!eligibility.candidate.assetId) {
        return {
          ok: false,
          reason: 'INELIGIBLE_SOURCE',
          shotId: selection.shotId,
          detail: 'selected candidate has no registered source asset',
          reasons: ['ASSET_NOT_READY'],
        };
      }
      selectedShots.push({
        shotIndex: shot.index,
        beat: shot.beat,
        description: shot.description,
        durationFrames: shot.durationFrames,
        sourceAssetRef: eligibility.candidate.assetId,
        shotId: shot.id,
      });
    }

    const frameRate = 30;
    const aspectRatio = brief.aspectRatios[0] ?? '9:16';
    const platform = brief.targetPlatforms[0] ?? 'GENERIC';
    const targetTotalDurationFrames = selectedShots.reduce((sum, s) => sum + s.durationFrames, 0);
    const brandTokens = concept.referenceNotes ?? [];

    const definition = deps.agentRegistry['edit-director'];
    if (!definition) {
      throw new Error('"edit-director" is not registered in the injected agent registry');
    }
    const promptVersionRecord = await getOrCreatePromptVersionForAgent(deps.promptDb, workspaceId, {
      agentKey: 'edit-director',
      version: definition.promptVersion.version,
      systemPrompt: definition.promptVersion.systemPrompt,
    });

    const agentResult = await deps.executeSpecialistAgentActivity({
      workspaceId,
      campaignId,
      workflowRunId,
      stage: 'COMPOSITING',
      agentName: 'edit-director',
      agentVersion: definition.promptVersion.version,
      idempotencyKey: `${workflowRunId}:AGENT:COMPOSITING:edit-director:${set.id}:${attempt}`,
      payload: {
        frameRate,
        aspectRatio,
        platform,
        targetTotalDurationFrames,
        brandTokens,
        selectedShots: selectedShots.map((s) => ({
          shotIndex: s.shotIndex,
          beat: s.beat,
          description: s.description,
          durationFrames: s.durationFrames,
          sourceAssetRef: s.sourceAssetRef,
        })),
      },
      context: { campaignId, priorArtifactRefs: [set.id], budgetRemainingCents: brief.budgetCents },
      correlationId: workflowRunId,
      budgetScope: {},
    });
    if (agentResult.status !== 'SUCCEEDED') {
      return {
        ok: false,
        reason: 'AGENT_FAILED',
        detail: agentResult.failure?.message ?? 'edit-director invocation failed',
      };
    }

    const result = EditDirectorResultSchema.parse(agentResult.result);
    const bySourceRef = new Map(selectedShots.map((s) => [s.shotIndex, s]));
    const clips: RoughEditClip[] = result.entries
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((entry) => {
        const shot = bySourceRef.get(entry.shotIndex)!;
        return {
          order: entry.order,
          shotId: shot.shotId,
          shotIndex: entry.shotIndex,
          sourceAssetId: shot.sourceAssetRef,
          sourceInFrame: entry.sourceInFrame,
          sourceOutFrame: entry.sourceOutFrame,
          timelineStartFrame: entry.startFrame,
          durationFrames: entry.durationFrames,
          transitionIn: entry.transitionIn,
          continuityNote: entry.continuityNote,
        };
      });
    const overlays: RoughEditOverlay[] = result.overlays.map((o) => ({
      kind: o.kind,
      shotIndex: o.shotIndex,
      description: o.description,
    }));
    const resolution = resolutionFor(aspectRatio);
    const version =
      ((
        await getLatestRoughEditSpecification(
          deps.roughEditSpecificationDb,
          workspaceId,
          campaignId,
        )
      )?.version ?? 0) + 1;

    const spec = await createRoughEditSpecification(deps.roughEditSpecificationDb, workspaceId, {
      campaignId,
      creativeConceptId: concept.id,
      creativeConceptVersion: concept.version,
      scriptId: script.id,
      scriptVersion: script.version,
      shotSelectionSetId: set.id,
      shotSelectionSetVersion: set.version,
      version,
      outputFormat: 'mp4',
      aspectRatio,
      resolutionWidth: resolution.width,
      resolutionHeight: resolution.height,
      frameRate: result.frameRate,
      targetDurationFrames: result.durationFrames,
      tracks: [{ trackType: 'VIDEO', clips }],
      overlays,
      pacingNotes: result.pacingNotes,
      beatStructure: result.beatStructure,
      continuityNotes: result.continuityNotes,
      textSafeAreas: [],
      brandTokens,
      captionPlaceholder: result.captionPlaceholder,
      musicPlaceholder: result.musicPlaceholder,
      sfxPlaceholder: result.sfxPlaceholder,
      platform,
      platformDeliveryNotes: `Delivery for ${platform} at ${aspectRatio}`,
      editRationale: result.editRationale,
      qualityRubric: result.qualityRubric,
      promptVersionId: promptVersionRecord.id,
      createdByAgentInvocationId: agentResult.invocationId,
    });

    return { ok: true, roughEditSpecificationId: spec.id, version: spec.version };
  };
}
