import type { ApprovalGate } from '../schemas/shared-enums';
import type { CampaignStage } from './campaign-stage';
import type { TransitionRejectionReason } from './transition-errors';

/**
 * Boolean facts the caller (packages/database's transition service) gathers
 * from persisted state before attempting a transition. Kept as flat booleans
 * — rather than handing this module raw rows — so `evaluateCampaignTransition`
 * stays a pure, dependency-free function that packages/workflows (which may
 * only import domain types, no I/O) can also call directly for planning
 * without needing a database handle.
 */
export interface TransitionFacts {
  // --- Forward-path prerequisites ---
  briefAccepted?: boolean;
  conceptDrafted?: boolean;
  conceptApproved?: boolean;
  scriptDrafted?: boolean;
  allShotsHaveRequiredAssets?: boolean;
  allShotsHavePrompts?: boolean;
  allShotsHaveCandidate?: boolean;
  allShotsPassedVisualQA?: boolean;
  allShotsPassedContinuityQA?: boolean;
  allShotsSelected?: boolean;
  compositingComplete?: boolean;
  roughCutAssembled?: boolean;
  soundDesignComplete?: boolean;
  finalQAPassed?: boolean;
  finalApproved?: boolean;
  variantsGenerated?: boolean;
  variantQAPassed?: boolean;
  exportRenderComplete?: boolean;
  deliverySpecMet?: boolean;

  // --- Revision-loop facts ---
  conceptRevisionRequested?: boolean;
  visualQARetryAllowed?: boolean;
  continuityQARetryAllowed?: boolean;
  shotSelectionRegenerateRequested?: boolean;
  compositingRepairTargetIsShotSelection?: boolean;
  compositingRepairTargetIsCompositingRetry?: boolean;
  roughCutFailureRequiresRecompositing?: boolean;
  soundDesignRepairTargetIsRoughCut?: boolean;
  soundDesignRepairTargetIsSoundDesignRetry?: boolean;
  finalQARepairTargetIsCompositing?: boolean;
  finalQARepairTargetIsRoughCut?: boolean;
  finalQAAudioFailure?: boolean;
  finalApprovalRepairTargetIsCompositing?: boolean;
  finalApprovalRepairTargetIsRoughCut?: boolean;
  finalApprovalRepairTargetIsSoundDesign?: boolean;
  variantQAFailed?: boolean;
  exportTechnicalFailureRetry?: boolean;
  distributionFailureDetected?: boolean;
}

export type TransitionFactKey = keyof TransitionFacts;

export type TransitionKind = 'FORWARD' | 'REVISION';

export interface TransitionDefinition {
  from: CampaignStage;
  to: CampaignStage;
  kind: TransitionKind;
  requiredFacts: TransitionFactKey[];
  /** Present only when the forward edge is gated by an immutable HumanApproval record. */
  requiredApprovalGate?: ApprovalGate;
}

/**
 * The complete, exhaustive transition table for the 20-stage campaign
 * pipeline (see campaign-stage.ts, docs/domain-model.md §4, and
 * docs/adr/0002-campaign-lifecycle-alignment.md). Any (from, to) pair not
 * listed here is an invalid transition by construction — there is no
 * fallback/default-allow path.
 *
 * Three stages have more than one valid revision target — COMPOSITING,
 * SOUND_DESIGN, and FINAL_QA — disambiguated by a *typed failure category*
 * (see quality-failure-routing.ts) rather than by caller say-so: each
 * candidate edge has its own `requiredFacts` entry, and the database layer
 * only reports the relevant one true when a persisted QualityFailure (or, for
 * FINAL_APPROVAL, a persisted HumanApproval.repairTarget) actually carries
 * that specific category/target. COMPOSITING, SOUND_DESIGN, and EXPORTING
 * additionally support a same-stage revision edge (`from === to`) for a
 * technical retry that doesn't regress any earlier creative approval.
 */
