import { readFile } from 'node:fs/promises';

import type {
  CreativeMemoryProfileKey as CreativeMemoryProfile,
  ModelProfile as CreativeMemoryModelProfile,
  ProviderEmbeddingInput as EmbeddingInput,
  ProviderEmbeddingResult as EmbeddingResult,
  ProviderRerankingInput as RerankingInput,
  ProviderRerankingResult as RerankingResult,
} from './contracts';

import {
  assertUsableVector,
  checksumVector,
  EmbeddingError,
  hashEmbeddingInput,
  l2Normalize,
  type EmbeddingHealth,
  type MultimodalEmbeddingProvider,
} from './embedding';
import {
  RerankingError,
  type MultimodalRerankerProvider,
  type RerankerCapabilities,
} from './reranking';

/**
 * Qwen3-VL embedding and reranking through a configured HTTP endpoint.
 *
 * **The model facts below are from the official repository
 * (github.com/QwenLM/Qwen3-VL-Embedding, verified 2026-07-27):**
 *
 * | Model | Vector dimension |
 * | --- | --- |
 * | `Qwen/Qwen3-VL-Embedding-2B` | 2048 |
 * | `Qwen/Qwen3-VL-Embedding-8B` | 4096 |
 *
 * Rerankers (`Qwen/Qwen3-VL-Reranker-2B`, `-8B`) return a relevance score
 * derived from the generation probability of `yes`/`no` tokens; they emit no
 * embedding. The official repository documents serving via `transformers` and
 * vLLM (≥0.14.0) and **documents no HTTP/REST API**.
 *
 * That last point matters. The request/response shape below is therefore a
 * **repository-defined contract**, not an official one — it is what this
 * adapter expects an operator's serving layer to expose. It is documented in
 * `docs/runbooks/creative-memory-retrieval.md` so a serving shim can be
 * written against it. Nothing here should be read as "Qwen publishes this API".
 *
 * Normalisation is likewise not specified by the official repository, so this
 * adapter does not assume it: `normalized` is declared per profile and the
 * adapter normalises defensively when it claims normalised output.
 *
 * **Nothing here downloads a model.** The endpoint is remote or operator-run;
 * `CREATIVE_MEMORY_MODEL_DOWNLOAD_POLICY` defaults to `deny` and no code path
 * in this repository fetches weights.
 */

export const QWEN3_VL_EMBEDDING_2B = 'Qwen/Qwen3-VL-Embedding-2B';
export const QWEN3_VL_EMBEDDING_8B = 'Qwen/Qwen3-VL-Embedding-8B';
export const QWEN3_VL_RERANKER_2B = 'Qwen/Qwen3-VL-Reranker-2B';
export const QWEN3_VL_RERANKER_8B = 'Qwen/Qwen3-VL-Reranker-8B';

/** Official dimensions. A response of any other width is refused. */
export const QWEN3_VL_DIMENSIONS: Readonly<Record<string, number>> = {
  [QWEN3_VL_EMBEDDING_2B]: 2048,
  [QWEN3_VL_EMBEDDING_8B]: 4096,
};

export const QWEN3_VL_DEFAULT_INSTRUCTION = "Represent the user's input";

export const QWEN3_VL_PROFILES: Readonly<
  Record<'QWEN3_VL_2B_QUALITY_V1' | 'QWEN3_VL_8B_REMOTE_QUALITY_V1', CreativeMemoryModelProfile>
> = {
  QWEN3_VL_2B_QUALITY_V1: {
    profile: 'QWEN3_VL_2B_QUALITY_V1',
    embeddingModel: QWEN3_VL_EMBEDDING_2B,
    embeddingRevision: 'main',
    rerankerModel: QWEN3_VL_RERANKER_2B,
    rerankerRevision: 'main',
    vectorDimension: 2048,
    normalized: true,
    supportedModalities: ['TEXT', 'IMAGE'],
    maxImagesPerInput: 8,
    neural: true,
    executionMode: 'LOCAL_ENDPOINT',
    documentSchemaVersion: 1,
    notes:
      'Requires a configured Qwen3-VL serving endpoint. Unproven in this repository until the opt-in binding test passes against a real endpoint.',
  },
  QWEN3_VL_8B_REMOTE_QUALITY_V1: {
    profile: 'QWEN3_VL_8B_REMOTE_QUALITY_V1',
    embeddingModel: QWEN3_VL_EMBEDDING_8B,
    embeddingRevision: 'main',
    rerankerModel: QWEN3_VL_RERANKER_8B,
    rerankerRevision: 'main',
    vectorDimension: 4096,
    normalized: true,
    supportedModalities: ['TEXT', 'IMAGE'],
    maxImagesPerInput: 8,
    neural: true,
    executionMode: 'REMOTE_ENDPOINT',
    notes:
      'Remote only. Never downloaded locally. Requires an explicitly configured compatible endpoint; refuses to index on model or dimension mismatch.',
    documentSchemaVersion: 1,
  },
};

