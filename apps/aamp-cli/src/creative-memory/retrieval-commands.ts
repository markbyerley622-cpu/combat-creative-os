import { type ReferenceDataSource } from '@combat/database';
import { CreativeMemoryQuerySchema, type CreativeMemoryQuery } from '@combat/domain';
import {
  collectionNameFor,
  QdrantClient,
  QdrantError,
  Qwen3VlEmbeddingProvider,
  Qwen3VlRerankerProvider,
  StructuralBaselineEmbeddingProvider,
  StructuralRerankerProvider,
  type MultimodalEmbeddingProvider,
  type MultimodalRerankerProvider,
} from '@combat/providers';

import { indexWorkspace, RetrievalError, searchCreativeMemory } from './retrieval-pipeline';

/**
 * Retrieval subcommands for `pnpm aamp:reference`.
 *
 * Exit codes are distinct per failure class, because the responses differ:
 * "Qdrant is down" is an infrastructure problem, "the endpoint serves a
 * different model" is a configuration problem, and "nothing is eligible" means
 * a human has not approved any annotations yet.
 */

export const RETRIEVAL_EXIT_CODES = {
  SUCCESS: 0,
  INVALID_QUERY: 2,
  UNAUTHORIZED_WORKSPACE: 3,
  EMBEDDING_PROVIDER_UNAVAILABLE: 11,
  INCOMPATIBLE_MODEL_PROFILE: 12,
  QDRANT_UNAVAILABLE: 13,
  INDEXING_FAILURE: 14,
  RERANKING_FAILURE: 15,
  NO_ELIGIBLE_REFERENCES: 16,
} as const;
export type RetrievalExitCode = (typeof RETRIEVAL_EXIT_CODES)[keyof typeof RETRIEVAL_EXIT_CODES];

export interface RetrievalCliEnv {
  readonly CREATIVE_MEMORY_EMBEDDING_PROFILE?: string;
  readonly CREATIVE_MEMORY_EMBEDDING_ENDPOINT?: string;
  readonly CREATIVE_MEMORY_RERANKER_ENDPOINT?: string;
  readonly CREATIVE_MEMORY_EMBEDDING_API_KEY?: string;
  readonly CREATIVE_MEMORY_BATCH_SIZE?: string;
  readonly CREATIVE_MEMORY_TIMEOUT_MS?: string;
  readonly QDRANT_URL?: string;
  readonly QDRANT_API_KEY?: string;
}

export interface RetrievalContext {
  readonly db: ReferenceDataSource;
  readonly env: RetrievalCliEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Injected by tests; production builds them from env. */
  readonly embedder?: MultimodalEmbeddingProvider;
  readonly reranker?: MultimodalRerankerProvider;
  readonly qdrant?: QdrantClient;
}

/**
 * Builds the embedder named by configuration.
 *
 * A neural profile without an endpoint is refused rather than quietly replaced
 * by the structural baseline — a collection labelled `QWEN3_VL_2B_QUALITY_V1`
 * holding non-neural vectors would be a lie that only surfaced as poor results
 * much later.
 */
export function resolveEmbedder(env: RetrievalCliEnv): MultimodalEmbeddingProvider {
  const profile = env.CREATIVE_MEMORY_EMBEDDING_PROFILE ?? 'STRUCTURAL_BASELINE_V1';
  if (profile === 'STRUCTURAL_BASELINE_V1') return new StructuralBaselineEmbeddingProvider();

  if (profile !== 'QWEN3_VL_2B_QUALITY_V1' && profile !== 'QWEN3_VL_8B_REMOTE_QUALITY_V1') {
    throw new Error(`unknown CREATIVE_MEMORY_EMBEDDING_PROFILE "${profile}"`);
  }
  const endpoint = env.CREATIVE_MEMORY_EMBEDDING_ENDPOINT?.trim();
  if (!endpoint) {
    throw new Error(
      `profile ${profile} requires CREATIVE_MEMORY_EMBEDDING_ENDPOINT — refusing to fall back to the non-neural baseline under a neural profile name`,
    );
  }
  return new Qwen3VlEmbeddingProvider(profile, {
    endpoint,
    ...(env.CREATIVE_MEMORY_EMBEDDING_API_KEY
      ? { apiKey: env.CREATIVE_MEMORY_EMBEDDING_API_KEY }
      : {}),
    timeoutMs: Number(env.CREATIVE_MEMORY_TIMEOUT_MS ?? 120_000),
  });
}