export const CAMPAIGN_TRANSITIONS: readonly TransitionDefinition[] = [
  // --- Forward path ---
  { from: 'DRAFT', to: 'STRATEGY_REVIEW', kind: 'FORWARD', requiredFacts: ['briefAccepted'] },
  {
    from: 'STRATEGY_REVIEW',
    to: 'CONCEPT_REVIEW',
    kind: 'FORWARD',
    requiredFacts: ['conceptDrafted'],
  },
  {
    from: 'CONCEPT_REVIEW',
    to: 'SCRIPT_REVIEW',
    kind: 'FORWARD',
    requiredFacts: ['conceptApproved'],
    requiredApprovalGate: 'CONCEPT',
  },
  {
    from: 'SCRIPT_REVIEW',
    to: 'ASSET_COLLECTION',
    kind: 'FORWARD',
    requiredFacts: ['scriptDrafted'],
  },
  {
    from: 'ASSET_COLLECTION',
    to: 'PROMPTING',
    kind: 'FORWARD',
    requiredFacts: ['allShotsHaveRequiredAssets'],
  },
  {
    from: 'PROMPTING',
    to: 'SHOT_GENERATION',
    kind: 'FORWARD',
    requiredFacts: ['allShotsHavePrompts'],
  },
  {
    from: 'SHOT_GENERATION',
    to: 'VISUAL_QA',
    kind: 'FORWARD',
    requiredFacts: ['allShotsHaveCandidate'],
  },
  {
    from: 'VISUAL_QA',
    to: 'CONTINUITY_QA',
    kind: 'FORWARD',
    requiredFacts: ['allShotsPassedVisualQA'],
  },
  {
    from: 'CONTINUITY_QA',
    to: 'HUMAN_SHOT_SELECTION',
    kind: 'FORWARD',
    requiredFacts: ['allShotsPassedContinuityQA'],
  },
  {
    from: 'HUMAN_SHOT_SELECTION',
    to: 'COMPOSITING',
    kind: 'FORWARD',
    requiredFacts: ['allShotsSelected'],
    requiredApprovalGate: 'SHOT_SELECTION',
  },
  { from: 'COMPOSITING', to: 'ROUGH_CUT', kind: 'FORWARD', requiredFacts: ['compositingComplete'] },
  { from: 'ROUGH_CUT', to: 'SOUND_DESIGN', kind: 'FORWARD', requiredFacts: ['roughCutAssembled'] },
  { from: 'SOUND_DESIGN', to: 'FINAL_QA', kind: 'FORWARD', requiredFacts: ['soundDesignComplete'] },
  { from: 'FINAL_QA', to: 'FINAL_APPROVAL', kind: 'FORWARD', requiredFacts: ['finalQAPassed'] },
  {
    from: 'FINAL_APPROVAL',
    to: 'VARIANT_GENERATION',
    kind: 'FORWARD',
    requiredFacts: ['finalApproved'],
    requiredApprovalGate: 'FINAL',
  },
  {
    from: 'VARIANT_GENERATION',
    to: 'VARIANT_QA',
    kind: 'FORWARD',
    requiredFacts: ['variantsGenerated'],
  },
  { from: 'VARIANT_QA', to: 'EXPORTING', kind: 'FORWARD', requiredFacts: ['variantQAPassed'] },
  {
    from: 'EXPORTING',
    to: 'READY_FOR_DISTRIBUTION',
    kind: 'FORWARD',
    requiredFacts: ['exportRenderComplete'],
  },
  {
    from: 'READY_FOR_DISTRIBUTION',
    to: 'DISTRIBUTED',
    kind: 'FORWARD',
    requiredFacts: ['deliverySpecMet'],
  },

  // --- Revision / failure loops ---
  {
    from: 'CONCEPT_REVIEW',
    to: 'STRATEGY_REVIEW',
    kind: 'REVISION',
    requiredFacts: ['conceptRevisionRequested'],
  },
  {
    // STRATEGY_REVIEW and SCRIPT_REVIEW are checkpoint stages, not approval
    // gates (decision 9) — there is deliberately no HumanApproval record (or
    // any other persisted signal) backing this edge yet, so it carries no
    // required facts. This is the one intentional exception to "every
    // transition has prerequisites" in this table; a future decision that
    // adds real script-validation tracking should replace this with a real
    // fact rather than leaving it open-ended indefinitely.
    from: 'SCRIPT_REVIEW',
    to: 'CONCEPT_REVIEW',
    kind: 'REVISION',
    requiredFacts: [],
  },
  {
    from: 'VISUAL_QA',
    to: 'SHOT_GENERATION',
    kind: 'REVISION',
    requiredFacts: ['visualQARetryAllowed'],
  },
  {
    from: 'CONTINUITY_QA',
    to: 'SHOT_GENERATION',
    kind: 'REVISION',
    requiredFacts: ['continuityQARetryAllowed'],
  },
  {
    from: 'HUMAN_SHOT_SELECTION',
    to: 'SHOT_GENERATION',
    kind: 'REVISION',
    requiredFacts: ['shotSelectionRegenerateRequested'],
  },
  {
    from: 'COMPOSITING',
    to: 'HUMAN_SHOT_SELECTION',
    kind: 'REVISION',
    requiredFacts: ['compositingRepairTargetIsShotSelection'],
  },
  {
    from: 'COMPOSITING',
    to: 'COMPOSITING',
    kind: 'REVISION',
    requiredFacts: ['compositingRepairTargetIsCompositingRetry'],
  },
  {
    from: 'ROUGH_CUT',
    to: 'COMPOSITING',
    kind: 'REVISION',
    requiredFacts: ['roughCutFailureRequiresRecompositing'],
  },
  {
    from: 'SOUND_DESIGN',
    to: 'ROUGH_CUT',
    kind: 'REVISION',
    requiredFacts: ['soundDesignRepairTargetIsRoughCut'],
  },
  {
    from: 'SOUND_DESIGN',
    to: 'SOUND_DESIGN',
    kind: 'REVISION',
    requiredFacts: ['soundDesignRepairTargetIsSoundDesignRetry'],
  },
  {
    from: 'FINAL_QA',
    to: 'COMPOSITING',
    kind: 'REVISION',
    requiredFacts: ['finalQARepairTargetIsCompositing'],
  },
  {
    from: 'FINAL_QA',
    to: 'ROUGH_CUT',
    kind: 'REVISION',
    requiredFacts: ['finalQARepairTargetIsRoughCut'],
  },
  {
    from: 'FINAL_QA',
    to: 'SOUND_DESIGN',
    kind: 'REVISION',
    requiredFacts: ['finalQAAudioFailure'],
  },
  {
    from: 'FINAL_APPROVAL',
    to: 'COMPOSITING',
    kind: 'REVISION',
    requiredFacts: ['finalApprovalRepairTargetIsCompositing'],
  },
  {
    from: 'FINAL_APPROVAL',
    to: 'ROUGH_CUT',
    kind: 'REVISION',
    requiredFacts: ['finalApprovalRepairTargetIsRoughCut'],
  },
  {
    from: 'FINAL_APPROVAL',
    to: 'SOUND_DESIGN',
    kind: 'REVISION',
    requiredFacts: ['finalApprovalRepairTargetIsSoundDesign'],
  },
  {
    from: 'VARIANT_QA',
    to: 'VARIANT_GENERATION',
    kind: 'REVISION',
    requiredFacts: ['variantQAFailed'],
  },
  {
    from: 'EXPORTING',
    to: 'EXPORTING',
    kind: 'REVISION',
    requiredFacts: ['exportTechnicalFailureRetry'],
  },
  {
    from: 'DISTRIBUTED',
    to: 'READY_FOR_DISTRIBUTION',
    kind: 'REVISION',
    requiredFacts: ['distributionFailureDetected'],
  },
] as const;

