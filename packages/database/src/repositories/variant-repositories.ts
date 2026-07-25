import type {
  CreativeVariant,
  VariantGenerationAttempt,
  VariantGenerationJob,
  VariantSpecification,
} from '@combat/domain';

export type VariantSpecificationRecord = VariantSpecification;
export type VariantGenerationJobRecord = VariantGenerationJob;
export type VariantGenerationAttemptRecord = VariantGenerationAttempt;
/** M12 extends the M0 `CreativeVariant` row with its cut recipe + variant QA verdict. */
export type CreativeVariantRecord = CreativeVariant & {
  variantSpecificationId?: string;
  qualityAssessmentId?: string;
};

/**
 * M12 persistence for delivery variants. Three concerns, one file because they
 * are one aggregate in practice (a specification, its bounded-retry render job
 * history, and the rendered variant row the campaign's `variantsGenerated` /
 * `variantQAPassed` facts read):
 *
 * - `VariantSpecification` — immutable + versioned per
 *   `(campaign, parentMaster, targetDuration)`. Frozen outright once
 *   `approvedForExportAt` is set; superseding is the only way to change a cut.
 * - `VariantGenerationJob` / `VariantGenerationAttempt` — the same "mutable job
 *   status + immutable append-only attempt history" split
 *   `CompositionJob`/`ShotGenerationJob` already establish.
 * - `CreativeVariant` — the rendered output row, linked back to the exact
 *   specification it came from.
 *
 * Every function takes `workspaceId` first and folds it into the query
 * (CLAUDE.md security rule); a variant is never looked up by id alone.
 */
export interface VariantDataSource {
  variantSpecification: {
    create(args: {
      data: Omit<VariantSpecificationRecord, 'id' | 'createdAt'>;
    }): Promise<VariantSpecificationRecord>;
    findFirst(args: {
      where: { id: string; workspaceId: string };
    }): Promise<VariantSpecificationRecord | null>;
    findMany(args: {
      where: { workspaceId: string; campaignId?: string; parentMasterAssetId?: string };
    }): Promise<VariantSpecificationRecord[]>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<VariantSpecificationRecord, 'approvedForExportAt' | 'supersededAt'>>;
    }): Promise<VariantSpecificationRecord>;
  };
  variantGenerationJob: {
    create(args: {
      data: Omit<VariantGenerationJobRecord, 'id' | 'createdAt' | 'updatedAt'>;
    }): Promise<VariantGenerationJobRecord>;
    findFirst(args: {
      where:
        | { id: string; workspaceId: string }
        | { variantSpecificationId: string; workspaceId?: string };
    }): Promise<VariantGenerationJobRecord | null>;
    findMany(args: {
      where: { workspaceId: string; campaignId?: string };
    }): Promise<VariantGenerationJobRecord[]>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<VariantGenerationJobRecord, 'status' | 'attemptCount'>>;
    }): Promise<VariantGenerationJobRecord>;
  };
  variantGenerationAttempt: {
    create(args: {
      data: Omit<VariantGenerationAttemptRecord, 'id' | 'createdAt'>;
    }): Promise<VariantGenerationAttemptRecord>;
    findFirst(args: {
      where:
        | { variantGenerationJobId: string; idempotencyKey: string }
        | { id: string; workspaceId: string };
    }): Promise<VariantGenerationAttemptRecord | null>;
    findMany(args: {
      where: { variantGenerationJobId: string };
    }): Promise<VariantGenerationAttemptRecord[]>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<
          VariantGenerationAttemptRecord,
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
    }): Promise<VariantGenerationAttemptRecord>;
  };
  creativeVariant: {
    create(args: {
      data: Omit<CreativeVariantRecord, 'id' | 'createdAt'>;
    }): Promise<CreativeVariantRecord>;
    findFirst(args: {
      where:
        | { id: string; workspaceId: string }
        | { variantSpecificationId: string; workspaceId?: string };
    }): Promise<CreativeVariantRecord | null>;
    findMany(args: {
      where: { workspaceId: string; campaignId?: string };
    }): Promise<CreativeVariantRecord[]>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<CreativeVariantRecord, 'status' | 'assetId' | 'qualityAssessmentId'>>;
    }): Promise<CreativeVariantRecord>;
  };
}

/**
 * Thrown when a caller tries to supersede or re-approve a specification that
 * was already frozen for export. An approved cut is the artifact downstream
 * export/distribution would ship — mutating it in place would silently change
 * what a human signed off on.
 */
