import {
  CAMPAIGN_TRANSITIONS,
  type ApprovalDecision,
  type ApprovalGate,
  type CampaignStage,
} from '@combat/domain';
import type { CampaignTransitionDataSource } from '@combat/database';
import { attemptCampaignTransition } from '@combat/database';

/**
 * The Activity boundary a `CampaignProductionWorkflow` uses to move the
 * persisted campaign forward one stage. All knowledge of the transition
 * table (`CAMPAIGN_TRANSITIONS`) and of which edge a gate decision routes to
 * lives here, not in the workflow file — CLAUDE.md restricts
 * `packages/workflows/src/workflows/*` to `@temporalio/workflow` and
 * type-only imports, so a value-level `@combat/domain` import (needed to
 * walk the transition table) belongs in an Activity instead. The workflow
 * only ever sees an opaque `CampaignStage` string and this Activity's
 * discriminated result.
 */

export interface AdvanceCampaignStageAutoInput {
  readonly mode: 'AUTO_FORWARD';
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly fromStage: CampaignStage;
  readonly idempotencyKey: string;
  readonly requestedByUserId?: string;
}

export interface AdvanceCampaignStageGateDecisionInput {
  readonly mode: 'GATE_DECISION';
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly fromStage: CampaignStage;
  readonly idempotencyKey: string;
  readonly gate: ApprovalGate;
  readonly decision: ApprovalDecision;
  /** Required exactly when gate === 'FINAL' && decision !== 'APPROVED' — mirrors HumanApprovalSchema. */
  readonly repairTarget?: CampaignStage;
  readonly requestedByUserId?: string;
}

/**
 * M7: an *automated* revision routing back to SHOT_GENERATION after a
 * failed Visual/Continuity QA assessment; M11 extends it to FINAL_QA's
 * repair edges. Deliberately narrower than a GATE_DECISION — it can only ever
 * traverse the non-gated revision edges leaving a stage in
 * `AUTO_RETRY_ELIGIBLE_STAGES`, never a human-gated one, so no automated
 * process can bypass a human approval gate. The transition itself is still
 * fully gated by the bounded `visualQARetryAllowed`/`continuityQARetryAllowed`
 * / `finalQARepairTargetIs*` facts and (when a budget is supplied) a budget
 * check inside `attemptCampaignTransition`, so retries stay bounded and
 * budget-enforced.
 */
export interface AdvanceCampaignStageAutoRetryInput {
  readonly mode: 'AUTO_RETRY';
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly fromStage: CampaignStage;
  readonly idempotencyKey: string;
  /** Reserved at WORKSPACE/CAMPAIGN before the retry re-enters SHOT_GENERATION, when provided. */
  readonly generationBudgetCents?: number;
  /**
   * M11: for a `fromStage` with more than one automated revision edge (FINAL_QA
   * → COMPOSITING | ROUGH_CUT | SOUND_DESIGN), the specific repair target the
   * failure category selected. Omitted for single-edge QA stages
   * (VISUAL_QA/CONTINUITY_QA → SHOT_GENERATION). It may only ever select a
   * NON-human-gated revision edge, so this never crosses an approval gate.
   */
  readonly repairTarget?: CampaignStage;
  readonly requestedByUserId?: string;
}

export type AdvanceCampaignStageInput =
  | AdvanceCampaignStageAutoInput
  | AdvanceCampaignStageGateDecisionInput
  | AdvanceCampaignStageAutoRetryInput;

/**
 * The only stages an AUTO_RETRY may leave: the automated QA stages. VISUAL_QA
 * and CONTINUITY_QA each have a sole REVISION edge routing to SHOT_GENERATION;
 * FINAL_QA has three, disambiguated by `repairTarget`. Any other `fromStage` —
 * in particular every human-gated stage — is refused, so an automated retry
 * can never cross a human approval gate.
 */
const AUTO_RETRY_ELIGIBLE_STAGES: ReadonlySet<CampaignStage> = new Set([
  'VISUAL_QA',
  'CONTINUITY_QA',
  // M11: FINAL_QA has three automated (non-human-gated) revision edges —
  // COMPOSITING | ROUGH_CUT | SOUND_DESIGN — selected by the failure category
  // via the input's `repairTarget`.
  'FINAL_QA',
]);

export type AdvanceCampaignStageOutput =
  | { readonly ok: true; readonly toStage: CampaignStage }
  | { readonly ok: false; readonly reason: 'TERMINAL' }
  | {
      readonly ok: false;
      readonly reason: 'GATE_REQUIRED';
      readonly gate: ApprovalGate;
      readonly targetStage: CampaignStage;
    }
  | {
      readonly ok: false;
      readonly reason: 'NO_MATCHING_TRANSITION';
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'INVALID_TRANSITION'
        | 'MISSING_PREREQUISITE'
        | 'BUDGET_EXCEEDED'
        | 'CONCURRENT_MODIFICATION'
        | 'DUPLICATE_REQUEST';
      readonly detail: string;
    };

export interface AdvanceCampaignStageActivityDeps {
  readonly campaignTransitionDb: CampaignTransitionDataSource;
}

/** The single FORWARD edge out of `fromStage`, if any — the transition table has at most one per stage. */
function findForwardEdge(fromStage: CampaignStage) {
  return CAMPAIGN_TRANSITIONS.find((t) => t.from === fromStage && t.kind === 'FORWARD');
}

/**
 * The REVISION edge a rejected/changes-requested decision at `gate` routes
 * to from `fromStage`. FINAL is the only gate with more than one candidate
 * target — disambiguated by the human-selected `repairTarget` (see
 * HumanApprovalSchema's doc comment in packages/domain).
 */
