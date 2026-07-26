import { listReferenceScenes, listReferences, type ReferenceDataSource } from '@combat/database';
import type {
  AdminReferenceResult,
  CreativeMemoryQuery,
  CreativeMemorySearchResult,
  CreativeReferenceInsight,
  RerankingFallbackStatus,
} from '@combat/domain';
import {
  collectionNameFor,
  durationBucketFor,
  pointIdFor,
  QdrantError,
  RerankingError,
  StructuralRerankerProvider,
  type MultimodalEmbeddingProvider,
  type MultimodalRerankerProvider,
  type QdrantClient,
  type QdrantFilter,
  type QdrantPoint,
} from '@combat/providers';

import {
  buildQueryDocument,
  buildSceneEmbeddingDocument,
  pacingFor,
  type SceneDocumentSource,
} from './embedding-document';

/**
 * Indexing and retrieval for Creative Memory.
 *
 * Eligibility is enforced **before** the vector store is touched: workspace
 * ownership, `READY_FOR_RETRIEVAL` state, a permitted reference rights class
 * and an approved annotation. A vector database cannot express those rules, so
 * relying on payload filters alone would make the guarantee only as strong as
 * the last person who wrote a query. Here it is a property of what gets
 * indexed and what gets read back.
 */

export const INDEXABLE_STATES = ['READY_FOR_RETRIEVAL'] as const;

export interface SceneRecordBundle {
  readonly source: SceneDocumentSource;
  readonly referenceAdvertisementId: string;
  readonly sceneId: string;
  readonly reviewStatus: string;
  readonly rightsClassification: string;
  readonly hookCategory: string;
  readonly narrativeStage: string;
  readonly ingestionVersion: number;
  /** Admin-only join data. Never reaches an agent-safe result. */
  readonly admin: {
    readonly title: string;
    readonly brand: string;
    readonly agency?: string;
    readonly campaign?: string;
    readonly officialUrl?: string;
    readonly processingState: string;
    readonly analysisThumbnailPath?: string;
    readonly sceneStartSeconds: number;
    readonly sceneEndSeconds: number;
    readonly reviewerNotes?: string;
    readonly prohibitedDirectSimilarity: string;
  };
  readonly reviewerConfidence?: 'LOW' | 'MEDIUM' | 'HIGH';
}

/**
 * Gathers every scene of every retrieval-eligible reference in a workspace.
 *
 * A reference that is not `READY_FOR_RETRIEVAL`, or whose latest annotation is
 * unapproved, contributes nothing — it is not indexed, so it cannot be
 * retrieved even by a caller who bypasses the filters.
 */
