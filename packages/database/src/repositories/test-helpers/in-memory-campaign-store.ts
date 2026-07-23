import { randomUUID } from 'node:crypto';
import type { CampaignStage } from '@combat/domain';
import type { AssetDataSource, AssetProvenanceRecord, AssetRecord } from '../asset-repository';
import type { BudgetDataSource, BudgetLedgerEntryRecord, BudgetPolicyRecord } from '../budget-repository';
import type { CampaignDataSource, CampaignRecord } from '../campaign-repository';
import type { CampaignTransitionAuditDataSource, CampaignTransitionAuditRecord } from '../campaign-transition-service';
import type { HumanApprovalDataSource, HumanApprovalRecord } from '../human-approval-repository';
import type {
  GenerationPromptRecord,
  PromptDataSource,
  PromptTemplateRecord,
  PromptVersionRecord,
} from '../prompt-repository';
import type {
  CampaignBriefFactRow,
  CreativeVariantFactRow,
  DeliverySpecificationFactRow,
  EditDecisionListFactRow,
  GenerationCandidateFactRow,
  GenerationPromptFactRow,
  PerformanceMetricsFactRow,
  QualityAssessmentFactRow,
  RenderJobFactRow,
  ScriptFactRow,
  ShotFactRow,
  TransitionFactsDataSource,
} from '../transition-facts';

/**
 * A single in-memory store implementing every narrow *DataSource interface
 * this repository layer defines, reproducing the semantics a real Postgres
 * transaction gives us:
 *  - `campaign.updateMany` only applies when the where-clause (including
 *    `currentStage`/`version`) matches every row — this is what makes the
 *    compare-and-swap concurrency guard testable without a live database.
 *  - unique constraints (`(campaignId, idempotencyKey)` on transition
 *    audits, `(budgetPolicyId, idempotencyKey)` on ledger entries) throw,
 *    matching Postgres's behavior, so idempotency/duplicate-reservation
 *    tests exercise the real failure mode.
 *
 * This is intentionally one large fake rather than one per repository file —
 * campaign-transition-service.ts composes many repositories in a single
 * logical transaction, and a real transaction shares one connection/lock
 * scope across all of them.
 */
