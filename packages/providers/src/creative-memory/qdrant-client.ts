import { createHash } from 'node:crypto';

import type { ModelProfile as CreativeMemoryModelProfile } from './contracts';

/**
 * Qdrant client for Creative Memory vectors.
 *
 * REST contract verified against qdrant.tech/documentation (2026-07-27):
 * `PUT /collections/{name}` with `{ vectors: { size, distance } }`,
 * `GET /collections/{name}`, `DELETE /collections/{name}`,
 * `PUT /collections/{name}/points`, `POST /collections/{name}/points/search`
 * with `{ vector, limit, with_payload, filter: { must, should, must_not } }`,
 * and `POST /collections/{name}/points/delete`. Distance enum: `Dot`,
 * `Cosine`, `Euclid`, `Manhattan`.
 *
 * **Qdrant stores vectors and filterable payload only.** No path, no URL, no
 * credential, no transcript, no bytes. PostgreSQL remains canonical for
 * rights, provenance, annotations and state — a vector database is a search
 * index, and treating it as a second source of truth is how two systems start
 * disagreeing about what a reference is allowed to be used for.
 */

export const QDRANT_FAILURE_KINDS = [
  'UNAVAILABLE',
  'TIMEOUT',
  'REJECTED',
  'MALFORMED_RESPONSE',
  'DIMENSION_MISMATCH',
  'COLLECTION_MISSING',
] as const;
export type QdrantFailureKind = (typeof QDRANT_FAILURE_KINDS)[number];

export class QdrantError extends Error {
  constructor(
    public readonly kind: QdrantFailureKind,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'QdrantError';
  }
}

/**
 * Payload written alongside each vector. Filterable, non-secret metadata only.
 *
 * Deliberately excludes anything expressive or locating: no title, no agency,
 * no path, no annotation text. Those live in PostgreSQL and are joined back
 * after retrieval, under the caller's rights checks.
 */
export interface QdrantScenePayload {
  readonly workspaceId: string;
  readonly referenceId: string;
  readonly sceneId: string;
  readonly roleTags: readonly string[];
  readonly platform: string | null;
  readonly reviewStatus: string;
  readonly rightsClassification: string;
  /** Coarse bucket, so duration is filterable without leaking exact timings. */
  readonly durationBucket: string;
  readonly hookCategory: string;
  readonly narrativeStage: string;
  readonly ingestionVersion: number;
  readonly modelRevision: string;
}

export interface QdrantPoint {
  readonly id: string;
  readonly vector: readonly number[];
  readonly payload: QdrantScenePayload;
}

export interface QdrantSearchHit {
  readonly id: string;
  readonly score: number;
  readonly payload: QdrantScenePayload;
}

export interface QdrantFilterCondition {
  readonly key: string;
  readonly match:
    { readonly value: string | number | boolean } | { readonly any: readonly string[] };
}

export interface QdrantFilter {
  readonly must?: readonly QdrantFilterCondition[];
  readonly must_not?: readonly QdrantFilterCondition[];
}

export interface QdrantClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * A collection name that encodes everything a vector must agree on.
 *
 * Profile, model revision, dimension and document schema version are all in
 * the name, so vectors from different models can never share a collection —
 * the mismatch becomes a missing collection rather than silently incoherent
 * neighbours. Bumping any of them creates a new collection and leaves the old
 * one intact for rollback.
 */
export function collectionNameFor(profile: CreativeMemoryModelProfile): string {
  const revision = profile.embeddingRevision.replace(/[^A-Za-z0-9_-]/g, '_');
  return [
    'creative_memory',
    profile.profile.toLowerCase(),
    `rev_${revision}`,
    `d${profile.vectorDimension}`,
    `s${profile.documentSchemaVersion}`,
  ].join('__');
}

/**
 * Deterministic point id from workspace + scene + profile.
 *
 * Qdrant accepts an unsigned integer or a UUID; this derives a UUIDv5-shaped
 * value from a hash so re-indexing the same scene overwrites its point rather
 * than accumulating duplicates.
 */