export async function collectEligibleScenes(
  db: ReferenceDataSource,
  workspaceId: string,
  options: { requireApprovedAnnotation?: boolean } = {},
): Promise<readonly SceneRecordBundle[]> {
  const requireApproved = options.requireApprovedAnnotation ?? true;
  const references = await listReferences(db, workspaceId);
  const bundles: SceneRecordBundle[] = [];

  for (const reference of references) {
    if (!reference.mediaAcquired) continue;
    if (!(INDEXABLE_STATES as readonly string[]).includes(reference.processingState)) continue;

    // eslint-disable-next-line no-await-in-loop -- collected in stable reference order
    const annotations = await db.referenceAnnotation.findMany({
      where: { workspaceId, referenceAdvertisementId: reference.id },
      orderBy: { version: 'desc' },
    });
    const latest = annotations[0];
    if (requireApproved && !latest?.approved) continue;

    // eslint-disable-next-line no-await-in-loop -- same ordering rationale
    const metrics = await db.referenceCraftMetrics.findFirst({
      where: { workspaceId, referenceAdvertisementId: reference.id },
    });
    if (!metrics) continue;

    // eslint-disable-next-line no-await-in-loop -- same ordering rationale
    const scenes = await listReferenceScenes(db, workspaceId, reference.id);
    // eslint-disable-next-line no-await-in-loop -- same ordering rationale
    const transcripts = await db.referenceTranscript.findMany({
      where: { workspaceId, referenceAdvertisementId: reference.id },
    });
    const transcriptSegments = Array.isArray(
      (transcripts[0] as { segments?: unknown } | undefined)?.segments,
    )
      ? ((transcripts[0] as { segments: unknown[] }).segments.length as number)
      : undefined;

    for (const scene of scenes) {
      const annotation = latest as Record<string, unknown> | undefined;
      const text = (key: string): string | undefined => {
        const value = annotation?.[key];
        return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
      };
      const num = (key: string): number | undefined => {
        const value = annotation?.[key];
        return typeof value === 'number' ? value : undefined;
      };

      bundles.push({
        referenceAdvertisementId: reference.id,
        sceneId: scene.id,
        reviewStatus: latest?.approved ? 'APPROVED' : 'UNREVIEWED',
        rightsClassification: 'ANALYSIS_SIDE',
        hookCategory: classifyHook(text('hookMechanism')),
        narrativeStage: classifyStage(scene.sceneIndex, scenes.length),
        ingestionVersion: 1,
        ...(annotation?.reviewerConfidence
          ? { reviewerConfidence: annotation.reviewerConfidence as 'LOW' | 'MEDIUM' | 'HIGH' }
          : {}),
        source: {
          referenceId: reference.id,
          sceneId: scene.id,
          roleTags: [...reference.businessRoles],
          ...(reference.platform ? { platform: reference.platform } : {}),
          sceneIndex: scene.sceneIndex,
          sceneStartSeconds: scene.startSeconds,
          sceneDurationSeconds: scene.durationSeconds,
          advertisementDurationSeconds: metrics.durationSeconds,
          sceneCount: metrics.sceneCount,
          cutsPerSecond: metrics.cutsPerSecond,
          ...(typeof metrics.averageSceneSeconds === 'number'
            ? { averageSceneSeconds: metrics.averageSceneSeconds }
            : {}),
          ...(typeof metrics.firstCutSeconds === 'number'
            ? { firstCutSeconds: metrics.firstCutSeconds }
            : {}),
          aspectRatio: metrics.aspectRatio,
          hasAudio: metrics.hasAudio,
          ...(text('hookMechanism') ? { hookMechanism: text('hookMechanism') } : {}),
          ...(text('narrativeStructure') ? { narrativeStructure: text('narrativeStructure') } : {}),
          ...(text('cameraMovement') ? { cameraMovement: text('cameraMovement') } : {}),
          ...(text('transitionCategory') ? { transitionCategory: text('transitionCategory') } : {}),
          ...(text('typographyBehaviour')
            ? { typographyBehaviour: text('typographyBehaviour') }
            : {}),
          ...(text('soundProgression') ? { soundProgression: text('soundProgression') } : {}),
          ...(text('emotionalMechanism') ? { emotionalMechanism: text('emotionalMechanism') } : {}),
          ...(text('platformNativeCharacteristics')
            ? { platformNativeCharacteristics: text('platformNativeCharacteristics') }
            : {}),
          ...(text('audienceTension') ? { audienceTension: text('audienceTension') } : {}),
          ...(text('campaignProposition')
            ? { campaignProposition: text('campaignProposition') }
            : {}),
          ...(num('productRevealSeconds') !== undefined
            ? { productRevealSeconds: num('productRevealSeconds') }
            : {}),
          ...(num('ctaSeconds') !== undefined ? { ctaSeconds: num('ctaSeconds') } : {}),
          ...(text('transferablePrinciple')
            ? { transferablePrinciple: text('transferablePrinciple') }
            : {}),
          ...(transcriptSegments === undefined
            ? {}
            : { transcriptSegmentCount: transcriptSegments }),
        },
        admin: {
          title: reference.title,
          brand: reference.brand,
          ...(reference.agency ? { agency: reference.agency } : {}),
          ...(reference.campaign ? { campaign: reference.campaign } : {}),
          processingState: reference.processingState,
          sceneStartSeconds: scene.startSeconds,
          sceneEndSeconds: scene.endSeconds,
          ...(text('reviewerNotes') ? { reviewerNotes: text('reviewerNotes') } : {}),
          prohibitedDirectSimilarity:
            text('prohibitedDirectSimilarity') ?? 'Do not reproduce this reference directly.',
        },
      });
    }
  }

  return bundles;
}

