import type { SoundCue, SoundDesignPlan } from '@combat/domain';

export type SoundDesignPlanRecord = SoundDesignPlan;
export type SoundCueRecord = SoundCue;
export type SoundCueInput = Omit<SoundCueRecord, 'id' | 'workspaceId' | 'createdAt'>;

/**
 * M10 persistence for the Sound Director's output — an immutable, versioned
 * `SoundDesignPlan` (music brief + mix notes + provenance) and its concrete
 * `SoundCue` rows (each may carry a `SOUND_STEM` asset). The existence of
 * SoundCues on the campaign's timeline is what `soundDesignComplete` reads,
 * letting the campaign advance out of SOUND_DESIGN. Workspace-scoped.
 */
export interface SoundDesignDataSource {
  soundDesignPlan: {
    create(args: {
      data: Omit<SoundDesignPlanRecord, 'id' | 'createdAt'>;
    }): Promise<SoundDesignPlanRecord>;
    findFirst(args: {
      where:
        | { id: string; workspaceId: string }
        | { campaignId: string; version: number; workspaceId: string };
    }): Promise<SoundDesignPlanRecord | null>;
    findMany(args: {
      where: { campaignId: string; workspaceId?: string };
    }): Promise<SoundDesignPlanRecord[]>;
  };
  soundCue: {
    create(args: { data: Omit<SoundCueRecord, 'id' | 'createdAt'> }): Promise<SoundCueRecord>;
    findMany(args: {
      where: { timelineId: string } | { timelineId: { in: string[] } };
    }): Promise<SoundCueRecord[]>;
  };
}

/** Idempotent per `(campaignId, version)`: a replay returns the existing plan rather than inserting a duplicate. */
export async function createSoundDesignPlan(
  db: SoundDesignDataSource,
  workspaceId: string,
  input: Omit<SoundDesignPlanRecord, 'id' | 'createdAt' | 'workspaceId'>,
): Promise<SoundDesignPlanRecord> {
  const existing = await db.soundDesignPlan.findFirst({
    where: { campaignId: input.campaignId, version: input.version, workspaceId },
  });
  if (existing) return existing;
  return db.soundDesignPlan.create({ data: { workspaceId, ...input } });
}

export async function getLatestSoundDesignPlan(
  db: SoundDesignDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<SoundDesignPlanRecord | undefined> {
  const rows = await db.soundDesignPlan.findMany({ where: { campaignId, workspaceId } });
  return [...rows].sort((a, b) => b.version - a.version)[0];
}

export async function createSoundCue(
  db: SoundDesignDataSource,
  workspaceId: string,
  input: SoundCueInput,
): Promise<SoundCueRecord> {
  return db.soundCue.create({ data: { workspaceId, ...input } });
}

export async function listSoundCuesForTimeline(
  db: SoundDesignDataSource,
  timelineId: string,
): Promise<SoundCueRecord[]> {
  const rows = await db.soundCue.findMany({ where: { timelineId } });
  return [...rows].sort((a, b) => a.startFrame - b.startFrame);
}
