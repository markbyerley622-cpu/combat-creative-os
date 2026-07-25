import type { GenerationCandidate, ShotGenerationAttempt, ShotGenerationJob } from '@combat/domain';

export type ShotGenerationJobRecord = ShotGenerationJob;
export type ShotGenerationAttemptRecord = ShotGenerationAttempt;
export type GenerationCandidateRecord = GenerationCandidate;

export interface ShotGenerationDataSource {
  shotGenerationJob: {
    create(args: {
      data: Omit<ShotGenerationJobRecord, 'id' | 'createdAt' | 'updatedAt'>;
    }): Promise<ShotGenerationJobRecord>;
    findFirst(args: {
      where:
        { shotSpecificationId: string; workspaceId?: string } | { id: string; workspaceId: string };
    }): Promise<ShotGenerationJobRecord | null>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<ShotGenerationJobRecord, 'status' | 'attemptCount'>>;
    }): Promise<ShotGenerationJobRecord>;
  };
  shotGenerationAttempt: {
    create(args: {
      data: Omit<ShotGenerationAttemptRecord, 'id' | 'createdAt'>;
    }): Promise<ShotGenerationAttemptRecord>;
    findFirst(args: {
      where:
        | { shotGenerationJobId: string; idempotencyKey: string }
        | { id: string; workspaceId: string };
    }): Promise<ShotGenerationAttemptRecord | null>;
    findMany(args: {
      where: { shotGenerationJobId: string };
    }): Promise<ShotGenerationAttemptRecord[]>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<
          ShotGenerationAttemptRecord,
          | 'status'
          | 'providerJobId'
          | 'actualCostCents'
          | 'failureReason'
          | 'failureRetryable'
          | 'failureMessage'
          | 'completedAt'
        >
      >;
    }): Promise<ShotGenerationAttemptRecord>;
  };
  generationCandidate: {
    create(args: {
      data: Omit<GenerationCandidateRecord, 'id' | 'createdAt' | 'updatedAt'>;
    }): Promise<GenerationCandidateRecord>;
    findMany(args: {
      where: { shotGenerationAttemptId: string } | { shotSpecificationId: { in: string[] } };
    }): Promise<GenerationCandidateRecord[]>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<GenerationCandidateRecord, 'status' | 'assetId'>>;
    }): Promise<GenerationCandidateRecord>;
  };
}

/** Idempotent: one job per `shotSpecificationId` (Prisma `@@unique`) — a retried dispatch returns the existing job instead of creating a duplicate. */
export async function getOrCreateShotGenerationJob(
  db: ShotGenerationDataSource,
  workspaceId: string,
  input: {
    campaignId: string;
    shotSpecificationId: string;
    requestedCandidateCount: number;
    maxAttempts: number;
  },
): Promise<ShotGenerationJobRecord> {
  const existing = await db.shotGenerationJob.findFirst({
    where: { shotSpecificationId: input.shotSpecificationId, workspaceId },
  });
  if (existing) return existing;
  return db.shotGenerationJob.create({
    data: {
      workspaceId,
      campaignId: input.campaignId,
      shotSpecificationId: input.shotSpecificationId,
      status: 'PENDING',
      requestedCandidateCount: input.requestedCandidateCount,
      maxAttempts: input.maxAttempts,
      attemptCount: 0,
    },
  });
}

export async function getShotGenerationJobForSpecification(
  db: ShotGenerationDataSource,
  workspaceId: string,
  shotSpecificationId: string,
): Promise<ShotGenerationJobRecord | null> {
  return db.shotGenerationJob.findFirst({ where: { shotSpecificationId, workspaceId } });
}

export async function getShotGenerationJobById(
  db: ShotGenerationDataSource,
  workspaceId: string,
  jobId: string,
): Promise<ShotGenerationJobRecord | null> {
  return db.shotGenerationJob.findFirst({ where: { id: jobId, workspaceId } });
}

export async function updateShotGenerationJob(
  db: ShotGenerationDataSource,
  jobId: string,
  data: Partial<Pick<ShotGenerationJobRecord, 'status' | 'attemptCount'>>,
): Promise<ShotGenerationJobRecord> {
  return db.shotGenerationJob.update({ where: { id: jobId }, data });
}