export interface QwenEndpointOptions {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Overrides the profile's declared revision when an operator pins one. */
  readonly revision?: string;
}

interface EmbedResponseShape {
  model?: unknown;
  data?: unknown;
}

function bearer(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/** Never let an endpoint credential reach a message that gets logged or persisted. */
export function redactSecrets(text: string, apiKey?: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***REDACTED***');
}

async function postJson(
  options: QwenEndpointOptions,
  path: string,
  body: unknown,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new EmbeddingError('PROVIDER_UNAVAILABLE', 'no fetch implementation is available');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  try {
    const response = await fetchImpl(`${options.endpoint.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(options.apiKey) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new EmbeddingError(
        response.status === 401 || response.status === 403
          ? 'PROVIDER_UNAVAILABLE'
          : 'PROVIDER_ERROR',
        `Qwen endpoint ${path} returned HTTP ${response.status}`,
        redactSecrets(text.slice(0, 500), options.apiKey),
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new EmbeddingError(
        'MALFORMED_RESPONSE',
        `Qwen endpoint ${path} returned a non-JSON body`,
        redactSecrets(text.slice(0, 200), options.apiKey),
      );
    }
  } catch (error) {
    if (error instanceof EmbeddingError) throw error;
    if (controller.signal.aborted) {
      throw new EmbeddingError(
        'TIMEOUT',
        `Qwen endpoint ${path} exceeded ${options.timeoutMs ?? 120_000}ms`,
      );
    }
    throw new EmbeddingError(
      'PROVIDER_UNAVAILABLE',
      `Qwen endpoint ${path} is unreachable`,
      redactSecrets(error instanceof Error ? error.message : String(error), options.apiKey),
    );
  } finally {
    clearTimeout(timer);
  }
}

export class Qwen3VlEmbeddingProvider implements MultimodalEmbeddingProvider {
  readonly name: string;
  private readonly profile: CreativeMemoryModelProfile;

  constructor(
    profileKey: Extract<
      CreativeMemoryProfile,
      'QWEN3_VL_2B_QUALITY_V1' | 'QWEN3_VL_8B_REMOTE_QUALITY_V1'
    >,
    private readonly options: QwenEndpointOptions,
  ) {
    const base = QWEN3_VL_PROFILES[profileKey];
    this.profile = options.revision ? { ...base, embeddingRevision: options.revision } : base;
    this.name = `qwen3-vl:${profileKey}`;
  }

  getProfile(): CreativeMemoryModelProfile {
    return this.profile;
  }

  /**
   * Confirms the endpoint serves the exact model at the exact width this
   * profile declares. A mismatch is fatal *before* indexing, because a
   * collection half-filled with the wrong model's vectors is worse than an
   * empty one — the failure is silent and the results merely look plausible.
   */
  async checkHealth(): Promise<EmbeddingHealth> {
    const problems: string[] = [];
    try {
      const probe = await this.embed({
        text: 'health probe',
        imagePaths: [],
        contributingFields: ['health'],
      });
      if (probe.model !== this.profile.embeddingModel) {
        problems.push(
          `endpoint serves "${probe.model}" but this profile requires "${this.profile.embeddingModel}"`,
        );
      }
      if (probe.dimension !== this.profile.vectorDimension) {
        problems.push(
          `endpoint returned ${probe.dimension}-dimensional vectors but this profile requires ${this.profile.vectorDimension}`,
        );
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    return { available: problems.length === 0, profile: this.profile, problems };
  }

  async embed(input: EmbeddingInput): Promise<EmbeddingResult> {
    const [result] = await this.embedBatch([input]);
    if (!result) {
      throw new EmbeddingError('MALFORMED_RESPONSE', 'Qwen endpoint returned no embedding');
    }
    return result;
  }

  async embedBatch(inputs: readonly EmbeddingInput[]): Promise<readonly EmbeddingResult[]> {
    if (inputs.length === 0) return [];

    for (const input of inputs) {
      if (input.imagePaths.length > 0 && !this.profile.supportedModalities.includes('IMAGE')) {
        throw new EmbeddingError(
          'UNSUPPORTED_MODALITY',
          `${this.profile.embeddingModel} was given images but this profile declares no IMAGE support`,
        );
      }
      if (input.imagePaths.length > this.profile.maxImagesPerInput) {
        throw new EmbeddingError(
          'UNSUPPORTED_MODALITY',
          `${input.imagePaths.length} images exceeds the profile maximum of ${this.profile.maxImagesPerInput}`,
        );
      }
    }

    const startedAt = Date.now();
    const payloadInputs = await Promise.all(
      inputs.map(async (input) => ({
        text: input.text,
        instruction: input.instruction ?? QWEN3_VL_DEFAULT_INSTRUCTION,
        // Images travel base64-encoded so the endpoint needs no filesystem
        // access to this machine.
        images: await Promise.all(
          input.imagePaths.map(async (path) => (await readFile(path)).toString('base64')),
        ),
      })),
    );

    const body = await postJson(this.options, '/v1/embeddings', {
      model: this.profile.embeddingModel,
      inputs: payloadInputs,
    });

    const response = body as EmbedResponseShape;
    const servedModel = typeof response.model === 'string' ? response.model : undefined;
    if (servedModel && servedModel !== this.profile.embeddingModel) {
      throw new EmbeddingError(
        'MODEL_MISMATCH',
        `endpoint served "${servedModel}" but this profile requires "${this.profile.embeddingModel}"`,
      );
    }
    if (!Array.isArray(response.data) || response.data.length !== inputs.length) {
      throw new EmbeddingError(
        'MALFORMED_RESPONSE',
        `expected ${inputs.length} embeddings, endpoint returned ${Array.isArray(response.data) ? response.data.length : 'a non-array'}`,
      );
    }

    const latencyMs = Date.now() - startedAt;
    return response.data.map((entry, index) => {
      const raw = (entry as { embedding?: unknown })?.embedding;
      if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'number')) {
        throw new EmbeddingError('MALFORMED_RESPONSE', `embedding ${index} is not a numeric array`);
      }
      const numeric = raw as number[];
      assertUsableVector(numeric, this.profile.vectorDimension);
      // Normalise defensively: the official repository does not state that
      // outputs are L2-normalised, so claiming it without enforcing it would
      // be an assumption presented as a guarantee.
      const vector = this.profile.normalized ? l2Normalize(numeric) : numeric;
      const input = inputs[index] as EmbeddingInput;

      return {
        provider: this.name,
        model: this.profile.embeddingModel,
        revision: this.profile.embeddingRevision,
        dimension: this.profile.vectorDimension,
        normalized: this.profile.normalized,
        instruction: input.instruction ?? QWEN3_VL_DEFAULT_INSTRUCTION,
        inputHash: hashEmbeddingInput(input, this.profile),
        vectorChecksum: checksumVector(vector),
        vector,
        generatedAt: new Date().toISOString(),
        executionMode: this.profile.executionMode,
        latencyMs,
      };
    });
  }
}

export class Qwen3VlRerankerProvider implements MultimodalRerankerProvider {
  readonly name: string;

  constructor(
    private readonly model: string,
    private readonly options: QwenEndpointOptions,
  ) {
    this.name = `qwen3-vl-reranker:${model}`;
  }

  getCapabilities(): RerankerCapabilities {
    return {
      model: this.model,
      revision: this.options.revision ?? 'main',
      supportedModalities: ['TEXT', 'IMAGE'],
      maxCandidates: 100,
      neural: true,
    };
  }

  async checkHealth(): Promise<{ available: boolean; problems: readonly string[] }> {
    try {
      await this.rerank({
        query: 'health probe',
        candidates: [{ candidateId: 'probe', document: 'probe document', imagePaths: [] }],
      });
      return { available: true, problems: [] };
    } catch (error) {
      return {
        available: false,
        problems: [
          redactSecrets(
            error instanceof Error ? error.message : String(error),
            this.options.apiKey,
          ),
        ],
      };
    }
  }

  async rerank(input: RerankingInput): Promise<RerankingResult> {
    const capabilities = this.getCapabilities();
    if (input.candidates.length > capabilities.maxCandidates) {
      throw new RerankingError(
        'TOO_MANY_CANDIDATES',
        `${input.candidates.length} candidates exceeds this reranker's maximum of ${capabilities.maxCandidates}`,
      );
    }

    const startedAt = Date.now();
    let body: unknown;
    try {
      body = await postJson(this.options, '/v1/rerank', {
        model: this.model,
        query: input.query,
        instruction: input.instruction,
        documents: input.candidates.map((candidate) => ({
          id: candidate.candidateId,
          text: candidate.document,
        })),
      });
    } catch (error) {
      // Translate the embedding-side transport error into the reranker's own
      // typed failure, so the pipeline's fallback logic sees one vocabulary.
      throw new RerankingError(
        error instanceof EmbeddingError && error.kind === 'TIMEOUT'
          ? 'TIMEOUT'
          : 'PROVIDER_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      );
    }

    const served = (body as { model?: unknown }).model;
    if (typeof served === 'string' && served !== this.model) {
      throw new RerankingError(
        'MODEL_MISMATCH',
        `endpoint served reranker "${served}" but "${this.model}" was requested`,
      );
    }

    const results = (body as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      throw new RerankingError('MALFORMED_RESPONSE', 'reranker returned no results array');
    }

    const scores = results.map((entry) => {
      const id = (entry as { id?: unknown })?.id;
      const score = (entry as { score?: unknown })?.score;
      if (typeof id !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) {
        throw new RerankingError('MALFORMED_RESPONSE', 'reranker returned a malformed score entry');
      }
      return { candidateId: id, score };
    });

    return {
      provider: this.name,
      model: this.model,
      revision: capabilities.revision,
      fallbackStatus: 'NONE',
      scores,
      latencyMs: Date.now() - startedAt,
    };
  }
}
