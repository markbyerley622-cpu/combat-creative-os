import type {
  CompositionDataSource,
  PrismaClient,
  RenderJobDataSource,
  RoughEditSpecificationDataSource,
} from '@combat/database';
import { createAssetDatabase, type AssetDatabase } from './asset-database';
import {
  createShotGenerationDatabase,
  type ShotGenerationDatabase,
} from './shot-generation-database';

/**
 * The M9 compositing read/cancel routes' combined data-source contract:
 * campaign/script/shot/spec/candidate/budget (shot-generation adapter), asset
 * (asset adapter), plus the M9 rough-edit-specification / composition-job /
 * render-job tables. Same "adapt a real PrismaClient to the narrow *DataSource
 * interfaces" pattern as its siblings; tests inject an in-memory fake.
 */
export type CompositingDatabase = ShotGenerationDatabase &
  AssetDatabase &
  RoughEditSpecificationDataSource &
  CompositionDataSource &
  RenderJobDataSource;

function undef<T>(v: T | null): T | undefined {
  return v ?? undefined;
}

export function createCompositingDatabase(prisma: PrismaClient): CompositingDatabase {
  return {
    ...createShotGenerationDatabase(prisma),
    ...createAssetDatabase(prisma),
    roughEditSpecification: {
      create: async (args) =>
        prisma.roughEditSpecification.create({ data: args.data as never }) as never,
      findFirst: async (args) =>
        prisma.roughEditSpecification.findFirst({ where: args.where as never }) as never,
      findMany: async (args) =>
        prisma.roughEditSpecification.findMany({ where: args.where }) as never,
    },
    compositionJob: {
      create: async (args) => prisma.compositionJob.create({ data: args.data as never }),
      findFirst: async (args) => prisma.compositionJob.findFirst({ where: args.where as never }),
      update: async (args) => prisma.compositionJob.update({ where: args.where, data: args.data }),
    },
    compositionAttempt: {
      create: async (args) =>
        mapAttempt(await prisma.compositionAttempt.create({ data: args.data as never })),
      findFirst: async (args) => {
        const row = await prisma.compositionAttempt.findFirst({ where: args.where as never });
        return row ? mapAttempt(row) : null;
      },
      findMany: async (args) =>
        (await prisma.compositionAttempt.findMany({ where: args.where })).map(mapAttempt),
      update: async (args) =>
        mapAttempt(await prisma.compositionAttempt.update({ where: args.where, data: args.data })),
    },
    renderJob: {
      create: async (args) =>
        mapRenderJob(await prisma.renderJob.create({ data: args.data as never })),
      findFirst: async (args) => {
        const row = await prisma.renderJob.findFirst({ where: args.where as never });
        return row ? mapRenderJob(row) : null;
      },
      findMany: async (args) =>
        (await prisma.renderJob.findMany({ where: args.where })).map(mapRenderJob),
    },
  };
}

function mapAttempt(row: {
  providerProjectId: string | null;
  providerJobId: string | null;
  budgetReservationId: string | null;
  estimatedCostCents: number | null;
  actualCostCents: number | null;
  outputAssetId: string | null;
  failureReason: string | null;
  failureRetryable: boolean | null;
  failureMessage: string | null;
  completedAt: Date | null;
  [k: string]: unknown;
}) {
  return {
    ...row,
    providerProjectId: undef(row.providerProjectId),
    providerJobId: undef(row.providerJobId),
    budgetReservationId: undef(row.budgetReservationId),
    estimatedCostCents: undef(row.estimatedCostCents),
    actualCostCents: undef(row.actualCostCents),
    outputAssetId: undef(row.outputAssetId),
    failureReason: undef(row.failureReason),
    failureRetryable: undef(row.failureRetryable),
    failureMessage: undef(row.failureMessage),
    completedAt: undef(row.completedAt),
  } as never;
}

function mapRenderJob(row: {
  outputAssetId: string | null;
  providerJobRef: string | null;
  completedAt: Date | null;
  [k: string]: unknown;
}) {
  return {
    ...row,
    outputAssetId: undef(row.outputAssetId),
    providerJobRef: undef(row.providerJobRef),
    completedAt: undef(row.completedAt),
  } as never;
}
