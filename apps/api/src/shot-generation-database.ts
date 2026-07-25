import type {
  BudgetDataSource,
  PrismaClient,
  ShotGenerationDataSource,
  ShotSpecificationDataSource,
} from '@combat/database';
import { createCampaignDatabase, type CampaignDatabase } from './campaign-database';

/**
 * The M6 shot-generation read routes' combined data-source contract — same
 * "adapt a real PrismaClient to the repository layer's narrow *DataSource
 * interfaces" pattern as asset-database.ts, composed with (not duplicating)
 * `createCampaignDatabase` for the `script`/`shot` lookups these routes also
 * need (resolving "the campaign's latest script's shots").
 */
export type ShotGenerationDatabase = CampaignDatabase &
  ShotSpecificationDataSource &
  ShotGenerationDataSource &
  BudgetDataSource;

export function createShotGenerationDatabase(prisma: PrismaClient): ShotGenerationDatabase {
  const campaignDb = createCampaignDatabase(prisma);

  return {
    ...campaignDb,
    shotSpecification: {
      create: async (args) => {
        const created = await prisma.shotSpecification.create({ data: args.data as never });
        return mapShotSpecification(created);
      },
      findFirst: async (args) => {
        const found = await prisma.shotSpecification.findFirst({ where: args.where as never });
        return found ? mapShotSpecification(found) : null;
      },
      findMany: async (args) => {
        const rows = await prisma.shotSpecification.findMany({ where: args.where as never });
        return rows.map(mapShotSpecification);
      },
    },
    shotGenerationJob: {
      create: async (args) => prisma.shotGenerationJob.create({ data: args.data }),
      findFirst: async (args) => prisma.shotGenerationJob.findFirst({ where: args.where as never }),
      update: async (args) =>
        prisma.shotGenerationJob.update({ where: args.where, data: args.data }),
    },
    shotGenerationAttempt: {
      create: async (args) => {
        const created = await prisma.shotGenerationAttempt.create({ data: args.data as never });
        return mapShotGenerationAttempt(created);
      },
      findFirst: async (args) => {
        const found = await prisma.shotGenerationAttempt.findFirst({ where: args.where as never });
        return found ? mapShotGenerationAttempt(found) : null;
      },
      findMany: async (args) => {
        const rows = await prisma.shotGenerationAttempt.findMany({ where: args.where });
        return rows.map(mapShotGenerationAttempt);
      },
      update: async (args) => {
        const updated = await prisma.shotGenerationAttempt.update({
          where: args.where,
          data: args.data,
        });
        return mapShotGenerationAttempt(updated);
      },
    },
    generationCandidate: {
      create: async (args) => {
        const created = await prisma.generationCandidate.create({ data: args.data as never });
        return mapGenerationCandidate(created);
      },
      findMany: async (args) => {
        const rows = await prisma.generationCandidate.findMany({ where: args.where as never });
        return rows.map(mapGenerationCandidate);
      },
      update: async (args) => {
        const updated = await prisma.generationCandidate.update({
          where: args.where,
          data: args.data,
        });
        return mapGenerationCandidate(updated);
      },
    },
    budgetPolicy: {
      findFirst: async (args) => prisma.budgetPolicy.findFirst({ where: args.where }),
    },
    budgetLedgerEntry: {
      findMany: async (args) => {
        const rows = await prisma.budgetLedgerEntry.findMany({ where: args.where });
        return rows.map(mapBudgetLedgerEntry);
      },
      findFirst: async (args) => {
        const found = await prisma.budgetLedgerEntry.findFirst({ where: args.where });
        return found ? mapBudgetLedgerEntry(found) : null;
      },
      create: async (args) => {
        const created = await prisma.budgetLedgerEntry.create({ data: args.data });
        return mapBudgetLedgerEntry(created);
      },
    },
  };
}

// The `ShotSpecification.generationParams`/`outputRequirements` Json columns
// are validated (packages/agents' ShotPromptEngineerResultSchema plus this
// Activity's own structuring) before ever being written — the cast here is
// safe, not a bypass, matching every other Json-column cast in this file.
function mapShotSpecification(row: {
  appInterfaceRequirements: string | null;
  negativePrompt: string | null;
  [key: string]: unknown;
}) {
  return {
    ...row,
    appInterfaceRequirements: row.appInterfaceRequirements ?? undefined,
    negativePrompt: row.negativePrompt ?? undefined,
  } as never;
}

function mapShotGenerationAttempt(row: {
  providerJobId: string | null;
  seed: number | null;
  budgetReservationId: string | null;
  estimatedCostCents: number | null;
  actualCostCents: number | null;
  failureReason: string | null;
  failureRetryable: boolean | null;
  failureMessage: string | null;
  completedAt: Date | null;
  [key: string]: unknown;
}) {
  return {
    ...row,
    providerJobId: row.providerJobId ?? undefined,
    seed: row.seed ?? undefined,
    budgetReservationId: row.budgetReservationId ?? undefined,
    estimatedCostCents: row.estimatedCostCents ?? undefined,
    actualCostCents: row.actualCostCents ?? undefined,
    failureReason: row.failureReason ?? undefined,
    failureRetryable: row.failureRetryable ?? undefined,
    failureMessage: row.failureMessage ?? undefined,
    completedAt: row.completedAt ?? undefined,
  } as never;
}

function mapGenerationCandidate(row: {
  assetId: string | null;
  providerCandidateRef: string | null;
  seed: number | null;
  durationSeconds: number | null;
  aspectRatio: string | null;
  [key: string]: unknown;
}) {
  return {
    ...row,
    assetId: row.assetId ?? undefined,
    providerCandidateRef: row.providerCandidateRef ?? undefined,
    seed: row.seed ?? undefined,
    durationSeconds: row.durationSeconds ?? undefined,
    aspectRatio: row.aspectRatio ?? undefined,
  } as never;
}

function mapBudgetLedgerEntry(row: {
  campaignId: string | null;
  shotId: string | null;
  generationJobRef: string | null;
  [key: string]: unknown;
}) {
  return {
    ...row,
    campaignId: row.campaignId ?? undefined,
    shotId: row.shotId ?? undefined,
    generationJobRef: row.generationJobRef ?? undefined,
  } as never;
}
