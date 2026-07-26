/**
 * Index-entry persistence for Creative Memory.
 *
 * `creative_memory_index_runs` and `creative_memory_index_entries` were created
 * by the retrieval migration and `indexWorkspace` has always accepted
 * `recordEntry`/`previousHash` seams for them — but nothing ever passed those
 * seams, so the tables stayed empty and every re-index re-embedded every scene.
 * This repository is what fills them.
 *
 * Two properties matter and are enforced here rather than left to the caller:
 *
 * - **One entry per `(scene, profile)`.** The migration declares that unique
 *   constraint, so re-indexing must update in place. A `create` that raced or
 *   repeated would accumulate rows and quietly make the "was this scene already
 *   indexed" answer ambiguous.
 * - **Failure detail is redacted before it is written.** A Qdrant or embedding
 *   endpoint failure message can carry the URL that produced it, and a URL can
 *   carry a credential. PostgreSQL is the audit trail, not a place to park one.
 *
 * The profile is stored as the Prisma `CreativeMemoryProfile` enum, so a
 * profile name this schema does not know is refused at the boundary instead of
 * landing as an unreadable string.
 */

export const CREATIVE_MEMORY_INDEX_PROFILES = [
  'STRUCTURAL_BASELINE_V1',
  'QWEN3_VL_2B_QUALITY_V1',
  'QWEN3_VL_8B_REMOTE_QUALITY_V1',
] as const;
export type CreativeMemoryIndexProfile = (typeof CREATIVE_MEMORY_INDEX_PROFILES)[number];

export const CREATIVE_MEMORY_INDEX_STATES = [
  'PENDING',
  'INDEXING',
  'INDEXED',
  'STALE',
  'DELETED',
  'FAILED',
] as const;
export type CreativeMemoryIndexState = (typeof CREATIVE_MEMORY_INDEX_STATES)[number];

export const CREATIVE_MEMORY_INDEX_FAILURE_TYPES = [
  'EMBEDDING_FAILED',
  'DIMENSION_MISMATCH',
  'INVALID_VECTOR',
  'QDRANT_UNAVAILABLE',
  'UPSERT_FAILED',
  'INELIGIBLE',
] as const;
export type CreativeMemoryIndexFailureType = (typeof CREATIVE_MEMORY_INDEX_FAILURE_TYPES)[number];

export interface CreativeMemoryIndexRunRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly profile: string;
  readonly qdrantCollection: string;
  readonly startedAt: Date;
  readonly completedAt?: Date | null;
  readonly indexedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
}

export interface CreativeMemoryIndexEntryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly referenceSceneId: string;
  readonly referenceAdvertisementId: string;
  readonly profile: string;
  readonly modelRevision: string;
  readonly vectorDimension: number;
  readonly embeddingInputHash: string;
  readonly vectorChecksum: string;
  readonly qdrantCollection: string;
  readonly qdrantPointId: string;
  readonly state: string;
  readonly indexedAt?: Date | null;
  readonly lastVerifiedAt?: Date | null;
  readonly failureType?: string | null;
  readonly failureDetail?: string | null;
  readonly indexRunId?: string | null;
}

/**
 * The delegates this repository needs. Structural, like every other
 * `*DataSource` here, so a real `PrismaClient` and the in-memory store both
 * satisfy it without either importing the other.
 */
export interface CreativeMemoryIndexDataSource {
  creativeMemoryIndexRun: {
    create(args: { data: Record<string, unknown> }): Promise<CreativeMemoryIndexRunRecord>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<CreativeMemoryIndexRunRecord>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<CreativeMemoryIndexRunRecord[]>;
  };
  creativeMemoryIndexEntry: {
    create(args: { data: Record<string, unknown> }): Promise<CreativeMemoryIndexEntryRecord>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<CreativeMemoryIndexEntryRecord>;
    findFirst(args: {
      where: Record<string, unknown>;
    }): Promise<CreativeMemoryIndexEntryRecord | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<CreativeMemoryIndexEntryRecord[]>;
  };
}

export class CreativeMemoryIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreativeMemoryIndexError';
  }
}

function assertProfile(profile: string): CreativeMemoryIndexProfile {
  if (!(CREATIVE_MEMORY_INDEX_PROFILES as readonly string[]).includes(profile)) {
    throw new CreativeMemoryIndexError(
      `unknown Creative Memory profile "${profile}" — the index tables store a known enum member, never an arbitrary string`,
    );
  }
  return profile as CreativeMemoryIndexProfile;
}

/**
 * Strips anything URL-shaped or key-shaped out of a failure message.
 *
 * A provider's own error text is the single most likely carrier of an endpoint
 * credential into durable storage, and it arrives here already stringified, so
 * a field-name allowlist cannot help. Pattern removal is the blunt instrument
 * that actually works at this boundary.
 */