function findRevisionEdge(
  fromStage: CampaignStage,
  gate: ApprovalGate,
  repairTarget?: CampaignStage,
) {
  const candidates = CAMPAIGN_TRANSITIONS.filter(
    (t) => t.from === fromStage && t.kind === 'REVISION',
  );
  if (gate === 'FINAL') {
    return candidates.find((t) => t.to === repairTarget);
  }
  return candidates[0];
}

function mapRejection(
  reason:
    | { type: 'INVALID_TRANSITION' }
    | { type: 'MISSING_PREREQUISITE'; missing: string[] }
    | { type: 'BUDGET_EXCEEDED' }
    | { type: 'CONCURRENT_MODIFICATION' }
    | { type: 'DUPLICATE_REQUEST' },
  message: string,
): AdvanceCampaignStageOutput {
  switch (reason.type) {
    case 'INVALID_TRANSITION':
      return { ok: false, reason: 'INVALID_TRANSITION', detail: message };
    case 'MISSING_PREREQUISITE':
      return { ok: false, reason: 'MISSING_PREREQUISITE', detail: message };
    case 'BUDGET_EXCEEDED':
      return { ok: false, reason: 'BUDGET_EXCEEDED', detail: message };
    case 'CONCURRENT_MODIFICATION':
      return { ok: false, reason: 'CONCURRENT_MODIFICATION', detail: message };
    case 'DUPLICATE_REQUEST':
      return { ok: false, reason: 'DUPLICATE_REQUEST', detail: message };
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function createAdvanceCampaignStageActivity(
  deps: AdvanceCampaignStageActivityDeps,
): (input: AdvanceCampaignStageInput) => Promise<AdvanceCampaignStageOutput> {
  return async function advanceCampaignStageActivity(
    input: AdvanceCampaignStageInput,
  ): Promise<AdvanceCampaignStageOutput> {
    let toStage: CampaignStage;
    let generationBudgetCents: number | undefined;

    if (input.mode === 'AUTO_FORWARD') {
      const edge = findForwardEdge(input.fromStage);
      if (!edge) {
        return { ok: false, reason: 'TERMINAL' };
      }
      if (edge.requiredApprovalGate) {
        return {
          ok: false,
          reason: 'GATE_REQUIRED',
          gate: edge.requiredApprovalGate,
          targetStage: edge.to,
        };
      }
      toStage = edge.to;
    } else if (input.mode === 'AUTO_RETRY') {
      // Refuse any stage whose revision edge isn't an automated-QA retry — a
      // hard guard so an AUTO_RETRY can never traverse a human-gated edge.
      if (!AUTO_RETRY_ELIGIBLE_STAGES.has(input.fromStage)) {
        return {
          ok: false,
          reason: 'NO_MATCHING_TRANSITION',
          detail: `AUTO_RETRY is not permitted from ${input.fromStage}`,
        };
      }
      // Only ever non-gated REVISION edges — the `!t.requiredApprovalGate`
      // filter is the second half of the "never bypass a human gate" guard.
      const candidates = CAMPAIGN_TRANSITIONS.filter(
        (t) => t.from === input.fromStage && t.kind === 'REVISION' && !t.requiredApprovalGate,
      );
      if (candidates.length === 0) {
        return {
          ok: false,
          reason: 'NO_MATCHING_TRANSITION',
          detail: `No automated revision edge exists from ${input.fromStage}`,
        };
      }
      // A multi-edge QA stage (FINAL_QA) must say which repair target the
      // failure category selected; a single-edge stage (VISUAL_QA/
      // CONTINUITY_QA) has nothing to disambiguate. An explicit repairTarget
      // is always honoured, so a caller can never silently land on a different
      // edge than the one it asked for.
      const edge =
        input.repairTarget !== undefined
          ? candidates.find((t) => t.to === input.repairTarget)
          : candidates.length === 1
            ? candidates[0]
            : undefined;
      if (!edge) {
        return {
          ok: false,
          reason: 'NO_MATCHING_TRANSITION',
          detail:
            input.repairTarget !== undefined
              ? `No automated revision edge to ${input.repairTarget} exists from ${input.fromStage}`
              : `${input.fromStage} has ${candidates.length} automated revision edges; a repairTarget is required`,
        };
      }
      toStage = edge.to;
      generationBudgetCents = input.generationBudgetCents;
    } else {
      if (input.decision === 'APPROVED') {
        const edge = findForwardEdge(input.fromStage);
        if (!edge || edge.requiredApprovalGate !== input.gate) {
          return {
            ok: false,
            reason: 'NO_MATCHING_TRANSITION',
            detail: `No forward edge gated by ${input.gate} exists from ${input.fromStage}`,
          };
        }
        toStage = edge.to;
      } else {
        const edge = findRevisionEdge(input.fromStage, input.gate, input.repairTarget);
        if (!edge) {
          return {
            ok: false,
            reason: 'NO_MATCHING_TRANSITION',
            detail: `No revision edge for gate ${input.gate}${
              input.repairTarget ? ` (repairTarget ${input.repairTarget})` : ''
            } exists from ${input.fromStage}`,
          };
        }
        toStage = edge.to;
      }
    }

    const result = await attemptCampaignTransition(deps.campaignTransitionDb, {
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      toStage,
      idempotencyKey: input.idempotencyKey,
      requestedByUserId: input.requestedByUserId,
      generationBudgetCents,
    });

    if (result.ok) {
      return { ok: true, toStage: result.campaign.currentStage };
    }
    return mapRejection(result.error.reason, result.error.message);
  };
}
