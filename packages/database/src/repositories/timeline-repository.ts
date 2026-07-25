import type { Timeline, TimelineEntry } from '@combat/domain';

export type TimelineRecord = Omit<Timeline, 'entries'>;
export type TimelineEntryRecord = TimelineEntry;
export type TimelineEntryInput = Omit<TimelineEntryRecord, 'id' | 'workspaceId' | 'timelineId'>;

/**
 * M10 persistence for the assembled `Timeline` (the frame-accurate cut the
 * SoundCues attach to). Built from the rough edit at SOUND_DESIGN; its
 * existence + version is what the `SoundCue` rows reference, and the campaign's
 * timelines are what `soundDesignComplete` joins through to find its cues.
 * Immutable + versioned per campaign; workspace-scoped.
 */
export interface TimelineDataSource {
  timeline: {
    create(args: { data: Omit<TimelineRecord, 'id' | 'createdAt'> }): Promise<TimelineRecord>;
    findFirst(args: {
      where:
        | { id: string; workspaceId: string }
        | { campaignId: string; version: number; workspaceId: string };
    }): Promise<TimelineRecord | null>;
    findMany(args: {
      where: { campaignId: string; workspaceId?: string };
    }): Promise<TimelineRecord[]>;
  };
  timelineEntry: {
    create(args: { data: Omit<TimelineEntryRecord, 'id'> }): Promise<TimelineEntryRecord>;
    findMany(args: { where: { timelineId: string } }): Promise<TimelineEntryRecord[]>;
  };
}

/** Idempotent per `(campaignId, version)`: a replay returns the existing timeline rather than inserting a duplicate. */
export async function createTimeline(
  db: TimelineDataSource,
  workspaceId: string,
  input: {
    campaignId: string;
    scriptId: string;
    version: number;
    frameRate: number;
    durationFrames: number;
    entries: readonly TimelineEntryInput[];
  },
): Promise<TimelineRecord> {
  const existing = await db.timeline.findFirst({
    where: { campaignId: input.campaignId, version: input.version, workspaceId },
  });
  if (existing) return existing;

  const timeline = await db.timeline.create({
    data: {
      workspaceId,
      campaignId: input.campaignId,
      scriptId: input.scriptId,
      version: input.version,
      frameRate: input.frameRate,
      durationFrames: input.durationFrames,
    },
  });
  for (const entry of input.entries) {
    // eslint-disable-next-line no-await-in-loop -- small, per-timeline set; sequential keeps order deterministic and only runs once per fresh timeline
    await db.timelineEntry.create({ data: { workspaceId, timelineId: timeline.id, ...entry } });
  }
  return timeline;
}

export async function getLatestTimeline(
  db: TimelineDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<TimelineRecord | undefined> {
  const rows = await db.timeline.findMany({ where: { campaignId, workspaceId } });
  return [...rows].sort((a, b) => b.version - a.version)[0];
}

export async function listTimelineEntries(
  db: TimelineDataSource,
  timelineId: string,
): Promise<TimelineEntryRecord[]> {
  const rows = await db.timelineEntry.findMany({ where: { timelineId } });
  return [...rows].sort((a, b) => a.order - b.order);
}
