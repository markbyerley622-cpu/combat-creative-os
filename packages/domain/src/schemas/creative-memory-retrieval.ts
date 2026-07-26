import { z } from 'zod';

import { ReferenceBusinessRoleSchema } from './creative-memory';

/**
 * Creative Memory retrieval — making the reference library searchable.
 *
 * Two properties matter more than relevance here.
 *
 * **The agent-safe boundary.** A specialist agent must be able to learn *what
 * worked* without ever receiving the material it worked in. `AGENT_SAFE`
 * results carry abstractions and measurements; `ADMIN` results carry
 * everything a human reviewer needs. The two are separate types with separate
 * projections, and `toAgentSafeInsight` is the only way to produce the first —
 * so a new field added to the admin shape cannot leak by default.
 *
 * **Retrieval grants nothing.** Being indexed, retrieved, reranked and returned
 * changes no rights. Reference material is analysis-only before a search and
 * analysis-only after one.
 */

// --- Query ------------------------------------------------------------------

export const RETRIEVAL_MODES = ['ADMIN', 'AGENT_SAFE'] as const;
export const RetrievalModeSchema = z.enum(RETRIEVAL_MODES);
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;

export const HOOK_CATEGORIES = [
  'STAT_OR_NUMBER',
  'QUESTION',
  'CONFLICT_OR_TENSION',
  'DEMONSTRATION',
  'SPECTACLE',
  'TESTIMONIAL',
  'UNKNOWN',
] as const;
export const HookCategorySchema = z.enum(HOOK_CATEGORIES);
export type HookCategory = z.infer<typeof HookCategorySchema>;

export const PACING_PROFILES = ['SLOW', 'MEASURED', 'FAST', 'VERY_FAST'] as const;
export const PacingProfileSchema = z.enum(PACING_PROFILES);
export type PacingProfile = z.infer<typeof PacingProfileSchema>;

export const NARRATIVE_STAGES = [
  'HOOK',
  'SETUP',
  'DEMONSTRATION',
  'PROOF',
  'RESOLUTION',
  'CALL_TO_ACTION',
] as const;
export const NarrativeStageSchema = z.enum(NARRATIVE_STAGES);
export type NarrativeStage = z.infer<typeof NarrativeStageSchema>;

/** Hard ceilings. A query cannot ask for unbounded work. */
export const MAX_QUERY_CHARACTERS = 2000;
export const MAX_CANDIDATE_COUNT = 200;
export const MAX_RESULT_COUNT = 50;
export const DEFAULT_CANDIDATE_COUNT = 40;
export const DEFAULT_RESULT_COUNT = 8;
export const DEFAULT_MAX_SCENES_PER_REFERENCE = 2;

export const CreativeMemoryFilterSchema = z
  .object({
    businessRole: ReferenceBusinessRoleSchema.optional(),
    platform: z.string().min(1).max(80).optional(),
    /** Seconds. Used for compatibility scoring, not a hard cut. */
    targetDurationSeconds: z.number().positive().max(600).optional(),
    desiredHook: HookCategorySchema.optional(),
    desiredPacing: PacingProfileSchema.optional(),
    narrativeStage: NarrativeStageSchema.optional(),
    transitionCategories: z.array(z.string().min(1).max(80)).max(10).default([]),
    /**
     * Only references a human has reviewed and approved are retrievable by
     * default. Admin tooling may widen this; agents never can.
     */
    requireApprovedAnnotation: z.boolean().default(true),
  })
  .strict();
export type CreativeMemoryFilter = z.infer<typeof CreativeMemoryFilterSchema>;

export const CreativeMemoryQuerySchema = z
  .object({
    queryVersion: z.literal(1),
    workspaceId: z.string().uuid(),
    query: z.string().min(1).max(MAX_QUERY_CHARACTERS),
    intendedAudience: z.string().max(500).optional(),
    campaignObjective: z.string().max(500).optional(),
    filter: CreativeMemoryFilterSchema.default({}),
    candidateCount: z
      .number()
      .int()
      .min(1)
      .max(MAX_CANDIDATE_COUNT)
      .default(DEFAULT_CANDIDATE_COUNT),
    resultCount: z.number().int().min(1).max(MAX_RESULT_COUNT).default(DEFAULT_RESULT_COUNT),
    maxScenesPerReference: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(DEFAULT_MAX_SCENES_PER_REFERENCE),
    mode: RetrievalModeSchema.default('AGENT_SAFE'),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.resultCount > query.candidateCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `resultCount (${query.resultCount}) cannot exceed candidateCount (${query.candidateCount}) — reranking cannot invent candidates`,
        path: ['resultCount'],
      });
    }
  });