/**
 * Idempotent: `(shotGenerationJobId, idempotencyKey)` is unique (Prisma
 * `@@unique`) — a replayed/retried Activity call for the same attempt
 * returns the existing row rather than double-submitting to the provider or
 * double-reserving budget (CLAUDE.md workflow-idempotency rules).
 */
export async function getOrCreateShotGenerationAttempt(
  db: ShotGenerationDataSource,
  workspaceId: string,
  input: Omit<ShotGenerationAttemptRecord, 'id' | 'createdAt' | 'workspaceId'>,
): Promise<{ attempt: ShotGenerationAttemptRecord; alreadyExisted: boolean }> {
  const existing = await db.shotGenerationAttempt.findFirst({
    where: { shotGenerationJobId: input.shotGenerationJobId, idempotencyKey: input.idempotencyKey },
  });
  if (existing) return { attempt: existing, alreadyExisted: true };
  const attempt = await db.shotGenerationAttempt.create({ data: { workspaceId, ...input } });
  return { attempt, alreadyExisted: false };
}

export async function updateShotGenerationAttempt(
  db: ShotGenerationDataSource,
  attemptId: string,
  data: Partial<
    Pick<
      ShotGenerationAttemptRecord,
      | 'status'
      | 'providerJobId'
      | 'actualCostCents'
      | 'failureReason'
      | 'failureRetryable'
      | 'failureMessage'
      | 'completedAt'
    >
  >,
): Promise<ShotGenerationAttemptRecord> {
  return db.shotGenerationAttempt.update({ where: { id: attemptId }, data });
}

export async function getShotGenerationAttemptById(
  db: ShotGenerationDataSource,
  workspaceId: string,
  attemptId: string,
): Promise<ShotGenerationAttemptRecord | null> {
  return db.shotGenerationAttempt.findFirst({ where: { id: attemptId, workspaceId } });
}

export async function listShotGenerationAttempts(
  db: ShotGenerationDataSource,
  shotGenerationJobId: string,
): Promise<ShotGenerationAttemptRecord[]> {
  return db.shotGenerationAttempt.findMany({ where: { shotGenerationJobId } });
}

/** Idempotent by construction: callers derive `candidateIndex` from the provider's own stable `GeneratedCandidateRef.candidateIndex`, so a replayed `fetchResult` never creates a duplicate row for the same attempt+index — see the Prisma `@@unique([shotGenerationAttemptId, candidateIndex])` constraint. */
export async function createGenerationCandidate(
  db: ShotGenerationDataSource,
  workspaceId: string,
  input: Omit<GenerationCandidateRecord, 'id' | 'createdAt' | 'updatedAt' | 'workspaceId'>,
): Promise<GenerationCandidateRecord> {
  const existing = await db.generationCandidate.findMany({
    where: { shotGenerationAttemptId: input.shotGenerationAttemptId },
  });
  const match = existing.find((c) => c.candidateIndex === input.candidateIndex);
  if (match) return match;
  return db.generationCandidate.create({ data: { workspaceId, ...input } });
}

export async function updateGenerationCandidate(
  db: ShotGenerationDataSource,
  candidateId: string,
  data: Partial<Pick<GenerationCandidateRecord, 'status' | 'assetId'>>,
): Promise<GenerationCandidateRecord> {
  return db.generationCandidate.update({ where: { id: candidateId }, data });
}

export async function listGenerationCandidatesForAttempt(
  db: ShotGenerationDataSource,
  shotGenerationAttemptId: string,
): Promise<GenerationCandidateRecord[]> {
  return db.generationCandidate.findMany({ where: { shotGenerationAttemptId } });
}

export async function listGenerationCandidatesForSpecifications(
  db: ShotGenerationDataSource,
  shotSpecificationIds: string[],
): Promise<GenerationCandidateRecord[]> {
  if (shotSpecificationIds.length === 0) return [];
  return db.generationCandidate.findMany({
    where: { shotSpecificationId: { in: shotSpecificationIds } },
  });
}
