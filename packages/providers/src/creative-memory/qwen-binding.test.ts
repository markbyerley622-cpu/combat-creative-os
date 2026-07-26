import { describe, expect, it } from 'vitest';

import {
  Qwen3VlEmbeddingProvider,
  Qwen3VlRerankerProvider,
  QWEN3_VL_DIMENSIONS,
  QWEN3_VL_EMBEDDING_2B,
  QWEN3_VL_RERANKER_2B,
} from './qwen3-vl';
import { assertUsableVector, EmbeddingError } from './embedding';
import { RerankingError } from './reranking';

/**
 * Qwen3-VL binding tests.
 *
 * Split in two. The **offline** block always runs and covers everything that
 * can be proven without a model: dimension constants against the official
 * repository, malformed-response handling, timeout handling, model-mismatch
 * refusal and modality bounds — all driven through an injected `fetch`.
 *
 * The **live** block is opt-in and requires a real endpoint. It skips loudly
 * otherwise. **Until it passes, Qwen retrieval is unproven** and must not be
 * reported as working.
 */

const ENDPOINT = process.env.CREATIVE_MEMORY_EMBEDDING_ENDPOINT;
const RERANKER_ENDPOINT = process.env.CREATIVE_MEMORY_RERANKER_ENDPOINT;
const OPT_IN = process.env.QWEN_BINDING_TEST === '1';

