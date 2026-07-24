import type { ApprovalDecision, ApprovalGate, CampaignStage } from '@combat/domain';
import type { HumanApprovalDataSource } from '@combat/database';
import { listHumanApprovals } from '@combat/database';

/**
 * The Activity boundary that makes gate-signal verification a backend fact
 * rather than a claim the signal payload gets to make about itself
 * (docs/architecture.md §0 guiding constraint 3: "unbypassable" is a
 * workflow-engine guarantee, not a UI convention). `listHumanApprovals` is
 * already scoped to `(workspaceId, campaignId)` — a signal whose
 * `approvalId` belongs to a different campaign or workspace simply never
 * matches a row here, which is what makes wrong-campaign/wrong-workspace
 * decisions indistinguishable from "no such approval" rather than a
 * information-leaking distinct error.
 */

export interface VerifyHumanApprovalInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly approvalId: string;
  readonly expectedGate: ApprovalGate;
}

export interface VerifiedHumanApproval {
  readonly id: string;
  readonly gate: ApprovalGate;
  readonly decision: ApprovalDecision;
  readonly decidedByUserId: string;
  readonly repairTarget?: CampaignStage;
  readonly decidedAt: string;
}

export type VerifyHumanApprovalOutput =
  | { readonly found: false }
  | { readonly found: true; readonly matchesGate: false }
  | { readonly found: true; readonly matchesGate: true; readonly approval: VerifiedHumanApproval };

export interface VerifyHumanApprovalActivityDeps {
  readonly humanApprovalDb: HumanApprovalDataSource;
}

export function createVerifyHumanApprovalActivity(
  deps: VerifyHumanApprovalActivityDeps,
): (input: VerifyHumanApprovalInput) => Promise<VerifyHumanApprovalOutput> {
  return async function verifyHumanApprovalActivity(
    input: VerifyHumanApprovalInput,
  ): Promise<VerifyHumanApprovalOutput> {
    const approvals = await listHumanApprovals(
      deps.humanApprovalDb,
      input.workspaceId,
      input.campaignId,
    );
    const approval = approvals.find((a) => a.id === input.approvalId);
    if (!approval) {
      return { found: false };
    }
    if (approval.gate !== input.expectedGate) {
      return { found: true, matchesGate: false };
    }
    return {
      found: true,
      matchesGate: true,
      approval: {
        id: approval.id,
        gate: approval.gate,
        decision: approval.decision,
        decidedByUserId: approval.decidedByUserId,
        repairTarget: approval.repairTarget,
        decidedAt: approval.decidedAt.toISOString(),
      },
    };
  };
}
