import type { PrismaClient } from '@combat/database';
import type {
  CampaignDataSource,
  HumanApprovalDataSource,
  MembershipDataSource,
} from '@combat/database';
import type { RoleName } from '@combat/domain';

export type ApprovalDatabase = CampaignDataSource & HumanApprovalDataSource & MembershipDataSource;

/**
 * Adapts a real `PrismaClient` to the narrow `*DataSource` interfaces the
 * repository layer (and these routes) are written against. Needed because
 * Prisma's generated types return `null` for nullable columns
 * (`HumanApproval.comments`/`repairTarget`), while the repository record
 * types declare those fields as optional (`?: string`, i.e. `string |
 * undefined`) — `null` isn't structurally assignable to `undefined`, so a
 * raw `PrismaClient` doesn't satisfy `HumanApprovalDataSource` as-is. This is
 * the one place that gap is bridged; nothing in `packages/database` changes.
 */
export function createApprovalDatabase(prisma: PrismaClient): ApprovalDatabase {
  return {
    campaign: {
      // `idempotencyKey` is nullable in Prisma (`String?`) but optional
      // (`| undefined`) in CampaignRecord — same null-vs-undefined bridge
      // as humanApproval below, just for a field added after this adapter
      // was first written (M4).
      create: async (args) => {
        const created = await prisma.campaign.create(args);
        return { ...created, idempotencyKey: created.idempotencyKey ?? undefined };
      },
      findFirst: async (args) => {
        const found = await prisma.campaign.findFirst(args);
        return found ? { ...found, idempotencyKey: found.idempotencyKey ?? undefined } : null;
      },
      findMany: async (args) => {
        const rows = await prisma.campaign.findMany(args);
        return rows.map((row) => ({ ...row, idempotencyKey: row.idempotencyKey ?? undefined }));
      },
    },
    humanApproval: {
      create: async (args) => {
        const created = await prisma.humanApproval.create(args);
        return {
          ...created,
          comments: created.comments ?? undefined,
          repairTarget: created.repairTarget ?? undefined,
        };
      },
      findMany: async (args) => {
        const rows = await prisma.humanApproval.findMany(args);
        return rows.map((row) => ({
          ...row,
          comments: row.comments ?? undefined,
          repairTarget: row.repairTarget ?? undefined,
        }));
      },
    },
    membership: {
      findFirst: (args) => prisma.membership.findFirst(args),
      findMany: (args) => prisma.membership.findMany(args),
      create: (args) =>
        prisma.membership.create({
          data: { ...args.data, role: args.data.role as RoleName },
        }),
    },
  };
}
