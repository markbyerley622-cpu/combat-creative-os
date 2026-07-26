import type {
  ProviderRerankingInput as RerankingInput,
  ProviderRerankingResult as RerankingResult,
} from './contracts';

import { stem, tokenize } from './structural-baseline';

/**
 * Reranking for Creative Memory.
 *
 * The honesty rule here is absolute: if neural reranking did not happen, the
 * result says so. `fallbackStatus` is part of the contract rather than a log
 * line, it travels into every result's explanation, and `AGENT_SAFE` output
 * carries it too — so a consumer can never mistake a weighted structural sort
 * for a cross-encoder's judgement.
 */

export const RERANKING_FAILURE_KINDS = [
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'MALFORMED_RESPONSE',
  'MODEL_MISMATCH',
  'TOO_MANY_CANDIDATES',
  'PROVIDER_ERROR',
] as const;
export type RerankingFailureKind = (typeof RERANKING_FAILURE_KINDS)[number];

export class RerankingError extends Error {
  constructor(
    public readonly kind: RerankingFailureKind,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'RerankingError';
  }
}

export interface RerankerCapabilities {
  readonly model: string;
  readonly revision: string;
  readonly supportedModalities: readonly ('TEXT' | 'IMAGE')[];
  readonly maxCandidates: number;
  readonly neural: boolean;
}

export interface MultimodalRerankerProvider {
  readonly name: string;
  getCapabilities(): RerankerCapabilities;
  checkHealth(): Promise<{ available: boolean; problems: readonly string[] }>;
  rerank(input: RerankingInput): Promise<RerankingResult>;
}

export const STRUCTURAL_RERANKER_MAX_CANDIDATES = 200;

/**
 * `STRUCTURAL_RERANKER_V1` — deterministic weighted reranking.
 *
 * Scores lexical overlap between the query and each candidate document, using
 * the same tokeniser and stemmer as the structural embedder so the two stages
 * agree about what a word is. The remaining signals — role, platform, hook,
 * pacing, duration, reviewer confidence — are applied by the retrieval
 * pipeline, which is where the query's structured filters live; this provider
 * scores the text relationship, and the pipeline composes.
 *
 * Real, useful and explicitly non-neural.
 */
export class StructuralRerankerProvider implements MultimodalRerankerProvider {
  readonly name = 'STRUCTURAL_RERANKER_V1';

  getCapabilities(): RerankerCapabilities {
    return {
      model: 'combat-structural-reranker',
      revision: 'v1',
      supportedModalities: ['TEXT'],
      maxCandidates: STRUCTURAL_RERANKER_MAX_CANDIDATES,
      neural: false,
    };
  }

  async checkHealth(): Promise<{ available: boolean; problems: readonly string[] }> {
    return { available: true, problems: [] };
  }

  async rerank(input: RerankingInput): Promise<RerankingResult> {
    if (input.candidates.length > STRUCTURAL_RERANKER_MAX_CANDIDATES) {
      throw new RerankingError(
        'TOO_MANY_CANDIDATES',
        `structural reranking accepts at most ${STRUCTURAL_RERANKER_MAX_CANDIDATES} candidates, got ${input.candidates.length}`,
      );
    }

    const queryTerms = new Set(tokenize(input.query).map(stem));
    const scores = input.candidates.map((candidate) => {
      const documentTerms = tokenize(candidate.document).map(stem);
      const documentSet = new Set(documentTerms);

      let overlap = 0;
      for (const term of queryTerms) if (documentSet.has(term)) overlap += 1;

      // Coverage of the query, tempered by how much of the document is
      // relevant — a long document that mentions everything should not
      // outrank a focused one that is actually about the query.
      const coverage = queryTerms.size === 0 ? 0 : overlap / queryTerms.size;
      const density = documentSet.size === 0 ? 0 : overlap / Math.sqrt(documentSet.size);

      return { candidateId: candidate.candidateId, score: coverage * 0.75 + density * 0.25 };
    });

    return {
      provider: this.name,
      model: 'combat-structural-reranker',
      revision: 'v1',
      // The pipeline decides whether this counts as a fallback; used directly
      // it is simply the configured reranker.
      fallbackStatus: 'NONE',
      scores,
    };
  }
}
