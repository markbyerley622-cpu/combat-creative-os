import { VariantGeneratorResultSchema } from '@combat/agents';
import type { AgentDefinition } from '@combat/agent-runtime';
import type {
  AssetDataSource,
  CampaignDataSource,
  CreativeConceptDataSource,
  DeliveryProfileDataSource,
  DeliveryProfileRecord,
  PromptDataSource,
  QualityAssessmentDataSource,
  RoughEditSpecificationDataSource,
  ScriptDataSource,
  ShotDataSource,
  ShotSelectionDataSource,
  SoundDesignDataSource,
  TimelineDataSource,
  VariantDataSource,
} from '@combat/database';
import {
  createVariantSpecification,
  getLatestCreativeConcept,
  getLatestDeliveryProfile,
  getLatestRoughEditSpecification,
  getLatestScript,
  getLatestShotSelectionSet,
  getLatestSoundDesignPlan,
  getLatestTimeline,
  getOrCreateDeliveryProfile,
  getOrCreatePromptVersionForAgent,
  getQualityAssessmentForAsset,
  listAssetsForCampaign,
  listShotsForScript,
  listSoundCuesForTimeline,
  listTimelineEntries,
} from '@combat/database';
import type {
  CtaPlacement,
  ExecuteSpecialistAgentInput,
  ExecuteSpecialistAgentOutput,
  RetainedClip,
  RetainedCue,
  VariantCutViolation,
} from '@combat/domain';
import { timelineBoundaries, validateVariantCut, VERTICAL_SHORT_FORM_V1 } from '@combat/domain';

/**
 * Cue types that are hard cut boundaries. A continuous MUSIC bed is
 * deliberately excluded: it spans the whole master and is re-mixed to the
 * variant's length, so treating it as a boundary would make every cutdown
 * illegal by construction. Discrete SFX/VOICEOVER cues genuinely cannot be
 * sliced in half. See `AudioCueSegment` in @combat/domain.
 */
const HARD_BOUNDARY_CUE_TYPES: ReadonlySet<string> = new Set(['SFX', 'VOICEOVER']);

export interface RunVariantGeneratorInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  readonly deliveryProfileKey: string;
  /** 1-based; distinguishes the agent idempotency key of each VARIANT_GENERATION visit. */
  readonly revisionAttempt: number;
}

export interface VariantSpecificationSummary {
  readonly variantSpecificationId: string;
  readonly targetDurationSeconds: number;
  readonly deliverySpecificationId: string;
  readonly version: number;
}

export type RunVariantGeneratorOutput =
  | {
      readonly ok: true;
      readonly parentMasterAssetId: string;
      readonly deliveryProfileId: string;
      readonly specifications: readonly VariantSpecificationSummary[];
    }
  | { readonly ok: false; readonly reason: 'CAMPAIGN_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'MASTER_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'MASTER_NOT_QA_PASSED'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'UPSTREAM_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'DELIVERY_SPEC_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'AGENT_FAILED'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'INVALID_CUT';
      readonly targetDurationSeconds: number;
      readonly violations: readonly VariantCutViolation[];
      readonly detail: string;
    };

export interface RunVariantGeneratorActivityDeps {
  readonly executeSpecialistAgentActivity: (
    input: ExecuteSpecialistAgentInput,
  ) => Promise<ExecuteSpecialistAgentOutput>;
  readonly agentRegistry: Readonly<Record<string, AgentDefinition<unknown, unknown>>>;
  readonly campaignDb: CampaignDataSource;
  readonly creativeConceptDb: CreativeConceptDataSource;
  readonly scriptDb: ScriptDataSource & ShotDataSource;
  readonly shotSelectionDb: ShotSelectionDataSource;
  readonly roughEditSpecificationDb: RoughEditSpecificationDataSource;
  readonly timelineDb: TimelineDataSource;
  readonly soundDesignDb: SoundDesignDataSource;
  readonly qualityAssessmentDb: QualityAssessmentDataSource;
  readonly deliveryProfileDb: DeliveryProfileDataSource;
  readonly variantDb: VariantDataSource;
  readonly promptDb: PromptDataSource;
  readonly assetDb: AssetDataSource;
  /**
   * Resolves the per-platform `DeliverySpecification` row a rendered variant
   * attaches to. Injected rather than created here: `DeliverySpecification`
   * rows are campaign-configuration, not something a generation Activity
   * should mint.
   */
  readonly resolveDeliverySpecificationId: (input: {
    workspaceId: string;
    campaignId: string;
    platform: string;
    durationSeconds: number;
  }) => Promise<string | undefined>;
}

