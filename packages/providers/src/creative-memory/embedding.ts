import { createHash } from 'node:crypto';

import type {
  ModelProfile as CreativeMemoryModelProfile,
  ProviderEmbeddingInput as EmbeddingInput,
  ProviderEmbeddingResult as EmbeddingResult,
} from './contracts';

/**
 * Multimodal embedding for Creative Memory retrieval.
 *
 * The contract is deliberately strict about identity. A vector is only
 * meaningful next to vectors produced by the same model at the same revision
 * with the same document schema, so every result carries all three, plus the
 * hash of the input that produced it and a checksum of the vector itself. A
 * collection keyed on those facts cannot silently accumulate incomparable
 * vectors — which is the failure mode that makes a vector database quietly
 * return nonsense.
 */

export const EMBEDDING_FAILURE_KINDS = [
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'MALFORMED_RESPONSE',
  'DIMENSION_MISMATCH',
  'INVALID_VECTOR',
  'MODEL_MISMATCH',
  'UNSUPPORTED_MODALITY',
  'PROVIDER_ERROR',
] as const;
export type EmbeddingFailureKind = (typeof EMBEDDING_FAILURE_KINDS)[number];

export class EmbeddingError extends Error {
  constructor(
    public readonly kind: EmbeddingFailureKind,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface EmbeddingHealth {
  readonly available: boolean;
  readonly profile: CreativeMemoryModelProfile;
  readonly problems: readonly string[];
}

export interface MultimodalEmbeddingProvider {
  readonly name: string;
  getProfile(): CreativeMemoryModelProfile;
  checkHealth(): Promise<EmbeddingHealth>;
  embed(input: EmbeddingInput): Promise<EmbeddingResult>;
  embedBatch(inputs: readonly EmbeddingInput[]): Promise<readonly EmbeddingResult[]>;
}

/**
 * Canonical hash of an embedding input.
 *
 * Includes `contributingFields`, so re-embedding after an annotation changes
 * produces a different hash even when the rendered text happens to collide.
 * That is what lets the index detect staleness rather than trusting a
 * timestamp.
 */
export function hashEmbeddingInput(
  input: EmbeddingInput,
  profile: CreativeMemoryModelProfile,
): string {
  const canonical = JSON.stringify({
    text: input.text,
    imagePaths: [...input.imagePaths].sort(),
    instruction: input.instruction ?? null,
    contributingFields: [...input.contributingFields].sort(),
    model: profile.embeddingModel,
    revision: profile.embeddingRevision,
    documentSchemaVersion: profile.documentSchemaVersion,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function checksumVector(vector: readonly number[]): string {
  // Fixed precision so a checksum is stable across platforms that print
  // floats differently.
  return createHash('sha256')
    .update(vector.map((value) => value.toFixed(8)).join(','), 'utf8')
    .digest('hex');
}

/**
 * Refuses a vector that would poison a collection.
 *
 * Qdrant will happily accept `NaN` and return incoherent neighbours forever
 * afterwards, so the check happens here, before the write, where the failure
 * is still attributable to one scene.
 */
export function assertUsableVector(vector: readonly number[], expectedDimension: number): void {
  if (vector.length !== expectedDimension) {
    throw new EmbeddingError(
      'DIMENSION_MISMATCH',
      `embedding has ${vector.length} dimensions but the profile declares ${expectedDimension}`,
    );
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new EmbeddingError(
        'INVALID_VECTOR',
        'embedding contains a NaN or Infinity component and would corrupt the collection',
      );
    }
  }
}

/** L2 normalisation, applied only where a profile declares normalised output. */
export function l2Normalize(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return [...vector];
  return vector.map((value) => value / magnitude);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    leftMagnitude += left * left;
    rightMagnitude += right * right;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}
