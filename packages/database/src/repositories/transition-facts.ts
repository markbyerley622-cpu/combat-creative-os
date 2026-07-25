import { QUALITY_FAILURE_ROUTING } from '@combat/domain';
import type {
  ApprovalGate,
  CampaignStage,
  GenerationCandidateStatus,
  QualityFailureCategory,
  RenderJobKind,
  RenderJobStatus,
  TransitionFactKey,
  TransitionFacts,
} from '@combat/domain';
import { latestApprovalForGate, type HumanApprovalRecord } from './human-approval-repository';

/**
 * Reverse lookup into the domain package's category -> target-stage map
 * (packages/domain/src/workflow/quality-failure-routing.ts) — the single
 * source of truth for "which failure category routes to which stage." Every
 * target stage in the current map has exactly one category routing to it, so
 * this reverse lookup is unambiguous.
 */
function categoryRoutingTo(target: CampaignStage): QualityFailureCategory | undefined {
  const entry = Object.entries(QUALITY_FAILURE_ROUTING).find(([, t]) => t === target);
  return entry?.[0] as QualityFailureCategory | undefined;
}

/** Bounded retry cap for a shot's generation attempts (architecture.md §3.3: "default 3"). */
export const MAX_SHOT_GENERATION_ATTEMPTS = 3;

export interface CampaignBriefFactRow {
  id: string;
  campaignId: string;
  version: number;
  acceptedAt: Date | null;
}
export interface CreativeConceptFactRow {
  id: string;
  campaignId: string;
}
export interface ScriptFactRow {
  id: string;
  campaignId: string;
  version: number;
}
export interface ShotFactRow {
  id: string;
  scriptId: string;
}
export interface ShotSpecificationFactRow {
  id: string;
  shotId: string;
}
export interface ShotGenerationJobFactRow {
  id: string;
  shotSpecificationId: string;
  attemptCount: number;
  maxAttempts: number;
}
export interface GenerationCandidateFactRow {
  id: string;
  shotSpecificationId: string;
  status: GenerationCandidateStatus;
}
export interface QualityAssessmentFactRow {
  id: string;
  generationCandidateId: string | null;
  assetId: string | null;
  subjectStage: CampaignStage | null;
  pass: boolean;
}
export interface QualityFailureFactRow {
  id: string;
  qualityAssessmentId: string;
  category: QualityFailureCategory;
}
export interface RenderJobFactRow {
  id: string;
  kind: RenderJobKind;
  status: RenderJobStatus;
}
export interface EditDecisionListFactRow {
  id: string;
  version: number;
}
export interface DeliverySpecificationFactRow {
  id: string;
}
export interface CreativeVariantFactRow {
  id: string;
  assetId: string | null;
  status: string;
}
export interface TimelineFactRow {
  id: string;
  campaignId: string;
}
export interface SoundCueFactRow {
  id: string;
  timelineId: string;
}

export interface TransitionFactInputs {
  briefs: CampaignBriefFactRow[];
  approvals: HumanApprovalRecord[];
  concepts: CreativeConceptFactRow[];
  scripts: ScriptFactRow[];
  shots: ShotFactRow[];
  shotSpecifications: ShotSpecificationFactRow[];
  shotGenerationJobs: ShotGenerationJobFactRow[];
  generationCandidates: GenerationCandidateFactRow[];
  qualityAssessments: QualityAssessmentFactRow[];
  qualityFailures: QualityFailureFactRow[];
  renderJobs: RenderJobFactRow[];
  editDecisionLists: EditDecisionListFactRow[];
  deliverySpecifications: DeliverySpecificationFactRow[];
  creativeVariants: CreativeVariantFactRow[];
  timelines: TimelineFactRow[];
  soundCues: SoundCueFactRow[];
}

