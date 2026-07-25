import type {
  PrismaClient,
  QualityAssessmentDataSource,
  ShotSelectionDataSource,
} from '@combat/database';
import { createAssetDatabase, type AssetDatabase } from './asset-database';
import {
  createShotGenerationDatabase,
  type ShotGenerationDatabase,
} from './shot-generation-database';

/**
 * The M8 shot-review routes' combined data-source contract. Composed from the
 * M6 shot-generation adapter (campaign/script/shot/spec/candidate/budget), the
 * M5 asset adapter (asset + license — both needed for preview URLs and
 * candidate eligibility), and thin adapters for the M7 QualityAssessment and
 * M8 shot-selection tables. Same "adapt a real PrismaClient to the repository
 * layer's narrow *DataSource interfaces" pattern as its siblings; tests inject
 * an in-memory fake instead.
 */
export type ShotReviewDatabase = ShotGenerationDatabase &
  AssetDatabase &
  QualityAssessmentDataSource &
  ShotSelectionDataSource;

function undef<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

export function createShotReviewDatabase(prisma: PrismaClient): ShotReviewDatabase {
  const shotGenerationDb = createShotGenerationDatabase(prisma);
  const assetDb = createAssetDatabase(prisma);

  return {
    ...shotGenerationDb,
    ...assetDb,
    qualityAssessment: {
      create: async (args) => {
        const created = await prisma.qualityAssessment.create({ data: args.data as never });
        return mapQualityAssessment(created);
      },
      findFirst: async (args) => {
        const found = await prisma.qualityAssessment.findFirst({ where: args.where as never });
        return found ? mapQualityAssessment(found) : null;
      },
      findMany: async (args) => {
        const rows = await prisma.qualityAssessment.findMany({ where: args.where as never });
        return rows.map(mapQualityAssessment);
      },
    },
    qualityFailure: {
      create: async (args) => {
        const created = await prisma.qualityFailure.create({ data: args.data as never });
        return mapQualityFailure(created);
      },
      findMany: async (args) => {
        const rows = await prisma.qualityFailure.findMany({ where: args.where });
        return rows.map(mapQualityFailure);
      },
    },
    shotSelectionSet: {
      create: async (args) => {
        const created = await prisma.shotSelectionSet.create({ data: args.data as never });
        return mapShotSelectionSet(created);
      },
      findFirst: async (args) => {
        const found = await prisma.shotSelectionSet.findFirst({ where: args.where as never });
        return found ? mapShotSelectionSet(found) : null;
      },
      findMany: async (args) => {
        const rows = await prisma.shotSelectionSet.findMany({ where: args.where });
        return rows.map(mapShotSelectionSet);
      },
      updateMany: async (args) =>
        prisma.shotSelectionSet.updateMany({ where: args.where, data: args.data as never }),
    },
    shotSelection: {
      create: async (args) => {
        const created = await prisma.shotSelection.create({ data: args.data as never });
        return mapShotSelection(created);
      },
      findMany: async (args) => {
        const rows = await prisma.shotSelection.findMany({ where: args.where });
        return rows.map(mapShotSelection);
      },
      updateMany: async (args) =>
        prisma.shotSelection.updateMany({ where: args.where, data: args.data as never }),
    },
    shotSelectionReplacement: {
      create: async (args) => {
        const created = await prisma.shotSelectionReplacement.create({ data: args.data as never });
        return mapShotSelectionReplacement(created);
      },
      findMany: async (args) => {
        const rows = await prisma.shotSelectionReplacement.findMany({ where: args.where });
        return rows.map(mapShotSelectionReplacement);
      },
    },
  };
}

function mapQualityAssessment(row: {
  generationCandidateId: string | null;
  assetId: string | null;
  subjectStage: string | null;
  createdByAgentInvocationId: string | null;
  scores: unknown;
  [key: string]: unknown;
}) {
  return {
    ...row,
    generationCandidateId: undef(row.generationCandidateId),
    assetId: undef(row.assetId),
    subjectStage: undef(row.subjectStage),
    createdByAgentInvocationId: undef(row.createdByAgentInvocationId),
  } as never;
}

function mapQualityFailure(row: { suggestedAction: string | null; [key: string]: unknown }) {
  return { ...row, suggestedAction: undef(row.suggestedAction) } as never;
}

function mapShotSelectionSet(row: {
  reviewerUserId: string | null;
  rationale: string | null;
  idempotencyKey: string | null;
  approvedAt: Date | null;
  [key: string]: unknown;
}) {
  return {
    ...row,
    reviewerUserId: undef(row.reviewerUserId),
    rationale: undef(row.rationale),
    idempotencyKey: undef(row.idempotencyKey),
    approvedAt: undef(row.approvedAt),
  } as never;
}

function mapShotSelection(row: {
  selectedCandidateId: string | null;
  visualQaAssessmentId: string | null;
  continuityQaAssessmentId: string | null;
  rationale: string | null;
  regenerationFeedback: string | null;
  [key: string]: unknown;
}) {
  return {
    ...row,
    selectedCandidateId: undef(row.selectedCandidateId),
    visualQaAssessmentId: undef(row.visualQaAssessmentId),
    continuityQaAssessmentId: undef(row.continuityQaAssessmentId),
    rationale: undef(row.rationale),
    regenerationFeedback: undef(row.regenerationFeedback),
  } as never;
}

function mapShotSelectionReplacement(row: {
  previousCandidateId: string | null;
  newCandidateId: string | null;
  reason: string | null;
  [key: string]: unknown;
}) {
  return {
    ...row,
    previousCandidateId: undef(row.previousCandidateId),
    newCandidateId: undef(row.newCandidateId),
    reason: undef(row.reason),
  } as never;
}