/** Stages that have a `from === to` revision edge — a technical retry that doesn't regress any earlier creative approval. */
export const SELF_LOOP_STAGES: ReadonlySet<CampaignStage> = new Set(
  CAMPAIGN_TRANSITIONS.filter((t) => t.from === t.to).map((t) => t.from),
);

function findDefinition(from: CampaignStage, to: CampaignStage): TransitionDefinition | undefined {
  return CAMPAIGN_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function isValidCampaignTransition(from: CampaignStage, to: CampaignStage): boolean {
  return findDefinition(from, to) !== undefined;
}

export function listValidNextStages(from: CampaignStage): CampaignStage[] {
  return CAMPAIGN_TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}

export type TransitionEvaluation =
  { ok: true; definition: TransitionDefinition } | { ok: false; reason: TransitionRejectionReason };

/**
 * Pure evaluation of a single transition attempt against gathered facts. Does
 * not check idempotency, budget, or concurrency — those are transaction-
 * boundary concerns layered on top in packages/database (see
 * campaign-transition-service.ts), because they require reading/writing
 * ledger and audit rows atomically with the stage change itself.
 */
export function evaluateCampaignTransition(
  from: CampaignStage,
  to: CampaignStage,
  facts: TransitionFacts,
): TransitionEvaluation {
  const definition = findDefinition(from, to);
  if (!definition) {
    return { ok: false, reason: { type: 'INVALID_TRANSITION', from, to } };
  }

  const missing = definition.requiredFacts.filter((key) => facts[key] !== true);
  if (missing.length > 0) {
    return { ok: false, reason: { type: 'MISSING_PREREQUISITE', from, to, missing } };
  }

  return { ok: true, definition };
}
