import { resolve } from 'node:path';

import { aampCliEnvSchema, type AampCliEnv } from '@combat/config';
import { createPrismaClient, type ReferenceDataSource } from '@combat/database';
import type { CreativeMemoryMode } from '@combat/domain';
import {
  NodeCommandRunner,
  resolveFfmpegBinaries,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';
import { createLogger, type Logger } from '@combat/observability';
import {
  collectionNameFor,
  ComfyUIVideoGenerationProvider,
  createClaudeReasoningProvider,
  createVideoGenerationProvider,
  type MultimodalEmbeddingProvider,
  type QdrantClient,
  type ReasoningProvider,
  type VideoGenerationProvider,
} from '@combat/providers';

import type { CreativeMemoryDependencies } from '../creative-memory/injection';
import {
  resolveEmbedder,
  resolveQdrant,
  resolveReranker,
  type RetrievalCliEnv,
} from '../creative-memory/retrieval-commands';
import { resolveReasoningPolicy, type ReasoningPolicy, type RunMode } from '../reasoning-policy';
import {
  describeExecutionEvidence,
  executionModeRank,
  resolveAttainedExecutionMode,
  shortfallsFor,
  type AampExecutionMode,
  type DependencyEvidence,
  type ExecutionModeLabel,
  type GenerationKind,
  type PersistenceKind,
  type RenderingKind,
  type VectorSearchKind,
} from './aamp-execution-mode';
import { endpointHostOf, sortProviderIdentities, type ProviderIdentity } from './provider-identity';

/**
 * The one AAMP composition root.
 *
 * Before this milestone, `aamp:generate` built a PrismaClient in one helper, a
 * Qdrant client in another, a reasoning provider in a third and an FFmpeg
 * runner inline; `aamp:reference` built its own PrismaClient again. Nothing
 * owned the set, so nothing could say what the run had actually stood on, and
 * a failure partway through leaked whatever had already been opened. This
 * module owns all of it: construction order, connectivity probes, the evidence
 * that decides the execution mode, provider identity, and — on every exit path,
 * including a failure during construction — shutdown.
 *
 * **It imports no fixture.** The deterministic providers live in the CLI and
 * are handed in through `fixtures`, so a source-level test can assert that no
 * import here can reach one, and so `PRODUCTION` can refuse them structurally
 * rather than by remembering to check. The same applies to `overrides`, which
 * is the test seam: requesting `PRODUCTION` with any override present is a hard
 * failure, because a run that a test could have substituted into is not a
 * production run.
 */

export const AAMP_DEPENDENCY_FAILURES = [
  'INVALID_CONFIGURATION',
  'DATABASE_UNAVAILABLE',
  'VECTOR_STORE_UNAVAILABLE',
  'EMBEDDING_PROVIDER_UNAVAILABLE',
  'REASONING_UNAVAILABLE',
  'RENDERER_UNAVAILABLE',
  'GENERATION_UNAVAILABLE',
  'FIXTURE_PROVIDER_PROHIBITED',
  'IN_MEMORY_PERSISTENCE_PROHIBITED',
  'EXECUTION_MODE_NOT_ATTAINED',
] as const;
export type AampDependencyFailure = (typeof AAMP_DEPENDENCY_FAILURES)[number];

export class AampDependencyError extends Error {
  constructor(
    public readonly kind: AampDependencyFailure,
    public readonly problems: readonly string[],
    public readonly remedies: readonly string[] = [],
  ) {
    super(
      [
        `AAMP dependencies could not be established (${kind}):`,
        ...problems.map((problem) => `  - ${problem}`),
        ...(remedies.length > 0 ? ['', 'To fix:', ...remedies.map((line) => `  ${line}`)] : []),
      ].join('\n'),
    );
    this.name = 'AampDependencyError';
  }
}

/**
 * The deterministic providers, supplied by the caller.
 *
 * Thunks rather than instances so nothing is constructed when the mode forbids
 * it — and so this module never has to name the modules they come from.
 */
export interface AampFixtureProviders {
  readonly reasoning?: () => ReasoningProvider;
  readonly videoGeneration?: () => VideoGenerationProvider;
}

/** Collaborators a test substitutes. Never reachable from configuration. */
export interface AampDependencyOverrides {
  readonly creativeMemoryDependencies?: CreativeMemoryDependencies;
  readonly db?: ReferenceDataSource;
  readonly runner?: CommandRunner;
  readonly videoGenerationProvider?: VideoGenerationProvider;
}

export interface AampDependencyOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The required floor. Absent means "report what you attained, require nothing". */
  readonly requestedExecutionMode?: AampExecutionMode;
  readonly creativeMemoryMode: CreativeMemoryMode;
  /** `FIXTURE_DEMO` selects replayed creative; `REAL` demands a configured model. */
  readonly runMode: RunMode;
  readonly repositoryRoot: string;
  /** Whether this run will actually render. `--plan-only` passes false. */
  readonly requiresRendering: boolean;
  /** `COMFYUI` for a request that asks for generated shots; `NONE` for source-only. */
  readonly generation: 'COMFYUI' | 'NONE';
  readonly comfyuiProfile?: string;
  readonly fixtures?: AampFixtureProviders;
  readonly overrides?: AampDependencyOverrides;
  readonly onProgress?: (message: string) => void;
}

