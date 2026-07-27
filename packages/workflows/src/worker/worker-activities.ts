import type {
  AgentInvocationDataSource,
  AssetDataSource,
  CampaignBriefDataSource,
  CampaignDataSource,
  CampaignTransitionDataSource,
  CandidateEligibilityDataSource,
  CompositionDataSource,
  CreativeConceptDataSource,
  DeliveryProfileDataSource,
  EditDecisionListDataSource,
  HumanApprovalDataSource,
  LearningDataSource,
  LicenseDataSource,
  PerformanceDataSource,
  PromptDataSource,
  QualityAssessmentDataSource,
  RenderJobDataSource,
  RoughEditSpecificationDataSource,
  ScriptDataSource,
  ScriptWithShotsDataSource,
  SerializableBudgetDataSource,
  ShotDataSource,
  ShotGenerationDataSource,
  ShotSelectionDataSource,
  ShotSpecificationDataSource,
  SoundDesignDataSource,
  StrategyDataSource,
  TimelineDataSource,
  VariantDataSource,
} from '@combat/database';
import type { AgentDefinition } from '@combat/agent-runtime';
import type { Logger } from '@combat/observability';
import type {
  MotionGraphicsProvider,
  ReasoningProvider,
  VideoGenerationProvider,
} from '@combat/providers';
import {
  createAdvanceCampaignStageActivity,
  createCancelCompositionRenderActivity,
  createCancelShotGenerationActivity,
  createCancelVariantRenderActivity,
  createDispatchCompositionRenderActivity,
  createDispatchShotGenerationActivity,
  createDispatchVariantRenderActivity,
  createExecuteSpecialistAgentActivity,
  createLoadLatestShotSpecificationsActivity,
  createLoadShotSelectionRegenerationFeedbackActivity,
  createPollCompositionRenderActivity,
  createPollShotGenerationActivity,
  createPollVariantRenderActivity,
  createRunContinuityAssessmentActivity,
  createRunEditDirectorActivity,
  createRunFinalQaControllerActivity,
  createRunPerformanceAnalystActivity,
  createRunShotPromptEngineerActivity,
  createRunSoundDirectorActivity,
  createRunStrategyConceptScriptActivity,
  createRunVariantFinalQaActivity,
  createRunVariantGeneratorActivity,
  createRunVisualQualityAssessmentsActivity,
  createVerifyHumanApprovalActivity,
  createVerifyShotSelectionActivity,
  pingActivity,
} from '../activities';
import type {
  GeneratedMediaInspection,
  GeneratedMediaInspector,
} from '../activities/poll-shot-generation-activity';

// Re-exported from the composition-root surface: `apps/worker` builds the real
// ffprobe-backed inspector and needs the type without reaching into the
// `activities` namespace.
export type { GeneratedMediaInspection, GeneratedMediaInspector };
import type { CampaignProductionActivities } from '../workflows/campaign-production-workflow-activities';
import type { CompositingActivities } from '../workflows/compositing-workflow-activities';
import type { PerformanceAnalysisActivities } from '../workflows/performance-analysis-workflow-activities';
import type { PingActivities } from '../workflows/ping-workflow-activities';
import type { ShotGenerationActivities } from '../workflows/shot-generation-workflow-activities';
import type { VariantActivities } from '../workflows/variant-workflow-activities';

/**
 * Every `*DataSource` interface the registered Activities read or write,
 * as one injected object.
 *
 * A single combined handle rather than 25 separately-passed ones because
 * production has exactly one backing store: splitting them at this boundary
 * would only invent seams that no caller uses. `InMemoryCampaignStore`
 * (exported by `@combat/database`) satisfies this in full, which is what lets
 * `worker-activities.test.ts` build the real registration object without a
 * live Postgres.
 */
