import type {
  LearningApplicability,
  LearningConfidence,
  LearningContextItem,
  LearningEvidence,
  LearningRecord,
  LearningScope,
  LearningStatus,
} from '@combat/domain';
import { selectLearningContext, type LearningContextRequest } from '@combat/domain';

export type LearningRecordRecord = LearningRecord;

/**
 * M13 persistence for distilled creative learnings. Every function takes
 * `workspaceId` first and folds it into the query — a learning from one
 * workspace can never surface in another's agent context, which is the whole
 * point of scoping a cross-campaign knowledge store.
 *
 * Records are immutable + versioned: `createLearningRecord` writes a new
 * version and supersedes the prior live one for the same `learningKey`. The
 * only mutation is the review transition (`PROPOSED -> APPROVED | REJECTED`),
 * because a human decision has to be recordable somewhere.
 */
export interface LearningDataSource {
  learningRecord: {
    create(args: {
      data: Omit<LearningRecordRecord, 'id' | 'createdAt'>;
    }): Promise<LearningRecordRecord>;
    findFirst(args: {
      where: { id: string; workspaceId: string };
    }): Promise<LearningRecordRecord | null>;
    findMany(args: {
      where: { workspaceId: string; learningKey?: string; sourceCampaignId?: string };
    }): Promise<LearningRecordRecord[]>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<LearningRecordRecord, 'status' | 'reviewedByUserId' | 'reviewedAt' | 'supersededAt'>
      >;
    }): Promise<LearningRecordRecord>;
  };
}

/** Thrown when a caller tries to persist an insight with no evidence behind it. */
export class LearningWithoutEvidenceError extends Error {
  constructor(learningKey: string) {
    super(`learning ${learningKey} has no evidence — an unsupported insight is not persistable`);
    this.name = 'LearningWithoutEvidenceError';
  }
}

export interface CreateLearningRecordInput {
  readonly learningKey: string;
  readonly insight: string;
  readonly scope: LearningScope;
  readonly applicability: LearningApplicability;
  /** Derived by `deriveLearningConfidence` from `evidence` — never asserted by the agent. */
  readonly confidence: LearningConfidence;
  readonly evidence: readonly LearningEvidence[];
  readonly totalImpressions: number;
  readonly sourceCampaignId: string;
  readonly createdByAgentInvocationId: string;
  readonly promptVersionId: string;
}

/**
 * Writes the next version of `learningKey`, superseding any prior live version.
 * Always `PROPOSED`: a fresh learning is never automatically visible to an
 * agent — `selectLearningContext` only admits APPROVED records, so a human
 * review stands between the analyst and any future Strategy.
 *
 * Idempotent per `(learningKey, createdByAgentInvocationId)`: a replayed
 * Activity returns the existing row instead of inflating the version.
 */
export async function createLearningRecord(
  db: LearningDataSource,
  workspaceId: string,
  input: CreateLearningRecordInput,
): Promise<{ record: LearningRecordRecord; alreadyExisted: boolean }> {
  if (input.evidence.length === 0) {
    throw new LearningWithoutEvidenceError(input.learningKey);
  }

  const siblings = await db.learningRecord.findMany({
    where: { workspaceId, learningKey: input.learningKey },
  });

  const replayed = siblings.find(
    (s) => s.createdByAgentInvocationId === input.createdByAgentInvocationId,
  );
  if (replayed) return { record: replayed, alreadyExisted: true };

  const nextVersion = siblings.reduce((max, s) => Math.max(max, s.version), 0) + 1;
  const record = await db.learningRecord.create({
    data: {
      workspaceId,
      version: nextVersion,
      learningKey: input.learningKey,
      insight: input.insight,
      scope: input.scope,
      applicability: input.applicability,
      confidence: input.confidence,
      evidence: [...input.evidence],
      totalImpressions: input.totalImpressions,
      status: 'PROPOSED',
      sourceCampaignId: input.sourceCampaignId,
      createdByAgentInvocationId: input.createdByAgentInvocationId,
      promptVersionId: input.promptVersionId,
    },
  });

  for (const prior of siblings.filter((s) => !s.supersededAt)) {
    // eslint-disable-next-line no-await-in-loop -- at most one live version per key in practice; sequential keeps supersession ordering deterministic
    await db.learningRecord.update({
      where: { id: prior.id },
      data: { supersededAt: new Date() },
    });
  }

  return { record, alreadyExisted: false };
}

/** Records a human's review decision — the only mutation a learning ever receives. */
export async function reviewLearningRecord(
  db: LearningDataSource,
  workspaceId: string,
  id: string,
  input: { status: Extract<LearningStatus, 'APPROVED' | 'REJECTED'>; reviewedByUserId: string },
): Promise<LearningRecordRecord> {
  const existing = await db.learningRecord.findFirst({ where: { id, workspaceId } });
  if (!existing) {
    throw new Error(`LearningRecord ${id} not found in workspace ${workspaceId}`);
  }
  return db.learningRecord.update({
    where: { id },
    data: {
      status: input.status,
      reviewedByUserId: input.reviewedByUserId,
      reviewedAt: new Date(),
    },
  });
}

export async function getLearningRecord(
  db: LearningDataSource,
  workspaceId: string,
  id: string,
): Promise<LearningRecordRecord | undefined> {
  return (await db.learningRecord.findFirst({ where: { id, workspaceId } })) ?? undefined;
}

/** Every learning in the workspace, newest first — the dashboard's review list. */
export async function listLearningRecords(
  db: LearningDataSource,
  workspaceId: string,
): Promise<LearningRecordRecord[]> {
  const rows = await db.learningRecord.findMany({ where: { workspaceId } });
  return [...rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.version - a.version,
  );
}

export async function listLearningRecordsForCampaign(
  db: LearningDataSource,
  workspaceId: string,
  sourceCampaignId: string,
): Promise<LearningRecordRecord[]> {
  const rows = await db.learningRecord.findMany({ where: { workspaceId, sourceCampaignId } });
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Loads the bounded, attributable context an agent may see. The workspace
 * filter happens here; every other restriction (APPROVED only, non-superseded,
 * scope match, minimum confidence, applicability overlap, hard item cap) is
 * applied by `@combat/domain`'s pure `selectLearningContext`, so the policy is
 * unit-testable without a database and identical everywhere it is used.
 */
export async function loadLearningContext(
  db: LearningDataSource,
  workspaceId: string,
  request: LearningContextRequest,
): Promise<LearningContextItem[]> {
  const candidates = await db.learningRecord.findMany({ where: { workspaceId } });
  return selectLearningContext(candidates, request);
}