export interface AampDependencies {
  readonly requestedExecutionMode?: AampExecutionMode;
  /** Derived from what was built. Never from `requestedExecutionMode`. */
  readonly executionMode: AampExecutionMode;
  readonly evidence: DependencyEvidence;
  readonly label: ExecutionModeLabel;
  readonly providers: readonly ProviderIdentity[];
  readonly env: AampCliEnv;
  readonly logger: Logger;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly reasoningProvider: ReasoningProvider;
  readonly reasoningPolicy: ReasoningPolicy;
  /** Present only when Creative Memory is on. A source-only run acquires no database. */
  readonly db?: ReferenceDataSource;
  readonly creativeMemory?: CreativeMemoryDependencies;
  readonly videoGenerationProvider?: VideoGenerationProvider;
  /**
   * Where deliverables land. The CLI's storage is the local filesystem: it
   * writes run directories, not objects, and holds no MinIO credential. The
   * Activity path is what uses `StorageProvider`.
   */
  readonly storageRoot: string;
  /** Idempotent. Safe to call on success, on failure and from a signal handler. */
  readonly close: () => Promise<void>;
}

/** A resource and how to release it, so a partial construction can unwind. */
interface Closer {
  readonly name: string;
  readonly close: () => Promise<void>;
}

/** Turns this command's coerced env back into the shape the retrieval resolvers take. */
export function retrievalEnvFrom(env: AampCliEnv): RetrievalCliEnv {
  return {
    CREATIVE_MEMORY_EMBEDDING_PROFILE: env.CREATIVE_MEMORY_EMBEDDING_PROFILE,
    ...(env.CREATIVE_MEMORY_EMBEDDING_ENDPOINT
      ? { CREATIVE_MEMORY_EMBEDDING_ENDPOINT: env.CREATIVE_MEMORY_EMBEDDING_ENDPOINT }
      : {}),
    ...(env.CREATIVE_MEMORY_RERANKER_ENDPOINT
      ? { CREATIVE_MEMORY_RERANKER_ENDPOINT: env.CREATIVE_MEMORY_RERANKER_ENDPOINT }
      : {}),
    ...(env.CREATIVE_MEMORY_EMBEDDING_API_KEY
      ? { CREATIVE_MEMORY_EMBEDDING_API_KEY: env.CREATIVE_MEMORY_EMBEDDING_API_KEY }
      : {}),
    CREATIVE_MEMORY_BATCH_SIZE: String(env.CREATIVE_MEMORY_BATCH_SIZE),
    CREATIVE_MEMORY_TIMEOUT_MS: String(env.CREATIVE_MEMORY_TIMEOUT_MS),
    QDRANT_URL: env.QDRANT_URL,
    ...(env.QDRANT_API_KEY ? { QDRANT_API_KEY: env.QDRANT_API_KEY } : {}),
  };
}

