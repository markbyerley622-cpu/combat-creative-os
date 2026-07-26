import {
  cosineSimilarity,
  QdrantClient,
  type QdrantFilter,
  type QdrantPoint,
  type QdrantScenePayload,
} from '@combat/providers';

/**
 * An in-process stand-in for Qdrant, used by the ranking benchmark.
 *
 * It exists so the benchmark can assert *ranking* quickly and hermetically.
 * It is emphatically **not** evidence that the integration works — that is
 * what `qdrant-acceptance.test.ts` proves against a real server, per the
 * milestone's requirement that the acceptance test use real Qdrant.
 *
 * Implemented by intercepting `fetch` and serving the same REST surface the
 * real client speaks, so the benchmark exercises the actual `QdrantClient`
 * rather than a parallel implementation of it.
 */
export class InMemoryQdrant {
  private readonly collections = new Map<
    string,
    { dimension: number; points: Map<string, QdrantPoint> }
  >();

  asClient(): QdrantClient {
    return new QdrantClient({ baseUrl: 'http://in-memory', fetchImpl: this.fetchImpl });
  }

  private matches(payload: QdrantScenePayload, filter?: QdrantFilter): boolean {
    for (const condition of filter?.must ?? []) {
      const actual = (payload as unknown as Record<string, unknown>)[condition.key];
      const match = condition.match as { value?: unknown; any?: readonly string[] };
      if (match.value !== undefined) {
        // An array payload field matches when it contains the value — the same
        // semantics Qdrant gives `roleTags`.
        const ok = Array.isArray(actual) ? actual.includes(match.value) : actual === match.value;
        if (!ok) return false;
      }
      if (match.any && !match.any.includes(String(actual))) return false;
    }
    return true;
  }

  private readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/healthz') return json({ status: 'ok' });

    const collectionMatch = /^\/collections\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!collectionMatch) return json({ status: { error: 'not found' } }, 404);
    const name = decodeURIComponent(collectionMatch[1] as string);
    const suffix = collectionMatch[2] ?? '';
    const existing = this.collections.get(name);

    if (suffix === '' && method === 'PUT') {
      const size = (body.vectors as { size?: number } | undefined)?.size ?? 0;
      this.collections.set(name, { dimension: size, points: new Map() });
      return json({ result: true });
    }
    if (suffix === '' && method === 'GET') {
      if (!existing) return json({ status: { error: 'not found' } }, 404);
      return json({ result: { config: { params: { vectors: { size: existing.dimension } } } } });
    }
    if (suffix === '' && method === 'DELETE') {
      this.collections.delete(name);
      return json({ result: true });
    }

    if (!existing) return json({ status: { error: 'not found' } }, 404);

    if (suffix.startsWith('/points') && method === 'PUT') {
      for (const point of (body.points as QdrantPoint[]) ?? []) {
        existing.points.set(point.id, point);
      }
      return json({ result: { status: 'completed' } });
    }
    if (suffix.startsWith('/points/search')) {
      const vector = (body.vector as number[]) ?? [];
      const filter = body.filter as QdrantFilter | undefined;
      const limit = (body.limit as number) ?? 10;
      const hits = [...existing.points.values()]
        .filter((point) => this.matches(point.payload, filter))
        .map((point) => ({
          id: point.id,
          score: cosineSimilarity(vector, point.vector),
          payload: point.payload,
        }))
        // Descending score, then id, so the benchmark is deterministic.
        .sort((a, b) => (b.score === a.score ? a.id.localeCompare(b.id) : b.score - a.score))
        .slice(0, limit);
      return json({ result: hits });
    }
    if (suffix.startsWith('/points/delete')) {
      for (const id of (body.points as string[]) ?? []) existing.points.delete(id);
      return json({ result: { status: 'completed' } });
    }
    if (suffix.startsWith('/points/count')) {
      const filter = body.filter as QdrantFilter | undefined;
      const count = [...existing.points.values()].filter((point) =>
        this.matches(point.payload, filter),
      ).length;
      return json({ result: { count } });
    }

    return json({ status: { error: 'unhandled' } }, 404);
  };
}