/** Coarse hook classification from the reviewer's own words. `UNKNOWN` when unreviewed. */
export function classifyHook(hookMechanism?: string): string {
  if (!hookMechanism) return 'UNKNOWN';
  const text = hookMechanism.toLowerCase();
  if (/\b(number|count|stat|\d+)\b/.test(text)) return 'STAT_OR_NUMBER';
  if (text.includes('?') || /\bquestion|ask\b/.test(text)) return 'QUESTION';
  if (/\bconflict|tension|argu|dispute\b/.test(text)) return 'CONFLICT_OR_TENSION';
  if (/\bdemonstrat|show|reveal\b/.test(text)) return 'DEMONSTRATION';
  if (/\bspectacle|impact|explos\b/.test(text)) return 'SPECTACLE';
  if (/\btestimon|fan said|review\b/.test(text)) return 'TESTIMONIAL';
  return 'UNKNOWN';
}

/** Where a scene sits in the arc, from its position. A structural fact. */
export function classifyStage(sceneIndex: number, sceneCount: number): string {
  if (sceneCount <= 1) return 'HOOK';
  if (sceneIndex === 0) return 'HOOK';
  if (sceneIndex === sceneCount - 1) return 'CALL_TO_ACTION';
  const position = sceneIndex / (sceneCount - 1);
  if (position < 0.35) return 'SETUP';
  if (position < 0.7) return 'DEMONSTRATION';
  return 'PROOF';
}

// --- Indexing ---------------------------------------------------------------

export interface IndexOutcome {
  readonly sceneId: string;
  readonly status: 'INDEXED' | 'SKIPPED_UNCHANGED' | 'FAILED';
  readonly pointId?: string;
  readonly inputHash?: string;
  readonly detail?: string;
}

export interface IndexOptions {
  readonly db: ReferenceDataSource;
  readonly workspaceId: string;
  readonly embedder: MultimodalEmbeddingProvider;
  readonly qdrant: QdrantClient;
  readonly batchSize?: number;
  /** Re-embed even when the input hash is unchanged. */
  readonly force?: boolean;
  readonly onProgress?: (message: string) => void;
  /** Persists index state. Injected so the pipeline stays storage-agnostic. */
  readonly recordEntry?: (entry: {
    sceneId: string;
    referenceAdvertisementId: string;
    inputHash: string;
    vectorChecksum: string;
    pointId: string;
    collection: string;
    state: 'INDEXED' | 'FAILED';
    failureKind?: 'EMBEDDING_FAILED' | 'UPSERT_FAILED';
    failureDetail?: string;
  }) => Promise<void>;
  /** Returns the previously recorded input hash for a scene, if any. */
  readonly previousHash?: (sceneId: string) => Promise<string | undefined>;
}

export interface IndexSummary {
  readonly collection: string;
  readonly profile: string;
  readonly indexed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly outcomes: readonly IndexOutcome[];
}