export function resolveReranker(env: RetrievalCliEnv): MultimodalRerankerProvider {
  const endpoint = env.CREATIVE_MEMORY_RERANKER_ENDPOINT?.trim();
  const profile = env.CREATIVE_MEMORY_EMBEDDING_PROFILE ?? 'STRUCTURAL_BASELINE_V1';
  if (!endpoint || profile === 'STRUCTURAL_BASELINE_V1') return new StructuralRerankerProvider();

  const model =
    profile === 'QWEN3_VL_8B_REMOTE_QUALITY_V1'
      ? 'Qwen/Qwen3-VL-Reranker-8B'
      : 'Qwen/Qwen3-VL-Reranker-2B';
  return new Qwen3VlRerankerProvider(model, {
    endpoint,
    ...(env.CREATIVE_MEMORY_EMBEDDING_API_KEY
      ? { apiKey: env.CREATIVE_MEMORY_EMBEDDING_API_KEY }
      : {}),
    timeoutMs: Number(env.CREATIVE_MEMORY_TIMEOUT_MS ?? 120_000),
  });
}

export function resolveQdrant(env: RetrievalCliEnv): QdrantClient {
  return new QdrantClient({
    baseUrl: env.QDRANT_URL ?? 'http://127.0.0.1:6333',
    ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}),
  });
}

export async function runIndexCommand(
  values: Readonly<Record<string, string>>,
  flags: ReadonlySet<string>,
  context: RetrievalContext,
): Promise<number> {
  const workspaceId = values.workspace;
  if (!workspaceId) {
    context.stderr('index requires --workspace <uuid>\n');
    return RETRIEVAL_EXIT_CODES.INVALID_QUERY;
  }

  let embedder: MultimodalEmbeddingProvider;
  try {
    embedder =
      context.embedder ??
      resolveEmbedder({
        ...context.env,
        ...(values.profile ? { CREATIVE_MEMORY_EMBEDDING_PROFILE: values.profile } : {}),
      });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return RETRIEVAL_EXIT_CODES.INCOMPATIBLE_MODEL_PROFILE;
  }

  const health = await embedder.checkHealth();
  if (!health.available) {
    context.stderr(`embedding provider unavailable:\n${health.problems.join('\n')}\n`);
    return RETRIEVAL_EXIT_CODES.EMBEDDING_PROVIDER_UNAVAILABLE;
  }

  const qdrant = context.qdrant ?? resolveQdrant(context.env);
  if (!(await qdrant.isHealthy())) {
    context.stderr(
      `Qdrant is not reachable at ${context.env.QDRANT_URL ?? 'http://127.0.0.1:6333'}. Start it with:\n  docker compose -f infrastructure/docker-compose.yml up -d qdrant\n`,
    );
    return RETRIEVAL_EXIT_CODES.QDRANT_UNAVAILABLE;
  }

  try {
    const summary = await indexWorkspace({
      db: context.db,
      workspaceId,
      embedder,
      qdrant,
      batchSize: Number(context.env.CREATIVE_MEMORY_BATCH_SIZE ?? 16),
      ...(flags.has('force') ? { force: true } : {}),
      onProgress: (message) => context.stderr(`  ${message}\n`),
    });
    context.stdout(
      `${JSON.stringify(
        {
          ...summary,
          neural: embedder.getProfile().neural,
          notice: 'Indexing grants no output rights. Reference material remains analysis-only.',
        },
        null,
        2,
      )}\n`,
    );
    return summary.failed > 0
      ? RETRIEVAL_EXIT_CODES.INDEXING_FAILURE
      : RETRIEVAL_EXIT_CODES.SUCCESS;
  } catch (error) {
    if (error instanceof QdrantError) {
      context.stderr(`${error.kind}: ${error.message}\n`);
      return error.kind === 'DIMENSION_MISMATCH'
        ? RETRIEVAL_EXIT_CODES.INCOMPATIBLE_MODEL_PROFILE
        : RETRIEVAL_EXIT_CODES.QDRANT_UNAVAILABLE;
    }
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return RETRIEVAL_EXIT_CODES.INDEXING_FAILURE;
  }
}