export function parseAampCliEnv(env: Readonly<Record<string, string | undefined>>): AampCliEnv {
  const parsed = aampCliEnvSchema.safeParse(env);
  if (parsed.success) return parsed.data;
  throw new AampDependencyError(
    'INVALID_CONFIGURATION',
    parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    ['Correct the values above in .env or the process environment, then re-run.'],
  );
}

/**
 * Confirms the toolchain is actually there.
 *
 * `-version` is the cheapest read-only proof that the configured path is an
 * executable FFmpeg, and it is worth one subprocess: the alternative is
 * discovering the binary is missing after planning has already run a paid
 * model.
 */
export async function probeFfmpeg(
  runner: CommandRunner,
  binaries: FfmpegBinaries,
): Promise<{
  readonly available: boolean;
  readonly problems: readonly string[];
  readonly ffmpegVersion: string;
  readonly ffprobeVersion: string;
}> {
  const problems: string[] = [];
  const versions: Record<'ffmpeg' | 'ffprobe', string> = { ffmpeg: 'UNKNOWN', ffprobe: 'UNKNOWN' };

  for (const tool of ['ffmpeg', 'ffprobe'] as const) {
    try {
      // eslint-disable-next-line no-await-in-loop -- probed in a fixed order for a stable report
      const result = await runner.run(binaries[tool], ['-version'], { timeoutMs: 15_000 });
      if (result.exitCode !== 0) {
        problems.push(`${binaries[tool]} -version exited ${result.exitCode}`);
        continue;
      }
      versions[tool] = (result.stdout.split('\n')[0] ?? '').trim() || 'UNKNOWN';
    } catch (error) {
      problems.push(
        `${binaries[tool]} could not be executed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    available: problems.length === 0,
    problems,
    ffmpegVersion: versions.ffmpeg,
    ffprobeVersion: versions.ffprobe,
  };
}

/**
 * Builds every AAMP collaborator, or explains precisely why it cannot.
 *
 * Order matters and is deliberate: the cheap refusals (configuration, reasoning
 * policy) come before anything that opens a socket, and the mode assertion
 * comes last, after the evidence is complete — so a run that cannot reach its
 * required tier is refused having spent nothing.
 */
export async function createAampDependencies(
  options: AampDependencyOptions,
): Promise<AampDependencies> {
  const closers: Closer[] = [];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Reverse order, and every closer is attempted even if an earlier one
    // throws — a failing disconnect must not strand an open connection behind
    // it.
    for (const closer of [...closers].reverse()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- released in reverse acquisition order
        await closer.close();
      } catch {
        // Nothing useful remains to be done with a failure to release.
      }
    }
  };

  try {
    return await build(options, closers);
  } catch (error) {
    await close();
    throw error;
  }

  async function build(input: AampDependencyOptions, stack: Closer[]): Promise<AampDependencies> {
    const progress = input.onProgress ?? ((): void => undefined);
    const requested = input.requestedExecutionMode;
    const productionRequested = requested === 'PRODUCTION';

    // --- 1. configuration ---------------------------------------------------
    const env = parseAampCliEnv(input.env);
    const logger = createLogger({
      serviceName: 'aamp-cli',
      level: env.LOG_LEVEL,
      // Endpoints and connection strings are already redacted by the shared
      // field list; these are the CLI-specific carriers of the same risk.
      additionalRedactedFields: [
        'QDRANT_API_KEY',
        'COMFYUI_API_KEY',
        'CREATIVE_MEMORY_EMBEDDING_API_KEY',
        'qdrantApiKey',
        'comfyuiApiKey',
      ],
    });
    const providers: ProviderIdentity[] = [
      {
        role: 'logging',
        identity: 'pino',
        version: 'redacted-fields-configured',
        capability: 'structured logging with credential and model-payload redaction',
        simulated: false,
      },
    ];

    if (productionRequested && input.overrides && Object.keys(input.overrides).length > 0) {
      throw new AampDependencyError(
        'FIXTURE_PROVIDER_PROHIBITED',
        [
          'execution mode "production" was requested, but test collaborators were injected into the composition root',
        ],
        ['Remove the injected overrides, or request --execution-mode local-production.'],
      );
    }

    // --- 2. reasoning -------------------------------------------------------
    let reasoningPolicy: ReasoningPolicy;
    try {
      reasoningPolicy = resolveReasoningPolicy({
        runMode: input.runMode,
        reasoningProvider: env.REASONING_PROVIDER,
        reasoningModel: env.REASONING_MODEL,
        ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
      });
    } catch (error) {
      throw new AampDependencyError(
        'REASONING_UNAVAILABLE',
        [error instanceof Error ? error.message : String(error)],
        [],
      );
    }

    if (productionRequested && reasoningPolicy.useFixtureReasoning) {
      throw new AampDependencyError(
        'FIXTURE_PROVIDER_PROHIBITED',
        [
          'execution mode "production" was requested, but the run would replay committed fixture creative',
        ],
        [
          'Set REASONING_PROVIDER=claude and ANTHROPIC_API_KEY, and drop --fixture-demo.',
          'Fixture creative ignores the campaign prompt entirely, so it can never be a production result.',
        ],
      );
    }

    let reasoningProvider: ReasoningProvider;
    if (reasoningPolicy.useFixtureReasoning) {
      const factory = input.fixtures?.reasoning;
      if (!factory) {
        throw new AampDependencyError(
          'REASONING_UNAVAILABLE',
          [
            'fixture reasoning was selected but no fixture provider was supplied to the composition root',
          ],
          ['This is a wiring defect, not a configuration problem.'],
        );
      }
      reasoningProvider = factory();
    } else {
      reasoningProvider = await createClaudeReasoningProvider(env.ANTHROPIC_API_KEY as string);
    }
    providers.push({
      role: 'reasoning',
      identity: reasoningPolicy.providerName,
      version: reasoningPolicy.reasoningModel,
      capability:
        reasoningPolicy.runMode === 'REAL'
          ? 'campaign-specific reasoning over the supplied brief'
          : 'replays committed golden fixtures; ignores the campaign prompt',
      simulated: reasoningPolicy.useFixtureReasoning,
    });

    // --- 3. rendering toolchain --------------------------------------------
    const binaries = resolveFfmpegBinaries(input.env);
    const runner = input.overrides?.runner ?? new NodeCommandRunner();
    let rendering: RenderingKind = 'NOT_REQUIRED';
    if (input.requiresRendering) {
      if (input.overrides?.runner) {
        rendering = 'SIMULATED';
        providers.push({
          role: 'motion-graphics',
          identity: 'injected-command-runner',
          version: 'UNKNOWN',
          capability: 'test double; no FFmpeg process is started',
          simulated: true,
        });
      } else {
        progress('verifying the FFmpeg toolchain');
        const probe = await probeFfmpeg(runner, binaries);
        if (!probe.available) {
          // Fatal only when a tier was actually demanded. Without a floor the
          // command keeps its previous behaviour — it goes as far as it can and
          // fails at the render — because a missing renderer must not stop a
          // run whose point was to prove that an ANALYSIS_ONLY asset is refused
          // long before any frame exists.
          if (requested && executionModeRank(requested) >= executionModeRank('LOCAL_PRODUCTION')) {
            throw new AampDependencyError('RENDERER_UNAVAILABLE', probe.problems, [
              'Install FFmpeg, or set FFMPEG_PATH and FFPROBE_PATH to the binaries.',
            ]);
          }
          rendering = 'UNAVAILABLE';
          progress(
            `WARNING: no usable FFmpeg toolchain (${probe.problems.join('; ')}); this run cannot render`,
          );
          providers.push({
            role: 'motion-graphics',
            identity: 'ffmpeg',
            version: 'UNKNOWN',
            capability: 'not executable at the configured path; no render is possible',
            simulated: true,
          });
        } else {
          rendering = 'FFMPEG_REAL';
          providers.push(
            {
              role: 'motion-graphics',
              identity: 'ffmpeg',
              version: probe.ffmpegVersion,
              capability: 'deterministic 1080x1920 h264 composition from a render manifest',
              simulated: false,
            },
            {
              role: 'actual-media-qa',
              identity: 'ffprobe + extracted-frame inspection',
              version: probe.ffprobeVersion,
              capability: 'binding measurements taken from the produced file',
              simulated: false,
            },
          );
        }
      }
    }

    // --- 4. persistence -----------------------------------------------------
    const creativeMemoryOn = input.creativeMemoryMode !== 'off';
    let db: ReferenceDataSource | undefined;
    let persistence: PersistenceKind = 'NOT_REQUIRED';

    // `off` acquires nothing, even when a test injected a store. An injected
    // collaborator is an offer, not an instruction: a run told not to use
    // Creative Memory must not end up holding a handle to it, or the mode
    // becomes a labelling convention instead of a behaviour.
    if (creativeMemoryOn && (input.overrides?.db || input.overrides?.creativeMemoryDependencies)) {
      db = input.overrides.db ?? input.overrides.creativeMemoryDependencies?.db;
      persistence = 'IN_MEMORY';
      providers.push({
        role: 'persistence',
        identity: 'in-memory-reference-store',
        version: 'UNKNOWN',
        capability: 'mirrors the migrated constraints; holds nothing beyond this process',
        simulated: true,
      });
    } else if (creativeMemoryOn) {
      if (!env.DATABASE_URL) {
        throw new AampDependencyError(
          'DATABASE_UNAVAILABLE',
          [
            'DATABASE_URL is not set, so the reference library, its approved annotations and its benchmark governance profiles cannot be read',
          ],
          ['Set DATABASE_URL, or run with --creative-memory off.'],
        );
      }
      progress('connecting to PostgreSQL');
      const prisma = createPrismaClient();
      stack.push({ name: 'prisma', close: () => prisma.$disconnect() });
      try {
        await prisma.$connect();
      } catch (error) {
        throw new AampDependencyError(
          'DATABASE_UNAVAILABLE',
          [
            `PostgreSQL is not reachable: ${error instanceof Error ? error.message : String(error)}`,
          ],
          ['docker compose -f infrastructure/docker-compose.yml up -d postgres'],
        );
      }
      db = prisma as unknown as ReferenceDataSource;
      persistence = 'PRISMA_POSTGRESQL';
      providers.push({
        role: 'persistence',
        identity: 'prisma-postgresql',
        version: 'canonical for rights, provenance, annotations and governance',
        capability:
          'reference library, benchmark governance profiles and Creative Memory index entries',
        simulated: false,
      });
    }

    if (productionRequested && persistence === 'IN_MEMORY') {
      throw new AampDependencyError(
        'IN_MEMORY_PERSISTENCE_PROHIBITED',
        ['execution mode "production" was requested, but persistence would be an in-memory store'],
        ['Point DATABASE_URL at a live PostgreSQL and remove the injected store.'],
      );
    }

    // --- 5. Creative Memory retrieval --------------------------------------
    let creativeMemory: CreativeMemoryDependencies | undefined;
    let vectorSearch: VectorSearchKind = 'NOT_REQUIRED';

    if (creativeMemoryOn && input.overrides?.creativeMemoryDependencies) {
      creativeMemory = input.overrides.creativeMemoryDependencies;
      vectorSearch = 'IN_PROCESS';
      providers.push({
        role: 'vector-search',
        identity: 'in-process-qdrant',
        version: 'UNKNOWN',
        capability: 'exercises the real search pipeline against an in-memory collection',
        simulated: true,
      });
    } else if (creativeMemoryOn) {
      let embedder: MultimodalEmbeddingProvider;
      try {
        embedder = resolveEmbedder(retrievalEnvFrom(env));
      } catch (error) {
        throw new AampDependencyError(
          'EMBEDDING_PROVIDER_UNAVAILABLE',
          [error instanceof Error ? error.message : String(error)],
          [
            'Set CREATIVE_MEMORY_EMBEDDING_ENDPOINT for a neural profile, or use STRUCTURAL_BASELINE_V1.',
          ],
        );
      }

      progress('checking Qdrant');
      const qdrant: QdrantClient = resolveQdrant(retrievalEnvFrom(env));
      if (!(await qdrant.isHealthy())) {
        throw new AampDependencyError(
          'VECTOR_STORE_UNAVAILABLE',
          [`Qdrant is not reachable at ${env.QDRANT_URL}`],
          ['docker compose -f infrastructure/docker-compose.yml up -d qdrant'],
        );
      }

      creativeMemory = {
        db: db as ReferenceDataSource,
        qdrant,
        embedder,
        reranker: resolveReranker(retrievalEnvFrom(env)),
      };
      vectorSearch = 'QDRANT_LIVE';

      const modelProfile = embedder.getProfile();
      providers.push(
        {
          role: 'vector-search',
          identity: 'qdrant',
          version: collectionNameFor(modelProfile),
          capability: 'vectors and filterable payload only; no path, URL, byte or credential',
          simulated: false,
          ...(endpointHostOf(env.QDRANT_URL)
            ? { endpointHost: endpointHostOf(env.QDRANT_URL) as string }
            : {}),
        },
        {
          role: 'embedding',
          identity: modelProfile.profile,
          version: modelProfile.embeddingRevision,
          capability: modelProfile.neural
            ? `neural, ${modelProfile.vectorDimension}-dimensional`
            : `NON_NEURAL_STRUCTURAL_BASELINE, ${modelProfile.vectorDimension}-dimensional`,
          // Non-neural is not simulated: the baseline really does the retrieval
          // it claims to. What it must never do is claim to be neural.
          simulated: false,
        },
        {
          role: 'reranking',
          identity: creativeMemory.reranker?.name ?? 'none',
          version: 'UNKNOWN',
          capability: 'reorders retrieved candidates; never widens the result set',
          simulated: false,
        },
      );
    }

    // --- 6. video generation ------------------------------------------------
    let videoGenerationProvider: VideoGenerationProvider | undefined;
    let videoGeneration: GenerationKind = 'NOT_REQUIRED';

    if (input.generation === 'COMFYUI') {
      if (input.overrides?.videoGenerationProvider) {
        videoGenerationProvider = input.overrides.videoGenerationProvider;
        videoGeneration = 'FIXTURE_TEST_PATTERN';
      } else if (env.VIDEO_GENERATION_PROVIDER === 'comfyui') {
        const comfyui = createVideoGenerationProvider({
          kind: 'comfyui',
          nodeEnv: env.NODE_ENV,
          comfyui: {
            baseUrl: env.COMFYUI_BASE_URL as string,
            workflowProfile: input.comfyuiProfile ?? env.COMFYUI_WORKFLOW_PROFILE,
            clientId: env.COMFYUI_CLIENT_ID,
            outputTimeoutMs: env.COMFYUI_OUTPUT_TIMEOUT_MS,
            outputDirectory: resolve(input.repositoryRoot, env.COMFYUI_OUTPUT_DIR),
            ...(env.COMFYUI_API_KEY ? { apiKey: env.COMFYUI_API_KEY } : {}),
          },
        });
        if (comfyui instanceof ComfyUIVideoGenerationProvider) {
          progress('verifying the ComfyUI endpoint');
          const environment = await comfyui.verifyEnvironment();
          if (!environment.compatible) {
            throw new AampDependencyError('GENERATION_UNAVAILABLE', environment.problems, [
              'This command will not substitute fixture footage for real generation.',
            ]);
          }
        }
        videoGenerationProvider = comfyui;
        videoGeneration = 'COMFYUI_LIVE';
      } else {
        const factory = input.fixtures?.videoGeneration;
        if (!factory) {
          throw new AampDependencyError(
            'GENERATION_UNAVAILABLE',
            [
              'the request asks for generated shots but VIDEO_GENERATION_PROVIDER is not comfyui and no fixture provider was supplied',
            ],
            ['Set VIDEO_GENERATION_PROVIDER=comfyui with COMFYUI_BASE_URL, or use SOURCE_ONLY.'],
          );
        }
        videoGenerationProvider = factory();
        videoGeneration = 'FIXTURE_TEST_PATTERN';
      }

      if (productionRequested && videoGeneration === 'FIXTURE_TEST_PATTERN') {
        throw new AampDependencyError(
          'FIXTURE_PROVIDER_PROHIBITED',
          [
            'execution mode "production" was requested, but the shots would be synthetic FFmpeg test patterns',
          ],
          ['Configure a working ComfyUI endpoint, or request --execution-mode local-production.'],
        );
      }

      providers.push({
        role: 'video-generation',
        identity: videoGeneration === 'COMFYUI_LIVE' ? 'comfyui' : 'fixture-test-pattern',
        version:
          videoGeneration === 'COMFYUI_LIVE'
            ? (input.comfyuiProfile ?? env.COMFYUI_WORKFLOW_PROFILE)
            : 'NONE-SYNTHETIC-TEST-PATTERN',
        capability:
          videoGeneration === 'COMFYUI_LIVE'
            ? 'model-generated video under a server-owned workflow profile'
            : 'synthetic lavfi test patterns; not AI-generated footage',
        simulated: videoGeneration !== 'COMFYUI_LIVE',
        ...(videoGeneration === 'COMFYUI_LIVE' && endpointHostOf(env.COMFYUI_BASE_URL)
          ? { endpointHost: endpointHostOf(env.COMFYUI_BASE_URL) as string }
          : {}),
      });
    }

    // --- 7. storage ---------------------------------------------------------
    providers.push({
      role: 'storage',
      identity: 'local-filesystem',
      version: 'run-directory',
      capability:
        'writes run directories and deliverables to disk; the CLI holds no object-storage credential',
      simulated: false,
    });

    // --- 8. evidence, then the mode assertion -------------------------------
    const evidence: DependencyEvidence = {
      persistence,
      vectorSearch,
      reasoning: reasoningPolicy.useFixtureReasoning ? 'FIXTURE_REPLAY' : 'REAL_MODEL',
      videoGeneration,
      rendering,
      // QA is only as real as the file it measured, so it tracks the renderer
      // exactly. There is no configuration in which QA is real and the render
      // was not.
      qa:
        rendering === 'FFMPEG_REAL'
          ? 'ACTUAL_MEDIA'
          : rendering === 'SIMULATED'
            ? 'SIMULATED'
            : rendering === 'UNAVAILABLE'
              ? 'UNAVAILABLE'
              : 'NOT_REQUIRED',
    };

    const executionMode = resolveAttainedExecutionMode(evidence);
    if (requested && executionModeRank(executionMode) < executionModeRank(requested)) {
      throw new AampDependencyError(
        'EXECUTION_MODE_NOT_ATTAINED',
        [
          `--execution-mode ${requested.toLowerCase().replace(/_/g, '-')} was required but this run could only attain ${executionMode}`,
          ...shortfallsFor(requested, evidence),
        ],
        ['Nothing was planned, generated or rendered. Fix the shortfalls above and re-run.'],
      );
    }

    return {
      ...(requested ? { requestedExecutionMode: requested } : {}),
      executionMode,
      evidence,
      label: describeExecutionEvidence(evidence),
      providers: sortProviderIdentities(providers),
      env,
      logger,
      runner,
      binaries,
      reasoningProvider,
      reasoningPolicy,
      ...(db ? { db } : {}),
      ...(creativeMemory ? { creativeMemory } : {}),
      ...(videoGenerationProvider ? { videoGenerationProvider } : {}),
      storageRoot: input.repositoryRoot,
      close,
    };
  }
}