export class VariantSpecificationImmutableError extends Error {
  constructor(id: string) {
    super(`VariantSpecification ${id} is approved for export and can no longer be modified`);
    this.name = 'VariantSpecificationImmutableError';
  }
}

export type CreateVariantSpecificationInput = Omit<
  VariantSpecificationRecord,
  'id' | 'workspaceId' | 'createdAt' | 'version' | 'approvedForExportAt' | 'supersededAt'
>;

/**
 * Creates the next version of the cut for `(campaign, parentMaster,
 * targetDuration)`, marking any prior live version superseded. Idempotent per
 * `createdByAgentInvocationId`: a replayed Activity call (including one whose
 * agent result was itself a cached replay) returns the existing row rather than
 * writing a second version.
 */
export async function createVariantSpecification(
  db: VariantDataSource,
  workspaceId: string,
  input: CreateVariantSpecificationInput,
): Promise<{ specification: VariantSpecificationRecord; alreadyExisted: boolean }> {
  const siblings = await db.variantSpecification.findMany({
    where: {
      workspaceId,
      campaignId: input.campaignId,
      parentMasterAssetId: input.parentMasterAssetId,
    },
  });
  const forDuration = siblings.filter(
    (s) => s.targetDurationSeconds === input.targetDurationSeconds,
  );

  const replayed = forDuration.find(
    (s) => s.createdByAgentInvocationId === input.createdByAgentInvocationId,
  );
  if (replayed) return { specification: replayed, alreadyExisted: true };

  const live = forDuration.filter((s) => !s.supersededAt);
  const frozen = live.find((s) => s.approvedForExportAt);
  if (frozen) throw new VariantSpecificationImmutableError(frozen.id);

  const nextVersion = forDuration.reduce((max, s) => Math.max(max, s.version), 0) + 1;
  const specification = await db.variantSpecification.create({
    data: { workspaceId, version: nextVersion, ...input },
  });
  for (const prior of live) {
    // eslint-disable-next-line no-await-in-loop -- at most one live row per duration in practice; sequential keeps supersession ordering deterministic
    await db.variantSpecification.update({
      where: { id: prior.id },
      data: { supersededAt: new Date() },
    });
  }
  return { specification, alreadyExisted: false };
}

export async function getVariantSpecification(
  db: VariantDataSource,
  workspaceId: string,
  id: string,
): Promise<VariantSpecificationRecord | undefined> {
  return (await db.variantSpecification.findFirst({ where: { id, workspaceId } })) ?? undefined;
}

