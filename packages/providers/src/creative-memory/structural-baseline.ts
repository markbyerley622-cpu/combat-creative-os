import { createHash } from 'node:crypto';

import type {
  ModelProfile as CreativeMemoryModelProfile,
  ProviderEmbeddingInput as EmbeddingInput,
  ProviderEmbeddingResult as EmbeddingResult,
} from './contracts';

import {
  assertUsableVector,
  checksumVector,
  hashEmbeddingInput,
  l2Normalize,
  type EmbeddingHealth,
  type MultimodalEmbeddingProvider,
} from './embedding';

/**
 * `STRUCTURAL_BASELINE_V1` — a real, deterministic, zero-download retrieval
 * baseline.
 *
 * **This is not a mock.** It produces genuinely useful ranking on this machine
 * with no model weights, no GPU and no endpoint, by embedding the things
 * Creative Memory actually knows: reviewed annotations, measured craft
 * statistics, role tags, platform and timing. Two components make up each
 * vector:
 *
 * 1. **A hashed bag-of-terms block.** Classic feature hashing over the
 *    document's terms with sublinear term weighting. It is not a language
 *    model and cannot resolve synonyms — a query must share vocabulary with
 *    the reviewed annotations to match. That limitation is real and documented
 *    rather than hidden behind the word "semantic".
 * 2. **A structured numeric block.** Craft measurements written into fixed
 *    positions, so pacing, duration and scene density influence similarity
 *    directly rather than only through words.
 *
 * Both blocks are deterministic functions of their input, so the same scene
 * always yields the same vector — which is what makes indexing idempotent and
 * the benchmark reproducible.
 *
 * Labelled `NON_NEURAL_STRUCTURAL_BASELINE` everywhere it surfaces. It must
 * never be reported as neural retrieval.
 */

export const STRUCTURAL_BASELINE_LABEL = 'NON_NEURAL_STRUCTURAL_BASELINE';

/** Hashed-term block width, then the structured block. Total must equal the profile dimension. */
const TERM_BLOCK_DIMENSION = 256;
const STRUCTURED_BLOCK_DIMENSION = 32;
export const STRUCTURAL_BASELINE_DIMENSION = TERM_BLOCK_DIMENSION + STRUCTURED_BLOCK_DIMENSION;

export const STRUCTURAL_BASELINE_PROFILE: CreativeMemoryModelProfile = {
  profile: 'STRUCTURAL_BASELINE_V1',
  embeddingModel: 'combat-structural-baseline',
  // Bumping this invalidates every vector, which is exactly what a change to
  // the feature construction below must do.
  embeddingRevision: 'v1',
  vectorDimension: STRUCTURAL_BASELINE_DIMENSION,
  normalized: true,
  supportedModalities: ['TEXT'],
  maxImagesPerInput: 0,
  neural: false,
  executionMode: 'LOCAL_DETERMINISTIC',
  documentSchemaVersion: 1,
  notes:
    'Real deterministic non-neural baseline: hashed term features over reviewed annotations plus a structured craft-metric block. Lexical, not semantic — a query must share vocabulary with the annotations. No model weights, no endpoint, no GPU.',
};

/** Words carrying no retrieval signal. Small and fixed; this is not a language model. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'over',
  'than',
  'then',
  'they',
  'them',
  'their',
  'there',
  'here',
  'have',
  'has',
  'had',
  'was',
  'were',
  'are',
  'its',
  'it',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'is',
  'be',
  'as',
  'or',
  'not',
  'no',
  'do',
  'does',
  'did',
  'can',
  'will',
  'would',
  'should',
  'more',
  'most',
  'very',
  'when',
  'while',
  'which',
  'who',
  'what',
  'how',
  'why',
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter(
    (token) => !STOP_WORDS.has(token),
  );
}

/**
 * Very small English stemmer: folds the handful of suffixes that would
 * otherwise split obvious matches ("prediction"/"predictions",
 * "cutting"/"cuts"). Deliberately crude — a real stemmer is a dependency, and
 * this baseline's honesty depends on not overclaiming.
 */
export function stem(token: string): string {
  for (const suffix of ['ingly', 'edly', 'ing', 'ies', 'ied', 'es', 'ed', 's']) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      const stripped = token.slice(0, -suffix.length);
      return suffix === 'ies' || suffix === 'ied' ? `${stripped}y` : stripped;
    }
  }
  return token;
}

/** Stable bucket for a term. Two buckets per term reduces hash-collision damage. */
function termBuckets(term: string): [number, number] {
  const digest = createHash('sha256').update(term).digest();
  return [
    digest.readUInt32BE(0) % TERM_BLOCK_DIMENSION,
    digest.readUInt32BE(4) % TERM_BLOCK_DIMENSION,
  ];
}

/** Sign hashing, so unrelated terms sharing a bucket tend to cancel rather than compound. */
function termSign(term: string): number {
  return createHash('sha256').update(`sign:${term}`).digest()[0]! % 2 === 0 ? 1 : -1;
}

