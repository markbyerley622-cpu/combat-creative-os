import type { CompositionAttempt, CompositionJob } from '@combat/domain';

export type CompositionJobRecord = CompositionJob;
export type CompositionAttemptRecord = CompositionAttempt;

/**
 * M9 persistence for the compositing render — mirrors
 * `shot-generation-repository`'s "mutable job status + immutable append-only
 * attempt history" split. One job per `RoughEditSpecification`; each attempt's
 * `idempotencyKey` is unique per job so a replayed Activity call never
 * double-submits or double-reserves budget.
 */
export interface CompositionDataSource {
  compositionJob: {
    create(args: {
      data: Omit<CompositionJobRecord, 'id' | 'createdAt' | 'updatedAt'>;
    }): Promise<CompositionJobRecord>;
    findFirst(args: {
      where:
        | { id: string; workspaceId: string }
        | { roughEditSpecificationId: string; workspaceId?: string };
    }): Promise<CompositionJobRecord | null>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<CompositionJobRecord, 'status' | 'attemptCount'>>;
    }): Promise<CompositionJobRecord>;
  };
  compositionAttempt: {
    create(args: {
      data: Omit<CompositionAttemptRecord, 'id' | 'createdAt'>;
    }): Promise<CompositionAttemptRecord>;
    findFirst(args: {
      where:
        { compositionJobId: string; idempotencyKey: string } | { id: string; workspaceId: string };
    }): Promise<CompositionAttemptRecord | null>;
    findMany(args: { where: { compositionJobId: string } }): Promise<CompositionAttemptRecord[]>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<
          CompositionAttemptRecord,
          | 'status'
          | 'providerProjectId'
          | 'providerJobId'
          | 'budgetReservationId'
          | 'estimatedCostCents'
          | 'actualCostCents'
          | 'outputAssetId'
          | 'failureReason'
          | 'failureRetryable'
          | 'failureMessage'
          | 'completedAt'
        >
      >;
    }): Promise<CompositionAttemptRecord>;
  };
}

/** Idempotent: one job per `roughEditSpecificationId` (Prisma `@@unique`). */
export async function getOrCreateCompositionJob(
  db: CompositionDataSource,
  workspaceId: string,
  input: { campaignId: string; roughEditSpecificationId: string; maxAttempts: number },
): Promise<CompositionJobRecord> {
  const existing = await db.compositionJob.findFirst({
    where: { roughEditSpecificationId: input.roughEditSpecificationId, workspaceId },
  });
  if (existing) return existing;
  return db.compositionJob.create({
    data: {
      workspaceId,
      campaignId: input.campaignId,
      roughEditSpecificationId: input.roughEditSpecificationId,
      status: 'PENDING',
      maxAttempts: input.maxAttempts,
      attemptCount: 0,
    },
  });
}

export async function getCompositionJobForSpecification(
  db: CompositionDataSource,
  workspaceId: string,
  roughEditSpecificationId: string,
): Promise<CompositionJobRecord | null> {
  return db.compositionJob.findFirst({ where: { roughEditSpecificationId, workspaceId } });
}

export async function getCompositionJobById(
  db: CompositionDataSource,
  workspaceId: string,
  id: string,
): Promise<CompositionJobRecord | null> {
  return db.compositionJob.findFirst({ where: { id, workspaceId } });
}

export async function updateCompositionJob(
  db: CompositionDataSource,
  jobId: string,
  data: Partial<Pick<CompositionJobRecord, 'status' | 'attemptCount'>>,
): Promise<CompositionJobRecord> {
  return db.compositionJob.update({ where: { id: jobId }, data });
}

/** Idempotent: `(compositionJobId, idempotencyKey)` is unique — a replayed dispatch returns the existing attempt. */
export async function getOrCreateCompositionAttempt(
  db: CompositionDataSource,
  workspaceId: string,
  input: Omit<CompositionAttemptRecord, 'id' | 'createdAt' | 'workspaceId'>,
): Promise<{ attempt: CompositionAttemptRecord; alreadyExisted: boolean }> {
  const existing = await db.compositionAttempt.findFirst({
    where: { compositionJobId: input.compositionJobId, idempotencyKey: input.idempotencyKey },
  });
  if (existing) return { attempt: existing, alreadyExisted: true };
  const attempt = await db.compositionAttempt.create({ data: { workspaceId, ...input } });
  return { attempt, alreadyExisted: false };
}

export async function updateCompositionAttempt(
  db: CompositionDataSource,
  attemptId: string,
  data: Parameters<CompositionDataSource['compositionAttempt']['update']>[0]['data'],
): Promise<CompositionAttemptRecord> {
  return db.compositionAttempt.update({ where: { id: attemptId }, data });
}

export async function getCompositionAttemptById(
  db: CompositionDataSource,
  workspaceId: string,
  attemptId: string,
): Promise<CompositionAttemptRecord | null> {
  return db.compositionAttempt.findFirst({ where: { id: attemptId, workspaceId } });
}

export async function listCompositionAttempts(
  db: CompositionDataSource,
  compositionJobId: string,
): Promise<CompositionAttemptRecord[]> {
  const rows = await db.compositionAttempt.findMany({ where: { compositionJobId } });
  return [...rows].sort((a, b) => a.attemptNumber - b.attemptNumber);
}