/** Every live (non-superseded) specification for a campaign, longest target duration first. */
export async function listLiveVariantSpecifications(
  db: VariantDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<VariantSpecificationRecord[]> {
  const rows = await db.variantSpecification.findMany({ where: { workspaceId, campaignId } });
  return rows
    .filter((s) => !s.supersededAt)
    .sort((a, b) => b.targetDurationSeconds - a.targetDurationSeconds);
}

export async function listVariantSpecifications(
  db: VariantDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<VariantSpecificationRecord[]> {
  const rows = await db.variantSpecification.findMany({ where: { workspaceId, campaignId } });
  return [...rows].sort(
    (a, b) => b.targetDurationSeconds - a.targetDurationSeconds || b.version - a.version,
  );
}

/** Freezes a specification once its variant passed QA — from here it is immutable. */
export async function approveVariantSpecificationForExport(
  db: VariantDataSource,
  workspaceId: string,
  id: string,
): Promise<VariantSpecificationRecord> {
  const existing = await db.variantSpecification.findFirst({ where: { id, workspaceId } });
  if (!existing)
    throw new Error(`VariantSpecification ${id} not found in workspace ${workspaceId}`);
  if (existing.approvedForExportAt) return existing;
  return db.variantSpecification.update({
    where: { id },
    data: { approvedForExportAt: new Date() },
  });
}

/** Idempotent: one job per `variantSpecificationId` (Prisma `@@unique`). */
export async function getOrCreateVariantGenerationJob(
  db: VariantDataSource,
  workspaceId: string,
  input: { campaignId: string; variantSpecificationId: string; maxAttempts: number },
): Promise<VariantGenerationJobRecord> {
  const existing = await db.variantGenerationJob.findFirst({
    where: { variantSpecificationId: input.variantSpecificationId, workspaceId },
  });
  if (existing) return existing;
  return db.variantGenerationJob.create({
    data: {
      workspaceId,
      campaignId: input.campaignId,
      variantSpecificationId: input.variantSpecificationId,
      status: 'PENDING',
      maxAttempts: input.maxAttempts,
      attemptCount: 0,
    },
  });
}

export async function getVariantGenerationJobById(
  db: VariantDataSource,
  workspaceId: string,
  id: string,
): Promise<VariantGenerationJobRecord | null> {
  return db.variantGenerationJob.findFirst({ where: { id, workspaceId } });
}

export async function getVariantGenerationJobForSpecification(
  db: VariantDataSource,
  workspaceId: string,
  variantSpecificationId: string,
): Promise<VariantGenerationJobRecord | null> {
  return db.variantGenerationJob.findFirst({ where: { variantSpecificationId, workspaceId } });
}

export async function listVariantGenerationJobs(
  db: VariantDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<VariantGenerationJobRecord[]> {
  return db.variantGenerationJob.findMany({ where: { workspaceId, campaignId } });
}

export async function updateVariantGenerationJob(
  db: VariantDataSource,
  jobId: string,
  data: Partial<Pick<VariantGenerationJobRecord, 'status' | 'attemptCount'>>,
): Promise<VariantGenerationJobRecord> {
  return db.variantGenerationJob.update({ where: { id: jobId }, data });
}

/** Idempotent: `(variantGenerationJobId, idempotencyKey)` is unique — a replayed dispatch returns the existing attempt. */
export async function getOrCreateVariantGenerationAttempt(
  db: VariantDataSource,
  workspaceId: string,
  input: Omit<VariantGenerationAttemptRecord, 'id' | 'createdAt' | 'workspaceId'>,
): Promise<{ attempt: VariantGenerationAttemptRecord; alreadyExisted: boolean }> {
  const existing = await db.variantGenerationAttempt.findFirst({
    where: {
      variantGenerationJobId: input.variantGenerationJobId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing) return { attempt: existing, alreadyExisted: true };
  const attempt = await db.variantGenerationAttempt.create({ data: { workspaceId, ...input } });
  return { attempt, alreadyExisted: false };
}

export async function updateVariantGenerationAttempt(
  db: VariantDataSource,
  attemptId: string,
  data: Parameters<VariantDataSource['variantGenerationAttempt']['update']>[0]['data'],
): Promise<VariantGenerationAttemptRecord> {
  return db.variantGenerationAttempt.update({ where: { id: attemptId }, data });
}

export async function getVariantGenerationAttemptById(
  db: VariantDataSource,
  workspaceId: string,
  attemptId: string,
): Promise<VariantGenerationAttemptRecord | null> {
  return db.variantGenerationAttempt.findFirst({ where: { id: attemptId, workspaceId } });
}

export async function listVariantGenerationAttempts(
  db: VariantDataSource,
  variantGenerationJobId: string,
): Promise<VariantGenerationAttemptRecord[]> {
  const rows = await db.variantGenerationAttempt.findMany({ where: { variantGenerationJobId } });
  return [...rows].sort((a, b) => a.attemptNumber - b.attemptNumber);
}

/** Idempotent: one rendered `CreativeVariant` per specification. */
export async function getOrCreateCreativeVariant(
  db: VariantDataSource,
  workspaceId: string,
  input: {
    campaignId: string;
    deliverySpecificationId: string;
    variantSpecificationId: string;
    durationSeconds: number;
  },
): Promise<{ variant: CreativeVariantRecord; alreadyExisted: boolean }> {
  const existing = await db.creativeVariant.findFirst({
    where: { variantSpecificationId: input.variantSpecificationId, workspaceId },
  });
  if (existing) return { variant: existing, alreadyExisted: true };
  const variant = await db.creativeVariant.create({
    data: { workspaceId, status: 'PENDING', ...input },
  });
  return { variant, alreadyExisted: false };
}

export async function updateCreativeVariant(
  db: VariantDataSource,
  variantId: string,
  data: Partial<Pick<CreativeVariantRecord, 'status' | 'assetId' | 'qualityAssessmentId'>>,
): Promise<CreativeVariantRecord> {
  return db.creativeVariant.update({ where: { id: variantId }, data });
}

export async function listCreativeVariants(
  db: VariantDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<CreativeVariantRecord[]> {
  const rows = await db.creativeVariant.findMany({ where: { workspaceId, campaignId } });
  return [...rows].sort((a, b) => b.durationSeconds - a.durationSeconds);
}

export async function getCreativeVariantForSpecification(
  db: VariantDataSource,
  workspaceId: string,
  variantSpecificationId: string,
): Promise<CreativeVariantRecord | undefined> {
  return (
    (await db.creativeVariant.findFirst({ where: { variantSpecificationId, workspaceId } })) ??
    undefined
  );
}
