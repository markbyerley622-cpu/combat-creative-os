import { z } from 'zod';
import { BudgetLedgerEntryTypeSchema, BudgetLevelSchema } from './shared-enums';

/**
 * A configured spending cap at one of the four required levels (workspace,
 * campaign, shot, provider — architecture.md §4.3). `scopeId` is the id of
 * the scoped entity (workspaceId/campaignId/shotId/providerId-as-string
 * depending on `level`); for level=WORKSPACE, scopeId equals workspaceId.
 */
export const BudgetPolicySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  level: BudgetLevelSchema,
  scopeId: z.string().min(1),
  limitCents: z.number().int().nonnegative(),
  periodStart: z.date().optional(),
  periodEnd: z.date().optional(),
  createdAt: z.date(),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

/**
 * Append-only spend ledger — architecture.md §4.3: "No budget row is ever
 * mutated in place." A `BudgetPolicy`'s remaining amount is always a computed
 * aggregate over this table (sum of RESERVATION + CHARGE, minus RELEASE),
 * never a field decremented in place. `idempotencyKey` is unique per
 * `budgetPolicyId` (see schema.prisma) so a retried reservation for the same
 * `(workflowRunId, stage, entityId, attempt)` key never double-reserves.
 */
export const BudgetLedgerEntrySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  budgetPolicyId: z.string().uuid(),
  entryType: BudgetLedgerEntryTypeSchema,
  amountCents: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1),
  campaignId: z.string().uuid().optional(),
  shotId: z.string().uuid().optional(),
  generationJobRef: z.string().optional(),
  createdAt: z.date(),
});
export type BudgetLedgerEntry = z.infer<typeof BudgetLedgerEntrySchema>;
