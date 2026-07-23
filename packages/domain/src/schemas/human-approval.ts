import { z } from 'zod';
import { CampaignStageSchema } from '../workflow/campaign-stage';
import { ApprovalDecisionSchema, ApprovalGateSchema } from './shared-enums';

/**
 * Human approval records are immutable once created (architecture.md §0
 * guiding constraint 3) — the repository layer in packages/database exposes
 * only an insert for this table, never an update or delete. A revised
 * decision is a new row, not a mutation of the old one, so the audit trail of
 * "who decided what, when" can never be altered after the fact.
 */
export const HumanApprovalSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  gate: ApprovalGateSchema,
  decision: ApprovalDecisionSchema,
  stageAtDecision: CampaignStageSchema,
  decidedByUserId: z.string().uuid(),
  comments: z.string().optional(),
  decidedAt: z.date(),
});
export type HumanApproval = z.infer<typeof HumanApprovalSchema>;