export type CreativeMemoryQuery = z.infer<typeof CreativeMemoryQuerySchema>;

// --- Embedding --------------------------------------------------------------

export const EMBEDDING_MODALITIES = ['TEXT', 'IMAGE'] as const;
export const EmbeddingModalitySchema = z.enum(EMBEDDING_MODALITIES);
export type EmbeddingModality = z.infer<typeof EmbeddingModalitySchema>;

export const CREATIVE_MEMORY_PROFILES = [
  /** Real, deterministic, non-neural. Runs anywhere with no model weights. */
  'STRUCTURAL_BASELINE_V1',
  'QWEN3_VL_2B_QUALITY_V1',
  'QWEN3_VL_8B_REMOTE_QUALITY_V1',
] as const;
export const CreativeMemoryProfileSchema = z.enum(CREATIVE_MEMORY_PROFILES);
export type CreativeMemoryProfile = z.infer<typeof CreativeMemoryProfileSchema>;

export const EXECUTION_MODES = [
  'LOCAL_DETERMINISTIC',
  'LOCAL_ENDPOINT',
  'REMOTE_ENDPOINT',
] as const;
export const ExecutionModeSchema = z.enum(EXECUTION_MODES);

/**
 * A profile's declared, verifiable identity. `vectorDimension` is load-bearing:
 * a collection is keyed by it, and an embedder returning a different width is
 * refused rather than written.
 */
