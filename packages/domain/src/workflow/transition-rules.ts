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
  briefAccepted?: boolean;
  strategyApproved?: boolean;
  conceptApproved?: boolean;
  scriptApproved?: boolean;
  allShotsHaveRequiredAssets?: boolean;
  allShotsHaveCandidate?: boolean;
  allShotsPassedAutomatedQA?: boolean;
  allShotsSelected?: boolean;
  compositingComplete?: boolean;
  roughCutAssembled?: boolean;
  finalQAPassed?: boolean;
  finalApproved?: boolean;
  exportRenderComplete?: boolean;
  deliverySpecMet?: boolean;
  distributionConfirmed?: boolean;
  performanceMetricsCollected?: boolean;

  // Revision-loop facts
  strategyRevisionRequested?: boolean;
  conceptRevisionRequested?: boolean;
  scriptRevisionRequested?: boolean;
  automatedQARetryAllowed?: boolean;
  shotSelectionRegenerateRequested?: boolean;
  finalQARevisionRequested?: boolean;
  finalApprovalRevisionRequested?: boolean;
  iterationPlanningRestartRequested?: boolean;
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
 * The complete, exhaustive transition table for the 17-stage campaign
 * pipeline (see campaign-stage.ts and docs/domain-model.md). Any (from, to)
 * pair not listed here is an invalid transition by construction — there is no
 * fallback/default-allow path.
 */
export const CAMPAIGN_TRANSITIONS: readonly TransitionDefinition[] = [
  // --- Forward path ---
  { from: 'DRAFT', to: 'STRATEGY_REVIEW', kind: 'FORWARD', requiredFacts: ['briefAccepted'] },
  {
    from: 'STRATEGY_REVIEW',
    to: 'CONCEPT_REVIEW',
    kind: 'FORWARD',
    requiredFacts: ['strategyApproved'],
    requiredApprovalGate: 'STRATEGY',
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
    requiredFacts: ['scriptApproved'],
    requiredApprovalGate: 'SCRIPT',
  },
  {
    from: 'ASSET_COLLECTION',
    to: 'SHOT_GENERATION',
    kind: 'FORWARD',
    requiredFacts: ['allShotsHaveRequiredAssets'],
  },
  {
    from: 'SHOT_GENERATION',
    to: 'AUTOMATED_QA',
    kind: 'FORWARD',
    requiredFacts: ['allShotsHaveCandidate'],
  },
  {
    from: 'AUTOMATED_QA',
    to: 'HUMAN_SHOT_SELECTION',
    kind: 'FORWARD',
    requiredFacts: ['allShotsPassedAutomatedQA'],
  },
  {
    from: 'HUMAN_SHOT_SELECTION',
    to: 'COMPOSITING',
    kind: 'FORWARD',
    requiredFacts: ['allShotsSelected'],
    requiredApprovalGate: 'SHOT_SELECTION',
  },
  { from: 'COMPOSITING', to: 'ROUGH_CUT', kind: 'FORWARD', requiredFacts: ['compositingComplete'] },
  { from: 'ROUGH_CUT', to: 'FINAL_QA', kind: 'FORWARD', requiredFacts: ['roughCutAssembled'] },
  { from: 'FINAL_QA', to: 'FINAL_APPROVAL', kind: 'FORWARD', requiredFacts: ['finalQAPassed'] },
  {
    from: 'FINAL_APPROVAL',
    to: 'EXPORTING',
    kind: 'FORWARD',
    requiredFacts: ['finalApproved'],
    requiredApprovalGate: 'FINAL',
  },
  { from: 'EXPORTING', to: 'READY_FOR_DISTRIBUTION', kind: 'FORWARD', requiredFacts: ['exportRenderComplete'] },
  {
    from: 'READY_FOR_DISTRIBUTION',
    to: 'DISTRIBUTED',
    kind: 'FORWARD',
    requiredFacts: ['deliverySpecMet'],
  },
  {
    from: 'DISTRIBUTED',
    to: 'PERFORMANCE_COLLECTION',
    kind: 'FORWARD',
    requiredFacts: ['distributionConfirmed'],
  },
  {
    from: 'PERFORMANCE_COLLECTION',
    to: 'ITERATION_PLANNING',
    kind: 'FORWARD',
    requiredFacts: ['performanceMetricsCollected'],
  },

  // --- Revision / failure loops ---
  {
    from: 'STRATEGY_REVIEW',
    to: 'DRAFT',
    kind: 'REVISION',
    requiredFacts: ['strategyRevisionRequested'],
  },
  {
    from: 'CONCEPT_REVIEW',
    to: 'STRATEGY_REVIEW',
    kind: 'REVISION',
    requiredFacts: ['conceptRevisionRequested'],
  },
  {
    from: 'SCRIPT_REVIEW',
    to: 'CONCEPT_REVIEW',
    kind: 'REVISION',
    requiredFacts: ['scriptRevisionRequested'],
  },
  {
    from: 'AUTOMATED_QA',
    to: 'SHOT_GENERATION',
    kind: 'REVISION',
    requiredFacts: ['automatedQARetryAllowed'],
  },
  {
    from: 'HUMAN_SHOT_SELECTION',
    to: 'SHOT_GENERATION',
    kind: 'REVISION',
    requiredFacts: ['shotSelectionRegenerateRequested'],
  },
  {
    from: 'FINAL_QA',
    to: 'ROUGH_CUT',
    kind: 'REVISION',
    requiredFacts: ['finalQARevisionRequested'],
  },
  {
    from: 'FINAL_APPROVAL',
    to: 'ROUGH_CUT',
    kind: 'REVISION',
    requiredFacts: ['finalApprovalRevisionRequested'],
  },
  {
    from: 'ITERATION_PLANNING',
    to: 'DRAFT',
    kind: 'REVISION',
    requiredFacts: ['iterationPlanningRestartRequested'],
  },
] as const;

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
  | { ok: true; definition: TransitionDefinition }
  | { ok: false; reason: TransitionRejectionReason };

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
