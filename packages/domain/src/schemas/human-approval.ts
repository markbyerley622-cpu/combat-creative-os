import { z } from 'zod';
import { CampaignStageSchema } from '../workflow/campaign-stage';
import { ApprovalDecisionSchema, ApprovalGateSchema } from './shared-enums';

/** The only stages a FINAL-gate rejection may nominate as the repair target — see decision 8/12 in docs/adr/0002-campaign-lifecycle-alignment.md. */
export const FINAL_APPROVAL_REPAIR_TARGETS = ['COMPOSITING', 'ROUGH_CUT', 'SOUND_DESIGN'] as const;

/**
 * Human approval records are immutable once created (architecture.md §0
 * guiding constraint 3) — the repository layer in packages/database exposes
 * only an insert for this table, never an update or delete. A revised
 * decision is a new row, not a mutation of the old one, so the audit trail of
 * "who decided what, when" can never be altered after the fact.
 *
 * `repairTarget` is the human-selected revision destination for a rejected
 * `FINAL` decision — FINAL_APPROVAL's rejection can route to COMPOSITING,
 * ROUGH_CUT, or SOUND_DESIGN, and the reviewer must say which. It is required
 * exactly when `gate === 'FINAL' && decision !== 'APPROVED'`, and forbidden
 * otherwise (the other two gates each have exactly one revision target, so no
 * selection is needed there).
 */
export const HumanApprovalSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    gate: ApprovalGateSchema,
    decision: ApprovalDecisionSchema,
    stageAtDecision: CampaignStageSchema,
    decidedByUserId: z.string().uuid(),
    comments: z.string().optional(),
    repairTarget: z.enum(FINAL_APPROVAL_REPAIR_TARGETS).optional(),
    decidedAt: z.date(),
  })
  .refine(
    (approval) => {
      const requiresRepairTarget = approval.gate === 'FINAL' && approval.decision !== 'APPROVED';
      return requiresRepairTarget
        ? approval.repairTarget !== undefined
        : approval.repairTarget === undefined;
    },
    {
      message:
        'repairTarget is required for a non-approved FINAL decision, and must be absent for every other gate/decision combination',
    },
  );
export type HumanApproval = z.infer<typeof HumanApprovalSchema>;
