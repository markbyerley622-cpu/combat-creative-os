import type {
  ApprovalGate,
  GenerationCandidateStatus,
  RenderJobKind,
  RenderJobStatus,
  TransitionFactKey,
  TransitionFacts,
} from '@combat/domain';
import { latestApprovalForGate, type HumanApprovalRecord } from './human-approval-repository';

/** Bounded retry cap for a shot's generation attempts (architecture.md §3.3: "default 3"). */
export const MAX_SHOT_GENERATION_ATTEMPTS = 3;

export interface CampaignBriefFactRow {
  id: string;
  campaignId: string;
  version: number;
  acceptedAt: Date | null;
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
export interface GenerationPromptFactRow {
  id: string;
  shotId: string;
}
export interface GenerationCandidateFactRow {
  id: string;
  generationPromptId: string;
  status: GenerationCandidateStatus;
  attempt: number;
}
export interface QualityAssessmentFactRow {
  id: string;
  generationCandidateId: string | null;
  assetId: string | null;
  pass: boolean;
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
export interface PerformanceMetricsFactRow {
  id: string;
  creativeVariantId: string;
}

export interface TransitionFactInputs {
  briefs: CampaignBriefFactRow[];
  approvals: HumanApprovalRecord[];
  scripts: ScriptFactRow[];
  shots: ShotFactRow[];
  generationPrompts: GenerationPromptFactRow[];
  generationCandidates: GenerationCandidateFactRow[];
  qualityAssessments: QualityAssessmentFactRow[];
  renderJobs: RenderJobFactRow[];
  editDecisionLists: EditDecisionListFactRow[];
  deliverySpecifications: DeliverySpecificationFactRow[];
  creativeVariants: CreativeVariantFactRow[];
  performanceMetrics: PerformanceMetricsFactRow[];
}

export interface TransitionFactsDataSource {
  campaignBrief: { findMany(args: { where: { campaignId: string } }): Promise<CampaignBriefFactRow[]> };
  humanApproval: {
    findMany(args: {
      where: { campaignId: string; workspaceId: string };
    }): Promise<HumanApprovalRecord[]>;
  };
  script: { findMany(args: { where: { campaignId: string } }): Promise<ScriptFactRow[]> };
  shot: { findMany(args: { where: { scriptId: { in: string[] } } }): Promise<ShotFactRow[]> };
  generationPrompt: {
    findMany(args: { where: { shotId: { in: string[] } } }): Promise<GenerationPromptFactRow[]>;
  };
  generationCandidate: {
    findMany(args: {
      where: { generationPromptId: { in: string[] } };
    }): Promise<GenerationCandidateFactRow[]>;
  };
  qualityAssessment: {
    findMany(args: {
      where: { OR: [{ generationCandidateId: { in: string[] } }, { assetId: { not: null } }] };
    }): Promise<QualityAssessmentFactRow[]>;
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
  performanceMetrics: {
    findMany(args: {
      where: { creativeVariantId: { in: string[] } };
    }): Promise<PerformanceMetricsFactRow[]>;
  };
}

/**
 * Loads the flat rows needed to derive transition facts for one campaign.
 * Deliberately fetches flat, un-nested rows (rather than deep Prisma
 * `include`s) and leaves the joining logic to `computeTransitionFacts` below
 * — this keeps the query shape simple enough to fake in tests without a live
 * database (see campaign-transition-service.test.ts) while still being real
 * Prisma queries in production (packages/database's PrismaClient structurally
 * satisfies this narrow interface).
 */
export async function loadTransitionFactInputs(
  db: TransitionFactsDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<TransitionFactInputs> {
  const [briefs, approvals, scripts, renderJobs, editDecisionLists, deliverySpecifications, creativeVariants] =
    await Promise.all([
      db.campaignBrief.findMany({ where: { campaignId } }),
      db.humanApproval.findMany({ where: { campaignId, workspaceId } }),
      db.script.findMany({ where: { campaignId } }),
      db.renderJob.findMany({ where: { campaignId } }),
      db.editDecisionList.findMany({ where: { campaignId } }),
      db.deliverySpecification.findMany({ where: { campaignId } }),
      db.creativeVariant.findMany({ where: { campaignId } }),
    ]);

  const scriptIds = scripts.map((s) => s.id);
  const shots = scriptIds.length > 0 ? await db.shot.findMany({ where: { scriptId: { in: scriptIds } } }) : [];

  const shotIds = shots.map((s) => s.id);
  const generationPrompts =
    shotIds.length > 0 ? await db.generationPrompt.findMany({ where: { shotId: { in: shotIds } } }) : [];

  const promptIds = generationPrompts.map((p) => p.id);
  const generationCandidates =
    promptIds.length > 0
      ? await db.generationCandidate.findMany({ where: { generationPromptId: { in: promptIds } } })
      : [];

  const candidateIds = generationCandidates.map((c) => c.id);
  const qualityAssessments = await db.qualityAssessment.findMany({
    where: { OR: [{ generationCandidateId: { in: candidateIds } }, { assetId: { not: null } }] },
  });

  const variantIds = creativeVariants.map((v) => v.id);
  const performanceMetrics =
    variantIds.length > 0
      ? await db.performanceMetrics.findMany({ where: { creativeVariantId: { in: variantIds } } })
      : [];

  return {
    briefs,
    approvals,
    scripts,
    shots,
    generationPrompts,
    generationCandidates,
    qualityAssessments,
    renderJobs,
    editDecisionLists,
    deliverySpecifications,
    creativeVariants,
    performanceMetrics,
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
 * there is no reason to derive all ~24. This function has no I/O and is unit
 * tested directly with hand-built `TransitionFactInputs` fixtures.
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
  const promptsForShots = inputs.generationPrompts.filter((p) => shotIdsForLatestScript.has(p.shotId));

  const candidatesByShotId = new Map<string, GenerationCandidateFactRow[]>();
  for (const prompt of promptsForShots) {
    const candidates = inputs.generationCandidates.filter((c) => c.generationPromptId === prompt.id);
    candidatesByShotId.set(prompt.shotId, [
      ...(candidatesByShotId.get(prompt.shotId) ?? []),
      ...candidates,
    ]);
  }

  function shotHasSucceededCandidate(shotId: string): boolean {
    return (candidatesByShotId.get(shotId) ?? []).some((c) => c.status === 'SUCCEEDED');
  }

  function shotPassedAutomatedQA(shotId: string): boolean {
    const candidateIds = new Set((candidatesByShotId.get(shotId) ?? []).map((c) => c.id));
    return inputs.qualityAssessments.some(
      (qa) => qa.generationCandidateId != null && candidateIds.has(qa.generationCandidateId) && qa.pass,
    );
  }

  function shotRetryAllowed(shotId: string): boolean {
    const candidates = candidatesByShotId.get(shotId) ?? [];
    if (shotPassedAutomatedQA(shotId)) return false;
    const maxAttempt = candidates.reduce((max, c) => Math.max(max, c.attempt), 0);
    return maxAttempt < MAX_SHOT_GENERATION_ATTEMPTS;
  }

  const gateForKey: Partial<Record<TransitionFactKey, ApprovalGate>> = {
    strategyApproved: 'STRATEGY',
    conceptApproved: 'CONCEPT',
    scriptApproved: 'SCRIPT',
    allShotsSelected: 'SHOT_SELECTION',
    finalApproved: 'FINAL',
    strategyRevisionRequested: 'STRATEGY',
    conceptRevisionRequested: 'CONCEPT',
    scriptRevisionRequested: 'SCRIPT',
    shotSelectionRegenerateRequested: 'SHOT_SELECTION',
    finalApprovalRevisionRequested: 'FINAL',
  };

  for (const key of keys) {
    switch (key) {
      case 'briefAccepted':
        facts.briefAccepted = latestByVersion(inputs.briefs)?.acceptedAt != null;
        break;
      case 'strategyApproved':
      case 'conceptApproved':
      case 'scriptApproved':
      case 'allShotsSelected':
      case 'finalApproved': {
        const gate = gateForKey[key];
        facts[key] = gate ? isApprovedDecision(latestApprovalForGate(inputs.approvals, gate)) : false;
        break;
      }
      case 'allShotsHaveRequiredAssets':
        facts.allShotsHaveRequiredAssets = shotsForLatestScript.length > 0;
        break;
      case 'allShotsHaveCandidate':
        facts.allShotsHaveCandidate =
          shotsForLatestScript.length > 0 && shotsForLatestScript.every((s) => shotHasSucceededCandidate(s.id));
        break;
      case 'allShotsPassedAutomatedQA':
        facts.allShotsPassedAutomatedQA =
          shotsForLatestScript.length > 0 && shotsForLatestScript.every((s) => shotPassedAutomatedQA(s.id));
        break;
      case 'compositingComplete':
        facts.compositingComplete = inputs.renderJobs.some(
          (r) => r.kind === 'COMPOSITING' && r.status === 'SUCCEEDED',
        );
        break;
      case 'roughCutAssembled':
        facts.roughCutAssembled = inputs.editDecisionLists.length > 0;
        break;
      case 'finalQAPassed':
        facts.finalQAPassed = inputs.qualityAssessments.some((qa) => qa.assetId != null && qa.pass);
        break;
      case 'finalQARevisionRequested':
        facts.finalQARevisionRequested = inputs.qualityAssessments.some(
          (qa) => qa.assetId != null && !qa.pass,
        );
        break;
      case 'exportRenderComplete':
        facts.exportRenderComplete = inputs.renderJobs.some(
          (r) => r.kind === 'EXPORT' && r.status === 'SUCCEEDED',
        );
        break;
      case 'deliverySpecMet':
        facts.deliverySpecMet =
          inputs.deliverySpecifications.length > 0 &&
          inputs.creativeVariants.some((v) => v.status === 'READY');
        break;
      case 'distributionConfirmed':
        facts.distributionConfirmed = inputs.creativeVariants.some(
          (v) => v.assetId != null && v.status === 'READY',
        );
        break;
      case 'performanceMetricsCollected':
      case 'iterationPlanningRestartRequested':
        facts[key] = inputs.performanceMetrics.length > 0;
        break;
      case 'strategyRevisionRequested':
      case 'conceptRevisionRequested':
      case 'scriptRevisionRequested':
      case 'shotSelectionRegenerateRequested':
      case 'finalApprovalRevisionRequested': {
        const gate = gateForKey[key];
        facts[key] = gate ? isRevisionDecision(latestApprovalForGate(inputs.approvals, gate)) : false;
        break;
      }
      case 'automatedQARetryAllowed':
        facts.automatedQARetryAllowed =
          shotsForLatestScript.length > 0 && shotsForLatestScript.some((s) => shotRetryAllowed(s.id));
        break;
      default: {
        const exhaustive: never = key;
        throw new Error(`unhandled transition fact key: ${String(exhaustive)}`);
      }
    }
  }

  return facts;
}