export type WorkerActivityDatabase = AgentInvocationDataSource &
  AssetDataSource &
  SerializableBudgetDataSource &
  CampaignBriefDataSource &
  CampaignDataSource &
  CampaignTransitionDataSource &
  CandidateEligibilityDataSource &
  CompositionDataSource &
  CreativeConceptDataSource &
  DeliveryProfileDataSource &
  EditDecisionListDataSource &
  HumanApprovalDataSource &
  LearningDataSource &
  LicenseDataSource &
  PerformanceDataSource &
  PromptDataSource &
  QualityAssessmentDataSource &
  RenderJobDataSource &
  RoughEditSpecificationDataSource &
  ScriptDataSource &
  ScriptWithShotsDataSource &
  ShotDataSource &
  ShotGenerationDataSource &
  ShotSelectionDataSource &
  ShotSpecificationDataSource &
  SoundDesignDataSource &
  StrategyDataSource &
  TimelineDataSource &
  VariantDataSource;

/** Cost estimates used to size pre-dispatch budget reservations; every one is trued up against real provider usage at settlement. */
export interface WorkerActivityCostEstimates {
  /** Per second of requested footage, per candidate — `dispatchShotGenerationActivity`. */
  readonly shotGenerationCentsPerSecond: number;
  /** Per output frame of the rough-cut render — `dispatchCompositionRenderActivity`. */
  readonly compositionCentsPerFrame: number;
  /** Per output frame of a delivery variant render — `dispatchVariantRenderActivity`. */
  readonly variantCentsPerFrame: number;
}

export interface WorkerActivityDependencies {
  readonly db: WorkerActivityDatabase;
  readonly videoGenerationProvider: VideoGenerationProvider;
  readonly motionGraphicsProvider: MotionGraphicsProvider;
  readonly reasoningProvider: ReasoningProvider;
  /** `@combat/agents`' canonical `AGENT_REGISTRY` in production; injected so tests can narrow it. */
  readonly agentRegistry: Readonly<Record<string, AgentDefinition<unknown, unknown>>>;
  readonly costEstimates: WorkerActivityCostEstimates;
  /**
   * Measures a generated clip before its Asset may be marked READY. Required
   * whenever `videoGenerationProvider` materialises real files; the
   * metadata-only mock produces nothing to measure, so tests leave it out.
   */
  readonly generatedMediaInspector?: GeneratedMediaInspector;
  readonly logger?: Logger;
  /**
   * Temporal's own attempt counter for the currently-executing Activity, used
   * as agent-invocation provenance. `apps/worker` supplies
   * `@temporalio/activity`'s `Context.current().info.attempt`; tests leave it
   * out and get the deterministic default.
   */
  readonly getAttempt?: () => number;
  /**
   * Resolves the per-platform `DeliverySpecification` a rendered variant
   * attaches to. Injected rather than minted by the generation Activity — see
   * `run-variant-generator-activity.ts`. Defaults to "unresolved", which the
   * generator handles.
   */
  readonly resolveDeliverySpecificationId?: (input: {
    workspaceId: string;
    campaignId: string;
    platform: string;
    durationSeconds: number;
  }) => Promise<string | undefined>;
}

/**
 * Exactly the Activities the executable workflows proxy, keyed by the names
 * they proxy them under.
 *
 * The type is the intersection of the canonical contracts themselves, so this
 * cannot drift from what the workflows call: adding a member to any contract
 * makes `createWorkerActivities` fail to compile until it is built here.
 */
export type WorkerActivities = PingActivities &
  CampaignProductionActivities &
  ShotGenerationActivities &
  CompositingActivities &
  VariantActivities &
  PerformanceAnalysisActivities;

/**
 * Builds the object `apps/worker` hands to `Worker.create({ activities })`.
 *
 * Post-M14 audit finding C-1. `apps/worker` previously registered
 * `@combat/workflows`' `activities` namespace directly, which exports
 * `create*Activity(deps)` *factories* — so not one name a workflow proxies
 * was actually registered, and every workflow would have failed at runtime
 * with an unregistered-Activity error the moment a real Temporal server was
 * connected. Nothing caught it because no test built the registration object.
 *
 * Dependency injection is preserved end to end: every Activity is still
 * constructed from its own `create*Activity(deps)` factory with explicit
 * collaborators, so unit tests keep building them individually, and this
 * function itself is exercised against in-memory fakes with no Temporal
 * server involved.
 *
 * Four Activities in `../activities` are deliberately *not* here, because no
 * executable workflow proxies them: `ingestAssetActivity` (called in-process
 * by `apps/api`'s upload-confirm route), `inspectMediaActivity` and
 * `generateMediaProxyActivity` (no media pipeline stage exists yet), and
 * `ingestPerformanceObservationsActivity` (ingestion is an API route, not a
 * workflow step). `worker-activities.test.ts` asserts that exclusion
 * explicitly, so adding a workflow that proxies one of them fails the suite
 * rather than silently registering nothing.
 */