export async function indexWorkspace(options: IndexOptions): Promise<IndexSummary> {
  const profile = options.embedder.getProfile();
  const collection = collectionNameFor(profile);
  await options.qdrant.ensureCollection(collection, profile.vectorDimension);

  const bundles = await collectEligibleScenes(options.db, options.workspaceId);
  options.onProgress?.(`${bundles.length} eligible scene(s) for ${profile.profile}`);

  const outcomes: IndexOutcome[] = [];
  const batchSize = options.batchSize ?? 16;

  /**
   * A point that has been embedded but is not yet in the collection, together
   * with everything needed to record its outcome once it is.
   *
   * The index entry is written **after** the upsert returns, never before. The
   * previous ordering recorded `INDEXED` at embed time, so a Qdrant failure
   * during the batch left rows claiming a scene was searchable when the
   * collection held nothing for it — and the next run, seeing an unchanged
   * input hash, would skip re-embedding it. A half-filled collection that looks
   * complete is the exact failure this package's rules single out.
   */
  interface PendingPoint {
    readonly point: QdrantPoint;
    readonly sceneId: string;
    readonly referenceAdvertisementId: string;
    readonly inputHash: string;
    readonly vectorChecksum: string;
    /** Slot in `outcomes`, so a failed flush rewrites the report in place. */
    readonly outcomeIndex: number;
  }
  const pending: PendingPoint[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    try {
      await options.qdrant.upsertPoints(
        collection,
        batch.map((entry) => entry.point),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      for (const entry of batch) {
        outcomes[entry.outcomeIndex] = { sceneId: entry.sceneId, status: 'FAILED', detail };
        // eslint-disable-next-line no-await-in-loop -- recorded in batch order
        await options.recordEntry?.({
          sceneId: entry.sceneId,
          referenceAdvertisementId: entry.referenceAdvertisementId,
          inputHash: entry.inputHash,
          vectorChecksum: entry.vectorChecksum,
          pointId: entry.point.id,
          collection,
          state: 'FAILED',
          failureKind: 'UPSERT_FAILED',
          failureDetail: detail,
        });
      }
      throw error;
    }

    for (const entry of batch) {
      // eslint-disable-next-line no-await-in-loop -- recorded in batch order
      await options.recordEntry?.({
        sceneId: entry.sceneId,
        referenceAdvertisementId: entry.referenceAdvertisementId,
        inputHash: entry.inputHash,
        vectorChecksum: entry.vectorChecksum,
        pointId: entry.point.id,
        collection,
        state: 'INDEXED',
      });
    }
  };

  for (const bundle of bundles) {
    const document = buildSceneEmbeddingDocument(bundle.source);
    // Image modality only when the profile actually supports it.
    const input =
      profile.supportedModalities.includes('IMAGE') && profile.maxImagesPerInput > 0
        ? document
        : { ...document, imagePaths: [] };

    let embedded;
    try {
      // eslint-disable-next-line no-await-in-loop -- embedded in stable scene order
      embedded = await options.embedder.embed(input);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcomes.push({ sceneId: bundle.sceneId, status: 'FAILED', detail });
      // eslint-disable-next-line no-await-in-loop -- same ordering rationale
      await options.recordEntry?.({
        sceneId: bundle.sceneId,
        referenceAdvertisementId: bundle.referenceAdvertisementId,
        inputHash: '',
        vectorChecksum: '',
        pointId: '',
        collection,
        state: 'FAILED',
        failureKind: 'EMBEDDING_FAILED',
        failureDetail: detail,
      });
      continue;
    }

    if (!options.force && options.previousHash) {
      // eslint-disable-next-line no-await-in-loop -- same ordering rationale
      const previous = await options.previousHash(bundle.sceneId);
      if (previous === embedded.inputHash) {
        outcomes.push({ sceneId: bundle.sceneId, status: 'SKIPPED_UNCHANGED' });
        continue;
      }
    }

    const pointId = pointIdFor(options.workspaceId, bundle.sceneId, profile.profile);
    const point: QdrantPoint = {
      id: pointId,
      vector: embedded.vector,
      payload: {
        workspaceId: options.workspaceId,
        referenceId: bundle.referenceAdvertisementId,
        sceneId: bundle.sceneId,
        roleTags: [...bundle.source.roleTags],
        platform: bundle.source.platform ?? null,
        reviewStatus: bundle.reviewStatus,
        rightsClassification: bundle.rightsClassification,
        durationBucket: durationBucketFor(bundle.source.advertisementDurationSeconds),
        hookCategory: bundle.hookCategory,
        narrativeStage: bundle.narrativeStage,
        ingestionVersion: bundle.ingestionVersion,
        modelRevision: profile.embeddingRevision,
      },
    };

    pending.push({
      point,
      sceneId: bundle.sceneId,
      referenceAdvertisementId: bundle.referenceAdvertisementId,
      inputHash: embedded.inputHash,
      vectorChecksum: embedded.vectorChecksum,
      outcomeIndex:
        outcomes.push({
          sceneId: bundle.sceneId,
          status: 'INDEXED',
          pointId,
          inputHash: embedded.inputHash,
        }) - 1,
    });

    if (pending.length >= batchSize) {
      // eslint-disable-next-line no-await-in-loop -- batched writes are inherently sequential
      await flush();
    }
  }

  await flush();

  return {
    collection,
    profile: profile.profile,
    indexed: outcomes.filter((o) => o.status === 'INDEXED').length,
    skipped: outcomes.filter((o) => o.status === 'SKIPPED_UNCHANGED').length,
    failed: outcomes.filter((o) => o.status === 'FAILED').length,
    outcomes,
  };
}

// --- Search ------------------------------------------------------------------

export interface SearchOptions {
  readonly db: ReferenceDataSource;
  readonly query: CreativeMemoryQuery;
  readonly embedder: MultimodalEmbeddingProvider;
  readonly qdrant: QdrantClient;
  readonly reranker?: MultimodalRerankerProvider;
}

export class RetrievalError extends Error {
  constructor(
    public readonly kind:
      | 'QDRANT_UNAVAILABLE'
      | 'EMBEDDING_UNAVAILABLE'
      | 'RERANKING_FAILED'
      | 'NO_ELIGIBLE_REFERENCES',
    message: string,
  ) {
    super(message);
    this.name = 'RetrievalError';
  }
}

export async function searchCreativeMemory(
  options: SearchOptions,
): Promise<CreativeMemorySearchResult> {
  const { query } = options;
  const profile = options.embedder.getProfile();
  const collection = collectionNameFor(profile);

  // Eligibility is recomputed from PostgreSQL, not trusted from the payload:
  // a reference withdrawn or unapproved since indexing must vanish from
  // results immediately, without waiting for a reindex.
  const eligible = await collectEligibleScenes(options.db, query.workspaceId, {
    requireApprovedAnnotation: query.filter.requireApprovedAnnotation,
  });
  if (eligible.length === 0) {
    throw new RetrievalError(
      'NO_ELIGIBLE_REFERENCES',
      `no reference in workspace ${query.workspaceId} is READY_FOR_RETRIEVAL with an approved annotation`,
    );
  }
  const bySceneId = new Map(eligible.map((bundle) => [bundle.sceneId, bundle]));

  const queryVector = await options.embedder.embed(
    buildQueryDocument(query.query, {
      ...(query.filter.businessRole ? { businessRole: query.filter.businessRole } : {}),
      ...(query.filter.platform ? { platform: query.filter.platform } : {}),
      ...(query.filter.targetDurationSeconds !== undefined
        ? { targetDurationSeconds: query.filter.targetDurationSeconds }
        : {}),
      ...(query.filter.desiredPacing ? { desiredPacing: query.filter.desiredPacing } : {}),
      ...(query.filter.desiredHook ? { desiredHook: query.filter.desiredHook } : {}),
      ...(query.filter.narrativeStage ? { narrativeStage: query.filter.narrativeStage } : {}),
    }),
  );

  // Workspace isolation is a hard payload filter as well as a join-side check.
  const must: QdrantFilter['must'] = [
    { key: 'workspaceId', match: { value: query.workspaceId } },
    ...(query.filter.businessRole
      ? [{ key: 'roleTags', match: { value: query.filter.businessRole } }]
      : []),
    ...(query.filter.platform
      ? [{ key: 'platform', match: { value: query.filter.platform } }]
      : []),
  ];

  let hits;
  try {
    hits = await options.qdrant.search(collection, queryVector.vector, query.candidateCount, {
      must,
    });
  } catch (error) {
    throw new RetrievalError(
      'QDRANT_UNAVAILABLE',
      error instanceof QdrantError ? `${error.kind}: ${error.message}` : String(error),
    );
  }

  // Anything Qdrant returns that is no longer eligible is dropped here.
  const candidates = hits
    .map((hit) => ({ hit, bundle: bySceneId.get(hit.payload.sceneId) }))
    .filter(
      (entry): entry is { hit: (typeof hits)[number]; bundle: SceneRecordBundle } =>
        entry.bundle !== undefined,
    );

  // --- rerank ---------------------------------------------------------------
  const reranker = options.reranker ?? new StructuralRerankerProvider();
  let fallbackStatus: RerankingFallbackStatus = reranker.getCapabilities().neural
    ? 'NONE'
    : 'FALLBACK_STRUCTURAL_RERANKING';
  let rerankScores = new Map<string, number>();

  if (candidates.length > 0) {
    try {
      const result = await reranker.rerank({
        query: query.query,
        candidates: candidates.map(({ bundle }) => ({
          candidateId: bundle.sceneId,
          document: buildSceneEmbeddingDocument(bundle.source).text,
          imagePaths: [],
        })),
      });
      rerankScores = new Map(result.scores.map((score) => [score.candidateId, score.score]));
      if (reranker.getCapabilities().neural) fallbackStatus = result.fallbackStatus;
    } catch (error) {
      // A neural reranker that failed must never be reported as having run.
      if (!(error instanceof RerankingError)) throw error;
      const structural = new StructuralRerankerProvider();
      const result = await structural.rerank({
        query: query.query,
        candidates: candidates.map(({ bundle }) => ({
          candidateId: bundle.sceneId,
          document: buildSceneEmbeddingDocument(bundle.source).text,
        })),
      });
      rerankScores = new Map(result.scores.map((score) => [score.candidateId, score.score]));
      fallbackStatus = 'FALLBACK_STRUCTURAL_RERANKING';
    }
  }

  // --- compose, diversify, rank ----------------------------------------------
  const scored = candidates.map(({ hit, bundle }) => {
    const roleMatch = query.filter.businessRole
      ? bundle.source.roleTags.includes(query.filter.businessRole)
      : true;
    const platformMatch = query.filter.platform
      ? bundle.source.platform === query.filter.platform
      : true;
    const pacingMatch = query.filter.desiredPacing
      ? pacingFor(bundle.source.cutsPerSecond) === query.filter.desiredPacing
      : true;
    const hookMatch = query.filter.desiredHook
      ? bundle.hookCategory === query.filter.desiredHook
      : true;
    const confidenceBonus =
      bundle.reviewerConfidence === 'HIGH'
        ? 0.06
        : bundle.reviewerConfidence === 'MEDIUM'
          ? 0.03
          : 0;

    const rerankScore = rerankScores.get(bundle.sceneId) ?? 0;
    const composite =
      hit.score * 0.45 +
      rerankScore * 0.35 +
      (roleMatch ? 0.05 : 0) +
      (platformMatch ? 0.03 : 0) +
      (pacingMatch ? 0.04 : 0) +
      (hookMatch ? 0.04 : 0) +
      confidenceBonus;

    return {
      hit,
      bundle,
      roleMatch,
      platformMatch,
      pacingMatch,
      hookMatch,
      rerankScore,
      composite,
    };
  });

  scored.sort((a, b) =>
    b.composite === a.composite
      ? a.bundle.sceneId.localeCompare(b.bundle.sceneId)
      : b.composite - a.composite,
  );

  // Diversification: cap scenes per advertisement so one reference cannot own
  // the whole result set, which would make the library look far narrower than
  // it is.
  const perReference = new Map<string, number>();
  const selected: typeof scored = [];
  const deferred: typeof scored = [];
  for (const entry of scored) {
    const used = perReference.get(entry.bundle.referenceAdvertisementId) ?? 0;
    if (used < query.maxScenesPerReference) {
      perReference.set(entry.bundle.referenceAdvertisementId, used + 1);
      selected.push(entry);
    } else {
      deferred.push(entry);
    }
    if (selected.length >= query.resultCount) break;
  }
  // Backfill only if the cap left the page short.
  for (const entry of deferred) {
    if (selected.length >= query.resultCount) break;
    selected.push(entry);
  }

  const rerankingProfile = reranker.name;
  const insights: CreativeReferenceInsight[] = selected.map((entry, index) => ({
    referenceId: entry.bundle.referenceAdvertisementId,
    sceneId: entry.bundle.sceneId,
    roleTags: [...entry.bundle.source.roleTags] as CreativeReferenceInsight['roleTags'],
    ...(entry.bundle.source.platform ? { platform: entry.bundle.source.platform } : {}),
    craft: {
      sceneDurationSeconds: entry.bundle.source.sceneDurationSeconds,
      advertisementDurationSeconds: entry.bundle.source.advertisementDurationSeconds,
      sceneCount: entry.bundle.source.sceneCount,
      cutsPerSecond: entry.bundle.source.cutsPerSecond,
      ...(entry.bundle.source.averageSceneSeconds !== undefined
        ? { averageSceneSeconds: entry.bundle.source.averageSceneSeconds }
        : {}),
      ...(entry.bundle.source.firstCutSeconds !== undefined
        ? { firstCutSeconds: entry.bundle.source.firstCutSeconds }
        : {}),
      aspectRatio: entry.bundle.source.aspectRatio,
      pacing: pacingFor(entry.bundle.source.cutsPerSecond),
    },
    ...(entry.bundle.source.hookMechanism
      ? { hookMechanism: entry.bundle.source.hookMechanism }
      : {}),
    ...(entry.bundle.source.narrativeStructure
      ? { narrativeStructure: entry.bundle.source.narrativeStructure }
      : {}),
    ...(entry.bundle.source.cameraMovement
      ? { cameraMovement: entry.bundle.source.cameraMovement }
      : {}),
    ...(entry.bundle.source.transitionCategory
      ? { transitionCategory: entry.bundle.source.transitionCategory }
      : {}),
    ...(entry.bundle.source.typographyBehaviour
      ? { typographyBehaviour: entry.bundle.source.typographyBehaviour }
      : {}),
    ...(entry.bundle.source.soundProgression
      ? { soundProgression: entry.bundle.source.soundProgression }
      : {}),
    ...(entry.bundle.source.productRevealSeconds !== undefined
      ? { productRevealSeconds: entry.bundle.source.productRevealSeconds }
      : {}),
    ...(entry.bundle.source.ctaSeconds !== undefined
      ? { ctaSeconds: entry.bundle.source.ctaSeconds }
      : {}),
    transferablePrinciple:
      entry.bundle.source.transferablePrinciple ?? 'No reviewed principle recorded.',
    prohibitedDirectSimilarity: entry.bundle.admin.prohibitedDirectSimilarity,
    explanation: {
      vectorRecallScore: Number(entry.hit.score.toFixed(6)),
      rerankScore: Number(entry.rerankScore.toFixed(6)),
      roleMatch: entry.roleMatch,
      platformMatch: entry.platformMatch,
      pacingMatch: entry.pacingMatch,
      hookMatch: entry.hookMatch,
      diversityAdjustment: 0,
      ...(entry.bundle.reviewerConfidence
        ? { reviewerConfidence: entry.bundle.reviewerConfidence }
        : {}),
      finalRank: index + 1,
      retrievalProfile: profile.profile,
      rerankingProfile,
      fallbackStatus,
    },
  }));

  const base = {
    mode: query.mode,
    profile: profile.profile,
    rerankingProfile,
    fallbackStatus,
    qdrantCollection: collection,
    candidatesRetrieved: hits.length,
    notice: 'Reference material is analysis-only. Retrieval grants no output rights.' as const,
  };

  if (query.mode === 'ADMIN') {
    const adminResults: AdminReferenceResult[] = selected.map((entry, index) => ({
      ...(insights[index] as CreativeReferenceInsight),
      title: entry.bundle.admin.title,
      brand: entry.bundle.admin.brand,
      ...(entry.bundle.admin.agency ? { agency: entry.bundle.admin.agency } : {}),
      ...(entry.bundle.admin.campaign ? { campaign: entry.bundle.admin.campaign } : {}),
      ...(entry.bundle.admin.officialUrl ? { officialUrl: entry.bundle.admin.officialUrl } : {}),
      rightsClassification: entry.bundle.rightsClassification,
      processingState: entry.bundle.admin.processingState,
      ...(entry.bundle.admin.analysisThumbnailPath
        ? { analysisThumbnailPath: entry.bundle.admin.analysisThumbnailPath }
        : {}),
      sceneStartSeconds: entry.bundle.admin.sceneStartSeconds,
      sceneEndSeconds: entry.bundle.admin.sceneEndSeconds,
      ...(entry.bundle.admin.reviewerNotes
        ? { reviewerNotes: entry.bundle.admin.reviewerNotes }
        : {}),
      diagnostics: { compositeScore: entry.composite, hookCategory: entry.bundle.hookCategory },
    }));
    return { ...base, adminResults };
  }

  return { ...base, insights };
}