export const CreativeMemoryModelProfileSchema = z
  .object({
    profile: CreativeMemoryProfileSchema,
    embeddingModel: z.string().min(1),
    embeddingRevision: z.string().min(1),
    rerankerModel: z.string().min(1).optional(),
    rerankerRevision: z.string().min(1).optional(),
    vectorDimension: z.number().int().positive(),
    /** Whether the provider guarantees L2-normalised vectors. Never assumed. */
    normalized: z.boolean(),
    supportedModalities: z.array(EmbeddingModalitySchema).min(1),
    maxImagesPerInput: z.number().int().nonnegative(),
    /** True only for a profile that needs no neural weights. */
    neural: z.boolean(),
    executionMode: ExecutionModeSchema,
    /** Schema version of the embedding *document*; bumping it invalidates vectors. */
    documentSchemaVersion: z.number().int().positive(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreativeMemoryModelProfile = z.infer<typeof CreativeMemoryModelProfileSchema>;

export const EmbeddingInputSchema = z
  .object({
    /** Deterministic text document. Never contains raw advertising copy. */
    text: z.string().min(1),
    /** Absolute paths to analysis frames. Only used by image-capable profiles. */
    imagePaths: z.array(z.string().min(1)).max(16).default([]),
    /** Task instruction, as the Qwen3-VL contract expects. */
    instruction: z.string().min(1).max(500).optional(),
    /** Which fields contributed, so a change can invalidate the vector. */
    contributingFields: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type EmbeddingInput = z.infer<typeof EmbeddingInputSchema>;

export const EmbeddingResultSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    revision: z.string().min(1),
    dimension: z.number().int().positive(),
    normalized: z.boolean(),
    instruction: z.string().max(500).optional(),
    /** sha256 of the canonical embedding input. Changing any contributing field changes it. */
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** sha256 of the vector itself, so a silently-changed vector is detectable. */
    vectorChecksum: z.string().regex(/^[0-9a-f]{64}$/),
    vector: z.array(z.number()),
    generatedAt: z.string().min(1),
    executionMode: ExecutionModeSchema,
    latencyMs: z.number().nonnegative().optional(),
    usage: z.record(z.string(), z.number()).optional(),
  })
  .strict();
export type EmbeddingResult = z.infer<typeof EmbeddingResultSchema>;

// --- Reranking --------------------------------------------------------------

export const RERANKING_FALLBACK_STATUSES = [
  'NONE',
  'FALLBACK_STRUCTURAL_RERANKING',
  'RERANKING_UNAVAILABLE',
] as const;
export const RerankingFallbackStatusSchema = z.enum(RERANKING_FALLBACK_STATUSES);
export type RerankingFallbackStatus = z.infer<typeof RerankingFallbackStatusSchema>;

export const RerankingInputSchema = z
  .object({
    query: z.string().min(1).max(MAX_QUERY_CHARACTERS),
    instruction: z.string().max(500).optional(),
    candidates: z
      .array(
        z
          .object({
            candidateId: z.string().min(1),
            document: z.string().min(1),
            imagePaths: z.array(z.string().min(1)).max(8).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CANDIDATE_COUNT),
  })
  .strict();
export type RerankingInput = z.infer<typeof RerankingInputSchema>;

export const RerankingResultSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    revision: z.string().min(1),
    fallbackStatus: RerankingFallbackStatusSchema,
    scores: z.array(z.object({ candidateId: z.string().min(1), score: z.number() }).strict()),
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict();
export type RerankingResult = z.infer<typeof RerankingResultSchema>;

// --- Index state ------------------------------------------------------------

export const INDEX_STATES = [
  'PENDING',
  'INDEXING',
  'INDEXED',
  'STALE',
  'DELETED',
  'FAILED',
] as const;
export const IndexStateSchema = z.enum(INDEX_STATES);
export type IndexState = z.infer<typeof IndexStateSchema>;

export const INDEX_FAILURE_TYPES = [
  'EMBEDDING_FAILED',
  'DIMENSION_MISMATCH',
  'INVALID_VECTOR',
  'QDRANT_UNAVAILABLE',
  'UPSERT_FAILED',
  'INELIGIBLE',
] as const;
export const IndexFailureTypeSchema = z.enum(INDEX_FAILURE_TYPES);
export type IndexFailureType = z.infer<typeof IndexFailureTypeSchema>;

export const IndexedReferenceSceneSchema = z
  .object({
    workspaceId: z.string().uuid(),
    referenceSceneId: z.string().uuid(),
    referenceAdvertisementId: z.string().uuid(),
    profile: CreativeMemoryProfileSchema,
    modelRevision: z.string().min(1),
    vectorDimension: z.number().int().positive(),
    embeddingInputHash: z.string().regex(/^[0-9a-f]{64}$/),
    vectorChecksum: z.string().regex(/^[0-9a-f]{64}$/),
    qdrantCollection: z.string().min(1),
    qdrantPointId: z.string().min(1),
    state: IndexStateSchema,
    indexedAt: z.date().optional(),
    lastVerifiedAt: z.date().optional(),
    failureType: IndexFailureTypeSchema.optional(),
    /** Redacted before persistence — never carries an endpoint credential. */
    failureDetail: z.string().max(2000).optional(),
  })
  .strict();
export type IndexedReferenceScene = z.infer<typeof IndexedReferenceSceneSchema>;

export const CreativeMemoryIndexRunSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    profile: CreativeMemoryProfileSchema,
    qdrantCollection: z.string().min(1),
    startedAt: z.date(),
    completedAt: z.date().optional(),
    indexedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
  })
  .strict();
export type CreativeMemoryIndexRun = z.infer<typeof CreativeMemoryIndexRunSchema>;

// --- Results ----------------------------------------------------------------

/**
 * Why a result ranked where it did. Every field is a real scoring component
 * produced by the pipeline — there is deliberately no natural-language
 * `explanation` string, because a generated sentence about a score is a
 * plausible-sounding restatement, not evidence.
 */
export const RetrievalExplanationSchema = z
  .object({
    vectorRecallScore: z.number(),
    rerankScore: z.number(),
    roleMatch: z.boolean(),
    platformMatch: z.boolean(),
    pacingMatch: z.boolean(),
    hookMatch: z.boolean(),
    diversityAdjustment: z.number(),
    reviewerConfidence: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    finalRank: z.number().int().positive(),
    retrievalProfile: CreativeMemoryProfileSchema,
    rerankingProfile: z.string().min(1),
    fallbackStatus: RerankingFallbackStatusSchema,
  })
  .strict();
export type RetrievalExplanation = z.infer<typeof RetrievalExplanationSchema>;

/**
 * What an agent may see.
 *
 * Every field is an abstraction or a measurement. There is no path, no URL, no
 * byte, no transcript, no advertising copy — see `AGENT_SAFE_FORBIDDEN_KEYS`
 * and the exhaustive test that walks a serialised result looking for them.
 */
export const CreativeReferenceInsightSchema = z
  .object({
    referenceId: z.string().uuid(),
    sceneId: z.string().uuid(),
    roleTags: z.array(ReferenceBusinessRoleSchema),
    platform: z.string().max(80).optional(),
    craft: z
      .object({
        sceneDurationSeconds: z.number().positive(),
        advertisementDurationSeconds: z.number().positive(),
        sceneCount: z.number().int().nonnegative(),
        cutsPerSecond: z.number().min(0),
        averageSceneSeconds: z.number().positive().optional(),
        firstCutSeconds: z.number().min(0).optional(),
        aspectRatio: z.string().min(1),
        pacing: PacingProfileSchema,
      })
      .strict(),
    hookMechanism: z.string().max(1000).optional(),
    narrativeStructure: z.string().max(1000).optional(),
    cameraMovement: z.string().max(200).optional(),
    transitionCategory: z.string().max(200).optional(),
    typographyBehaviour: z.string().max(1000).optional(),
    soundProgression: z.string().max(1000).optional(),
    productRevealSeconds: z.number().min(0).optional(),
    ctaSeconds: z.number().min(0).optional(),
    transferablePrinciple: z.string().min(1).max(2000),
    prohibitedDirectSimilarity: z.string().min(1).max(2000),
    explanation: RetrievalExplanationSchema,
  })
  .strict();
export type CreativeReferenceInsight = z.infer<typeof CreativeReferenceInsightSchema>;

/** What a human reviewer may see. A superset, never handed to an agent. */
export const AdminReferenceResultSchema = CreativeReferenceInsightSchema.extend({
  title: z.string(),
  brand: z.string(),
  agency: z.string().optional(),
  campaign: z.string().optional(),
  officialUrl: z.string().optional(),
  rightsClassification: z.string(),
  processingState: z.string(),
  /** Analysis thumbnail path. Admin-only, and still analysis-only material. */
  analysisThumbnailPath: z.string().optional(),
  sceneStartSeconds: z.number(),
  sceneEndSeconds: z.number(),
  reviewerNotes: z.string().optional(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type AdminReferenceResult = z.infer<typeof AdminReferenceResultSchema>;

export const CreativeMemorySearchResultSchema = z
  .object({
    mode: RetrievalModeSchema,
    profile: CreativeMemoryProfileSchema,
    rerankingProfile: z.string().min(1),
    fallbackStatus: RerankingFallbackStatusSchema,
    qdrantCollection: z.string().min(1),
    candidatesRetrieved: z.number().int().nonnegative(),
    insights: z.array(CreativeReferenceInsightSchema).optional(),
    adminResults: z.array(AdminReferenceResultSchema).optional(),
    /** Always present. Retrieval never changes what a reference may be used for. */
    notice: z.literal('Reference material is analysis-only. Retrieval grants no output rights.'),
  })
  .strict();
export type CreativeMemorySearchResult = z.infer<typeof CreativeMemorySearchResultSchema>;

/**
 * Keys that must never appear anywhere in a serialised `AGENT_SAFE` payload.
 *
 * Checked by walking the actual JSON rather than by inspecting the type, because
 * the risk is a field added later that the type permits and nobody re-reads.
 */
export const AGENT_SAFE_FORBIDDEN_KEYS = [
  'localPath',
  'filepath',
  'filePath',
  'path',
  'officialUrl',
  'url',
  'analysisThumbnailPath',
  'transcript',
  'segments',
  'copy',
  'lyrics',
  'music',
  'frame',
  'frames',
  'logo',
  'assetId',
  'checksumSha256',
  'agency',
  'brand',
  'title',
  'campaign',
  'reviewerNotes',
] as const;

/** Substrings that betray a filesystem path or a fetchable resource. */
export const AGENT_SAFE_FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = [
  /[A-Za-z]:[\\/]/, // Windows absolute path
  /^\/(?:home|Users|var|tmp|mnt)\//, // POSIX absolute path
  /https?:\/\//i,
  /\.(?:mp4|mov|webm|mkv|jpg|jpeg|png|wav|mp3)\b/i,
];