export interface TransitionFactsDataSource {
  campaignBrief: {
    findMany(args: { where: { campaignId: string } }): Promise<CampaignBriefFactRow[]>;
  };
  humanApproval: {
    findMany(args: {
      where: { campaignId: string; workspaceId: string };
    }): Promise<HumanApprovalRecord[]>;
  };
  creativeConcept: {
    findMany(args: { where: { campaignId: string } }): Promise<CreativeConceptFactRow[]>;
  };
  script: { findMany(args: { where: { campaignId: string } }): Promise<ScriptFactRow[]> };
  shot: { findMany(args: { where: { scriptId: { in: string[] } } }): Promise<ShotFactRow[]> };
  shotSpecification: {
    findMany(args: { where: { shotId: { in: string[] } } }): Promise<ShotSpecificationFactRow[]>;
  };
  shotGenerationJob: {
    findMany(args: {
      where: { shotSpecificationId: { in: string[] } };
    }): Promise<ShotGenerationJobFactRow[]>;
  };
  generationCandidate: {
    findMany(args: {
      where: { shotSpecificationId: { in: string[] } };
    }): Promise<GenerationCandidateFactRow[]>;
  };
  qualityAssessment: {
    findMany(args: {
      where: { OR: [{ generationCandidateId: { in: string[] } }, { assetId: { not: null } }] };
    }): Promise<QualityAssessmentFactRow[]>;
  };
  qualityFailure: {
    findMany(args: {
      where: { qualityAssessmentId: { in: string[] } };
    }): Promise<QualityFailureFactRow[]>;
  };
  renderJob: { findMany(args: { where: { campaignId: string } }): Promise<RenderJobFactRow[]> };
  editDecisionList: {
    findMany(args: { where: { campaignId: string } }): Promise<EditDecisionListFactRow[]>;
  };
  deliverySpecification: {
    findMany(args: { where: { campaignId: string } }): Promise<DeliverySpecificationFactRow[]>;
  };
  creativeVariant: {
    findMany(args: { where: { campaignId: string } }): Promise<CreativeVariantFactRow[]>;
  };
  timeline: { findMany(args: { where: { campaignId: string } }): Promise<TimelineFactRow[]> };
  soundCue: {
    findMany(args: { where: { timelineId: { in: string[] } } }): Promise<SoundCueFactRow[]>;
  };
}

/**
 * Loads the flat rows needed to derive transition facts for one campaign.
 * Deliberately fetches flat, un-nested rows (rather than deep Prisma
 * `include`s) and leaves the joining logic to `computeTransitionFacts` below
 * — this keeps the query shape simple enough to fake in tests without a live
 * database (see campaign-transition-service.test.ts) while still being real
 * Prisma queries in production (packages/database's PrismaClient structurally
 * satisfies this narrow interface). Performance-related tables are
 * deliberately never loaded here — performance analysis is a separate,
 * decoupled workflow and must not feed campaign-stage transition facts (see
 * docs/adr/0002-campaign-lifecycle-alignment.md).
 */
export async function loadTransitionFactInputs(
  db: TransitionFactsDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<TransitionFactInputs> {
  const [
    briefs,
    approvals,
    concepts,
    scripts,
    renderJobs,
    editDecisionLists,
    deliverySpecifications,
    creativeVariants,
    timelines,
  ] = await Promise.all([
    db.campaignBrief.findMany({ where: { campaignId } }),
    db.humanApproval.findMany({ where: { campaignId, workspaceId } }),
    db.creativeConcept.findMany({ where: { campaignId } }),
    db.script.findMany({ where: { campaignId } }),
    db.renderJob.findMany({ where: { campaignId } }),
    db.editDecisionList.findMany({ where: { campaignId } }),
    db.deliverySpecification.findMany({ where: { campaignId } }),
    db.creativeVariant.findMany({ where: { campaignId } }),
    db.timeline.findMany({ where: { campaignId } }),
  ]);

  const scriptIds = scripts.map((s) => s.id);
  const shots =
    scriptIds.length > 0 ? await db.shot.findMany({ where: { scriptId: { in: scriptIds } } }) : [];

  const shotIds = shots.map((s) => s.id);
  const shotSpecifications =
    shotIds.length > 0
      ? await db.shotSpecification.findMany({ where: { shotId: { in: shotIds } } })
      : [];

  const specIds = shotSpecifications.map((s) => s.id);
  const [shotGenerationJobs, generationCandidates] =
    specIds.length > 0
      ? await Promise.all([
          db.shotGenerationJob.findMany({ where: { shotSpecificationId: { in: specIds } } }),
          db.generationCandidate.findMany({ where: { shotSpecificationId: { in: specIds } } }),
        ])
      : [[], []];

  const candidateIds = generationCandidates.map((c) => c.id);
  const qualityAssessments = await db.qualityAssessment.findMany({
    where: { OR: [{ generationCandidateId: { in: candidateIds } }, { assetId: { not: null } }] },
  });

  const assessmentIds = qualityAssessments.map((a) => a.id);
  const qualityFailures =
    assessmentIds.length > 0
      ? await db.qualityFailure.findMany({ where: { qualityAssessmentId: { in: assessmentIds } } })
      : [];

  const timelineIds = timelines.map((t) => t.id);
  const soundCues =
    timelineIds.length > 0
      ? await db.soundCue.findMany({ where: { timelineId: { in: timelineIds } } })
      : [];

  return {
    briefs,
    approvals,
    concepts,
    scripts,
    shots,
    shotSpecifications,
    shotGenerationJobs,
    generationCandidates,
    qualityAssessments,
    qualityFailures,
    renderJobs,
    editDecisionLists,
    deliverySpecifications,
    creativeVariants,
    timelines,
    soundCues,
  };
}

function latestByVersion<T extends { version: number }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>((latest, row) => {
    if (!latest || row.version > latest.version) return row;
    return latest;
  }, undefined);
}