export class InMemoryCampaignStore
  implements
    CampaignDataSource,
    CampaignTransitionAuditDataSource,
    HumanApprovalDataSource,
    TransitionFactsDataSource,
    BudgetDataSource,
    AssetDataSource,
    PromptDataSource
{
  campaigns: CampaignRecord[] = [];
  audits: CampaignTransitionAuditRecord[] = [];
  approvals: HumanApprovalRecord[] = [];
  briefs: CampaignBriefFactRow[] = [];
  scripts: ScriptFactRow[] = [];
  shots: ShotFactRow[] = [];
  generationPrompts: (GenerationPromptFactRow & Partial<GenerationPromptRecord>)[] = [];
  generationCandidates: GenerationCandidateFactRow[] = [];
  qualityAssessments: QualityAssessmentFactRow[] = [];
  renderJobs: RenderJobFactRow[] = [];
  editDecisionLists: EditDecisionListFactRow[] = [];
  deliverySpecifications: DeliverySpecificationFactRow[] = [];
  creativeVariants: CreativeVariantFactRow[] = [];
  performanceMetricsRows: PerformanceMetricsFactRow[] = [];
  budgetPolicies: BudgetPolicyRecord[] = [];
  budgetLedgerEntries: BudgetLedgerEntryRecord[] = [];
  assets: AssetRecord[] = [];
  assetProvenances: AssetProvenanceRecord[] = [];
  promptTemplates: PromptTemplateRecord[] = [];
  promptVersions: PromptVersionRecord[] = [];

  seedCampaign(overrides: Partial<CampaignRecord> = {}): CampaignRecord {
    const now = new Date();
    const campaign: CampaignRecord = {
      id: randomUUID(),
      workspaceId: randomUUID(),
      name: 'Test Campaign',
      currentStage: 'DRAFT',
      version: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.campaigns.push(campaign);
    return campaign;
  }

  campaign: CampaignDataSource['campaign'] & {
    updateMany(args: {
      where: { id: string; workspaceId: string; currentStage: CampaignStage; version: number };
      data: { currentStage: CampaignStage; version: { increment: number } };
    }): Promise<{ count: number }>;
  } = {
    create: async ({ data }) => {
      const now = new Date();
      const campaign: CampaignRecord = {
        id: randomUUID(),
        currentStage: 'DRAFT',
        version: 0,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.campaigns.push(campaign);
      return campaign;
    },
    findFirst: async ({ where }) => {
      return (
        this.campaigns.find((c) => c.id === where.id && c.workspaceId === where.workspaceId) ?? null
      );
    },
    updateMany: async ({ where, data }) => {
      const match = this.campaigns.find(
        (c) =>
          c.id === where.id &&
          c.workspaceId === where.workspaceId &&
          c.currentStage === where.currentStage &&
          c.version === where.version,
      );
      if (!match) return { count: 0 };
      match.currentStage = data.currentStage;
      match.version += data.version.increment;
      match.updatedAt = new Date();
      return { count: 1 };
    },
  };

  campaignTransitionAudit: CampaignTransitionAuditDataSource['campaignTransitionAudit'] = {
    findFirst: async ({ where }) => {
      return (
        this.audits.find((a) => a.campaignId === where.campaignId && a.idempotencyKey === where.idempotencyKey) ??
        null
      );
    },
    create: async ({ data }) => {
      const exists = this.audits.some(
        (a) => a.campaignId === data.campaignId && a.idempotencyKey === data.idempotencyKey,
      );
      if (exists) {
        throw new Error(
          `unique constraint violation on campaign_transition_audits (campaignId, idempotencyKey)`,
        );
      }
      const audit: CampaignTransitionAuditRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.audits.push(audit);
      return audit;
    },
  };

  humanApproval: HumanApprovalDataSource['humanApproval'] = {
    create: async ({ data }) => {
      const approval: HumanApprovalRecord = { id: randomUUID(), decidedAt: new Date(), ...data };
      this.approvals.push(approval);
      return approval;
    },
    findMany: async ({ where }) => {
      return this.approvals.filter(
        (a) => a.campaignId === where.campaignId && a.workspaceId === where.workspaceId,
      );
    },
  };

  campaignBrief: TransitionFactsDataSource['campaignBrief'] = {
    findMany: async ({ where }) => this.briefs.filter((b) => b.campaignId === where.campaignId),
  };
  script: TransitionFactsDataSource['script'] = {
    findMany: async ({ where }) => this.scripts.filter((s) => s.campaignId === where.campaignId),
  };
  shot: TransitionFactsDataSource['shot'] = {
    findMany: async ({ where }) => this.shots.filter((s) => where.scriptId.in.includes(s.scriptId)),
  };
  generationPrompt: TransitionFactsDataSource['generationPrompt'] & PromptDataSource['generationPrompt'] = {
    findMany: async ({ where }) =>
      this.generationPrompts.filter((p) => where.shotId.in.includes(p.shotId)),
    create: async ({ data }) => {
      const record: GenerationPromptRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.generationPrompts.push(record);
      return record;
    },
    findFirst: async ({ where }) => {
      const found = this.generationPrompts.find(
        (p) => p.id === where.id && p.workspaceId === where.workspaceId,
      );
      return (found as GenerationPromptRecord | undefined) ?? null;
    },
  };
  generationCandidate: TransitionFactsDataSource['generationCandidate'] = {
    findMany: async ({ where }) =>
      this.generationCandidates.filter((c) => where.generationPromptId.in.includes(c.generationPromptId)),
  };
  qualityAssessment: TransitionFactsDataSource['qualityAssessment'] = {
    findMany: async ({ where }) => {
      const [candidateFilter] = where.OR;
      const candidateIds = new Set(candidateFilter.generationCandidateId.in);
      return this.qualityAssessments.filter(
        (qa) =>
          (qa.generationCandidateId != null && candidateIds.has(qa.generationCandidateId)) ||
          qa.assetId != null,
      );
    },
  };
  renderJob: TransitionFactsDataSource['renderJob'] = {
    findMany: async () => this.renderJobs,
  };
  editDecisionList: TransitionFactsDataSource['editDecisionList'] = {
    findMany: async () => this.editDecisionLists,
  };
  deliverySpecification: TransitionFactsDataSource['deliverySpecification'] = {
    findMany: async () => this.deliverySpecifications,
  };
  creativeVariant: TransitionFactsDataSource['creativeVariant'] = {
    findMany: async () => this.creativeVariants,
  };
  performanceMetrics: TransitionFactsDataSource['performanceMetrics'] = {
    findMany: async ({ where }) =>
      this.performanceMetricsRows.filter((m) => where.creativeVariantId.in.includes(m.creativeVariantId)),
  };

  budgetPolicy: BudgetDataSource['budgetPolicy'] = {
    findFirst: async ({ where }) =>
      this.budgetPolicies.find(
        (p) => p.workspaceId === where.workspaceId && p.level === where.level && p.scopeId === where.scopeId,
      ) ?? null,
  };
  budgetLedgerEntry: BudgetDataSource['budgetLedgerEntry'] = {
    findMany: async ({ where }) =>
      this.budgetLedgerEntries.filter((e) => e.budgetPolicyId === where.budgetPolicyId),
    findFirst: async ({ where }) =>
      this.budgetLedgerEntries.find(
        (e) => e.budgetPolicyId === where.budgetPolicyId && e.idempotencyKey === where.idempotencyKey,
      ) ?? null,
    create: async ({ data }) => {
      const exists = this.budgetLedgerEntries.some(
        (e) => e.budgetPolicyId === data.budgetPolicyId && e.idempotencyKey === data.idempotencyKey,
      );
      if (exists) {
        throw new Error('unique constraint violation on budget_ledger_entries (budgetPolicyId, idempotencyKey)');
      }
      const entry: BudgetLedgerEntryRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.budgetLedgerEntries.push(entry);
      return entry;
    },
  };

  asset: AssetDataSource['asset'] = {
    create: async ({ data }) => {
      const asset: AssetRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.assets.push(asset);
      return asset;
    },
    findFirst: async ({ where }) =>
      this.assets.find((a) => a.id === where.id && a.workspaceId === where.workspaceId) ?? null,
  };
  assetProvenance: AssetDataSource['assetProvenance'] = {
    create: async ({ data }) => {
      const provenance: AssetProvenanceRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.assetProvenances.push(provenance);
      return provenance;
    },
    findFirst: async ({ where }) =>
      this.assetProvenances.find((p) => p.assetId === where.assetId && p.workspaceId === where.workspaceId) ??
      null,
  };

  promptTemplate: PromptDataSource['promptTemplate'] = {
    create: async ({ data }) => {
      const template: PromptTemplateRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.promptTemplates.push(template);
      return template;
    },
  };
  promptVersion: PromptDataSource['promptVersion'] = {
    create: async ({ data }) => {
      const version: PromptVersionRecord = { id: randomUUID(), isActive: false, createdAt: new Date(), ...data };
      this.promptVersions.push(version);
      return version;
    },
    findMany: async ({ where }) =>
      this.promptVersions.filter((v) => v.promptTemplateId === where.promptTemplateId),
  };
}
