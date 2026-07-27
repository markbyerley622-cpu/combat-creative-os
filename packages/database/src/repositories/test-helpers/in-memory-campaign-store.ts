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
import {
  createSerializedBudgetTransactionRunner,
  type BudgetTransactionRunner,
  type SerializableBudgetDataSource,
} from '../budget-transaction';
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
import type { UserDataSource, UserRecord } from '../user-repository';
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
  QualityAssessmentDataSource,
  QualityAssessmentRecord,
  QualityFailureRecord,
} from '../quality-assessment-repository';
import type {
  DeliveryProfileDataSource,
  DeliveryProfileRecord,
} from '../delivery-profile-repository';
import type {
  PerformanceDataSource,
  PerformanceObservationRecord,
} from '../performance-repository';
import type { LearningDataSource, LearningRecordRecord } from '../learning-repository';
import type {
  CreativeVariantRecord,
  VariantDataSource,
  VariantGenerationAttemptRecord,
  VariantGenerationJobRecord,
  VariantSpecificationRecord,
} from '../variant-repositories';
import type {
  ShotSelectionDataSource,
  ShotSelectionRecord,
  ShotSelectionReplacementRecord,
  ShotSelectionSetRecord,
} from '../shot-selection-repository';
import type {
  RoughEditSpecificationDataSource,
  RoughEditSpecificationRecord,
} from '../rough-edit-specification-repository';
import type {
  CompositionAttemptRecord,
  CompositionDataSource,
  CompositionJobRecord,
} from '../composition-repository';
import type { RenderJobDataSource, RenderJobRecord } from '../render-job-repository';
import type {
  EditDecisionEntryRecord,
  EditDecisionListDataSource,
  EditDecisionListRecord,
} from '../edit-decision-list-repository';
import type {
  TimelineDataSource,
  TimelineEntryRecord,
  TimelineRecord,
} from '../timeline-repository';
import type {
  SoundCueRecord,
  SoundDesignDataSource,
  SoundDesignPlanRecord,
} from '../sound-design-repository';
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
 *  - unique constraints throw, matching Postgres's behavior, so
 *    idempotency and duplicate-version tests exercise the real failure mode.
 *    Post-M14 audit finding H-1: this used to cover only three constraints
 *    (transition audits, ledger entries, assets), which meant a duplicate
 *    `(campaignId, version)` row or a double-inserted generation attempt
 *    passed the entire suite and would have failed on the first real
 *    database. Every `(campaignId, version)` family, every per-job
 *    idempotency-key constraint and the one-job-per-specification
 *    constraints are now mirrored — see `assertUnique`.
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
    SerializableBudgetDataSource,
    AssetDataSource,
    PromptDataSource,
    AgentInvocationDataSource,
    CampaignBriefDataSource,
    StrategyDataSource,
    CreativeConceptDataSource,
    ScriptDataSource,
    ShotDataSource,
    MembershipDataSource,
    UserDataSource,
    LicenseDataSource,
    ShotSpecificationDataSource,
    ShotGenerationDataSource,
    QualityAssessmentDataSource,
    ShotSelectionDataSource,
    RoughEditSpecificationDataSource,
    CompositionDataSource,
    RenderJobDataSource,
    EditDecisionListDataSource,
    TimelineDataSource,
    SoundDesignDataSource,
    DeliveryProfileDataSource,
    VariantDataSource,
    PerformanceDataSource,
    LearningDataSource
{
  campaigns: CampaignRecord[] = [];
  audits: CampaignTransitionAuditRecord[] = [];
  approvals: HumanApprovalRecord[] = [];
  memberships: MembershipRecord[] = [];
  users: UserRecord[] = [];
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
  /** Full rows written via `createQualityAssessmentForCandidate` (M7) — kept separate from the legacy minimal fixture arrays above for the same reason `shotSpecificationRecords` is kept separate from `shotSpecifications`. */
  qualityAssessmentRecords: QualityAssessmentRecord[] = [];
  qualityFailureRecords: QualityFailureRecord[] = [];
  /** M8 shot-selection aggregate rows. */
  shotSelectionSetRecords: ShotSelectionSetRecord[] = [];
  shotSelectionRecords: ShotSelectionRecord[] = [];
  shotSelectionReplacementRecords: ShotSelectionReplacementRecord[] = [];
  /** M9 compositing rows. */
  roughEditSpecificationRecords: RoughEditSpecificationRecord[] = [];
  compositionJobRecords: CompositionJobRecord[] = [];
  compositionAttemptRecords: CompositionAttemptRecord[] = [];
  deliveryProfileRecords: DeliveryProfileRecord[] = [];
  variantSpecificationRecords: VariantSpecificationRecord[] = [];
  variantGenerationJobRecords: VariantGenerationJobRecord[] = [];
  variantGenerationAttemptRecords: VariantGenerationAttemptRecord[] = [];
  creativeVariantRecords: CreativeVariantRecord[] = [];
  performanceObservationRecords: PerformanceObservationRecord[] = [];
  learningRecordRecords: LearningRecordRecord[] = [];
  renderJobRecords: RenderJobRecord[] = [];
  editDecisionListRecords: EditDecisionListRecord[] = [];
  editDecisionEntryRecords: EditDecisionEntryRecord[] = [];
  /** M10 sound-design rows. */
  timelineRecords: TimelineRecord[] = [];
  timelineEntryRecords: TimelineEntryRecord[] = [];
  soundDesignPlanRecords: SoundDesignPlanRecord[] = [];
  soundCueRecords: SoundCueRecord[] = [];
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

  /**
   * Throws the same way Postgres does when an insert would violate a unique
   * index. Post-M14 audit finding H-1: this fake previously enforced only
   * three of the schema's unique constraints, so an idempotency bug or a
   * duplicate version could pass the whole suite and fail on the first real
   * database. `table` and `columns` are the schema's own names, so a failure
   * message points straight at the constraint it mirrors.
   */
  private assertUnique<TRow>(
    table: string,
    columns: string,
    rows: readonly TRow[],
    conflicts: (row: TRow) => boolean,
  ): void {
    if (rows.some(conflicts)) {
      throw new Error(`unique constraint violation on ${table} (${columns})`);
    }
  }

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
      if (data.idempotencyKey !== undefined) {
        this.assertUnique(
          'campaigns',
          'workspaceId, idempotencyKey',
          this.campaigns,
          (c) => c.workspaceId === data.workspaceId && c.idempotencyKey === data.idempotencyKey,
        );
      }
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

  /**
   * Registers a local user already bound to a verified external subject — the
   * state every sign-in after the first one sees. Tests use this to assert that
   * a subject resolves to *the* seeded `User.id` their `Membership` rows point
   * at, rather than to a freshly provisioned one.
   */
  seedUser(overrides: Partial<UserRecord> = {}): UserRecord {
    const now = new Date();
    const id = overrides.id ?? randomUUID();
    const user: UserRecord = {
      id,
      email: `${id}@example.test`,
      displayName: 'Test User',
      clerkUserId: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.assertUnique('users', 'email', this.users, (u) => u.email === user.email);
    if (user.clerkUserId !== null) {
      this.assertUnique(
        'users',
        'clerkUserId',
        this.users,
        (u) => u.clerkUserId === user.clerkUserId,
      );
    }
    this.users.push(user);
    return user;
  }

  user: UserDataSource['user'] = {
    findFirst: async ({ where }) =>
      this.users.find((u) =>
        'clerkUserId' in where
          ? u.clerkUserId !== null && u.clerkUserId === where.clerkUserId
          : u.email === where.email,
      ) ?? null,
    create: async ({ data }) => {
      // Mirrors both of the `users` table's unique indexes — the email one that
      // has always existed, and `users_clerkUserId_key` added by
      // 20260726062308_add_user_clerk_subject. Without the second, a
      // first-login provisioning race would pass here and duplicate on Postgres.
      this.assertUnique('users', 'email', this.users, (u) => u.email === data.email);
      this.assertUnique(
        'users',
        'clerkUserId',
        this.users,
        (u) => u.clerkUserId === data.clerkUserId,
      );
      const now = new Date();
      const user: UserRecord = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
      this.users.push(user);
      return user;
    },
    update: async ({ where, data }) => {
      const user = this.users.find((u) => u.id === where.id);
      if (!user) throw new Error(`user ${where.id} not found`);
      this.assertUnique(
        'users',
        'clerkUserId',
        this.users,
        (u) => u.id !== where.id && u.clerkUserId === data.clerkUserId,
      );
      user.clerkUserId = data.clerkUserId;
      user.updatedAt = new Date();
      return user;
    },
  };

  membership: MembershipDataSource['membership'] = {
    findFirst: async ({ where }) =>
      this.memberships.find((m) => m.id === where.id && m.workspaceId === where.workspaceId) ??
      null,
    findMany: async ({ where }) =>
      this.memberships.filter((m) =>
        'workspaceId' in where ? m.workspaceId === where.workspaceId : m.userId === where.userId,
      ),
    create: async ({ data }) => {
      const membership: MembershipRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.memberships.push(membership);
      return membership;
    },
  };

  campaignBrief: TransitionFactsDataSource['campaignBrief'] &
    CampaignBriefDataSource['campaignBrief'] = {
    create: async ({ data }) => {
      this.assertUnique(
        'campaign_briefs',
        'campaignId, version',
        this.campaignBriefRecords,
        (row) => row.campaignId === data.campaignId && row.version === data.version,
      );
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
      this.assertUnique(
        'strategies',
        'campaignId, version',
        this.strategies,
        (row) => row.campaignId === data.campaignId && row.version === data.version,
      );
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
      this.assertUnique(
        'creative_concepts',
        'campaignId, version',
        this.creativeConceptRecords,
        (row) => row.campaignId === data.campaignId && row.version === data.version,
      );
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
      this.assertUnique(
        'scripts',
        'campaignId, version',
        this.scriptRecords,
        (row) => row.campaignId === data.campaignId && row.version === data.version,
      );
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
      this.assertUnique(
        'shot_specifications',
        'shotId, version',
        this.shotSpecificationRecords,
        (row) => row.shotId === data.shotId && row.version === data.version,
      );
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
      this.assertUnique(
        'shot_generation_jobs',
        'shotSpecificationId',
        this.shotGenerationJobRecords,
        (row) => row.shotSpecificationId === data.shotSpecificationId,
      );
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
      this.assertUnique(
        'shot_generation_attempts',
        'shotGenerationJobId, idempotencyKey',
        this.shotGenerationAttemptRecords,
        (row) =>
          row.shotGenerationJobId === data.shotGenerationJobId &&
          row.idempotencyKey === data.idempotencyKey,
      );
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
      this.assertUnique(
        'generation_candidates',
        'shotGenerationAttemptId, candidateIndex',
        this.generationCandidateRecords,
        (row) =>
          row.shotGenerationAttemptId === data.shotGenerationAttemptId &&
          row.candidateIndex === data.candidateIndex,
      );
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
  // Cast to `unknown` then the target intersection at the end, rather than
  // annotating the object literal with the intersection type directly: the
  // two source interfaces' `findMany` overloads have structurally
  // incompatible return element shapes (`QualityAssessmentFactRow`'s
  // `string | null` fields vs `QualityAssessmentRecord`'s `string |
  // undefined` optional fields), which TS cannot reconcile as one
  // assignable function type even though every branch below is runtime-
  // correct for its own call shape.
  qualityAssessment = {
    findMany: async (args: {
      where:
        | { OR: [{ generationCandidateId: { in: string[] } }, { assetId: { not: null } }] }
        | { generationCandidateId: { in: string[] }; workspaceId: string };
    }) => {
      const { where } = args;
      if ('OR' in where) {
        const [candidateFilter] = where.OR;
        const candidateIds = new Set(candidateFilter.generationCandidateId.in);
        return [
          ...this.qualityAssessments.filter(
            (qa) =>
              (qa.generationCandidateId != null && candidateIds.has(qa.generationCandidateId)) ||
              qa.assetId != null,
          ),
          // Records written via createQualityAssessmentForCandidate (M7) must
          // also feed transition-facts.ts's fact computation — same
          // legacy-plus-full-record merge rationale as shotSpecification/
          // generationCandidate above.
          ...this.qualityAssessmentRecords.filter(
            (qa) =>
              (qa.generationCandidateId != null && candidateIds.has(qa.generationCandidateId)) ||
              qa.assetId != null,
          ),
        ];
      }
      const candidateIds = where.generationCandidateId.in;
      return this.qualityAssessmentRecords.filter(
        (qa) =>
          qa.generationCandidateId != null &&
          candidateIds.includes(qa.generationCandidateId) &&
          qa.workspaceId === where.workspaceId,
      );
    },
    findFirst: async ({
      where,
    }: {
      where:
        | { generationCandidateId: string; subjectStage: CampaignStage; workspaceId: string }
        | { assetId: string; subjectStage: CampaignStage; workspaceId: string };
    }) =>
      this.qualityAssessmentRecords.find((qa) =>
        'assetId' in where
          ? qa.assetId === where.assetId &&
            qa.subjectStage === where.subjectStage &&
            qa.workspaceId === where.workspaceId
          : qa.generationCandidateId === where.generationCandidateId &&
            qa.subjectStage === where.subjectStage &&
            qa.workspaceId === where.workspaceId,
      ) ?? null,
    create: async ({ data }: { data: Omit<QualityAssessmentRecord, 'id' | 'createdAt'> }) => {
      const record: QualityAssessmentRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.qualityAssessmentRecords.push(record);
      return record;
    },
  } as unknown as TransitionFactsDataSource['qualityAssessment'] &
    QualityAssessmentDataSource['qualityAssessment'];

  qualityFailure = {
    findMany: async (args: {
      where: { qualityAssessmentId: { in: string[] } } | { qualityAssessmentId: string };
    }) => {
      const { where } = args;
      if (typeof where.qualityAssessmentId === 'string') {
        const id = where.qualityAssessmentId;
        return [
          ...this.qualityFailures.filter((f) => f.qualityAssessmentId === id),
          ...this.qualityFailureRecords.filter((f) => f.qualityAssessmentId === id),
        ];
      }
      // Capture the narrowed `in` list in a const before the closures — TS
      // drops the control-flow narrowing of `where.qualityAssessmentId` inside
      // a nested closure (it could in principle be reassigned).
      const inList = where.qualityAssessmentId.in;
      return [
        ...this.qualityFailures.filter((f) => inList.includes(f.qualityAssessmentId)),
        ...this.qualityFailureRecords.filter((f) => inList.includes(f.qualityAssessmentId)),
      ];
    },
    create: async ({ data }: { data: Omit<QualityFailureRecord, 'id' | 'createdAt'> }) => {
      const record: QualityFailureRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.qualityFailureRecords.push(record);
      return record;
    },
  } as unknown as TransitionFactsDataSource['qualityFailure'] &
    QualityAssessmentDataSource['qualityFailure'];

  shotSelectionSet: ShotSelectionDataSource['shotSelectionSet'] = {
    create: async ({ data }) => {
      const now = new Date();
      this.assertUnique(
        'shot_selection_sets',
        'campaignId, version',
        this.shotSelectionSetRecords,
        (row) => row.campaignId === data.campaignId && row.version === data.version,
      );
      const record: ShotSelectionSetRecord = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.shotSelectionSetRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.shotSelectionSetRecords.find(
            (s) => s.id === where.id && s.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.shotSelectionSetRecords.find(
          (s) =>
            s.campaignId === where.campaignId &&
            s.version === where.version &&
            s.workspaceId === where.workspaceId,
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.shotSelectionSetRecords.filter(
        (s) => s.campaignId === where.campaignId && s.workspaceId === where.workspaceId,
      ),
    updateMany: async ({ where, data }) => {
      // Compare-and-swap: only the row matching id + workspace + revision +
      // DRAFT status is mutated, reproducing the optimistic-concurrency guard a
      // real `updateMany` gives us.
      const match = this.shotSelectionSetRecords.find(
        (s) =>
          s.id === where.id &&
          s.workspaceId === where.workspaceId &&
          s.revision === where.revision &&
          s.status === where.status,
      );
      if (!match) return { count: 0 };
      if (data.status !== undefined) match.status = data.status;
      if (data.reviewerUserId !== undefined) match.reviewerUserId = data.reviewerUserId;
      if (data.rationale !== undefined) match.rationale = data.rationale;
      if (data.approvedAt !== undefined) match.approvedAt = data.approvedAt;
      match.revision += data.revision.increment;
      match.updatedAt = new Date();
      return { count: 1 };
    },
  };

  shotSelection: ShotSelectionDataSource['shotSelection'] = {
    create: async ({ data }) => {
      const now = new Date();
      const record: ShotSelectionRecord = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.shotSelectionRecords.push(record);
      return record;
    },
    findMany: async ({ where }) =>
      this.shotSelectionRecords.filter((s) => s.shotSelectionSetId === where.shotSelectionSetId),
    updateMany: async ({ where, data }) => {
      const matches = this.shotSelectionRecords.filter(
        (s) => s.shotSelectionSetId === where.shotSelectionSetId && s.shotId === where.shotId,
      );
      for (const match of matches) {
        if (data.status !== undefined) match.status = data.status;
        // `selectedCandidateId` is nullable — `undefined` in the data means
        // "clear it" (a rejected shot), so it's assigned unconditionally when
        // the key is present rather than guarded by a `!== undefined` check.
        if ('selectedCandidateId' in data) match.selectedCandidateId = data.selectedCandidateId;
        if ('visualQaAssessmentId' in data) match.visualQaAssessmentId = data.visualQaAssessmentId;
        if ('continuityQaAssessmentId' in data)
          match.continuityQaAssessmentId = data.continuityQaAssessmentId;
        if ('rationale' in data) match.rationale = data.rationale;
        if ('regenerationFeedback' in data) match.regenerationFeedback = data.regenerationFeedback;
        match.updatedAt = new Date();
      }
      return { count: matches.length };
    },
  };

  shotSelectionReplacement: ShotSelectionDataSource['shotSelectionReplacement'] = {
    create: async ({ data }) => {
      const record: ShotSelectionReplacementRecord = {
        id: randomUUID(),
        createdAt: new Date(),
        ...data,
      };
      this.shotSelectionReplacementRecords.push(record);
      return record;
    },
    findMany: async ({ where }) =>
      this.shotSelectionReplacementRecords.filter(
        (r) => r.shotSelectionSetId === where.shotSelectionSetId,
      ),
  };

  // Merges the legacy fact-row fixtures with M9 full records (same rationale as
  // qualityAssessment/generationCandidate above), and satisfies both the
  // transition-facts read shape and the M9 RenderJobDataSource.
  renderJob = {
    findMany: async (args: { where: { campaignId: string; workspaceId?: string } }) => {
      const { campaignId, workspaceId } = args.where;
      return [
        ...this.renderJobs,
        ...this.renderJobRecords.filter(
          (r) =>
            r.campaignId === campaignId &&
            (workspaceId === undefined || r.workspaceId === workspaceId),
        ),
      ];
    },
    findFirst: async (args: { where: { id: string; workspaceId: string } }) =>
      this.renderJobRecords.find(
        (r) => r.id === args.where.id && r.workspaceId === args.where.workspaceId,
      ) ?? null,
    create: async ({ data }: { data: Omit<RenderJobRecord, 'id' | 'createdAt'> }) => {
      const record: RenderJobRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.renderJobRecords.push(record);
      return record;
    },
  } as unknown as TransitionFactsDataSource['renderJob'] & RenderJobDataSource['renderJob'];

  editDecisionList = {
    findMany: async (args?: { where?: { campaignId?: string; workspaceId?: string } }) => {
      const campaignId = args?.where?.campaignId;
      const records = campaignId
        ? this.editDecisionListRecords.filter((e) => e.campaignId === campaignId)
        : this.editDecisionListRecords;
      return [...this.editDecisionLists, ...records];
    },
    findFirst: async (args: {
      where:
        | { id: string; workspaceId: string }
        | { campaignId: string; version: number; workspaceId: string };
    }) => {
      const { where } = args;
      if ('id' in where) {
        return (
          this.editDecisionListRecords.find(
            (e) => e.id === where.id && e.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.editDecisionListRecords.find(
          (e) =>
            e.campaignId === where.campaignId &&
            e.version === where.version &&
            e.workspaceId === where.workspaceId,
        ) ?? null
      );
    },
    create: async ({ data }: { data: Omit<EditDecisionListRecord, 'id' | 'createdAt'> }) => {
      this.assertUnique(
        'edit_decision_lists',
        'campaignId, version',
        this.editDecisionListRecords,
        (row) => row.campaignId === data.campaignId && row.version === data.version,
      );
      const record: EditDecisionListRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.editDecisionListRecords.push(record);
      return record;
    },
  } as unknown as TransitionFactsDataSource['editDecisionList'] &
    EditDecisionListDataSource['editDecisionList'];

  editDecisionEntry: EditDecisionListDataSource['editDecisionEntry'] = {
    create: async ({ data }) => {
      const record: EditDecisionEntryRecord = { id: randomUUID(), ...data };
      this.editDecisionEntryRecords.push(record);
      return record;
    },
    findMany: async ({ where }) =>
      this.editDecisionEntryRecords.filter(
        (e) => e.editDecisionListId === where.editDecisionListId,
      ),
  };

  roughEditSpecification: RoughEditSpecificationDataSource['roughEditSpecification'] = {
    create: async ({ data }) => {
      this.assertUnique(
        'rough_edit_specifications',
        'campaignId, version',
        this.roughEditSpecificationRecords,
        (row) => row.campaignId === data.campaignId && row.version === data.version,
      );
      const record: RoughEditSpecificationRecord = {
        id: randomUUID(),
        createdAt: new Date(),
        ...data,
      };
      this.roughEditSpecificationRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.roughEditSpecificationRecords.find(
            (r) => r.id === where.id && r.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.roughEditSpecificationRecords.find(
          (r) =>
            r.campaignId === where.campaignId &&
            r.version === where.version &&
            r.workspaceId === where.workspaceId,
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.roughEditSpecificationRecords.filter(
        (r) => r.campaignId === where.campaignId && r.workspaceId === where.workspaceId,
      ),
  };

  compositionJob: CompositionDataSource['compositionJob'] = {
    create: async ({ data }) => {
      const now = new Date();
      this.assertUnique(
        'composition_jobs',
        'roughEditSpecificationId',
        this.compositionJobRecords,
        (row) => row.roughEditSpecificationId === data.roughEditSpecificationId,
      );
      const record: CompositionJobRecord = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.compositionJobRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.compositionJobRecords.find(
            (j) => j.id === where.id && j.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.compositionJobRecords.find(
          (j) =>
            j.roughEditSpecificationId === where.roughEditSpecificationId &&
            (where.workspaceId === undefined || j.workspaceId === where.workspaceId),
        ) ?? null
      );
    },
    update: async ({ where, data }) => {
      const job = this.compositionJobRecords.find((j) => j.id === where.id);
      if (!job) throw new Error(`composition job ${where.id} not found`);
      Object.assign(job, data);
      job.updatedAt = new Date();
      return job;
    },
  };

  compositionAttempt: CompositionDataSource['compositionAttempt'] = {
    create: async ({ data }) => {
      this.assertUnique(
        'composition_attempts',
        'compositionJobId, idempotencyKey',
        this.compositionAttemptRecords,
        (row) =>
          row.compositionJobId === data.compositionJobId &&
          row.idempotencyKey === data.idempotencyKey,
      );
      const record: CompositionAttemptRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.compositionAttemptRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.compositionAttemptRecords.find(
            (a) => a.id === where.id && a.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.compositionAttemptRecords.find(
          (a) =>
            a.compositionJobId === where.compositionJobId &&
            a.idempotencyKey === where.idempotencyKey,
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.compositionAttemptRecords.filter((a) => a.compositionJobId === where.compositionJobId),
    update: async ({ where, data }) => {
      const attempt = this.compositionAttemptRecords.find((a) => a.id === where.id);
      if (!attempt) throw new Error(`composition attempt ${where.id} not found`);
      Object.assign(attempt, data);
      return attempt;
    },
  };
  deliverySpecification: TransitionFactsDataSource['deliverySpecification'] = {
    findMany: async () => this.deliverySpecifications,
  };
  /**
   * Merges the legacy fact-row fixtures with M12 full records, satisfying both
   * the transition-facts read shape (`variantsGenerated`/`variantQAPassed`/
   * `variantQAFailed`) and the M12 `VariantDataSource` — same rationale as
   * renderJob/editDecisionList/timeline above.
   */
  creativeVariant: TransitionFactsDataSource['creativeVariant'] &
    VariantDataSource['creativeVariant'] = {
    create: async ({ data }) => {
      const record: CreativeVariantRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.creativeVariantRecords.push(record);
      return record;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      if ('id' in where) {
        return (
          this.creativeVariantRecords.find(
            (v) => v.id === where.id && v.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.creativeVariantRecords.find(
          (v) =>
            v.variantSpecificationId === where.variantSpecificationId &&
            (where.workspaceId === undefined || v.workspaceId === where.workspaceId),
        ) ?? null
      );
    },
    findMany: (async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (where && 'workspaceId' in where) {
        return this.creativeVariantRecords.filter(
          (v) =>
            v.workspaceId === where.workspaceId &&
            (where.campaignId === undefined || v.campaignId === where.campaignId),
        );
      }
      // Fact-row read: legacy fixtures plus every persisted M12 variant.
      return [
        ...this.creativeVariants,
        ...this.creativeVariantRecords.map((v) => ({
          id: v.id,
          assetId: v.assetId ?? null,
          status: v.status as string,
        })),
      ];
    }) as never,
    update: async ({ where, data }) => {
      const variant = this.creativeVariantRecords.find((v) => v.id === where.id);
      if (!variant) throw new Error(`creative variant ${where.id} not found`);
      Object.assign(variant, data);
      return variant;
    },
  };

  performanceObservation: PerformanceDataSource['performanceObservation'] = {
    create: async ({ data }) => {
      this.assertUnique(
        'performance_observations',
        'workspaceId, idempotencyKey',
        this.performanceObservationRecords,
        (row) => row.workspaceId === data.workspaceId && row.idempotencyKey === data.idempotencyKey,
      );
      const record: PerformanceObservationRecord = {
        id: randomUUID(),
        createdAt: new Date(),
        ...data,
      };
      this.performanceObservationRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.performanceObservationRecords.find(
            (o) => o.id === where.id && o.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.performanceObservationRecords.find(
          (o) => o.idempotencyKey === where.idempotencyKey && o.workspaceId === where.workspaceId,
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.performanceObservationRecords.filter(
        (o) =>
          o.workspaceId === where.workspaceId &&
          (where.campaignId === undefined || o.subject.campaignId === where.campaignId) &&
          (where.creativeVariantId === undefined ||
            o.subject.creativeVariantId === where.creativeVariantId),
      ),
  };

  learningRecord: LearningDataSource['learningRecord'] = {
    create: async ({ data }) => {
      this.assertUnique(
        'learning_records',
        'workspaceId, learningKey, version',
        this.learningRecordRecords,
        (row) =>
          row.workspaceId === data.workspaceId &&
          row.learningKey === data.learningKey &&
          row.version === data.version,
      );
      const record: LearningRecordRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.learningRecordRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) =>
      this.learningRecordRecords.find(
        (l) => l.id === where.id && l.workspaceId === where.workspaceId,
      ) ?? null,
    findMany: async ({ where }) =>
      this.learningRecordRecords.filter(
        (l) =>
          l.workspaceId === where.workspaceId &&
          (where.learningKey === undefined || l.learningKey === where.learningKey) &&
          (where.sourceCampaignId === undefined || l.sourceCampaignId === where.sourceCampaignId),
      ),
    update: async ({ where, data }) => {
      const record = this.learningRecordRecords.find((l) => l.id === where.id);
      if (!record) throw new Error(`learning record ${where.id} not found`);
      Object.assign(record, data);
      return record;
    },
  };

  deliveryProfile: DeliveryProfileDataSource['deliveryProfile'] = {
    create: async ({ data }) => {
      this.assertUnique(
        'delivery_profiles',
        'workspaceId, key, version',
        this.deliveryProfileRecords,
        (row) =>
          row.workspaceId === data.workspaceId &&
          row.key === data.key &&
          row.version === data.version,
      );
      const record: DeliveryProfileRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.deliveryProfileRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.deliveryProfileRecords.find(
            (p) => p.id === where.id && p.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.deliveryProfileRecords.find(
          (p) =>
            p.key === where.key &&
            p.version === where.version &&
            p.workspaceId === where.workspaceId,
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.deliveryProfileRecords.filter(
        (p) =>
          p.workspaceId === where.workspaceId && (where.key === undefined || p.key === where.key),
      ),
  };

  variantSpecification: VariantDataSource['variantSpecification'] = {
    create: async ({ data }) => {
      this.assertUnique(
        'variant_specifications',
        'campaignId, parentMasterAssetId, targetDurationSeconds, version',
        this.variantSpecificationRecords,
        (row) =>
          row.campaignId === data.campaignId &&
          row.parentMasterAssetId === data.parentMasterAssetId &&
          row.targetDurationSeconds === data.targetDurationSeconds &&
          row.version === data.version,
      );
      const record: VariantSpecificationRecord = {
        id: randomUUID(),
        createdAt: new Date(),
        ...data,
      };
      this.variantSpecificationRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) =>
      this.variantSpecificationRecords.find(
        (v) => v.id === where.id && v.workspaceId === where.workspaceId,
      ) ?? null,
    findMany: async ({ where }) =>
      this.variantSpecificationRecords.filter(
        (v) =>
          v.workspaceId === where.workspaceId &&
          (where.campaignId === undefined || v.campaignId === where.campaignId) &&
          (where.parentMasterAssetId === undefined ||
            v.parentMasterAssetId === where.parentMasterAssetId),
      ),
    update: async ({ where, data }) => {
      const spec = this.variantSpecificationRecords.find((v) => v.id === where.id);
      if (!spec) throw new Error(`variant specification ${where.id} not found`);
      Object.assign(spec, data);
      return spec;
    },
  };

  variantGenerationJob: VariantDataSource['variantGenerationJob'] = {
    create: async ({ data }) => {
      const now = new Date();
      this.assertUnique(
        'variant_generation_jobs',
        'variantSpecificationId',
        this.variantGenerationJobRecords,
        (row) => row.variantSpecificationId === data.variantSpecificationId,
      );
      const record: VariantGenerationJobRecord = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.variantGenerationJobRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.variantGenerationJobRecords.find(
            (j) => j.id === where.id && j.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.variantGenerationJobRecords.find(
          (j) =>
            j.variantSpecificationId === where.variantSpecificationId &&
            (where.workspaceId === undefined || j.workspaceId === where.workspaceId),
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.variantGenerationJobRecords.filter(
        (j) =>
          j.workspaceId === where.workspaceId &&
          (where.campaignId === undefined || j.campaignId === where.campaignId),
      ),
    update: async ({ where, data }) => {
      const job = this.variantGenerationJobRecords.find((j) => j.id === where.id);
      if (!job) throw new Error(`variant generation job ${where.id} not found`);
      Object.assign(job, data);
      job.updatedAt = new Date();
      return job;
    },
  };

  variantGenerationAttempt: VariantDataSource['variantGenerationAttempt'] = {
    create: async ({ data }) => {
      this.assertUnique(
        'variant_generation_attempts',
        'variantGenerationJobId, idempotencyKey',
        this.variantGenerationAttemptRecords,
        (row) =>
          row.variantGenerationJobId === data.variantGenerationJobId &&
          row.idempotencyKey === data.idempotencyKey,
      );
      const record: VariantGenerationAttemptRecord = {
        id: randomUUID(),
        createdAt: new Date(),
        ...data,
      };
      this.variantGenerationAttemptRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.variantGenerationAttemptRecords.find(
            (a) => a.id === where.id && a.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.variantGenerationAttemptRecords.find(
          (a) =>
            a.variantGenerationJobId === where.variantGenerationJobId &&
            a.idempotencyKey === where.idempotencyKey,
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.variantGenerationAttemptRecords.filter(
        (a) => a.variantGenerationJobId === where.variantGenerationJobId,
      ),
    update: async ({ where, data }) => {
      const attempt = this.variantGenerationAttemptRecords.find((a) => a.id === where.id);
      if (!attempt) throw new Error(`variant generation attempt ${where.id} not found`);
      Object.assign(attempt, data);
      return attempt;
    },
  };
  // Merges the legacy fact-row fixtures with M10 full records (same rationale
  // as renderJob/editDecisionList above), satisfying both the transition-facts
  // read shape and the M10 TimelineDataSource.
  timeline = {
    findMany: async (args: { where: { campaignId: string; workspaceId?: string } }) => {
      const { campaignId, workspaceId } = args.where;
      return [
        ...this.timelines.filter((t) => t.campaignId === campaignId),
        ...this.timelineRecords.filter(
          (t) =>
            t.campaignId === campaignId &&
            (workspaceId === undefined || t.workspaceId === workspaceId),
        ),
      ];
    },
    findFirst: async (args: {
      where:
        | { id: string; workspaceId: string }
        | { campaignId: string; version: number; workspaceId: string };
    }) => {
      const { where } = args;
      if ('id' in where) {
        return (
          this.timelineRecords.find(
            (t) => t.id === where.id && t.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.timelineRecords.find(
          (t) =>
            t.campaignId === where.campaignId &&
            t.version === where.version &&
            t.workspaceId === where.workspaceId,
        ) ?? null
      );
    },
    create: async ({ data }: { data: Omit<TimelineRecord, 'id' | 'createdAt'> }) => {
      this.assertUnique(
        'timelines',
        'campaignId, version',
        this.timelineRecords,
        (row) => row.campaignId === data.campaignId && row.version === data.version,
      );
      const record: TimelineRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.timelineRecords.push(record);
      return record;
    },
  } as unknown as TransitionFactsDataSource['timeline'] & TimelineDataSource['timeline'];

  timelineEntry: TimelineDataSource['timelineEntry'] = {
    create: async ({ data }) => {
      const record: TimelineEntryRecord = { id: randomUUID(), ...data };
      this.timelineEntryRecords.push(record);
      return record;
    },
    findMany: async ({ where }) =>
      this.timelineEntryRecords.filter((e) => e.timelineId === where.timelineId),
  };

  soundCue = {
    findMany: async (args: {
      where: { timelineId: string } | { timelineId: { in: string[] } };
    }) => {
      const { where } = args;
      if (typeof where.timelineId === 'string') {
        const id = where.timelineId;
        return [
          ...this.soundCues.filter((s) => s.timelineId === id),
          ...this.soundCueRecords.filter((s) => s.timelineId === id),
        ];
      }
      const ids = where.timelineId.in;
      return [
        ...this.soundCues.filter((s) => ids.includes(s.timelineId)),
        ...this.soundCueRecords.filter((s) => ids.includes(s.timelineId)),
      ];
    },
    create: async ({ data }: { data: Omit<SoundCueRecord, 'id' | 'createdAt'> }) => {
      const record: SoundCueRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.soundCueRecords.push(record);
      return record;
    },
  } as unknown as TransitionFactsDataSource['soundCue'] & SoundDesignDataSource['soundCue'];

  soundDesignPlan: SoundDesignDataSource['soundDesignPlan'] = {
    create: async ({ data }) => {
      this.assertUnique(
        'sound_design_plans',
        'campaignId, version',
        this.soundDesignPlanRecords,
        (row) => row.campaignId === data.campaignId && row.version === data.version,
      );
      const record: SoundDesignPlanRecord = { id: randomUUID(), createdAt: new Date(), ...data };
      this.soundDesignPlanRecords.push(record);
      return record;
    },
    findFirst: async ({ where }) => {
      if ('id' in where) {
        return (
          this.soundDesignPlanRecords.find(
            (p) => p.id === where.id && p.workspaceId === where.workspaceId,
          ) ?? null
        );
      }
      return (
        this.soundDesignPlanRecords.find(
          (p) =>
            p.campaignId === where.campaignId &&
            p.version === where.version &&
            p.workspaceId === where.workspaceId,
        ) ?? null
      );
    },
    findMany: async ({ where }) =>
      this.soundDesignPlanRecords.filter(
        (p) =>
          p.campaignId === where.campaignId &&
          (where.workspaceId === undefined || p.workspaceId === where.workspaceId),
      ),
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

  /**
   * The in-process stand-in for a `SERIALIZABLE` transaction. Strictly
   * serializes reservation bodies and undoes a failed one — see
   * `createSerializedBudgetTransactionRunner`. A pass here says nothing about
   * PostgreSQL concurrency; that is proven only by
   * `budget-postgres-concurrency.test.ts` against a live database.
   */
  budgetTransaction: BudgetTransactionRunner = createSerializedBudgetTransactionRunner({
    dataSource: this,
    snapshot: () => [...this.budgetLedgerEntries],
    restore: (rows) => {
      this.budgetLedgerEntries.length = 0;
      this.budgetLedgerEntries.push(...rows);
    },
  });

  asset: AssetDataSource['asset'] = {
    create: async ({ data }) => {
      // M14: mirrors the schema's `@@unique([workspaceId, checksum, kind])`.
      // Without it a test could pass here while the same code threw against
      // Postgres, hiding a missing `findAssetByChecksum` dedup in an Activity.
      const exists = this.assets.some(
        (a) =>
          a.workspaceId === data.workspaceId &&
          a.checksum === data.checksum &&
          a.kind === data.kind,
      );
      if (exists) {
        throw new Error('unique constraint violation on assets (workspaceId, checksum, kind)');
      }
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