function isRevisionDecision(approval: HumanApprovalRecord | undefined): boolean {
  return approval?.decision === 'CHANGES_REQUESTED' || approval?.decision === 'REJECTED';
}

function isApprovedDecision(approval: HumanApprovalRecord | undefined): boolean {
  return approval?.decision === 'APPROVED';
}

/**
 * Pure derivation of the boolean facts a campaign-stage transition needs,
 * from the flat rows `loadTransitionFactInputs` returns. Only the requested
 * `keys` are computed — a transition typically needs one or two facts, so
 * there is no reason to derive all of them. This function has no I/O and is
 * unit tested directly with hand-built `TransitionFactInputs` fixtures.
 *
 * Several facts are MVP-level heuristics rather than fully-modeled business
 * logic — see docs/domain-model.md §5 for the complete list and rationale.
 * Notably: the typed-failure-category facts (`*RepairTargetIs*`,
 * `finalQAAudioFailure`) check for the *existence* of any matching
 * QualityFailure among this campaign's asset-based assessments, not
 * specifically the most recent one for a given subject; and
 * `distributionFailureDetected` shares its underlying signal
 * (`CreativeVariant.status === 'FAILED'`) with `variantQAFailed`, because no
 * dedicated distribution-attempt entity exists in this schema yet.
 */
