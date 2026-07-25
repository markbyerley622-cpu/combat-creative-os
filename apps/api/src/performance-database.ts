import type { LearningDataSource, PerformanceDataSource, PrismaClient } from '@combat/database';
import { createCampaignDatabase, type CampaignDatabase } from './campaign-database';

/**
 * The M13 performance/learning routes' data-source contract: campaign +
 * membership (campaign adapter) plus the two M13 tables. Same "adapt a real
 * PrismaClient to the narrow *DataSource interfaces" pattern as its siblings;
 * tests inject an in-memory fake.
 */
export type PerformanceDatabase = CampaignDatabase & PerformanceDataSource & LearningDataSource;

function undef<T>(v: T | null): T | undefined {
  return v ?? undefined;
}

export function createPerformanceDatabase(prisma: PrismaClient): PerformanceDatabase {
  return {
    ...createCampaignDatabase(prisma),
    performanceObservation: {
      create: async (args) =>
        mapObservation(await prisma.performanceObservation.create({ data: args.data as never })),
      findFirst: async (args) => {
        const found = await prisma.performanceObservation.findFirst({ where: args.where as never });
        return found ? mapObservation(found) : null;
      },
      findMany: async (args) =>
        (await prisma.performanceObservation.findMany({ where: args.where as never })).map(
          mapObservation,
        ),
    },
    learningRecord: {
      create: async (args) =>
        mapLearning(await prisma.learningRecord.create({ data: args.data as never })),
      findFirst: async (args) => {
        const found = await prisma.learningRecord.findFirst({ where: args.where as never });
        return found ? mapLearning(found) : null;
      },
      findMany: async (args) =>
        (await prisma.learningRecord.findMany({ where: args.where as never })).map(mapLearning),
      update: async (args) =>
        mapLearning(
          await prisma.learningRecord.update({ where: args.where, data: args.data as never }),
        ),
    },
  };
}

/**
 * The Prisma row stores the subject fields flat (so they can be indexed and
 * filtered) while the domain entity nests them under `subject`; this is the one
 * place that mapping lives.
 */
function mapObservation(row: {
  platform: string;
  externalPostId: string;
  externalAccountId: string | null;
  campaignId: string;
  creativeVariantId: string | null;
  variantAssetId: string | null;
  durationSeconds: number | null;
  ingestedByUserId: string | null;
  fixtureRef: string | null;
  [k: string]: unknown;
}) {
  return {
    ...row,
    subject: {
      platform: row.platform,
      externalPostId: row.externalPostId,
      externalAccountId: undef(row.externalAccountId),
      campaignId: row.campaignId,
      creativeVariantId: undef(row.creativeVariantId),
      variantAssetId: undef(row.variantAssetId),
      durationSeconds: undef(row.durationSeconds),
    },
    ingestedByUserId: undef(row.ingestedByUserId),
    fixtureRef: undef(row.fixtureRef),
  } as never;
}

function mapLearning(row: {
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  supersededAt: Date | null;
  [k: string]: unknown;
}) {
  return {
    ...row,
    reviewedByUserId: undef(row.reviewedByUserId),
    reviewedAt: undef(row.reviewedAt),
    supersededAt: undef(row.supersededAt),
  } as never;
}
