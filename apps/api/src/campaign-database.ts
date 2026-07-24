import type { PrismaClient } from '@combat/database';
import type {
  CampaignBriefDataSource,
  CreativeConceptDataSource,
  ScriptWithShotsDataSource,
  StrategyDataSource,
} from '@combat/database';
import { createApprovalDatabase, type ApprovalDatabase } from './approval-database';

/**
 * The M4 campaign-intake routes' combined data-source contract — the same
 * "adapt a real PrismaClient to the repository layer's narrow *DataSource
 * interfaces" pattern approval-database.ts established, extended to the new
 * M4 repositories. Composed with (not duplicating) `createApprovalDatabase`
 * so `apps/api` still has exactly one adapter per Prisma client, not two
 * independently-drifting ones.
 */
export type CampaignDatabase = ApprovalDatabase &
  CampaignBriefDataSource &
  StrategyDataSource &
  CreativeConceptDataSource &
  ScriptWithShotsDataSource;

export function createCampaignDatabase(prisma: PrismaClient): CampaignDatabase {
  const approvalDb = createApprovalDatabase(prisma);

  return {
    ...approvalDb,
    campaignBrief: {
      // `aspectRatios`/`targetPlatforms` round-trip through Prisma's untyped
      // `String[]`/enum-array columns — `CampaignBriefContentSchema.parse`
      // (the API route's body validation) is what constrained these values
      // before they were ever written, so the cast back on read is safe, not
      // a bypass.
      create: async (args) => {
        const created = await prisma.campaignBrief.create({ data: args.data as never });
        return {
          ...created,
          notes: created.notes ?? undefined,
          deadline: created.deadline ?? undefined,
        } as never;
      },
      findMany: async (args) => {
        const rows = await prisma.campaignBrief.findMany({ where: args.where });
        return rows.map(
          (row) =>
            ({
              ...row,
              notes: row.notes ?? undefined,
              deadline: row.deadline ?? undefined,
            }) as never,
        );
      },
    },
    strategy: {
      // Prisma's `Json` column type-checks as `Prisma.InputJsonValue`, not
      // the structured `StrategyAudienceProfile` shape — `createStrategy`
      // (strategy-repository.ts) is what validated that shape before this
      // adapter is ever reached, so the cast here is safe, not a bypass.
      create: async (args) => (await prisma.strategy.create({ data: args.data as never })) as never,
      findMany: async (args) => (await prisma.strategy.findMany({ where: args.where })) as never,
    },
    creativeConcept: {
      create: async (args) => prisma.creativeConcept.create({ data: args.data }),
      findMany: async (args) => prisma.creativeConcept.findMany({ where: args.where }),
    },
    script: {
      create: async (args) => prisma.script.create({ data: args.data }),
      findMany: async (args) => prisma.script.findMany({ where: args.where }),
    },
    shot: {
      create: async (args) => prisma.shot.create({ data: args.data }),
      findMany: async (args) => prisma.shot.findMany({ where: args.where }),
      update: async (args) => prisma.shot.update({ where: args.where, data: args.data }),
    },
  };
}