export function computeTransitionFacts(
  inputs: TransitionFactInputs,
  keys: readonly TransitionFactKey[],
): TransitionFacts {
  const facts: TransitionFacts = {};
  const latestScript = latestByVersion(inputs.scripts);
  const shotsForLatestScript = latestScript
    ? inputs.shots.filter((s) => s.scriptId === latestScript.id)
    : [];
  const shotIdsForLatestScript = new Set(shotsForLatestScript.map((s) => s.id));
  const specsForShots = inputs.shotSpecifications.filter((s) =>
    shotIdsForLatestScript.has(s.shotId),
  );

  const candidatesByShotId = new Map<string, GenerationCandidateFactRow[]>();
  const jobsByShotId = new Map<string, ShotGenerationJobFactRow[]>();
  for (const spec of specsForShots) {
    const candidates = inputs.generationCandidates.filter((c) => c.shotSpecificationId === spec.id);
    candidatesByShotId.set(spec.shotId, [
      ...(candidatesByShotId.get(spec.shotId) ?? []),
      ...candidates,
    ]);
    const jobs = inputs.shotGenerationJobs.filter((j) => j.shotSpecificationId === spec.id);
    jobsByShotId.set(spec.shotId, [...(jobsByShotId.get(spec.shotId) ?? []), ...jobs]);
  }

  function shotHasSucceededCandidate(shotId: string): boolean {
    return (candidatesByShotId.get(shotId) ?? []).some((c) => c.status === 'SUCCEEDED');
  }

  function shotPassedCheck(shotId: string, subjectStage: CampaignStage): boolean {
    const candidateIds = new Set((candidatesByShotId.get(shotId) ?? []).map((c) => c.id));
    return inputs.qualityAssessments.some(
      (qa) =>
        qa.generationCandidateId != null &&
        candidateIds.has(qa.generationCandidateId) &&
        qa.subjectStage === subjectStage &&
        qa.pass,
    );
  }

  function shotRetryAllowed(shotId: string, subjectStage: CampaignStage): boolean {
    if (shotPassedCheck(shotId, subjectStage)) return false;
    const jobs = jobsByShotId.get(shotId) ?? [];
    if (jobs.length === 0) return true; // no dispatch attempted yet -> a first attempt is always allowed
    return jobs.some((j) => j.attemptCount < j.maxAttempts);
  }

  /** Does an asset-based assessment for `subjectStage` exist with `pass === expectPass`, optionally requiring a specific failure category? */
  function assetAssessmentExists(
    subjectStage: CampaignStage,
    expectPass: boolean,
    category?: QualityFailureCategory,
  ): boolean {
    const assessmentIds = new Set(
      inputs.qualityAssessments
        .filter(
          (qa) => qa.assetId != null && qa.subjectStage === subjectStage && qa.pass === expectPass,
        )
        .map((qa) => qa.id),
    );
    if (assessmentIds.size === 0) return false;
    if (category === undefined) return true;
    return inputs.qualityFailures.some(
      (f) => assessmentIds.has(f.qualityAssessmentId) && f.category === category,
    );
  }

  const gateForKey: Partial<Record<TransitionFactKey, ApprovalGate>> = {
    conceptApproved: 'CONCEPT',
    allShotsSelected: 'SHOT_SELECTION',
    finalApproved: 'FINAL',
    conceptRevisionRequested: 'CONCEPT',
    shotSelectionRegenerateRequested: 'SHOT_SELECTION',
  };

  for (const key of keys) {
    switch (key) {
      case 'briefAccepted':
        facts.briefAccepted = latestByVersion(inputs.briefs)?.acceptedAt != null;
        break;
      case 'conceptDrafted':
        facts.conceptDrafted = inputs.concepts.length > 0;
        break;
      case 'scriptDrafted':
        facts.scriptDrafted = inputs.scripts.length > 0;
        break;
      case 'conceptApproved':
      case 'allShotsSelected':
      case 'finalApproved': {
        const gate = gateForKey[key];
        facts[key] = gate
          ? isApprovedDecision(latestApprovalForGate(inputs.approvals, gate))
          : false;
        break;
      }
      case 'conceptRevisionRequested':
      case 'shotSelectionRegenerateRequested': {
        const gate = gateForKey[key];
        facts[key] = gate
          ? isRevisionDecision(latestApprovalForGate(inputs.approvals, gate))
          : false;
        break;
      }
      case 'allShotsHaveRequiredAssets':
        facts.allShotsHaveRequiredAssets = shotsForLatestScript.length > 0;
        break;
      case 'allShotsHavePrompts':
        facts.allShotsHavePrompts =
          shotsForLatestScript.length > 0 &&
          shotsForLatestScript.every((s) => specsForShots.some((spec) => spec.shotId === s.id));
        break;
      case 'allShotsHaveCandidate':
        facts.allShotsHaveCandidate =
          shotsForLatestScript.length > 0 &&
          shotsForLatestScript.every((s) => shotHasSucceededCandidate(s.id));
        break;
      case 'allShotsPassedVisualQA':
        facts.allShotsPassedVisualQA =
          shotsForLatestScript.length > 0 &&
          shotsForLatestScript.every((s) => shotPassedCheck(s.id, 'VISUAL_QA'));
        break;
      case 'allShotsPassedContinuityQA':
        facts.allShotsPassedContinuityQA =
          shotsForLatestScript.length > 0 &&
          shotsForLatestScript.every((s) => shotPassedCheck(s.id, 'CONTINUITY_QA'));
        break;
      case 'visualQARetryAllowed':
        facts.visualQARetryAllowed =
          shotsForLatestScript.length > 0 &&
          shotsForLatestScript.some((s) => shotRetryAllowed(s.id, 'VISUAL_QA'));
        break;
      case 'continuityQARetryAllowed':
        facts.continuityQARetryAllowed =
          shotsForLatestScript.length > 0 &&
          shotsForLatestScript.some((s) => shotRetryAllowed(s.id, 'CONTINUITY_QA'));
        break;
      case 'compositingComplete':
        facts.compositingComplete = inputs.renderJobs.some(
          (r) => r.kind === 'COMPOSITING' && r.status === 'SUCCEEDED',
        );
        break;
      case 'roughCutAssembled':
        facts.roughCutAssembled = inputs.editDecisionLists.length > 0;
        break;
      case 'soundDesignComplete':
        facts.soundDesignComplete = inputs.soundCues.length > 0;
        break;
      case 'finalQAPassed':
        facts.finalQAPassed = assetAssessmentExists('FINAL_QA', true);
        break;
      case 'variantsGenerated':
        facts.variantsGenerated = inputs.creativeVariants.length > 0;
        break;
      case 'variantQAPassed':
        facts.variantQAPassed =
          inputs.creativeVariants.length > 0 &&
          inputs.creativeVariants.every((v) => v.status === 'READY');
        break;
      case 'variantQAFailed':
        facts.variantQAFailed = inputs.creativeVariants.some((v) => v.status === 'FAILED');
        break;
      case 'distributionFailureDetected':
        facts.distributionFailureDetected = inputs.creativeVariants.some(
          (v) => v.status === 'FAILED',
        );
        break;
      case 'exportRenderComplete':
        facts.exportRenderComplete = inputs.renderJobs.some(
          (r) => r.kind === 'EXPORT' && r.status === 'SUCCEEDED',
        );
        break;
      case 'exportTechnicalFailureRetry':
        facts.exportTechnicalFailureRetry = inputs.renderJobs.some(
          (r) => r.kind === 'EXPORT' && r.status === 'FAILED',
        );
        break;
      case 'deliverySpecMet':
        facts.deliverySpecMet =
          inputs.deliverySpecifications.length > 0 &&
          inputs.creativeVariants.some((v) => v.status === 'READY');
        break;
      case 'compositingRepairTargetIsShotSelection':
        facts.compositingRepairTargetIsShotSelection = assetAssessmentExists(
          'COMPOSITING',
          false,
          categoryRoutingTo('HUMAN_SHOT_SELECTION'),
        );
        break;
      case 'compositingRepairTargetIsCompositingRetry':
        facts.compositingRepairTargetIsCompositingRetry = assetAssessmentExists(
          'COMPOSITING',
          false,
          categoryRoutingTo('COMPOSITING'),
        );
        break;
      case 'roughCutFailureRequiresRecompositing':
        facts.roughCutFailureRequiresRecompositing = assetAssessmentExists('ROUGH_CUT', false);
        break;
      case 'soundDesignRepairTargetIsRoughCut':
        facts.soundDesignRepairTargetIsRoughCut = assetAssessmentExists(
          'SOUND_DESIGN',
          false,
          categoryRoutingTo('ROUGH_CUT'),
        );
        break;
      case 'soundDesignRepairTargetIsSoundDesignRetry':
        facts.soundDesignRepairTargetIsSoundDesignRetry = assetAssessmentExists(
          'SOUND_DESIGN',
          false,
          categoryRoutingTo('SOUND_DESIGN'),
        );
        break;
      case 'finalQARepairTargetIsCompositing':
        facts.finalQARepairTargetIsCompositing = assetAssessmentExists(
          'FINAL_QA',
          false,
          categoryRoutingTo('COMPOSITING'),
        );
        break;
      case 'finalQARepairTargetIsRoughCut':
        facts.finalQARepairTargetIsRoughCut = assetAssessmentExists(
          'FINAL_QA',
          false,
          categoryRoutingTo('ROUGH_CUT'),
        );
        break;
      case 'finalQAAudioFailure':
        facts.finalQAAudioFailure = assetAssessmentExists(
          'FINAL_QA',
          false,
          categoryRoutingTo('SOUND_DESIGN'),
        );
        break;
      case 'finalApprovalRepairTargetIsCompositing':
      case 'finalApprovalRepairTargetIsRoughCut':
      case 'finalApprovalRepairTargetIsSoundDesign': {
        const targetByKey: Record<string, CampaignStage> = {
          finalApprovalRepairTargetIsCompositing: 'COMPOSITING',
          finalApprovalRepairTargetIsRoughCut: 'ROUGH_CUT',
          finalApprovalRepairTargetIsSoundDesign: 'SOUND_DESIGN',
        };
        const latestFinal = latestApprovalForGate(inputs.approvals, 'FINAL');
        facts[key] =
          isRevisionDecision(latestFinal) && latestFinal?.repairTarget === targetByKey[key];
        break;
      }
      default: {
        const exhaustive: never = key;
        throw new Error(`unhandled transition fact key: ${String(exhaustive)}`);
      }
    }
  }

  return facts;
}
