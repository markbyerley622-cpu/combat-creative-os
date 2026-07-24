import { randomUUID } from 'node:crypto';
import type { CampaignStage } from '@combat/domain';
import type {
  AgentInvocationDataSource,
  AgentInvocationRecord,
  BudgetDataSource,
  BudgetLedgerEntryRecord,
  BudgetPolicyRecord,
  CampaignDataSource,
  CampaignRecord,
} from '@combat/database';

/**
 * A minimal in-memory fake of the three narrow *DataSource interfaces
 * `execute-specialist-agent-activity.ts` depends on — mirroring
 * `@combat/database`'s own `InMemoryCampaignStore` test-helper pattern
 * (same unique-constraint-throws-on-violation semantics), scoped down to
 * only what this Activity touches. Kept local to `@combat/workflows` rather
 * than imported from `@combat/database`'s internal test-helpers, since that
 * file isn't part of `@combat/database`'s public package export.
 */
export class InMemoryAgentExecutionStore
  implements CampaignDataSource, BudgetDataSource, AgentInvocationDataSource
{
  campaigns: CampaignRecord[] = [];
  budgetPolicies: BudgetPolicyRecord[] = [];
  budgetLedgerEntries: BudgetLedgerEntryRecord[] = [];
  agentInvocations: AgentInvocationRecord[] = [];

  seedCampaign(overrides: Partial<CampaignRecord> = {}): CampaignRecord {
    const now = new Date();
    const campaign: CampaignRecord = {
      id: randomUUID(),
      workspaceId: randomUUID(),
      name: 'Test Campaign',
      currentStage: 'PROMPTING',
      version: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.campaigns.push(campaign);
    return campaign;
  }

  campaign: CampaignDataSource['campaign'] = {
    create: async ({ data }) => {
      const now = new Date();
      const campaign: CampaignRecord = {
        id: randomUUID(),
        currentStage: 'DRAFT' as CampaignStage,
        version: 0,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.campaigns.push(campaign);
      return campaign;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.campaigns.find((c) => c.id === where.id && c.workspaceId === where.workspaceId) ??
          null
        );
      }
      return (
        this.campaigns.find(
          (c) => c.workspaceId === where.workspaceId && c.idempotencyKey === where.idempotencyKey,
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.campaigns.filter((c) => c.workspaceId === where.workspaceId),
  };

  budgetPolicy: BudgetDataSource['budgetPolicy'] = {
    findFirst: async ({ where }) =>
      this.budgetPolicies.find(
        (p) =>
          p.workspaceId === where.workspaceId &&
          p.level === where.level &&
          p.scopeId === where.scopeId,
      ) ?? null,
  };
  budgetLedgerEntry: BudgetDataSource['budgetLedgerEntry'] = {
    findMany: async ({ where }) =>
      this.budgetLedgerEntries.filter((e) => e.budgetPolicyId === where.budgetPolicyId),
    findFirst: async ({ where }) =>
      this.budgetLedgerEntries.find(
        (e) =>
          e.budgetPolicyId === where.budgetPolicyId && e.idempotencyKey === where.idempotencyKey,
      ) ?? null,
    create: async ({ data }) => {
      const exists = this.budgetLedgerEntries.some(
        (e) => e.budgetPolicyId === data.budgetPolicyId && e.idempotencyKey === data.idempotencyKey,
      );
      if (exists) {
        throw new Error(
          'unique constraint violation on budget_ledger_entries (budgetPolicyId, idempotencyKey)',
        );
      }
      const entry: BudgetLedgerEntryRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.budgetLedgerEntries.push(entry);
      return entry;
    },
  };

  agentInvocation: AgentInvocationDataSource['agentInvocation'] = {
    findFirst: async ({ where }) =>
      this.agentInvocations.find(
        (a) => a.campaignId === where.campaignId && a.idempotencyKey === where.idempotencyKey,
      ) ?? null,
    create: async ({ data }) => {
      const exists = this.agentInvocations.some(
        (a) => a.campaignId === data.campaignId && a.idempotencyKey === data.idempotencyKey,
      );
      if (exists) {
        throw new Error(
          'unique constraint violation on agent_invocations (campaignId, idempotencyKey)',
        );
      }
      const record: AgentInvocationRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.agentInvocations.push(record);
      return record;
    },
  };
}