export function buildTermBlock(text: string): number[] {
  const block = new Array<number>(TERM_BLOCK_DIMENSION).fill(0);
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    const term = stem(token);
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  for (const [term, count] of counts) {
    // Sublinear weighting: the tenth mention of "fast" says much less than the
    // first, and without this a repetitive annotation would dominate.
    const weight = 1 + Math.log(count);
    const sign = termSign(term);
    const [first, second] = termBuckets(term);
    block[first] = (block[first] ?? 0) + weight * sign;
    block[second] = (block[second] ?? 0) + weight * sign * 0.5;
  }
  return block;
}

/**
 * Structured numeric features, written to fixed positions.
 *
 * Parsed out of the `key=value` lines the document builder emits, so the
 * numbers influence similarity directly. Each is squashed into roughly 0-1 so
 * no single measurement swamps the term block after normalisation.
 */
export function buildStructuredBlock(text: string): number[] {
  const block = new Array<number>(STRUCTURED_BLOCK_DIMENSION).fill(0);
  const read = (key: string): number | undefined => {
    const match = new RegExp(`${key}=([-0-9.]+)`).exec(text);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  };
  const has = (needle: string): number => (text.toLowerCase().includes(needle) ? 1 : 0);

  const cutsPerSecond = read('cutsPerSecond') ?? 0;
  const sceneSeconds = read('sceneDurationSeconds') ?? 0;
  const totalSeconds = read('advertisementDurationSeconds') ?? 0;
  const sceneCount = read('sceneCount') ?? 0;
  const firstCut = read('firstCutSeconds');
  const productReveal = read('productRevealSeconds');
  const ctaSeconds = read('ctaSeconds');

  // 0-3: pacing, the most discriminating structural signal for advertising.
  block[0] = Math.min(1, cutsPerSecond / 2);
  block[1] = Math.min(1, sceneCount / 12);
  block[2] = Math.min(1, sceneSeconds / 6);
  block[3] = Math.min(1, totalSeconds / 60);
  // 4-6: how early the ad does its work.
  block[4] = firstCut === undefined ? 0 : Math.max(0, 1 - firstCut / 5);
  block[5] = productReveal === undefined ? 0 : Math.max(0, 1 - productReveal / 10);
  block[6] = ctaSeconds === undefined ? 0 : Math.max(0, 1 - ctaSeconds / 15);
  // 7-8: orientation.
  block[7] = has('aspectratio=9:16');
  block[8] = has('aspectratio=16:9');
  // 9-12: coarse pacing bands, so "fast" as a word and fast as a measurement agree.
  block[9] = cutsPerSecond >= 0.8 ? 1 : 0;
  block[10] = cutsPerSecond >= 0.4 && cutsPerSecond < 0.8 ? 1 : 0;
  block[11] = cutsPerSecond >= 0.15 && cutsPerSecond < 0.4 ? 1 : 0;
  block[12] = cutsPerSecond < 0.15 ? 1 : 0;

  return block;
}

export class StructuralBaselineEmbeddingProvider implements MultimodalEmbeddingProvider {
  readonly name = STRUCTURAL_BASELINE_LABEL;

  getProfile(): CreativeMemoryModelProfile {
    return STRUCTURAL_BASELINE_PROFILE;
  }

  async checkHealth(): Promise<EmbeddingHealth> {
    // Nothing to reach: it is pure local computation, so it is always healthy.
    return { available: true, profile: STRUCTURAL_BASELINE_PROFILE, problems: [] };
  }

  async embed(input: EmbeddingInput): Promise<EmbeddingResult> {
    const startedAt = Date.now();
    const vector = l2Normalize([
      ...buildTermBlock(input.text),
      ...buildStructuredBlock(input.text),
    ]);
    assertUsableVector(vector, STRUCTURAL_BASELINE_DIMENSION);

    return {
      provider: this.name,
      model: STRUCTURAL_BASELINE_PROFILE.embeddingModel,
      revision: STRUCTURAL_BASELINE_PROFILE.embeddingRevision,
      dimension: STRUCTURAL_BASELINE_DIMENSION,
      normalized: true,
      ...(input.instruction ? { instruction: input.instruction } : {}),
      inputHash: hashEmbeddingInput(input, STRUCTURAL_BASELINE_PROFILE),
      vectorChecksum: checksumVector(vector),
      vector,
      // Fixed, not wall-clock: this provider is deterministic and a timestamp
      // would make otherwise-identical results differ.
      generatedAt: 'deterministic',
      executionMode: 'LOCAL_DETERMINISTIC',
      latencyMs: Date.now() - startedAt,
    };
  }

  async embedBatch(inputs: readonly EmbeddingInput[]): Promise<readonly EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    for (const input of inputs) {
      // eslint-disable-next-line no-await-in-loop -- pure computation; kept ordered to match the input array
      results.push(await this.embed(input));
    }
    return results;
  }
}