export function redactIndexFailureDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  return (
    detail
      .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']+/g, '[REDACTED_URL]')
      .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]')
      // Anything introduced as a credential, whatever it looks like. A short
      // secret is still a secret, and no length heuristic can recognise one —
      // but the word in front of it almost always can.
      .replace(
        /\b(api[-_ ]?key|apikey|token|password|passphrase|secret|credential)\b[\s:=]*\S+/gi,
        '$1 [REDACTED]',
      )
      // Backstop for a long opaque blob that arrived with no label at all.
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED_TOKEN]')
      .slice(0, 500)
  );
}

export async function startCreativeMemoryIndexRun(
  db: CreativeMemoryIndexDataSource,
  workspaceId: string,
  input: { readonly profile: string; readonly qdrantCollection: string; readonly startedAt: Date },
): Promise<CreativeMemoryIndexRunRecord> {
  return db.creativeMemoryIndexRun.create({
    data: {
      workspaceId,
      profile: assertProfile(input.profile),
      qdrantCollection: input.qdrantCollection,
      startedAt: input.startedAt,
    },
  });
}

export async function completeCreativeMemoryIndexRun(
  db: CreativeMemoryIndexDataSource,
  runId: string,
  counts: {
    readonly indexedCount: number;
    readonly skippedCount: number;
    readonly failedCount: number;
    readonly completedAt: Date;
  },
): Promise<CreativeMemoryIndexRunRecord> {
  return db.creativeMemoryIndexRun.update({ where: { id: runId }, data: { ...counts } });
}

export interface RecordIndexEntryInput {
  readonly referenceSceneId: string;
  readonly referenceAdvertisementId: string;
  readonly profile: string;
  readonly modelRevision: string;
  readonly vectorDimension: number;
  readonly embeddingInputHash: string;
  readonly vectorChecksum: string;
  readonly qdrantCollection: string;
  readonly qdrantPointId: string;
  readonly state: CreativeMemoryIndexState;
  readonly at: Date;
  readonly failureType?: CreativeMemoryIndexFailureType;
  readonly failureDetail?: string;
  readonly indexRunId?: string;
}

/**
 * Writes, or updates in place, the one row that exists per `(scene, profile)`.
 *
 * Deliberately a read-then-write rather than a Prisma `upsert`: the in-memory
 * store implements the same four delegates every other repository here uses,
 * and adding `upsert` to that surface for one call site would widen the seam
 * the whole package is typed against. The unique constraint still backstops a
 * genuine race — the second writer's `create` fails, which is the correct
 * outcome, not a silently duplicated row.
 */
export async function recordCreativeMemoryIndexEntry(
  db: CreativeMemoryIndexDataSource,
  workspaceId: string,
  input: RecordIndexEntryInput,
): Promise<CreativeMemoryIndexEntryRecord> {
  const profile = assertProfile(input.profile);
  const failureDetail = redactIndexFailureDetail(input.failureDetail);
  const common = {
    modelRevision: input.modelRevision,
    vectorDimension: input.vectorDimension,
    embeddingInputHash: input.embeddingInputHash,
    vectorChecksum: input.vectorChecksum,
    qdrantCollection: input.qdrantCollection,
    qdrantPointId: input.qdrantPointId,
    state: input.state,
    indexedAt: input.state === 'INDEXED' ? input.at : null,
    lastVerifiedAt: input.at,
    failureType: input.failureType ?? null,
    failureDetail: failureDetail ?? null,
    indexRunId: input.indexRunId ?? null,
  };

  const existing = await db.creativeMemoryIndexEntry.findFirst({
    where: { workspaceId, referenceSceneId: input.referenceSceneId, profile },
  });
  if (existing) {
    return db.creativeMemoryIndexEntry.update({ where: { id: existing.id }, data: common });
  }
  return db.creativeMemoryIndexEntry.create({
    data: {
      workspaceId,
      referenceSceneId: input.referenceSceneId,
      referenceAdvertisementId: input.referenceAdvertisementId,
      profile,
      ...common,
    },
  });
}

/**
 * The hash recorded last time this scene was embedded under this profile.
 *
 * Only an `INDEXED` entry counts. A `FAILED` or `STALE` row records that an
 * attempt happened, and returning its hash would make the next run skip a scene
 * that is not actually in the collection.
 */
export async function previousIndexInputHash(
  db: CreativeMemoryIndexDataSource,
  workspaceId: string,
  sceneId: string,
  profile: string,
): Promise<string | undefined> {
  const entry = await db.creativeMemoryIndexEntry.findFirst({
    where: { workspaceId, referenceSceneId: sceneId, profile: assertProfile(profile) },
  });
  if (!entry || entry.state !== 'INDEXED') return undefined;
  return entry.embeddingInputHash;
}

export async function listCreativeMemoryIndexEntries(
  db: CreativeMemoryIndexDataSource,
  workspaceId: string,
  filter: { readonly profile?: string; readonly state?: CreativeMemoryIndexState } = {},
): Promise<CreativeMemoryIndexEntryRecord[]> {
  return db.creativeMemoryIndexEntry.findMany({
    where: {
      workspaceId,
      ...(filter.profile ? { profile: assertProfile(filter.profile) } : {}),
      ...(filter.state ? { state: filter.state } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
}