export function pointIdFor(workspaceId: string, sceneId: string, profile: string): string {
  const hex = createHash('sha256').update(`${workspaceId}:${sceneId}:${profile}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Coarse duration bands, so timing is filterable without exposing exact values. */
export function durationBucketFor(seconds: number): string {
  if (seconds <= 6) return 'LE_6S';
  if (seconds <= 15) return 'LE_15S';
  if (seconds <= 30) return 'LE_30S';
  if (seconds <= 60) return 'LE_60S';
  return 'GT_60S';
}

export class QdrantClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: QdrantClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    const injected = options.fetchImpl ?? globalThis.fetch;
    if (typeof injected !== 'function') {
      throw new QdrantError('UNAVAILABLE', 'no fetch implementation is available');
    }
    this.fetchImpl = injected;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.options.apiKey ? { 'api-key': this.options.apiKey } : {}),
    };
  }

  /** Strips the API key from anything that might be logged or persisted. */
  private redact(text: string): string {
    return this.options.apiKey ? text.split(this.options.apiKey).join('***REDACTED***') : text;
  }

  private async request(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let json: unknown = null;
      if (text.trim().length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          // Not fatal here. Qdrant answers some errors (notably an
          // authentication refusal) with a plain-text body, and turning that
          // into a parse error would report "malformed response" for what is
          // really "401". Callers that need parsed data check the shape and
          // raise their own, more accurate, failure.
          json = null;
        }
      }
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof QdrantError) throw error;
      if (controller.signal.aborted) {
        throw new QdrantError('TIMEOUT', `Qdrant ${method} ${path} exceeded ${this.timeoutMs}ms`);
      }
      throw new QdrantError(
        'UNAVAILABLE',
        `Qdrant is unreachable at ${this.baseUrl}`,
        this.redact(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const { status } = await this.request('GET', '/healthz');
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  }

  async collectionExists(name: string): Promise<boolean> {
    const { status } = await this.request('GET', `/collections/${encodeURIComponent(name)}`);
    return status >= 200 && status < 300;
  }

  /** Returns the configured vector width, or null when the collection is absent. */
  async collectionDimension(name: string): Promise<number | null> {
    const { status, json } = await this.request('GET', `/collections/${encodeURIComponent(name)}`);
    if (status === 404) return null;
    const size = (json as { result?: { config?: { params?: { vectors?: { size?: unknown } } } } })
      ?.result?.config?.params?.vectors?.size;
    return typeof size === 'number' ? size : null;
  }

  /**
   * Creates the collection if absent, and refuses to proceed when an existing
   * one has a different vector width — that mismatch means the profile or the
   * document schema changed without the collection name changing, and writing
   * into it would mix incomparable vectors.
   */
  async ensureCollection(name: string, dimension: number): Promise<{ created: boolean }> {
    const existing = await this.collectionDimension(name);
    if (existing !== null) {
      if (existing !== dimension) {
        throw new QdrantError(
          'DIMENSION_MISMATCH',
          `collection "${name}" holds ${existing}-dimensional vectors but this profile produces ${dimension}`,
        );
      }
      return { created: false };
    }

    const { status, json } = await this.request('PUT', `/collections/${encodeURIComponent(name)}`, {
      vectors: { size: dimension, distance: 'Cosine' },
    });
    if (status < 200 || status >= 300) {
      throw new QdrantError(
        'REJECTED',
        `Qdrant refused to create collection "${name}" (HTTP ${status})`,
        this.redact(JSON.stringify(json).slice(0, 300)),
      );
    }
    return { created: true };
  }

  async deleteCollection(name: string): Promise<void> {
    await this.request('DELETE', `/collections/${encodeURIComponent(name)}`);
  }

  /** Idempotent by construction: point ids are deterministic, so a repeat overwrites. */
  async upsertPoints(name: string, points: readonly QdrantPoint[]): Promise<void> {
    if (points.length === 0) return;
    const { status, json } = await this.request(
      'PUT',
      `/collections/${encodeURIComponent(name)}/points?wait=true`,
      {
        points: points.map((point) => ({
          id: point.id,
          vector: [...point.vector],
          payload: point.payload,
        })),
      },
    );
    if (status < 200 || status >= 300) {
      throw new QdrantError(
        'REJECTED',
        `Qdrant refused an upsert into "${name}" (HTTP ${status})`,
        this.redact(JSON.stringify(json).slice(0, 300)),
      );
    }
  }

  async search(
    name: string,
    vector: readonly number[],
    limit: number,
    filter?: QdrantFilter,
  ): Promise<readonly QdrantSearchHit[]> {
    const { status, json } = await this.request(
      'POST',
      `/collections/${encodeURIComponent(name)}/points/search`,
      {
        vector: [...vector],
        limit,
        with_payload: true,
        ...(filter ? { filter } : {}),
      },
    );

    if (status === 404) {
      throw new QdrantError(
        'COLLECTION_MISSING',
        `collection "${name}" does not exist — index first`,
      );
    }
    if (status < 200 || status >= 300) {
      throw new QdrantError(
        'REJECTED',
        `Qdrant refused a search on "${name}" (HTTP ${status})`,
        this.redact(JSON.stringify(json).slice(0, 300)),
      );
    }

    const result = (json as { result?: unknown }).result;
    if (!Array.isArray(result)) {
      throw new QdrantError('MALFORMED_RESPONSE', 'Qdrant search returned no result array');
    }

    return result.map((hit) => {
      const id = (hit as { id?: unknown }).id;
      const score = (hit as { score?: unknown }).score;
      const payload = (hit as { payload?: unknown }).payload;
      if (typeof score !== 'number' || typeof payload !== 'object' || payload === null) {
        throw new QdrantError('MALFORMED_RESPONSE', 'Qdrant returned a malformed search hit');
      }
      return { id: String(id), score, payload: payload as QdrantScenePayload };
    });
  }

  /** Tombstones by point id. Used when a reference is withdrawn or re-profiled. */
  async deletePoints(name: string, pointIds: readonly string[]): Promise<void> {
    if (pointIds.length === 0) return;
    await this.request('POST', `/collections/${encodeURIComponent(name)}/points/delete?wait=true`, {
      points: [...pointIds],
    });
  }

  async countPoints(name: string, filter?: QdrantFilter): Promise<number> {
    const { status, json } = await this.request(
      'POST',
      `/collections/${encodeURIComponent(name)}/points/count`,
      { exact: true, ...(filter ? { filter } : {}) },
    );
    if (status === 404) return 0;
    const count = (json as { result?: { count?: unknown } })?.result?.count;
    return typeof count === 'number' ? count : 0;
  }
}
