import type {
  DeliveryProfileDataSource,
  PrismaClient,
  QualityAssessmentDataSource,
  VariantDataSource,
} from '@combat/database';
import { createAssetDatabase, type AssetDatabase } from './asset-database';
import { createSoundDesignDatabase, type SoundDesignDatabase } from './sound-design-database';

/**
 * The M12 variant routes' data-source contract: campaign/membership/budget
 * (sound-design adapter), asset (for the rendered VARIANT rows), the delivery
 * profile, the variant specification/job/attempt tables, and the
 * quality-assessment tables the VARIANT_QA verdicts live in. Same "adapt a real
 * PrismaClient to the narrow *DataSource interfaces" pattern as its siblings;
 * tests inject an in-memory fake.
 */
export type VariantDatabase = SoundDesignDatabase &
  AssetDatabase &
  DeliveryProfileDataSource &
  VariantDataSource &
  QualityAssessmentDataSource;

function undef<T>(v: T | null): T | undefined {
  return v ?? undefined;
}

export function createVariantDatabase(prisma: PrismaClient): VariantDatabase {
  return {
    ...createSoundDesignDatabase(prisma),
    ...createAssetDatabase(prisma),
    deliveryProfile: {
      create: async (args) => prisma.deliveryProfile.create({ data: args.data as never }) as never,
      findFirst: async (args) =>
        prisma.deliveryProfile.findFirst({ where: args.where as never }) as never,
      findMany: async (args) => prisma.deliveryProfile.findMany({ where: args.where }) as never,
    },
    variantSpecification: {
      create: async (args) =>
        mapSpec(await prisma.variantSpecification.create({ data: args.data as never })),
      findFirst: async (args) => {
        const found = await prisma.variantSpecification.findFirst({ where: args.where as never });
        return found ? mapSpec(found) : null;
      },
      findMany: async (args) =>
        (await prisma.variantSpecification.findMany({ where: args.where as never })).map(mapSpec),
      update: async (args) =>
        mapSpec(
          await prisma.variantSpecification.update({
            where: args.where,
            data: args.data as never,
          }),
        ),
    },
    variantGenerationJob: {
      create: async (args) =>
        prisma.variantGenerationJob.create({ data: args.data as never }) as never,
      findFirst: async (args) =>
        prisma.variantGenerationJob.findFirst({ where: args.where as never }) as never,
      findMany: async (args) =>
        prisma.variantGenerationJob.findMany({ where: args.where as never }) as never,
      update: async (args) =>
        prisma.variantGenerationJob.update({
          where: args.where,
          data: args.data as never,
        }) as never,
    },
    variantGenerationAttempt: {
      create: async (args) =>
        mapAttempt(await prisma.variantGenerationAttempt.create({ data: args.data as never })),
      findFirst: async (args) => {
        const found = await prisma.variantGenerationAttempt.findFirst({
          where: args.where as never,
        });
        return found ? mapAttempt(found) : null;
      },
      findMany: async (args) =>
        (await prisma.variantGenerationAttempt.findMany({ where: args.where as never })).map(
          mapAttempt,
        ),
      update: async (args) =>
        mapAttempt(
          await prisma.variantGenerationAttempt.update({
            where: args.where,
            data: args.data as never,
          }),
        ),
    },
    creativeVariant: {
      create: async (args) =>
        mapVariant(await prisma.creativeVariant.create({ data: args.data as never })),
      findFirst: async (args) => {
        const found = await prisma.creativeVariant.findFirst({ where: args.where as never });
        return found ? mapVariant(found) : null;
      },
      findMany: async (args) =>
        (await prisma.creativeVariant.findMany({ where: args.where as never })).map(mapVariant),
      update: async (args) =>
        mapVariant(
          await prisma.creativeVariant.update({ where: args.where, data: args.data as never }),
        ),
    },
    qualityAssessment: {
      create: async (args) =>
        mapAssessment(await prisma.qualityAssessment.create({ data: args.data as never })),
      findFirst: async (args) => {
        const found = await prisma.qualityAssessment.findFirst({ where: args.where as never });
        return found ? mapAssessment(found) : null;
      },
      findMany: async (args) =>
        (await prisma.qualityAssessment.findMany({ where: args.where as never })).map(
          mapAssessment,
        ),
    },
    qualityFailure: {
      create: async (args) =>
        mapFailure(await prisma.qualityFailure.create({ data: args.data as never })),
      findMany: async (args) =>
        (await prisma.qualityFailure.findMany({ where: args.where as never })).map(mapFailure),
    },
  };
}

function mapSpec(row: {
  approvedForExportAt: Date | null;
  supersededAt: Date | null;
  [k: string]: unknown;
}) {
  return {
    ...row,
    approvedForExportAt: undef(row.approvedForExportAt),
    supersededAt: undef(row.supersededAt),
  } as never;
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

function mapVariant(row: {
  assetId: string | null;
  variantSpecificationId: string | null;
  qualityAssessmentId: string | null;
  [k: string]: unknown;
}) {
  return {
    ...row,
    assetId: undef(row.assetId),
    variantSpecificationId: undef(row.variantSpecificationId),
    qualityAssessmentId: undef(row.qualityAssessmentId),
  } as never;
}

function mapAssessment(row: {
  generationCandidateId: string | null;
  assetId: string | null;
  subjectStage: string | null;
  createdByAgentInvocationId: string | null;
  [k: string]: unknown;
}) {
  return {
    ...row,
    generationCandidateId: undef(row.generationCandidateId),
    assetId: undef(row.assetId),
    subjectStage: undef(row.subjectStage),
    createdByAgentInvocationId: undef(row.createdByAgentInvocationId),
  } as never;
}

function mapFailure(row: { suggestedAction: string | null; [k: string]: unknown }) {
  return { ...row, suggestedAction: undef(row.suggestedAction) } as never;
}
