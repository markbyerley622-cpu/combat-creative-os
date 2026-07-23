import { z } from 'zod';
import { TransitionAuditResultSchema } from '../schemas/shared-enums';
import { CampaignStageSchema } from './campaign-stage';

/**
 * Append-only audit trail row for every transition *attempt* (not just
 * successful ones) — CLAUDE.md "Transition attempts must be audited". The
 * `(campaignId, idempotencyKey)` pair is unique at the database level (see
 * CampaignTransitionAudit in schema.prisma) and is the mechanism that makes
 * duplicate requests idempotent: a retried request with the same key returns
 * the row already recorded here instead of re-evaluating the transition.
 */
export const CampaignTransitionAuditSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
  fromStage: CampaignStageSchema,
  toStage: CampaignStageSchema,
  result: TransitionAuditResultSchema,
  reason: z.string().optional(),
  approvalId: z.string().uuid().optional(),
  requestedByUserId: z.string().uuid().optional(),
  createdAt: z.date(),
});
export type CampaignTransitionAudit = z.infer<typeof CampaignTransitionAuditSchema>;
