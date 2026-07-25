import type { PrismaClient, SoundDesignDataSource, TimelineDataSource } from '@combat/database';
import {
  createShotGenerationDatabase,
  type ShotGenerationDatabase,
} from './shot-generation-database';

/**
 * The M10 sound-design read route's data-source contract: campaign/membership/
 * budget/script (shot-generation adapter) plus the M10 timeline + sound-design
 * tables. Same "adapt a real PrismaClient to the narrow *DataSource interfaces"
 * pattern as its siblings; tests inject an in-memory fake.
 */
export type SoundDesignDatabase = ShotGenerationDatabase &
  TimelineDataSource &
  SoundDesignDataSource;

function undef<T>(v: T | null): T | undefined {
  return v ?? undefined;
}

export function createSoundDesignDatabase(prisma: PrismaClient): SoundDesignDatabase {
  return {
    ...createShotGenerationDatabase(prisma),
    timeline: {
      create: async (args) => prisma.timeline.create({ data: args.data as never }) as never,
      findFirst: async (args) => prisma.timeline.findFirst({ where: args.where as never }) as never,
      findMany: async (args) => prisma.timeline.findMany({ where: args.where }) as never,
    },
    timelineEntry: {
      create: async (args) => prisma.timelineEntry.create({ data: args.data as never }) as never,
      findMany: async (args) => prisma.timelineEntry.findMany({ where: args.where }) as never,
    },
    soundDesignPlan: {
      create: async (args) => prisma.soundDesignPlan.create({ data: args.data as never }) as never,
      findFirst: async (args) =>
        prisma.soundDesignPlan.findFirst({ where: args.where as never }) as never,
      findMany: async (args) => prisma.soundDesignPlan.findMany({ where: args.where }) as never,
    },
    soundCue: {
      create: async (args) => mapCue(await prisma.soundCue.create({ data: args.data as never })),
      findMany: async (args) =>
        (await prisma.soundCue.findMany({ where: args.where as never })).map(mapCue),
    },
  };
}

function mapCue(row: { assetId: string | null; notes: string | null; [k: string]: unknown }) {
  return { ...row, assetId: undef(row.assetId), notes: undef(row.notes) } as never;
}