/**
 * M12: runs the existing `variant-generator` agent once per target duration in
 * the campaign's delivery profile, and persists each answer as an immutable,
 * versioned `VariantSpecification`.
 *
 * **Starts only from an approved, QA-passed master.** The parent `FINAL_MASTER`
 * asset must carry a passing `subjectStage: 'FINAL_QA'` `QualityAssessment`
 * (M11) — a missing or failing verdict is refused before any agent call, so no
 * variant is ever cut from a master that did not clear Final QA.
 *
 * The agent sees only legal cut boundaries derived from the persisted
 * `Timeline`, the discrete sound cues and caption spans it may not split, and
 * the delivery profile's requirements — never a repository, storage key,
 * provider, or another agent. Its answer is then checked by the pure
 * `validateVariantCut` before anything is written: an illegal cut is a typed
 * `INVALID_CUT` failure, not a persisted specification. Mechanical pins
 * (`retainedClips`' source assets and transitions, `retainedCues`) are derived
 * here from the rough edit and sound-design plan rather than trusted from the
 * agent, so a variant always references the exact approved source assets.
 *
 * Idempotent under Activity retry: each specification is keyed on the agent
 * invocation that produced it, so a replay returns the existing version.
 */
export function createRunVariantGeneratorActivity(
  deps: RunVariantGeneratorActivityDeps,
): (input: RunVariantGeneratorInput) => Promise<RunVariantGeneratorOutput> {
  return async function runVariantGeneratorActivity(
    input: RunVariantGeneratorInput,
  ): Promise<RunVariantGeneratorOutput> {
    const { workspaceId, campaignId, workflowRunId, revisionAttempt } = input;

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

    // --- The approved master, and proof it passed Final QA ------------------
    const masters = await listAssetsForCampaign(
      deps.assetDb,
      workspaceId,
      campaignId,
      'FINAL_MASTER',
    );
    const master = masters[0];
    if (!master) {
      return {
        ok: false,
        reason: 'MASTER_NOT_FOUND',
        detail: `Campaign ${campaignId} has no registered FINAL_MASTER asset`,
      };
    }
    const finalQa = await getQualityAssessmentForAsset(
      deps.qualityAssessmentDb,
      workspaceId,
      master.id,
      'FINAL_QA',
    );
    if (!finalQa || !finalQa.pass) {
      return {
        ok: false,
        reason: 'MASTER_NOT_QA_PASSED',
        detail: finalQa
          ? `FINAL_MASTER ${master.id} failed Final QA — no variant may be cut from it`
          : `FINAL_MASTER ${master.id} has no FINAL_QA assessment`,
      };
    }

    // --- Every upstream version the cut pins --------------------------------
    const [concept, script, selectionSet, roughEdit, timeline, plan] = await Promise.all([
      getLatestCreativeConcept(deps.creativeConceptDb, workspaceId, campaignId),
      getLatestScript(deps.scriptDb, workspaceId, campaignId),
      getLatestShotSelectionSet(deps.shotSelectionDb, workspaceId, campaignId),
      getLatestRoughEditSpecification(deps.roughEditSpecificationDb, workspaceId, campaignId),
      getLatestTimeline(deps.timelineDb, workspaceId, campaignId),
      getLatestSoundDesignPlan(deps.soundDesignDb, workspaceId, campaignId),
    ]);
    if (!concept || !script || !selectionSet || !roughEdit || !timeline || !plan) {
      return {
        ok: false,
        reason: 'UPSTREAM_NOT_FOUND',
        detail: `Campaign ${campaignId} is missing an upstream artifact the variant must pin (concept/script/selection/roughEdit/timeline/soundDesign)`,
      };
    }

    // --- Delivery profile: seeded on first use, then pinned by version ------
    let profile: DeliveryProfileRecord | undefined = await getLatestDeliveryProfile(
      deps.deliveryProfileDb,
      workspaceId,
      input.deliveryProfileKey,
    );
    if (!profile && input.deliveryProfileKey === VERTICAL_SHORT_FORM_V1.key) {
      profile = (
        await getOrCreateDeliveryProfile(deps.deliveryProfileDb, workspaceId, {
          ...VERTICAL_SHORT_FORM_V1,
        })
      ).profile;
    }
    if (!profile) {
      return {
        ok: false,
        reason: 'UPSTREAM_NOT_FOUND',
        detail: `No DeliveryProfile ${input.deliveryProfileKey} exists in workspace ${workspaceId}`,
      };
    }

    // --- Legal cut boundaries, from persisted Timeline + EDL data ----------
    const entries = await listTimelineEntries(deps.timelineDb, timeline.id);
    const shots = await listShotsForScript(deps.scriptDb, script.id);
    const shotById = new Map(shots.map((s) => [s.id, s]));
    const beatByShotId: Record<string, string | undefined> = Object.fromEntries(
      shots.map((s) => [s.id, s.beat]),
    );
    const segments = timelineBoundaries(entries, beatByShotId);
    if (segments.length === 0) {
      return {
        ok: false,
        reason: 'UPSTREAM_NOT_FOUND',
        detail: `Timeline ${timeline.id} has no entries to cut from`,
      };
    }

    const cues = await listSoundCuesForTimeline(deps.soundDesignDb, timeline.id);
    const discreteCues = cues
      .filter((c) => HARD_BOUNDARY_CUE_TYPES.has(c.type))
      .map((c) => ({
        soundCueId: c.id,
        startFrame: c.startFrame,
        endFrame: c.startFrame + c.durationFrames,
      }));

    // Caption spans follow the rough edit's CAPTION overlays. An overlay
    // pinned to a shotIndex covers that shot's segment; an unpinned overlay
    // covers the whole master and constrains nothing extra.
    const captionSegments = roughEdit.overlays
      .filter((o) => o.kind === 'CAPTION' && o.shotIndex !== undefined)
      .flatMap((o) => {
        const seg = segments.find((s) => shotById.get(s.shotId)?.index === o.shotIndex);
        return seg ? [{ startFrame: seg.startFrame, endFrame: seg.endFrame }] : [];
      });
    const ctaSegmentBoundary = segments.find((s) => s.beat === 'CTA');
    const ctaSegment = ctaSegmentBoundary
      ? { startFrame: ctaSegmentBoundary.startFrame, endFrame: ctaSegmentBoundary.endFrame }
      : undefined;

    // Source-asset pins, from the rough edit's VIDEO clips.
    const clipByShotId = new Map(
      roughEdit.tracks
        .filter((t) => t.trackType === 'VIDEO')
        .flatMap((t) => t.clips)
        .map((c) => [c.shotId, c]),
    );

    const definition = deps.agentRegistry['variant-generator'];
    if (!definition) {
      throw new Error('"variant-generator" is not registered in the injected agent registry');
    }
    const promptVersionRecord = await getOrCreatePromptVersionForAgent(deps.promptDb, workspaceId, {
      agentKey: 'variant-generator',
      version: definition.promptVersion.version,
      systemPrompt: definition.promptVersion.systemPrompt,
    });

    const specifications: VariantSpecificationSummary[] = [];
    for (const targetDurationSeconds of profile.durationsSeconds) {
      const deliverySpecificationId = await deps.resolveDeliverySpecificationId({
        workspaceId,
        campaignId,
        platform: profile.platforms[0]!,
        durationSeconds: targetDurationSeconds,
      });
      if (!deliverySpecificationId) {
        return {
          ok: false,
          reason: 'DELIVERY_SPEC_NOT_FOUND',
          detail: `No DeliverySpecification for ${profile.platforms[0]} at ${targetDurationSeconds}s`,
        };
      }

      // eslint-disable-next-line no-await-in-loop -- one agent call + persistence per duration; sequential keeps each idempotency key safe to replay independently
      const agentResult = await deps.executeSpecialistAgentActivity({
        workspaceId,
        campaignId,
        workflowRunId,
        stage: 'VARIANT_GENERATION',
        agentName: 'variant-generator',
        agentVersion: definition.promptVersion.version,
        idempotencyKey: `${workflowRunId}:AGENT:VARIANT_GENERATION:variant-generator:${master.id}:${targetDurationSeconds}:${revisionAttempt}`,
        payload: {
          masterDurationFrames: timeline.durationFrames,
          frameRate: timeline.frameRate,
          targetDurationSeconds,
          platform: profile.platforms[0],
          aspectRatio: profile.aspectRatio,
          resolutionWidth: profile.resolutionWidth,
          resolutionHeight: profile.resolutionHeight,
          timelineSegments: segments.map((s) => ({
            order: s.order,
            shotId: s.shotId,
            shotIndex: shotById.get(s.shotId)?.index ?? s.order,
            description: shotById.get(s.shotId)?.description ?? '',
            beat: s.beat,
            startFrame: s.startFrame,
            endFrame: s.endFrame,
          })),
          discreteAudioCues: discreteCues.map((c) => ({
            startFrame: c.startFrame,
            endFrame: c.endFrame,
          })),
          captionSegments,
          ctaSegment,
          captionBurnRequired: profile.captionBurnRequired,
          safeAreas: profile.safeAreas,
          ctaTailSeconds: profile.ctaTailSeconds,
          ctaMinimumDurationSeconds: profile.ctaMinimumDurationSeconds,
        },
        context: {
          campaignId,
          priorArtifactRefs: [master.id, timeline.id, roughEdit.id, plan.id],
          budgetRemainingCents: 0,
        },
        correlationId: workflowRunId,
        budgetScope: {},
      });
      if (agentResult.status !== 'SUCCEEDED') {
        return {
          ok: false,
          reason: 'AGENT_FAILED',
          detail:
            agentResult.failure?.message ??
            `variant-generator invocation failed for the ${targetDurationSeconds}s variant`,
        };
      }
      const result = VariantGeneratorResultSchema.parse(agentResult.result);

      // --- Derive the mechanical pins from persisted data, not the agent ---
      const retainedClips: RetainedClip[] = [];
      let clipOrder = 0;
      for (const cut of [...result.cutPoints].sort((a, b) => a.order - b.order)) {
        for (const seg of segments) {
          if (seg.startFrame >= cut.sourceStartFrame && seg.endFrame <= cut.sourceEndFrame) {
            const roughClip = clipByShotId.get(seg.shotId);
            retainedClips.push({
              order: clipOrder,
              shotId: seg.shotId,
              shotIndex: shotById.get(seg.shotId)?.index ?? seg.order,
              sourceAssetId: roughClip?.sourceAssetId ?? seg.shotId,
              beat: shotById.get(seg.shotId)?.beat,
              sourceStartFrame: seg.startFrame,
              sourceEndFrame: seg.endFrame,
              transitionIn: roughClip?.transitionIn,
            });
            clipOrder += 1;
          }
        }
      }

      const retainedCues: RetainedCue[] = [];
      for (const cue of cues) {
        const cueEnd = cue.startFrame + cue.durationFrames;
        for (const cut of result.cutPoints) {
          if (cue.startFrame >= cut.sourceStartFrame && cueEnd <= cut.sourceEndFrame) {
            retainedCues.push({
              soundCueId: cue.id,
              type: cue.type,
              sourceStartFrame: cue.startFrame,
              sourceEndFrame: cueEnd,
              variantStartFrame: cut.variantStartFrame + (cue.startFrame - cut.sourceStartFrame),
              assetId: cue.assetId,
            });
            break;
          }
        }
      }

      const ctaPlacement: CtaPlacement = result.ctaPlacement;

      // --- Deterministic legality check BEFORE anything is written ---------
      const validation = validateVariantCut({
        profile,
        targetDurationSeconds,
        cutPoints: result.cutPoints,
        retainedClips,
        retainedCues,
        retainedCaptions: result.retainedCaptions,
        ctaPlacement,
        safeAreas: profile.safeAreas,
        timelineSegments: segments,
        audioCues: discreteCues,
        captionSegments,
        parentCtaSegment: ctaSegment,
      });
      if (!validation.ok) {
        return {
          ok: false,
          reason: 'INVALID_CUT',
          targetDurationSeconds,
          violations: validation.violations,
          detail: `${targetDurationSeconds}s cut is illegal: ${validation.violations
            .map((v) => v.code)
            .join(', ')}`,
        };
      }

      // eslint-disable-next-line no-await-in-loop -- see sequencing note above
      const { specification } = await createVariantSpecification(deps.variantDb, workspaceId, {
        campaignId,
        parentMasterAssetId: master.id,
        parentFinalQaAssessmentId: finalQa.id,
        timelineId: timeline.id,
        timelineVersion: timeline.version,
        creativeConceptId: concept.id,
        creativeConceptVersion: concept.version,
        scriptId: script.id,
        scriptVersion: script.version,
        shotSelectionSetId: selectionSet.id,
        shotSelectionSetVersion: selectionSet.version,
        roughEditSpecificationId: roughEdit.id,
        roughEditSpecificationVersion: roughEdit.version,
        soundDesignPlanId: plan.id,
        soundDesignPlanVersion: plan.version,
        deliveryProfileId: profile.id,
        deliveryProfileKey: profile.key,
        deliveryProfileVersion: profile.version,
        deliverySpecificationId,
        platform: profile.platforms[0]!,
        targetDurationSeconds,
        targetDurationFrames: validation.variantDurationFrames,
        aspectRatio: profile.aspectRatio,
        resolutionWidth: profile.resolutionWidth,
        resolutionHeight: profile.resolutionHeight,
        frameRate: profile.frameRate,
        cutPoints: result.cutPoints,
        retainedClips,
        retainedCues,
        retainedCaptions: result.retainedCaptions,
        ctaPlacement,
        captionBurnRequired: profile.captionBurnRequired,
        safeAreas: profile.safeAreas,
        cutRationale: result.cutRationale,
        removedRationale: result.removedRationale,
        qualityRubric: result.qualityRubric,
        promptVersionId: promptVersionRecord.id,
        createdByAgentInvocationId: agentResult.invocationId,
      });

      specifications.push({
        variantSpecificationId: specification.id,
        targetDurationSeconds,
        deliverySpecificationId,
        version: specification.version,
      });
    }

    return {
      ok: true,
      parentMasterAssetId: master.id,
      deliveryProfileId: profile.id,
      specifications,
    };
  };
}
