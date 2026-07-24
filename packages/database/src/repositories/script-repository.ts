import type { Script, Shot } from '@combat/domain';

export type ScriptRecord = Script;
export type ShotRecord = Shot;

/** `workspaceId` optional on the where clause for the same reason as creative-concept-repository.ts — structural compatibility with TransitionFactsDataSource's narrower query shape. */
export interface ScriptDataSource {
  script: {
    create(args: { data: Omit<ScriptRecord, 'id' | 'createdAt'> }): Promise<ScriptRecord>;
    findMany(args: {
      where: { campaignId: string; workspaceId?: string };
    }): Promise<ScriptRecord[]>;
  };
}

/** Reuses TransitionFactsDataSource's exact `{ scriptId: { in: string[] } }` query shape to stay structurally compatible with one fake implementation. */
export interface ShotDataSource {
  shot: {
    create(args: { data: Omit<ShotRecord, 'id' | 'createdAt' | 'updatedAt'> }): Promise<ShotRecord>;
    findMany(args: { where: { scriptId: { in: string[] } } }): Promise<ShotRecord[]>;
    update(args: {
      where: { id: string };
      data: { dependsOnShotIds: string[] };
    }): Promise<ShotRecord>;
  };
}

export interface ScriptWithShotsDataSource extends ScriptDataSource, ShotDataSource {}

export interface ScriptShotInput {
  index: number;
  description: string;
  durationFrames: number;
  beat: Shot['beat'];
  /** Other shots' `index` values (not yet-assigned row ids) this shot depends on — resolved to `dependsOnShotIds` after all shots in the batch are created. */
  dependsOnShotIndices: number[];
}

/**
 * Persists a Script and its Shots as one versioned unit. Idempotent: if
 * `(campaignId, version)` already has a Script row (an Activity retry after
 * a prior attempt persisted it), returns that script and its already-created
 * shots instead of re-inserting.
 *
 * Shots are created in two passes because `dependsOnShotIds` references
 * sibling shots by their (DB-assigned) id, which doesn't exist until after
 * insert — the agent output only knows sibling shots by `index`.
 */
export async function createScriptWithShots(
  db: ScriptWithShotsDataSource,
  workspaceId: string,
  input: {
    campaignId: string;
    creativeConceptId: string;
    version: number;
    totalDurationFrames: number;
    shots: ScriptShotInput[];
  },
): Promise<{ script: ScriptRecord; shots: ShotRecord[] }> {
  const existingScripts = await db.script.findMany({
    where: { campaignId: input.campaignId, workspaceId },
  });
  const existingMatch = existingScripts.find((s) => s.version === input.version);
  if (existingMatch) {
    const shots = await db.shot.findMany({ where: { scriptId: { in: [existingMatch.id] } } });
    return { script: existingMatch, shots };
  }

  const script = await db.script.create({
    data: {
      workspaceId,
      campaignId: input.campaignId,
      creativeConceptId: input.creativeConceptId,
      version: input.version,
      totalDurationFrames: input.totalDurationFrames,
    },
  });

  const created: { shotInput: ScriptShotInput; shot: ShotRecord }[] = [];
  for (const shotInput of input.shots) {
    // eslint-disable-next-line no-await-in-loop -- shots must be inserted sequentially so index->id resolution below is deterministic
    const shot = await db.shot.create({
      data: {
        workspaceId,
        scriptId: script.id,
        index: shotInput.index,
        description: shotInput.description,
        durationFrames: shotInput.durationFrames,
        beat: shotInput.beat,
        status: 'PENDING',
        dependsOnShotIds: [],
      },
    });
    created.push({ shotInput, shot });
  }

  const idByIndex = new Map(created.map(({ shot }) => [shot.index, shot.id]));
  const resolved: ShotRecord[] = [];
  for (const { shotInput, shot } of created) {
    const dependsOnShotIds = shotInput.dependsOnShotIndices
      .map((idx) => idByIndex.get(idx))
      .filter((id): id is string => id !== undefined);
    if (dependsOnShotIds.length === 0) {
      resolved.push(shot);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- same sequencing rationale as the create loop above
    const updated = await db.shot.update({ where: { id: shot.id }, data: { dependsOnShotIds } });
    resolved.push(updated);
  }

  return { script, shots: resolved };
}

export async function listScripts(
  db: ScriptDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<ScriptRecord[]> {
  return db.script.findMany({ where: { campaignId, workspaceId } });
}

export async function getLatestScript(
  db: ScriptDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<ScriptRecord | undefined> {
  const scripts = await listScripts(db, workspaceId, campaignId);
  return [...scripts].sort((a, b) => b.version - a.version)[0];
}

export async function listShotsForScript(
  db: ShotDataSource,
  scriptId: string,
): Promise<ShotRecord[]> {
  return db.shot.findMany({ where: { scriptId: { in: [scriptId] } } });
}
