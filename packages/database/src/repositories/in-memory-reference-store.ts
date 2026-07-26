import { randomUUID } from 'node:crypto';

import type { ReferenceDataSource } from './reference-repository';

/**
 * An in-memory `ReferenceDataSource`, mirroring `InMemoryCampaignStore`'s role
 * for the production side: it lets the ingestion pipeline and its tests run
 * without a live PostgreSQL, while still exercising the real repository
 * functions rather than a re-implementation of them.
 *
 * It deliberately mirrors the **constraints** the migration declares, not just
 * the shape — `(workspaceId, referenceKey)`, `(workspaceId, checksumSha256)`
 * and `(referenceAdvertisementId, sceneIndex)` all throw on violation here. A
 * store that accepts writes Postgres would reject is worse than no store,
 * because it lets a duplicate-detection bug pass its tests and fail in
 * production.
 */
export class InMemoryReferenceStore implements ReferenceDataSource {
  private readonly tables = new Map<string, Map<string, Record<string, unknown>>>();

  private table(name: string): Map<string, Record<string, unknown>> {
    let table = this.tables.get(name);
    if (!table) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  private rows(name: string): Record<string, unknown>[] {
    return [...this.table(name).values()];
  }

  private matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, expected]) => {
      const actual = row[key];
      if (expected !== null && typeof expected === 'object') {
        // Supports the `{ has: value }` array filter the repository uses for roles.
        const has = (expected as { has?: unknown }).has;
        if (has !== undefined) return Array.isArray(actual) && actual.includes(has);
        return false;
      }
      return actual === expected;
    });
  }

  private insert(
    name: string,
    data: Record<string, unknown>,
    unique: readonly (readonly string[])[] = [],
  ): Record<string, unknown> {
    for (const keys of unique) {
      const clash = this.rows(name).find((row) => keys.every((key) => row[key] === data[key]));
      if (clash) {
        throw new Error(
          `Unique constraint failed on ${name}(${keys.join(', ')}) — a row with these values already exists`,
        );
      }
    }
    const now = new Date();
    const row = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...data,
    } as Record<string, unknown>;
    this.table(name).set(row.id as string, row);
    return row;
  }

  private makeDelegate<T>(
    name: string,
    unique: readonly (readonly string[])[] = [],
  ): {
    create(args: { data: Record<string, unknown> }): Promise<T>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<T>;
    findFirst(args: { where: Record<string, unknown> }): Promise<T | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<T[]>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  } {
    // Arrow functions throughout, so `this` is captured lexically rather than
    // aliased into a local.
    return {
      create: async ({ data }) => this.insert(name, data, unique) as T,
      update: async ({ where, data }) => {
        const row = this.table(name).get(where.id);
        if (!row) throw new Error(`${name} ${where.id} not found`);
        // Prisma treats an explicit null as "clear this column".
        for (const [key, value] of Object.entries(data)) {
          if (value === null) delete row[key];
          else row[key] = value;
        }
        row.updatedAt = new Date();
        return row as T;
      },
      findFirst: async ({ where }) =>
        (this.rows(name).find((row) => this.matches(row, where)) ?? null) as T | null,
      findMany: async ({ where, orderBy }) => {
        const found = this.rows(name).filter((row) => this.matches(row, where));
        if (orderBy) {
          const [[key, direction]] = Object.entries(orderBy) as [[string, string]];
          found.sort((a, b) => {
            const left = a[key] as number | string | Date;
            const right = b[key] as number | string | Date;
            const order = left < right ? -1 : left > right ? 1 : 0;
            return direction === 'desc' ? -order : order;
          });
        }
        return found as T[];
      },
      deleteMany: async ({ where }) => {
        const doomed = this.rows(name).filter((row) => this.matches(row, where));
        for (const row of doomed) this.table(name).delete(row.id as string);
        return { count: doomed.length };
      },
    };
  }

  readonly referenceSource = this.makeDelegate<never>('referenceSource');
  readonly referenceAdvertisement = this.makeDelegate<never>('referenceAdvertisement', [
    ['workspaceId', 'referenceKey'],
  ]);
  readonly referenceMedia = this.makeDelegate<never>('referenceMedia', [
    ['workspaceId', 'checksumSha256'],
    ['referenceAdvertisementId'],
  ]);
  readonly referenceScene = this.makeDelegate<never>('referenceScene', [
    ['referenceAdvertisementId', 'sceneIndex'],
  ]);
  readonly referenceFrame = this.makeDelegate<never>('referenceFrame', [
    ['referenceAdvertisementId', 'referenceSceneId', 'kind'],
  ]);
  readonly referenceTranscript = this.makeDelegate<never>('referenceTranscript', [
    ['referenceAdvertisementId', 'provider', 'model'],
  ]);
  readonly referenceCraftMetrics = this.makeDelegate<never>('referenceCraftMetrics', [
    ['referenceAdvertisementId'],
  ]);
  readonly referenceAnnotation = this.makeDelegate<never>('referenceAnnotation', [
    ['referenceAdvertisementId', 'version'],
  ]);
  readonly referenceIngestionRun = this.makeDelegate<never>('referenceIngestionRun', [
    ['workspaceId', 'idempotencyKey'],
  ]);
  readonly referenceDerivedArtifact = this.makeDelegate<never>('referenceDerivedArtifact', [
    ['referenceAdvertisementId', 'kind', 'localPath'],
  ]);

  /** Test helper: every row of a table, for assertions. */
  snapshot(name: string): Record<string, unknown>[] {
    return this.rows(name);
  }
}
