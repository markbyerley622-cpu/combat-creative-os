import { FinalQaControllerResultSchema } from '@combat/agents';
import type { AgentDefinition } from '@combat/agent-runtime';
import type {
  AssetDataSource,
  AssetRecord,
  CampaignBriefDataSource,
  CampaignDataSource,
  PromptDataSource,
  QualityAssessmentDataSource,
  QualityFindingInput,
  RoughEditSpecificationDataSource,
  SoundDesignDataSource,
  TimelineDataSource,
} from '@combat/database';
import {
  createAssetWithProvenance,
  createQualityAssessmentForAsset,
  findAssetByChecksum,
  getLatestAcceptedCampaignBrief,
  getLatestRoughEditSpecification,
  getLatestSoundDesignPlan,
  getLatestTimeline,
  getOrCreatePromptVersionForAgent,
  listAssetsForCampaign,
  listSoundCuesForTimeline,
} from '@combat/database';
import type {
  CampaignBrief,
  CampaignStage,
  ExecuteSpecialistAgentInput,
  ExecuteSpecialistAgentOutput,
  QualityFailureCategory,
  RoughEditSpecification,
} from '@combat/domain';
import { QUALITY_FAILURE_ROUTING } from '@combat/domain';

/**
 * The default programme-loudness target every delivery specification is held
 * to until per-platform delivery specs exist (docs/architecture.md §7.2 open
 * question 5, which blocks M12 — M11 deliberately does not invent per-platform
 * caption/safe-area/loudness rules). Matches
 * `FinalQaControllerInputSchema`'s own `targetLoudnessLufs` default.
 */
const DEFAULT_TARGET_LOUDNESS_LUFS = -14;

/**
 * The FINAL_QA revision edges, most-upstream first. When a failing assessment
 * carries findings routing to more than one of them, the most upstream target
 * wins: re-compositing regenerates the rough cut, which re-runs ROUGH_CUT and
 * SOUND_DESIGN behind it anyway, so repairing downstream first would only have
 * to be redone. Mirrors `CAMPAIGN_TRANSITIONS`' three `from: 'FINAL_QA'`
 * REVISION edges — all non-gated, so this never selects a human-gated edge.
 */
const FINAL_QA_REPAIR_TARGETS: readonly CampaignStage[] = ['COMPOSITING', 'ROUGH_CUT', 'SOUND_DESIGN'];

export interface FinalQaTechnicalProbe {
  readonly durationSeconds: number;
  readonly resolutionWidth: number;
  readonly resolutionHeight: number;
  readonly integratedLoudnessLufs: number;
  readonly hasBurnedInCaptions: boolean;
}

export interface FinalQaDeliverySpecification {
  readonly platform: RoughEditSpecification['platform'];
  readonly aspectRatio: string;
  readonly durationSeconds: number;
  readonly captionBurnRequired: boolean;
  readonly targetLoudnessLufs: number;
}

/**
 * Derives the master's technical probe from persisted production facts rather
 * than from ffmpeg/ffprobe. **Interim (M11):** no real master media exists in
 * this environment — the rough-edit render is the deterministic mock
 * MotionGraphicsProvider's output (a registered `ROUGH_CUT` asset with
 * `sizeBytes: 0` and no bytes) and the sound stems are mock `SOUND_STEM`
 * assets, so there is nothing to probe. Every field below is therefore read
 * from the artifacts that a real render *would* have been produced from:
 *
 * - `durationSeconds` — the assembled `Timeline`'s real frame count / frame
 *   rate, which is what a render of that timeline would actually last.
 * - `resolutionWidth`/`resolutionHeight` — the rough edit's declared output
 *   format (the resolution the render was specified at).
 * - `hasBurnedInCaptions` — whether the rough edit actually carries a CAPTION
 *   overlay, i.e. what the assembled edit contains.
 * - `integratedLoudnessLufs` — **nominal, not measured**: with no audio bytes
 *   there is no loudnorm pass to run, so the master is reported at the
 *   delivery target. The loudness criterion is consequently advisory until a
 *   real render worker + ffmpeg probe exist; the duration, resolution and
 *   caption criteria are genuine conformance checks today.
 *
 * Pure and exported so the derivation is unit-testable against fixture masters
 * with known technical defects, independently of any agent call.
 */
