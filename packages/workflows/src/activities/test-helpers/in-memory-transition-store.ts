import { randomUUID } from 'node:crypto';
import type { CampaignStage } from '@combat/domain';
import type {
  BudgetDataSource,
  BudgetLedgerEntryRecord,
  BudgetPolicyRecord,
  CampaignRecord,
  CampaignTransitionAuditDataSource,
  CampaignTransitionAuditRecord,
  CampaignTransitionDataSource,
  HumanApprovalDataSource,
  HumanApprovalRecord,
} from '@combat/database';
import type {
  CampaignBriefFactRow,
  CreativeConceptFactRow,
  CreativeVariantFactRow,
  DeliverySpecificationFactRow,
  EditDecisionListFactRow,
  GenerationCandidateFactRow,
  GenerationPromptFactRow,
  QualityAssessmentFactRow,
  QualityFailureFactRow,
  RenderJobFactRow,
  ScriptFactRow,
  ShotFactRow,
  SoundCueFactRow,
  TimelineFactRow,
  TransitionFactsDataSource,
} from '@combat/database';

/**
 * A minimal in-memory fake of `CampaignTransitionDataSource` (which itself
 * composes five narrower *DataSource interfaces), scoped to what
 * `advance-campaign-stage-activity.ts` and `verify-human-approval-activity.ts`
 * touch. Mirrors `@combat/database`'s own `InMemoryCampaignStore` test-helper
 * (same compare-and-swap / unique-constraint semantics) rather than importing
 * it directly — that class isn't part of `@combat/database`'s public package
 * export, matching the precedent set by this package's own
 * `InMemoryAgentExecutionStore` (see execute-specialist-agent-activity.test.ts).
 */
export class InMemoryTransitionStore
  implements CampaignTransitionDataSource, TransitionFactsDataSource
{
  campaigns: CampaignRecord[] = [];
  audits: CampaignTransitionAuditRecord[] = [];
  approvals: HumanApprovalRecord[] = [];
  briefs: CampaignBriefFactRow[] = [];
  concepts: CreativeConceptFactRow[] = [];
  scripts: ScriptFactRow[] = [];
  shots: ShotFactRow[] = [];
  generationPrompts: GenerationPromptFactRow[] = [];
  generationCandidates: GenerationCandidateFactRow[] = [];
  qualityAssessments: QualityAssessmentFactRow[] = [];
  qualityFailures: QualityFailureFactRow[] = [];
  renderJobs: RenderJobFactRow[] = [];
  editDecisionLists: EditDecisionListFactRow[] = [];
  deliverySpecifications: DeliverySpecificationFactRow[] = [];
  creativeVariants: CreativeVariantFactRow[] = [];
  timelines: TimelineFactRow[] = [];
  soundCues: SoundCueFactRow[] = [];
  budgetPolicies: BudgetPolicyRecord[] = [];
  budgetLedgerEntries: BudgetLedgerEntryRecord[] = [];

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

  seedApproval(
    overrides: Partial<HumanApprovalRecord> &
      Pick<
        HumanApprovalRecord,
        'workspaceId' | 'campaignId' | 'gate' | 'decision' | 'stageAtDecision' | 'decidedByUserId'
      >,
  ): HumanApprovalRecord {
    const approval: HumanApprovalRecord = { id: randomUUID(), decidedAt: new Date(), ...overrides };
    this.approvals.push(approval);
    return approval;
  }

  campaign: CampaignTransitionDataSource['campaign'] = {
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
    findFirst: async ({ where }) =>
      this.campaigns.find((c) => c.id === where.id && c.workspaceId === where.workspaceId) ?? null,
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
    findFirst: async ({ where }) =>
      this.audits.find(
        (a) => a.campaignId === where.campaignId && a.idempotencyKey === where.idempotencyKey,
      ) ?? null,
    create: async ({ data }) => {
      const exists = this.audits.some(
        (a) => a.campaignId === data.campaignId && a.idempotencyKey === data.idempotencyKey,
      );
      if (exists) {
        throw new Error(
          'unique constraint violation on campaign_transition_audits (campaignId, idempotencyKey)',
        );
      }
      const audit: CampaignTransitionAuditRecord = {
        id: randomUUID(),
        createdAt: new Date(),
        ...data,
      };
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
    findMany: async ({ where }) =>
      this.approvals.filter(
        (a) => a.campaignId === where.campaignId && a.workspaceId === where.workspaceId,
      ),
  };

  campaignBrief: TransitionFactsDataSource['campaignBrief'] = {
    findMany: async ({ where }) => this.briefs.filter((b) => b.campaignId === where.campaignId),
  };
  creativeConcept: TransitionFactsDataSource['creativeConcept'] = {
    findMany: async ({ where }) => this.concepts.filter((c) => c.campaignId === where.campaignId),
  };
  script: TransitionFactsDataSource['script'] = {
    findMany: async ({ where }) => this.scripts.filter((s) => s.campaignId === where.campaignId),
  };
  shot: TransitionFactsDataSource['shot'] = {
    findMany: async ({ where }) => this.shots.filter((s) => where.scriptId.in.includes(s.scriptId)),
  };
  generationPrompt: TransitionFactsDataSource['generationPrompt'] = {
    findMany: async ({ where }) =>
      this.generationPrompts.filter((p) => where.shotId.in.includes(p.shotId)),
  };
  generationCandidate: TransitionFactsDataSource['generationCandidate'] = {
    findMany: async ({ where }) =>
      this.generationCandidates.filter((c) =>
        where.generationPromptId.in.includes(c.generationPromptId),
      ),
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
  qualityFailure: TransitionFactsDataSource['qualityFailure'] = {
    findMany: async ({ where }) =>
      this.qualityFailures.filter((f) =>
        where.qualityAssessmentId.in.includes(f.qualityAssessmentId),
      ),
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
  timeline: TransitionFactsDataSource['timeline'] = {
    findMany: async ({ where }) => this.timelines.filter((t) => t.campaignId === where.campaignId),
  };
  soundCue: TransitionFactsDataSource['soundCue'] = {
    findMany: async ({ where }) =>
      this.soundCues.filter((s) => where.timelineId.in.includes(s.timelineId)),
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
      const entry: BudgetLedgerEntryRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.budgetLedgerEntries.push(entry);
      return entry;
    },
  };
}
