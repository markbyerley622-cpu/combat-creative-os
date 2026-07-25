import { randomUUID } from 'node:crypto';
import type { AssetKind, CampaignStage } from '@combat/domain';
import type {
  AgentInvocationDataSource,
  AgentInvocationRecord,
} from '../agent-invocation-repository';
import type { AssetDataSource, AssetProvenanceRecord, AssetRecord } from '../asset-repository';
import type { LicenseDataSource, LicenseRecord } from '../license-repository';
import type {
  BudgetDataSource,
  BudgetLedgerEntryRecord,
  BudgetPolicyRecord,
} from '../budget-repository';
import type { CampaignDataSource, CampaignRecord } from '../campaign-repository';
import type { CampaignBriefDataSource, CampaignBriefRecord } from '../campaign-brief-repository';
import type { StrategyDataSource, StrategyRecord } from '../strategy-repository';
import type {
  CreativeConceptDataSource,
  CreativeConceptRecord,
} from '../creative-concept-repository';
import type {
  ScriptDataSource,
  ScriptRecord,
  ShotDataSource,
  ShotRecord,
} from '../script-repository';
import type {
  CampaignTransitionAuditDataSource,
  CampaignTransitionAuditRecord,
} from '../campaign-transition-service';
import type { HumanApprovalDataSource, HumanApprovalRecord } from '../human-approval-repository';
import type { MembershipDataSource, MembershipRecord } from '../membership-repository';
import type {
  PromptDataSource,
  PromptTemplateRecord,
  PromptVersionRecord,
} from '../prompt-repository';
import type {
  ShotSpecificationDataSource,
  ShotSpecificationRecord,
} from '../shot-specification-repository';
import type {
  GenerationCandidateRecord,
  ShotGenerationAttemptRecord,
  ShotGenerationDataSource,
  ShotGenerationJobRecord,
} from '../shot-generation-repository';
import type {
  CampaignBriefFactRow,
  CreativeConceptFactRow,
  CreativeVariantFactRow,
  DeliverySpecificationFactRow,
  EditDecisionListFactRow,
  GenerationCandidateFactRow,
  QualityAssessmentFactRow,
  QualityFailureFactRow,
  RenderJobFactRow,
  ScriptFactRow,
  ShotFactRow,
  ShotGenerationJobFactRow,
  ShotSpecificationFactRow,
  SoundCueFactRow,
  TimelineFactRow,
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
 * scope across all of them. Performance entities (PerformanceMetrics, etc.)
 * are deliberately not modeled here — they no longer feed campaign-stage
 * transition facts (docs/adr/0002-campaign-lifecycle-alignment.md).
 */
export class InMemoryCampaignStore
  implements
    CampaignDataSource,
    CampaignTransitionAuditDataSource,
    HumanApprovalDataSource,
    TransitionFactsDataSource,
    BudgetDataSource,
    AssetDataSource,
    PromptDataSource,
    AgentInvocationDataSource,
    CampaignBriefDataSource,
    StrategyDataSource,
    CreativeConceptDataSource,
    ScriptDataSource,
    ShotDataSource,
    MembershipDataSource,
    LicenseDataSource,
    ShotSpecificationDataSource,
    ShotGenerationDataSource
{
  campaigns: CampaignRecord[] = [];
  audits: CampaignTransitionAuditRecord[] = [];
  approvals: HumanApprovalRecord[] = [];
  memberships: MembershipRecord[] = [];
  /** Legacy minimal fixtures — direct-pushed by campaign-transition-service.test.ts, read only through transition-facts.ts's narrow (version/acceptedAt-only) consumption. */
  briefs: CampaignBriefFactRow[] = [];
  concepts: CreativeConceptFactRow[] = [];
  scripts: ScriptFactRow[] = [];
  shots: ShotFactRow[] = [];
  /** Full rows written via the M4 repositories' `create*` functions (campaign-brief-repository.ts etc.) — kept separate from the legacy arrays above so neither set of tests has to know about the other's minimal/full shape. */
  strategies: StrategyRecord[] = [];
  campaignBriefRecords: CampaignBriefRecord[] = [];
  creativeConceptRecords: CreativeConceptRecord[] = [];
  scriptRecords: ScriptRecord[] = [];
  shotRecords: ShotRecord[] = [];
  shotSpecifications: (ShotSpecificationFactRow & Partial<ShotSpecificationRecord>)[] = [];
  shotGenerationJobs: ShotGenerationJobFactRow[] = [];
  generationCandidates: (GenerationCandidateFactRow & Partial<GenerationCandidateRecord>)[] = [];
  /** Full rows written via `createShotSpecification`/`getOrCreateShotGenerationJob`/`getOrCreateShotGenerationAttempt`/`createGenerationCandidate` (M6) — kept separate from the legacy minimal fixture arrays above for the same reason `campaignBriefRecords` is kept separate from `briefs`. */
  shotSpecificationRecords: ShotSpecificationRecord[] = [];
  shotGenerationJobRecords: ShotGenerationJobRecord[] = [];
  shotGenerationAttemptRecords: ShotGenerationAttemptRecord[] = [];
  generationCandidateRecords: GenerationCandidateRecord[] = [];
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
  assets: AssetRecord[] = [];
  assetProvenances: AssetProvenanceRecord[] = [];
  licenses: LicenseRecord[] = [];
  promptTemplates: PromptTemplateRecord[] = [];
  promptVersions: PromptVersionRecord[] = [];
  agentInvocations: AgentInvocationRecord[] = [];

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
        this.audits.find(
          (a) => a.campaignId === where.campaignId && a.idempotencyKey === where.idempotencyKey,
        ) ?? null
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
    findMany: async ({ where }) => {
      return this.approvals.filter(
        (a) => a.campaignId === where.campaignId && a.workspaceId === where.workspaceId,
      );
    },
  };

  membership: MembershipDataSource['membership'] = {
    findFirst: async ({ where }) =>
      this.memberships.find((m) => m.id === where.id && m.workspaceId === where.workspaceId) ??
      null,
    findMany: async ({ where }) =>
      this.memberships.filter((m) => m.workspaceId === where.workspaceId),
    create: async ({ data }) => {
      const membership: MembershipRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.memberships.push(membership);
      return membership;
    },
  };

  campaignBrief: TransitionFactsDataSource['campaignBrief'] &
    CampaignBriefDataSource['campaignBrief'] = {
    create: async ({ data }) => {
      const brief: CampaignBriefRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.campaignBriefRecords.push(brief);
      return brief;
    },
    findMany: async ({ where }) => [
      ...this.campaignBriefRecords.filter((b) => b.campaignId === where.campaignId),
      // Legacy fixtures only populate CampaignBriefFactRow's 4 fields and are only ever
      // read back through transition-facts.ts's narrow (version/acceptedAt-only)
      // consumption — this cast is safe in practice, never exercised by M4 code paths.
      ...(this.briefs.filter(
        (b) => b.campaignId === where.campaignId,
      ) as unknown as CampaignBriefRecord[]),
    ],
  };
  strategy: StrategyDataSource['strategy'] = {
    create: async ({ data }) => {
      const strategy: StrategyRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.strategies.push(strategy);
      return strategy;
    },
    findMany: async ({ where }) =>
      this.strategies.filter(
        (s) => s.campaignId === where.campaignId && s.workspaceId === where.workspaceId,
      ),
  };
  creativeConcept: TransitionFactsDataSource['creativeConcept'] &
    CreativeConceptDataSource['creativeConcept'] = {
    create: async ({ data }) => {
      const concept: CreativeConceptRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.creativeConceptRecords.push(concept);
      return concept;
    },
    findMany: async ({ where }) => [
      ...this.creativeConceptRecords.filter((c) => c.campaignId === where.campaignId),
      // Same rationale as campaignBrief.findMany above.
      ...(this.concepts.filter(
        (c) => c.campaignId === where.campaignId,
      ) as unknown as CreativeConceptRecord[]),
    ],
  };
  script: TransitionFactsDataSource['script'] & ScriptDataSource['script'] = {
    create: async ({ data }) => {
      const script: ScriptRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.scriptRecords.push(script);
      return script;
    },
    findMany: async ({ where }) => [
      ...this.scriptRecords.filter((s) => s.campaignId === where.campaignId),
      // Same rationale as campaignBrief.findMany above.
      ...(this.scripts.filter(
        (s) => s.campaignId === where.campaignId,
      ) as unknown as ScriptRecord[]),
    ],
  };
  shot: TransitionFactsDataSource['shot'] & ShotDataSource['shot'] = {
    create: async ({ data }) => {
      const now = new Date();
      const shot: ShotRecord = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
      this.shotRecords.push(shot);
      return shot;
    },
    findMany: async ({ where }) => [
      ...this.shotRecords.filter((s) => where.scriptId.in.includes(s.scriptId)),
      // Same rationale as campaignBrief.findMany above.
      ...(this.shots.filter((s) =>
        where.scriptId.in.includes(s.scriptId),
      ) as unknown as ShotRecord[]),
    ],
    update: async ({ where, data }) => {
      const shot = this.shotRecords.find((s) => s.id === where.id);
      if (!shot) throw new Error(`shot ${where.id} not found`);
      shot.dependsOnShotIds = data.dependsOnShotIds;
      shot.updatedAt = new Date();
      return shot;
    },
  };
  shotSpecification: TransitionFactsDataSource['shotSpecification'] &
    ShotSpecificationDataSource['shotSpecification'] = {
    findMany: async (args: {
      where: { shotId: { in: string[] } } | { shotId: string; workspaceId?: string };
    }) => {
      const { where } = args;
      if (typeof where.shotId === 'string') {
        const scoped = where as { shotId: string; workspaceId?: string };
        const { shotId, workspaceId } = scoped;
        return this.shotSpecificationRecords.filter(
          (s) =>
            s.shotId === shotId && (workspaceId === undefined || s.workspaceId === workspaceId),
        );
      }
      const shotIds = where.shotId.in;
      return [
        ...this.shotSpecificationRecords.filter((s) => shotIds.includes(s.shotId)),
        // Legacy fixtures only populate ShotSpecificationFactRow's 2 fields and are only ever
        // read back through transition-facts.ts's narrow (shotId-only) consumption —
        // this cast is safe in practice, never exercised by the real repository functions.
        ...(this.shotSpecifications.filter((s) =>
          shotIds.includes(s.shotId),
        ) as unknown as ShotSpecificationRecord[]),
      ];
    },
    create: async ({ data }) => {
      const record: ShotSpecificationRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.shotSpecificationRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) =>
      this.shotSpecificationRecords.find(
        (s) => s.id === where.id && s.workspaceId === where.workspaceId,
      ) ?? null,
  };
  shotGenerationJob: TransitionFactsDataSource['shotGenerationJob'] &
    ShotGenerationDataSource['shotGenerationJob'] = {
    findMany: async ({ where }) => [
      ...this.shotGenerationJobRecords.filter((j) =>
        where.shotSpecificationId.in.includes(j.shotSpecificationId),
      ),
      ...this.shotGenerationJobs.filter((j) =>
        where.shotSpecificationId.in.includes(j.shotSpecificationId),
      ),
    ],
    findFirst: async (args: {
      where:
        { shotSpecificationId: string; workspaceId?: string } | { id: string; workspaceId: string };
    }) => {
      const { where } = args;
      if ('id' in where) {
        return (
          this.shotGenerationJobRecords.find(
            (j) => j.id === where.id && j.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.shotGenerationJobRecords.find(
          (j) =>
            j.shotSpecificationId === where.shotSpecificationId &&
            (where.workspaceId === undefined || j.workspaceId === where.workspaceId),
        ) ?? null
      );
    },
    create: async ({ data }) => {
      const now = new Date();
      const record: ShotGenerationJobRecord = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.shotGenerationJobRecords.push(record);
      return record;
    },
    update: async ({ where, data }) => {
      const job = this.shotGenerationJobRecords.find((j) => j.id === where.id);
      if (!job) throw new Error(`shot generation job ${where.id} not found`);
      Object.assign(job, data);
      job.updatedAt = new Date();
      return job;
    },
  };
  shotGenerationAttempt: ShotGenerationDataSource['shotGenerationAttempt'] = {
    findFirst: async (args: {
      where:
        | { shotGenerationJobId: string; idempotencyKey: string }
        | { id: string; workspaceId: string };
    }) => {
      const { where } = args;
      if ('id' in where) {
        return (
          this.shotGenerationAttemptRecords.find(
            (a) => a.id === where.id && a.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.shotGenerationAttemptRecords.find(
          (a) =>
            a.shotGenerationJobId === where.shotGenerationJobId &&
            a.idempotencyKey === where.idempotencyKey,
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.shotGenerationAttemptRecords.filter(
        (a) => a.shotGenerationJobId === where.shotGenerationJobId,
      ),
    create: async ({ data }) => {
      const record: ShotGenerationAttemptRecord = {
        id: randomUUID(),
        createdAt: new Date(),
        ...data,
      };
      this.shotGenerationAttemptRecords.push(record);
      return record;
    },
    update: async ({ where, data }) => {
      const attempt = this.shotGenerationAttemptRecords.find((a) => a.id === where.id);
      if (!attempt) throw new Error(`shot generation attempt ${where.id} not found`);
      Object.assign(attempt, data);
      return attempt;
    },
  };
  generationCandidate: TransitionFactsDataSource['generationCandidate'] &
    ShotGenerationDataSource['generationCandidate'] = {
    findMany: async (args: {
      where: { shotSpecificationId: { in: string[] } } | { shotGenerationAttemptId: string };
    }) => {
      const { where } = args;
      if ('shotGenerationAttemptId' in where) {
        return this.generationCandidateRecords.filter(
          (c) => c.shotGenerationAttemptId === where.shotGenerationAttemptId,
        );
      }
      return [
        ...this.generationCandidateRecords.filter((c) =>
          where.shotSpecificationId.in.includes(c.shotSpecificationId),
        ),
        // Same legacy-fixture rationale as shotSpecification.findMany above.
        ...(this.generationCandidates.filter((c) =>
          where.shotSpecificationId.in.includes(c.shotSpecificationId),
        ) as unknown as GenerationCandidateRecord[]),
      ];
    },
    create: async ({ data }) => {
      const now = new Date();
      const record: GenerationCandidateRecord = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.generationCandidateRecords.push(record);
      return record;
    },
    update: async ({ where, data }) => {
      const candidate = this.generationCandidateRecords.find((c) => c.id === where.id);
      if (!candidate) throw new Error(`generation candidate ${where.id} not found`);
      Object.assign(candidate, data);
      candidate.updatedAt = new Date();
      return candidate;
    },
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

  asset: AssetDataSource['asset'] = {
    create: async ({ data }) => {
      const asset: AssetRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.assets.push(asset);
      return asset;
    },
    findFirst: async ({ where }) =>
      this.assets.find((a) => a.id === where.id && a.workspaceId === where.workspaceId) ?? null,
    findMany: async (args: {
      where:
        | { workspaceId: string; checksum: string; kind: AssetKind }
        | { workspaceId: string; campaignId: string; kind?: AssetKind };
    }) => {
      const { where } = args;
      if ('checksum' in where) {
        return this.assets.filter(
          (a) =>
            a.workspaceId === where.workspaceId &&
            a.checksum === where.checksum &&
            a.kind === where.kind,
        );
      }
      return this.assets.filter(
        (a) =>
          a.workspaceId === where.workspaceId &&
          a.campaignId === where.campaignId &&
          (where.kind === undefined || a.kind === where.kind),
      );
    },
    update: async ({ where, data }) => {
      const asset = this.assets.find((a) => a.id === where.id);
      if (!asset) throw new Error(`asset ${where.id} not found`);
      asset.ingestionStatus = data.ingestionStatus;
      asset.mediaMetadata = data.mediaMetadata;
      asset.inspectionFailureDetails = data.inspectionFailureDetails;
      return asset;
    },
  };
  assetProvenance: AssetDataSource['assetProvenance'] = {
    create: async ({ data }) => {
      const provenance: AssetProvenanceRecord = {
        id: randomUUID(),
        createdAt: new Date(),
        ...data,
      };
      this.assetProvenances.push(provenance);
      return provenance;
    },
    findFirst: async ({ where }) =>
      this.assetProvenances.find(
        (p) => p.assetId === where.assetId && p.workspaceId === where.workspaceId,
      ) ?? null,
  };
  licenseRecord: LicenseDataSource['licenseRecord'] = {
    create: async ({ data }) => {
      const license: LicenseRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.licenses.push(license);
      return license;
    },
    findFirst: async ({ where }) =>
      this.licenses.find(
        (l) => l.assetId === where.assetId && l.workspaceId === where.workspaceId,
      ) ?? null,
  };

  promptTemplate: PromptDataSource['promptTemplate'] = {
    create: async ({ data }) => {
      const template: PromptTemplateRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.promptTemplates.push(template);
      return template;
    },
    findFirst: async ({ where }) =>
      this.promptTemplates.find(
        (t) =>
          t.workspaceId === where.workspaceId &&
          t.agentKey === where.agentKey &&
          t.name === where.name,
      ) ?? null,
  };
  promptVersion: PromptDataSource['promptVersion'] = {
    create: async ({ data }) => {
      const version: PromptVersionRecord = {
        id: randomUUID(),
        isActive: false,
        createdAt: new Date(),
        ...data,
      };
      this.promptVersions.push(version);
      return version;
    },
    findMany: async ({ where }) =>
      this.promptVersions.filter((v) => v.promptTemplateId === where.promptTemplateId),
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