export function buildFinalQaTechnicalProbe(
  spec: Pick<
    RoughEditSpecification,
    'resolutionWidth' | 'resolutionHeight' | 'frameRate' | 'overlays'
  >,
  timeline: { readonly durationFrames: number; readonly frameRate: number },
  targetLoudnessLufs: number = DEFAULT_TARGET_LOUDNESS_LUFS,
): FinalQaTechnicalProbe {
  const frameRate = timeline.frameRate > 0 ? timeline.frameRate : spec.frameRate;
  return {
    durationSeconds: timeline.durationFrames / frameRate,
    resolutionWidth: spec.resolutionWidth,
    resolutionHeight: spec.resolutionHeight,
    integratedLoudnessLufs: targetLoudnessLufs,
    hasBurnedInCaptions: spec.overlays.some((o) => o.kind === 'CAPTION'),
  };
}

/**
 * Derives the delivery specification the master is judged against, from the
 * rough edit's declared output format plus the accepted brief's first
 * requested duration. No `DeliverySpecification` row is created: per-platform
 * delivery requirements are an open question that blocks M12
 * (docs/architecture.md §7.2 item 5), so M11 judges the master against what
 * the campaign actually asked for rather than against invented platform rules.
 * `captionBurnRequired` comes from the Edit Director's declared caption intent
 * (`captionPlaceholder`), which is independent of whether the edit actually
 * contains a CAPTION overlay — that gap is exactly what the caption criterion
 * is there to catch.
 */
export function buildFinalQaDeliverySpecification(
  spec: Pick<RoughEditSpecification, 'platform' | 'aspectRatio' | 'captionPlaceholder'>,
  brief: Pick<CampaignBrief, 'durationsSeconds'>,
  targetLoudnessLufs: number = DEFAULT_TARGET_LOUDNESS_LUFS,
): FinalQaDeliverySpecification {
  return {
    platform: spec.platform,
    aspectRatio: spec.aspectRatio,
    durationSeconds: brief.durationsSeconds[0]!,
    captionBurnRequired: spec.captionPlaceholder.trim().length > 0,
    targetLoudnessLufs,
  };
}

/**
 * The repair stage a failing Final QA assessment routes to: the most upstream
 * FINAL_QA revision edge any finding's typed category maps to via
 * `QUALITY_FAILURE_ROUTING`. Returns undefined when no finding carries a
 * routable category — the caller escalates that to BLOCKED rather than picking
 * an edge on the agent's behalf.
 */
export function selectFinalQaRepairTarget(
  categories: readonly QualityFailureCategory[],
): CampaignStage | undefined {
  const targets = new Set(
    categories
      .map((category) => QUALITY_FAILURE_ROUTING[category])
      .filter((stage): stage is CampaignStage => stage !== undefined),
  );
  return FINAL_QA_REPAIR_TARGETS.find((stage) => targets.has(stage));
}

export interface RunFinalQaControllerInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  /** 1-based; distinguishes the agent idempotency key of each FINAL_QA visit. */
  readonly revisionAttempt: number;
}