function fakeFetch(handler: (body: unknown) => { status?: number; body: unknown }): typeof fetch {
  return (async (_input: unknown, init?: { body?: unknown }) => {
    const parsed = init?.body ? JSON.parse(String(init.body)) : {};
    const { status = 200, body } = handler(parsed);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const input = { text: 'a fast vertical hook', imagePaths: [], contributingFields: ['text'] };

describe('Qwen3-VL contract facts (offline)', () => {
  it('records the official dimensions', () => {
    // From github.com/QwenLM/Qwen3-VL-Embedding, verified 2026-07-27.
    expect(QWEN3_VL_DIMENSIONS['Qwen/Qwen3-VL-Embedding-2B']).toBe(2048);
    expect(QWEN3_VL_DIMENSIONS['Qwen/Qwen3-VL-Embedding-8B']).toBe(4096);
  });

  it('declares 2048 dimensions for the 2B profile and 4096 for the 8B', () => {
    const twoB = new Qwen3VlEmbeddingProvider('QWEN3_VL_2B_QUALITY_V1', { endpoint: 'http://x' });
    const eightB = new Qwen3VlEmbeddingProvider('QWEN3_VL_8B_REMOTE_QUALITY_V1', {
      endpoint: 'http://x',
    });
    expect(twoB.getProfile().vectorDimension).toBe(2048);
    expect(eightB.getProfile().vectorDimension).toBe(4096);
    expect(eightB.getProfile().executionMode).toBe('REMOTE_ENDPOINT');
  });

  it('refuses a vector of the wrong width rather than indexing it', async () => {
    const provider = new Qwen3VlEmbeddingProvider('QWEN3_VL_2B_QUALITY_V1', {
      endpoint: 'http://x',
      fetchImpl: fakeFetch(() => ({
        body: { model: QWEN3_VL_EMBEDDING_2B, data: [{ embedding: [0.1, 0.2, 0.3] }] },
      })),
    });
    await expect(provider.embed(input)).rejects.toMatchObject({ kind: 'DIMENSION_MISMATCH' });
  });

  it('refuses a non-finite vector component', () => {
    // JSON cannot carry NaN — it serialises to null — so a non-finite value
    // can only reach the guard directly. The endpoint path is covered by the
    // non-numeric-array case below.
    expect(() => assertUsableVector([Number.NaN, 0.1], 2)).toThrow(/NaN or Infinity/);
    expect(() => assertUsableVector([Number.POSITIVE_INFINITY, 0.1], 2)).toThrow(/NaN or Infinity/);
  });

  it('refuses an embedding array containing a non-number', async () => {
    const provider = new Qwen3VlEmbeddingProvider('QWEN3_VL_2B_QUALITY_V1', {
      endpoint: 'http://x',
      fetchImpl: fakeFetch(() => ({
        body: {
          model: QWEN3_VL_EMBEDDING_2B,
          // What a NaN actually becomes on the wire.
          data: [{ embedding: [null, ...new Array(2047).fill(0.1)] }],
        },
      })),
    });
    await expect(provider.embed(input)).rejects.toMatchObject({ kind: 'MALFORMED_RESPONSE' });
  });

  it('refuses an endpoint serving a different model', async () => {
    const provider = new Qwen3VlEmbeddingProvider('QWEN3_VL_2B_QUALITY_V1', {
      endpoint: 'http://x',
      fetchImpl: fakeFetch(() => ({
        body: { model: 'some/other-model', data: [{ embedding: new Array(2048).fill(0.1) }] },
      })),
    });
    await expect(provider.embed(input)).rejects.toMatchObject({ kind: 'MODEL_MISMATCH' });
  });

  it('rejects a malformed response instead of guessing', async () => {
    const provider = new Qwen3VlEmbeddingProvider('QWEN3_VL_2B_QUALITY_V1', {
      endpoint: 'http://x',
      fetchImpl: fakeFetch(() => ({ body: 'not json at all' })),
    });
    await expect(provider.embed(input)).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('reports a timeout as a timeout', async () => {
    const provider = new Qwen3VlEmbeddingProvider('QWEN3_VL_2B_QUALITY_V1', {
      endpoint: 'http://x',
      timeoutMs: 20,
      fetchImpl: (async (_i: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    });
    await expect(provider.embed(input)).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('refuses more images than the profile allows', async () => {
    const provider = new Qwen3VlEmbeddingProvider('QWEN3_VL_2B_QUALITY_V1', {
      endpoint: 'http://x',
      fetchImpl: fakeFetch(() => ({ body: {} })),
    });
    await expect(
      provider.embed({ ...input, imagePaths: new Array(20).fill('C:/frame.jpg') }),
    ).rejects.toMatchObject({ kind: 'UNSUPPORTED_MODALITY' });
  });

  it('never leaks the API key into an error message', async () => {
    const apiKey = 'super-secret-endpoint-key';
    const provider = new Qwen3VlEmbeddingProvider('QWEN3_VL_2B_QUALITY_V1', {
      endpoint: 'http://x',
      apiKey,
      fetchImpl: fakeFetch(() => ({ status: 500, body: `failure for key ${apiKey}` })),
    });
    await expect(provider.embed(input)).rejects.toSatisfy(
      (error: unknown) =>
        !JSON.stringify({
          message: (error as Error).message,
          detail: (error as EmbeddingError).detail,
        }).includes(apiKey),
    );
  });

  it('bounds the reranker candidate count', async () => {
    const reranker = new Qwen3VlRerankerProvider(QWEN3_VL_RERANKER_2B, { endpoint: 'http://x' });
    await expect(
      reranker.rerank({
        query: 'q',
        candidates: new Array(150).fill(null).map((_, index) => ({
          candidateId: `c${index}`,
          document: 'doc',
          imagePaths: [],
        })),
      }),
    ).rejects.toBeInstanceOf(RerankingError);
  });
});

const live = OPT_IN && ENDPOINT ? describe : describe.skip;

if (OPT_IN && !ENDPOINT) {
  throw new Error(
    'QWEN_BINDING_TEST=1 was set without CREATIVE_MEMORY_EMBEDDING_ENDPOINT — refusing to silently skip the binding test that would prove Qwen retrieval',
  );
}
if (!OPT_IN) {
  // eslint-disable-next-line no-console -- an unproven capability must announce itself
  console.warn(
    '[creative-memory] SKIPPED Qwen binding tests. Qwen retrieval is UNPROVEN until they pass. Enable with QWEN_BINDING_TEST=1 and CREATIVE_MEMORY_EMBEDDING_ENDPOINT.',
  );
}

live('Qwen3-VL live binding (opt-in)', () => {
  const provider = (): Qwen3VlEmbeddingProvider =>
    new Qwen3VlEmbeddingProvider('QWEN3_VL_2B_QUALITY_V1', {
      endpoint: ENDPOINT as string,
      ...(process.env.CREATIVE_MEMORY_EMBEDDING_API_KEY
        ? { apiKey: process.env.CREATIVE_MEMORY_EMBEDDING_API_KEY }
        : {}),
      timeoutMs: 180_000,
    });

  it('reports healthy with the exact expected model and dimension', async () => {
    const health = await provider().checkHealth();
    expect(health.problems.join('\n')).toBe('');
    expect(health.available).toBe(true);
  }, 300_000);

  it('embeds text at the official dimension', async () => {
    const result = await provider().embed(input);
    expect(result.model).toBe(QWEN3_VL_EMBEDDING_2B);
    expect(result.dimension).toBe(2048);
    expect(result.vector).toHaveLength(2048);
    expect(result.vector.every((value) => Number.isFinite(value))).toBe(true);
  }, 300_000);

  it('produces a normalised vector when the profile claims normalisation', async () => {
    const result = await provider().embed(input);
    if (!result.normalized) return;
    const magnitude = Math.sqrt(result.vector.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 3);
  }, 300_000);

  it('embeds a mixed text and image input at the same dimension', async () => {
    const framePath = process.env.QWEN_BINDING_IMAGE;
    if (!framePath) return;
    const result = await provider().embed({ ...input, imagePaths: [framePath] });
    expect(result.dimension).toBe(2048);
  }, 300_000);

  it('reranks a candidate set', async () => {
    if (!RERANKER_ENDPOINT) return;
    const reranker = new Qwen3VlRerankerProvider(QWEN3_VL_RERANKER_2B, {
      endpoint: RERANKER_ENDPOINT,
      ...(process.env.CREATIVE_MEMORY_EMBEDDING_API_KEY
        ? { apiKey: process.env.CREATIVE_MEMORY_EMBEDDING_API_KEY }
        : {}),
      timeoutMs: 180_000,
    });
    const result = await reranker.rerank({
      query: 'fast vertical fight night hook',
      candidates: [
        { candidateId: 'a', document: 'rapid vertical fight night crowd hype', imagePaths: [] },
        { candidateId: 'b', document: 'calm product information screen', imagePaths: [] },
      ],
    });
    expect(result.fallbackStatus).toBe('NONE');
    expect(result.scores).toHaveLength(2);
    const byId = new Map(result.scores.map((score) => [score.candidateId, score.score]));
    expect(byId.get('a')).toBeGreaterThan(byId.get('b') as number);
  }, 300_000);
});