export async function runSearchCommand(
  values: Readonly<Record<string, string>>,
  context: RetrievalContext,
): Promise<number> {
  const parsed = CreativeMemoryQuerySchema.safeParse({
    queryVersion: 1,
    workspaceId: values.workspace,
    query: values.query,
    ...(values.audience ? { intendedAudience: values.audience } : {}),
    ...(values.objective ? { campaignObjective: values.objective } : {}),
    filter: {
      ...(values.role ? { businessRole: values.role } : {}),
      ...(values.platform ? { platform: values.platform } : {}),
      ...(values.pacing ? { desiredPacing: values.pacing } : {}),
      ...(values.hook ? { desiredHook: values.hook } : {}),
      ...(values.stage ? { narrativeStage: values.stage } : {}),
      ...(values.duration ? { targetDurationSeconds: Number(values.duration) } : {}),
    },
    ...(values.candidates ? { candidateCount: Number(values.candidates) } : {}),
    ...(values['top-k'] ? { resultCount: Number(values['top-k']) } : {}),
    ...(values.mode ? { mode: values.mode } : {}),
  });

  if (!parsed.success) {
    context.stderr(
      `Invalid query:\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n')}\n`,
    );
    return RETRIEVAL_EXIT_CODES.INVALID_QUERY;
  }

  const query: CreativeMemoryQuery = parsed.data;

  let embedder: MultimodalEmbeddingProvider;
  try {
    embedder = context.embedder ?? resolveEmbedder(context.env);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return RETRIEVAL_EXIT_CODES.INCOMPATIBLE_MODEL_PROFILE;
  }

  const qdrant = context.qdrant ?? resolveQdrant(context.env);

  try {
    const result = await searchCreativeMemory({
      db: context.db,
      query,
      embedder,
      qdrant,
      ...(context.reranker
        ? { reranker: context.reranker }
        : { reranker: resolveReranker(context.env) }),
    });
    context.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return RETRIEVAL_EXIT_CODES.SUCCESS;
  } catch (error) {
    if (error instanceof RetrievalError) {
      context.stderr(`${error.kind}: ${error.message}\n`);
      switch (error.kind) {
        case 'NO_ELIGIBLE_REFERENCES':
          return RETRIEVAL_EXIT_CODES.NO_ELIGIBLE_REFERENCES;
        case 'RERANKING_FAILED':
          return RETRIEVAL_EXIT_CODES.RERANKING_FAILURE;
        case 'EMBEDDING_UNAVAILABLE':
          return RETRIEVAL_EXIT_CODES.EMBEDDING_PROVIDER_UNAVAILABLE;
        default:
          return RETRIEVAL_EXIT_CODES.QDRANT_UNAVAILABLE;
      }
    }
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return RETRIEVAL_EXIT_CODES.QDRANT_UNAVAILABLE;
  }
}

export async function runIndexStatusCommand(
  values: Readonly<Record<string, string>>,
  context: RetrievalContext,
): Promise<number> {
  const workspaceId = values.workspace;
  if (!workspaceId) {
    context.stderr('index-status requires --workspace <uuid>\n');
    return RETRIEVAL_EXIT_CODES.INVALID_QUERY;
  }

  let embedder: MultimodalEmbeddingProvider;
  try {
    embedder = context.embedder ?? resolveEmbedder(context.env);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return RETRIEVAL_EXIT_CODES.INCOMPATIBLE_MODEL_PROFILE;
  }

  const profile = embedder.getProfile();
  const collection = collectionNameFor(profile);
  const qdrant = context.qdrant ?? resolveQdrant(context.env);
  const healthy = await qdrant.isHealthy();

  context.stdout(
    `${JSON.stringify(
      {
        profile: profile.profile,
        neural: profile.neural,
        vectorDimension: profile.vectorDimension,
        modelRevision: profile.embeddingRevision,
        documentSchemaVersion: profile.documentSchemaVersion,
        collection,
        qdrantHealthy: healthy,
        pointCount: healthy
          ? await qdrant.countPoints(collection, {
              must: [{ key: 'workspaceId', match: { value: workspaceId } }],
            })
          : null,
      },
      null,
      2,
    )}\n`,
  );
  return healthy ? RETRIEVAL_EXIT_CODES.SUCCESS : RETRIEVAL_EXIT_CODES.QDRANT_UNAVAILABLE;
}

export async function runRemoveFromIndexCommand(
  values: Readonly<Record<string, string>>,
  context: RetrievalContext,
): Promise<number> {
  const workspaceId = values.workspace;
  const referenceKey = values.reference;
  if (!workspaceId || !referenceKey) {
    context.stderr('remove-from-index requires --workspace <uuid> --reference <key>\n');
    return RETRIEVAL_EXIT_CODES.INVALID_QUERY;
  }

  const embedder = context.embedder ?? resolveEmbedder(context.env);
  const collection = collectionNameFor(embedder.getProfile());
  const qdrant = context.qdrant ?? resolveQdrant(context.env);

  const [reference] = await context.db.referenceAdvertisement.findMany({
    where: { workspaceId, referenceKey },
  });
  if (!reference) {
    context.stderr(`No reference "${referenceKey}" in workspace ${workspaceId}\n`);
    return RETRIEVAL_EXIT_CODES.INVALID_QUERY;
  }

  const scenes = await context.db.referenceScene.findMany({
    where: { workspaceId, referenceAdvertisementId: reference.id },
  });
  const { pointIdFor: derive } = await import('@combat/providers');
  const pointIds = scenes.map((scene) =>
    derive(workspaceId, scene.id as string, embedder.getProfile().profile),
  );

  try {
    await qdrant.deletePoints(collection, pointIds);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return RETRIEVAL_EXIT_CODES.QDRANT_UNAVAILABLE;
  }

  context.stdout(
    `${JSON.stringify({ referenceKey, collection, removedPoints: pointIds.length }, null, 2)}\n`,
  );
  return RETRIEVAL_EXIT_CODES.SUCCESS;
}
