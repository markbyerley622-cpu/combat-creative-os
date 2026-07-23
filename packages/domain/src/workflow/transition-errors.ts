import type { BudgetLevel } from '../schemas/shared-enums';
import type { CampaignStage } from './campaign-stage';

/**
 * Typed rejection reasons for a campaign stage transition. Returned as data
 * (a discriminated union) by `evaluateCampaignTransition`, not thrown — an
 * invalid or missing-prerequisite transition attempt is an expected outcome
 * the caller must branch on, not an exceptional program state. The
 * transaction-boundary layer (packages/database) wraps these in
 * `CampaignTransitionError` when it needs to unwind a transaction / surface a
 * single throwable.
 */
export type TransitionRejectionReason =
  | { type: 'INVALID_TRANSITION'; from: CampaignStage; to: CampaignStage }
  | { type: 'MISSING_PREREQUISITE'; from: CampaignStage; to: CampaignStage; missing: string[] }
  | {
      type: 'BUDGET_EXCEEDED';
      level: BudgetLevel;
      scopeId: string;
      requiredCents: number;
      remainingCents: number;
    }
  | { type: 'CONCURRENT_MODIFICATION'; campaignId: string; expectedVersion: number }
  | { type: 'DUPLICATE_REQUEST'; idempotencyKey: string };

export function describeTransitionRejection(reason: TransitionRejectionReason): string {
  switch (reason.type) {
    case 'INVALID_TRANSITION':
      return `Cannot transition campaign from ${reason.from} to ${reason.to}: no such transition is defined`;
    case 'MISSING_PREREQUISITE':
      return `Cannot transition campaign from ${reason.from} to ${reason.to}: missing prerequisite(s) ${reason.missing.join(', ')}`;
    case 'BUDGET_EXCEEDED':
      return `Budget exceeded at ${reason.level} scope ${reason.scopeId}: required ${reason.requiredCents}c, remaining ${reason.remainingCents}c`;
    case 'CONCURRENT_MODIFICATION':
      return `Campaign ${reason.campaignId} was modified concurrently (expected version ${reason.expectedVersion})`;
    case 'DUPLICATE_REQUEST':
      return `Duplicate transition request with idempotency key ${reason.idempotencyKey}`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export class CampaignTransitionError extends Error {
  public readonly reason: TransitionRejectionReason;

  constructor(reason: TransitionRejectionReason) {
    super(describeTransitionRejection(reason));
    this.name = 'CampaignTransitionError';
    this.reason = reason;
  }
}
