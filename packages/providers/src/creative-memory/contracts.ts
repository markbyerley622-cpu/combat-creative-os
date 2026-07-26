/**
 * Structural mirrors of `@combat/domain`'s Creative Memory retrieval types.
 *
 * `packages/providers` does not depend on `packages/domain` — the same
 * discipline `video-generation.ts` documents for `ShotCreativeAttributes` and
 * `ReferenceRights`. These are the shapes the provider layer needs; the
 * composition root (`apps/aamp-cli`) maps between them and the validated
 * domain contracts, and a conformance test asserts the two agree.
 *
 * Kept deliberately minimal: only what an embedder, a reranker or the vector
 * store actually touches.
 */

export const CREATIVE_MEMORY_PROFILE_KEYS = [
  'STRUCTURAL_BASELINE_V1',
  'QWEN3_VL_2B_QUALITY_V1',
  'QWEN3_VL_8B_REMOTE_QUALITY_V1',
] as const;
export type CreativeMemoryProfileKey = (typeof CREATIVE_MEMORY_PROFILE_KEYS)[number];

export type EmbeddingModalityName = 'TEXT' | 'IMAGE';
export type ExecutionModeName = 'LOCAL_DETERMINISTIC' | 'LOCAL_ENDPOINT' | 'REMOTE_ENDPOINT';
export type RerankingFallbackStatusName =
  'NONE' | 'FALLBACK_STRUCTURAL_RERANKING' | 'RERANKING_UNAVAILABLE';

export interface ModelProfile {
  readonly profile: CreativeMemoryProfileKey;
  readonly embeddingModel: string;
  readonly embeddingRevision: string;
  readonly rerankerModel?: string;
  readonly rerankerRevision?: string;
  readonly vectorDimension: number;
  readonly normalized: boolean;
  readonly supportedModalities: readonly EmbeddingModalityName[];
  readonly maxImagesPerInput: number;
  readonly neural: boolean;
  readonly executionMode: ExecutionModeName;
  readonly documentSchemaVersion: number;
  readonly notes?: string;
}

export interface ProviderEmbeddingInput {
  readonly text: string;
  readonly imagePaths: readonly string[];
  readonly instruction?: string;
  readonly contributingFields: readonly string[];
}

export interface ProviderEmbeddingResult {
  readonly provider: string;
  readonly model: string;
  readonly revision: string;
  readonly dimension: number;
  readonly normalized: boolean;
  readonly instruction?: string;
  readonly inputHash: string;
  readonly vectorChecksum: string;
  readonly vector: readonly number[];
  readonly generatedAt: string;
  readonly executionMode: ExecutionModeName;
  readonly latencyMs?: number;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface ProviderRerankCandidate {
  readonly candidateId: string;
  readonly document: string;
  readonly imagePaths?: readonly string[];
}

export interface ProviderRerankingInput {
  readonly query: string;
  readonly instruction?: string;
  readonly candidates: readonly ProviderRerankCandidate[];
}

export interface ProviderRerankingResult {
  readonly provider: string;
  readonly model: string;
  readonly revision: string;
  readonly fallbackStatus: RerankingFallbackStatusName;
  readonly scores: readonly { readonly candidateId: string; readonly score: number }[];
  readonly latencyMs?: number;
}