export function createWorkerActivities(deps: WorkerActivityDependencies): WorkerActivities {
  const { db, agentRegistry, costEstimates } = deps;

  // Composed, not proxied: the specialist-agent Activities take this as a
  // dependency rather than the workflow calling it directly, which is what
  // keeps "an agent never calls another agent" true at the code level.
  const executeSpecialistAgentActivity = createExecuteSpecialistAgentActivity({
    agentRegistry,
    reasoningProvider: deps.reasoningProvider,
    campaignDb: db,
    agentInvocationDb: db,
    budgetDb: db,
    logger: deps.logger,
    getAttempt: deps.getAttempt,
  });

  return {
    pingActivity,

    // --- CampaignProductionActivities -------------------------------------
    advanceCampaignStageActivity: createAdvanceCampaignStageActivity({
      campaignTransitionDb: db,
    }),
    verifyHumanApprovalActivity: createVerifyHumanApprovalActivity({ humanApprovalDb: db }),
    runStrategyConceptScriptActivity: createRunStrategyConceptScriptActivity({
      executeSpecialistAgentActivity,
      campaignBriefDb: db,
      strategyDb: db,
      creativeConceptDb: db,
      scriptDb: db,
      humanApprovalDb: db,
      learningDb: db,
    }),
    runShotPromptEngineerActivity: createRunShotPromptEngineerActivity({
      executeSpecialistAgentActivity,
      agentRegistry,
      campaignBriefDb: db,
      creativeConceptDb: db,
      scriptDb: db,
      assetDb: db,
      licenseDb: db,
      promptDb: db,
      shotSpecificationDb: db,
    }),
    loadLatestShotSpecificationsActivity: createLoadLatestShotSpecificationsActivity({
      scriptDb: db,
      shotSpecificationDb: db,
    }),
    runVisualQualityAssessmentsActivity: createRunVisualQualityAssessmentsActivity({
      executeSpecialistAgentActivity,
      campaignDb: db,
      campaignBriefDb: db,
      scriptDb: db,
      shotSpecificationDb: db,
      shotGenerationDb: db,
      qualityAssessmentDb: db,
    }),
    runContinuityAssessmentActivity: createRunContinuityAssessmentActivity({
      executeSpecialistAgentActivity,
      campaignDb: db,
      campaignBriefDb: db,
      scriptDb: db,
      shotSpecificationDb: db,
      shotGenerationDb: db,
      qualityAssessmentDb: db,
    }),
    verifyShotSelectionActivity: createVerifyShotSelectionActivity({
      shotSelectionDb: db,
      scriptDb: db,
    }),
    loadShotSelectionRegenerationFeedbackActivity:
      createLoadShotSelectionRegenerationFeedbackActivity({
        shotSelectionDb: db,
        scriptDb: db,
        shotSpecificationDb: db,
      }),
    runSoundDirectorActivity: createRunSoundDirectorActivity({
      executeSpecialistAgentActivity,
      agentRegistry,
      campaignDb: db,
      campaignBriefDb: db,
      creativeConceptDb: db,
      scriptDb: db,
      roughEditSpecificationDb: db,
      timelineDb: db,
      soundDesignDb: db,
      promptDb: db,
      assetDb: db,
    }),
    runFinalQaControllerActivity: createRunFinalQaControllerActivity({
      executeSpecialistAgentActivity,
      agentRegistry,
      campaignDb: db,
      campaignBriefDb: db,
      roughEditSpecificationDb: db,
      timelineDb: db,
      soundDesignDb: db,
      qualityAssessmentDb: db,
      promptDb: db,
      assetDb: db,
    }),

    // --- ShotGenerationActivities -----------------------------------------
    dispatchShotGenerationActivity: createDispatchShotGenerationActivity({
      videoGenerationProvider: deps.videoGenerationProvider,
      shotSpecificationDb: db,
      shotGenerationDb: db,
      budgetDb: db,
      licenseDb: db,
      estimatedCostCentsPerSecond: costEstimates.shotGenerationCentsPerSecond,
    }),
    pollShotGenerationActivity: createPollShotGenerationActivity({
      videoGenerationProvider: deps.videoGenerationProvider,
      shotGenerationDb: db,
      assetDb: db,
      budgetDb: db,
      ...(deps.generatedMediaInspector
        ? { generatedMediaInspector: deps.generatedMediaInspector }
        : {}),
    }),
    cancelShotGenerationActivity: createCancelShotGenerationActivity({
      videoGenerationProvider: deps.videoGenerationProvider,
      shotGenerationDb: db,
      budgetDb: db,
    }),

    // --- CompositingActivities --------------------------------------------
    runEditDirectorActivity: createRunEditDirectorActivity({
      executeSpecialistAgentActivity,
      agentRegistry,
      campaignDb: db,
      campaignBriefDb: db,
      creativeConceptDb: db,
      scriptDb: db,
      shotSelectionDb: db,
      eligibilityDb: db,
      promptDb: db,
      roughEditSpecificationDb: db,
    }),
    dispatchCompositionRenderActivity: createDispatchCompositionRenderActivity({
      motionGraphicsProvider: deps.motionGraphicsProvider,
      roughEditSpecificationDb: db,
      compositionDb: db,
      budgetDb: db,
      estimatedCostCentsPerFrame: costEstimates.compositionCentsPerFrame,
    }),
    pollCompositionRenderActivity: createPollCompositionRenderActivity({
      motionGraphicsProvider: deps.motionGraphicsProvider,
      compositionDb: db,
      roughEditSpecificationDb: db,
      assetDb: db,
      renderJobDb: db,
      editDecisionListDb: db,
      budgetDb: db,
    }),
    cancelCompositionRenderActivity: createCancelCompositionRenderActivity({
      motionGraphicsProvider: deps.motionGraphicsProvider,
      compositionDb: db,
      budgetDb: db,
    }),

    // --- VariantActivities -------------------------------------------------
    runVariantGeneratorActivity: createRunVariantGeneratorActivity({
      executeSpecialistAgentActivity,
      agentRegistry,
      campaignDb: db,
      creativeConceptDb: db,
      scriptDb: db,
      shotSelectionDb: db,
      roughEditSpecificationDb: db,
      timelineDb: db,
      soundDesignDb: db,
      qualityAssessmentDb: db,
      deliveryProfileDb: db,
      variantDb: db,
      promptDb: db,
      assetDb: db,
      resolveDeliverySpecificationId:
        deps.resolveDeliverySpecificationId ?? (async () => undefined),
    }),
    dispatchVariantRenderActivity: createDispatchVariantRenderActivity({
      motionGraphicsProvider: deps.motionGraphicsProvider,
      variantDb: db,
      budgetDb: db,
      estimatedCostCentsPerFrame: costEstimates.variantCentsPerFrame,
    }),
    pollVariantRenderActivity: createPollVariantRenderActivity({
      motionGraphicsProvider: deps.motionGraphicsProvider,
      variantDb: db,
      assetDb: db,
      budgetDb: db,
    }),
    cancelVariantRenderActivity: createCancelVariantRenderActivity({
      motionGraphicsProvider: deps.motionGraphicsProvider,
      variantDb: db,
      budgetDb: db,
    }),
    runVariantFinalQaActivity: createRunVariantFinalQaActivity({
      executeSpecialistAgentActivity,
      agentRegistry,
      campaignBriefDb: db,
      variantDb: db,
      qualityAssessmentDb: db,
      promptDb: db,
      assetDb: db,
    }),

    // --- PerformanceAnalysisActivities -------------------------------------
    runPerformanceAnalystActivity: createRunPerformanceAnalystActivity({
      executeSpecialistAgentActivity,
      agentRegistry,
      campaignDb: db,
      performanceDb: db,
      learningDb: db,
      promptDb: db,
    }),
  };
}