export type RunFinalQaControllerOutput =
  | {
      readonly ok: true;
      readonly pass: boolean;
      readonly assessmentId: string;
      readonly finalMasterAssetId: string;
      readonly overallScore: number;
      readonly blockingFindingCount: number;
      /** Set only when `pass` is false and a finding's category routes to a FINAL_QA revision edge. */
      readonly repairTarget?: CampaignStage;
    }
  | { readonly ok: false; readonly reason: 'CAMPAIGN_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'BRIEF_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ROUGH_EDIT_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'SOUND_DESIGN_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ROUGH_CUT_ASSET_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'AGENT_FAILED'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'UNROUTABLE_FAILURE'; readonly detail: string };

export interface RunFinalQaControllerActivityDeps {
  readonly executeSpecialistAgentActivity: (
    input: ExecuteSpecialistAgentInput,
  ) => Promise<ExecuteSpecialistAgentOutput>;
  readonly agentRegistry: Readonly<Record<string, AgentDefinition<unknown, unknown>>>;
  readonly campaignDb: CampaignDataSource;
  readonly campaignBriefDb: CampaignBriefDataSource;
  readonly roughEditSpecificationDb: RoughEditSpecificationDataSource;
  readonly timelineDb: TimelineDataSource;
  readonly soundDesignDb: SoundDesignDataSource;
  readonly qualityAssessmentDb: QualityAssessmentDataSource;
  readonly promptDb: PromptDataSource;
  readonly assetDb: AssetDataSource;
}

/**
 * M11: runs the existing `final-qa-controller` agent over the campaign's
 * finished master and persists its verdict as the immutable, asset-based
 * `QualityAssessment` (subjectStage FINAL_QA) that `finalQAPassed` /
 * `finalQARepairTargetIs*` read.
 *
 * The master itself is registered here as a deterministic mock `FINAL_MASTER`
 * asset derived from the rough-cut render and every sound stem — no bytes are
 * produced (there is no real render worker in this environment; see
 * `buildFinalQaTechnicalProbe`), but the provenance chain
 * `FINAL_MASTER -> ROUGH_CUT + SOUND_STEM[]` is real, which is what
 * `traceAssetLineage` and the assessment's `assetId` depend on.
 *
 * Like every other agent hop, the agent runs through the ADR-0004
 * `executeSpecialistAgentActivity` boundary and receives only validated input
 * — it never touches a repository, provider, or other agent. This Activity
 * records the assessment and reports the repair target; it never advances a
 * stage and never fires a human approval signal. Routing a failing master back
 * to COMPOSITING/ROUGH_CUT/SOUND_DESIGN is the workflow's job (via
 * `advanceCampaignStageActivity` AUTO_RETRY), and crossing FINAL_QA ->
 * FINAL_APPROVAL still requires the persisted `finalQAPassed` fact.
 *
 * Idempotent under Activity retry: the master asset is deduped by deterministic
 * checksum and the assessment is unique per `(assetId, subjectStage)`, so a
 * replay returns the existing verdict instead of writing a second one.
 */
export function createRunFinalQaControllerActivity(
  deps: RunFinalQaControllerActivityDeps,
): (input: RunFinalQaControllerInput) => Promise<RunFinalQaControllerOutput> {
  return async function runFinalQaControllerActivity(
    input: RunFinalQaControllerInput,
  ): Promise<RunFinalQaControllerOutput> {
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

    const spec = await getLatestRoughEditSpecification(
      deps.roughEditSpecificationDb,
      workspaceId,
      campaignId,
    );
    if (!spec) {
      return {
        ok: false,
        reason: 'ROUGH_EDIT_NOT_FOUND',
        detail: `Campaign ${campaignId} has no RoughEditSpecification`,
      };
    }

    // The sound design plan + its timeline are what SOUND_DESIGN produced; a
    // master cannot be assessed before the mix exists.
    const [timeline, plan] = await Promise.all([
      getLatestTimeline(deps.timelineDb, workspaceId, campaignId),
      getLatestSoundDesignPlan(deps.soundDesignDb, workspaceId, campaignId),
    ]);
    if (!timeline || !plan) {
      return {
        ok: false,
        reason: 'SOUND_DESIGN_NOT_FOUND',
        detail: `Campaign ${campaignId} has no Timeline/SoundDesignPlan to assess`,
      };
    }

    const roughCuts = await listAssetsForCampaign(
      deps.assetDb,
      workspaceId,
      campaignId,
      'ROUGH_CUT',
    );
    const roughCut = roughCuts[0];
    if (!roughCut) {
      return {
        ok: false,
        reason: 'ROUGH_CUT_ASSET_NOT_FOUND',
        detail: `Campaign ${campaignId} has no registered ROUGH_CUT asset`,
      };
    }

    const cues = await listSoundCuesForTimeline(deps.soundDesignDb, timeline.id);
    const stemAssetIds = cues
      .map((cue) => cue.assetId)
      .filter((assetId): assetId is string => Boolean(assetId));

    // Register (or re-find) the master. Checksum is derived from the timeline +
    // plan version, so every replay of this Activity — and every FINAL_QA
    // revisit that did not produce a new mix — resolves to the same asset.
    const checksum = `final-master-${timeline.id}-${plan.version}`;
    let master: AssetRecord | undefined = await findAssetByChecksum(
      deps.assetDb,
      workspaceId,
      checksum,
      'FINAL_MASTER',
    );
    if (!master) {
      const created = await createAssetWithProvenance(deps.assetDb, workspaceId, {
        campaignId,
        kind: 'FINAL_MASTER',
        s3Key: `mock/final-master/${timeline.id}/${plan.version}.mp4`,
        checksum,
        mimeType: 'video/mp4',
        originalFilename: `final-master-v${plan.version}.mp4`,
        sizeBytes: 0,
        ingestionStatus: 'READY',
        generatedByActivity: 'runFinalQaControllerActivity',
        derivedFromAssetIds: [roughCut.id, ...stemAssetIds],
        producedByInvocationId: plan.createdByAgentInvocationId,
      });
      master = created.asset;
    }

    const technicalProbe = buildFinalQaTechnicalProbe(spec, timeline);
    const deliverySpecification = buildFinalQaDeliverySpecification(spec, brief);

    const definition = deps.agentRegistry['final-qa-controller'];
    if (!definition) {
      throw new Error('"final-qa-controller" is not registered in the injected agent registry');
    }
    await getOrCreatePromptVersionForAgent(deps.promptDb, workspaceId, {
      agentKey: 'final-qa-controller',
      version: definition.promptVersion.version,
      systemPrompt: definition.promptVersion.systemPrompt,
    });

    const agentResult = await deps.executeSpecialistAgentActivity({
      workspaceId,
      campaignId,
      workflowRunId,
      stage: 'FINAL_QA',
      agentName: 'final-qa-controller',
      agentVersion: definition.promptVersion.version,
      idempotencyKey: `${workflowRunId}:AGENT:FINAL_QA:final-qa-controller:${master.id}:${revisionAttempt}`,
      payload: { technicalProbe, deliverySpecification },
      context: {
        campaignId,
        priorArtifactRefs: [spec.id, timeline.id, plan.id, master.id],
        budgetRemainingCents: brief.budgetCents,
      },
      correlationId: workflowRunId,
      budgetScope: {},
    });
    if (agentResult.status !== 'SUCCEEDED') {
      return {
        ok: false,
        reason: 'AGENT_FAILED',
        detail: agentResult.failure?.message ?? 'final-qa-controller invocation failed',
      };
    }

    const result = FinalQaControllerResultSchema.parse(agentResult.result);
    const pass = result.criterionScores.every((c) => c.pass);
    const scores = Object.fromEntries(result.criterionScores.map((c) => [c.criterionId, c.score]));
    const overallScore =
      result.criterionScores.reduce((sum, c) => sum + c.score, 0) / result.criterionScores.length;
    const failures: QualityFindingInput[] = result.findings.map((f) => ({
      category: f.category,
      severity: f.severity,
      description: f.description,
      suggestedAction: f.suggestedAction,
    }));

    const { assessment } = await createQualityAssessmentForAsset(
      deps.qualityAssessmentDb,
      workspaceId,
      {
        campaignId,
        assetId: master.id,
        subjectStage: 'FINAL_QA',
        pass,
        overallScore,
        scores,
        assessedBy: 'AGENT',
        createdByAgentInvocationId: agentResult.invocationId,
        failures,
      },
    );

    const repairTarget = pass
      ? undefined
      : selectFinalQaRepairTarget(failures.map((f) => f.category));
    if (!pass && !repairTarget) {
      // A failing master whose findings carry no routable category (e.g. only
      // TECHNICAL/CONTINUITY) has no automated repair edge. Escalate rather
      // than guessing — the assessment itself is already persisted, so the
      // failure is auditable and a human can act on it.
      return {
        ok: false,
        reason: 'UNROUTABLE_FAILURE',
        detail: `Final QA failed with no routable repair category (${
          failures.map((f) => f.category).join(', ') || 'no findings'
        })`,
      };
    }

    return {
      ok: true,
      pass,
      assessmentId: assessment.id,
      finalMasterAssetId: master.id,
      overallScore,
      blockingFindingCount: failures.filter((f) => f.severity === 'BLOCKING').length,
      repairTarget,
    };
  };
}
