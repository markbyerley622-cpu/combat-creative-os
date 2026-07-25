import type {
  PrismaClient,
  QualityAssessmentDataSource,
  RoughEditSpecificationDataSource,
} from '@combat/database';
import { createAssetDatabase, type AssetDatabase } from './asset-database';
import { createSoundDesignDatabase, type SoundDesignDatabase } from './sound-design-database';

/**
 * The M11 final-QA read route's data-source contract: campaign/membership/
 * budget/script + timeline + sound design (sound-design adapter), asset (asset
 * adapter, for the FINAL_MASTER row), the rough-edit specification the master
 * was assembled from, and the quality-assessment tables the verdict lives in.
 * Same "adapt a real PrismaClient to the narrow *DataSource interfaces" pattern
 * as its siblings; tests inject an in-memory fake.
 */
export type FinalQaDatabase = SoundDesignDatabase &
  AssetDatabase &
  RoughEditSpecificationDataSource &
  QualityAssessmentDataSource;

function undef<T>(v: T | null): T | undefined {
  return v ?? undefined;
}

export function createFinalQaDatabase(prisma: PrismaClient): FinalQaDatabase {
  return {
    ...createSoundDesignDatabase(prisma),
    ...createAssetDatabase(prisma),
    roughEditSpecification: {
      create: async (args) =>
        mapRoughEdit(await prisma.roughEditSpecification.create({ data: args.data as never })),
      findFirst: async (args) => {
        const found = await prisma.roughEditSpecification.findFirst({
          where: args.where as never,
        });
        return found ? mapRoughEdit(found) : null;
      },
      findMany: async (args) =>
        (await prisma.roughEditSpecification.findMany({ where: args.where as never })).map(
          mapRoughEdit,
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

function mapRoughEdit(row: Record<string, unknown>) {
  return row as never;
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
