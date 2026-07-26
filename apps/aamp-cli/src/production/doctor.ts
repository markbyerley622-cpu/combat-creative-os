import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { listBenchmarkProfiles, listReferences, type ReferenceDataSource } from '@combat/database';
import { CREATIVE_MEMORY_AGENT_ROLES, type CreativeMemoryMode } from '@combat/domain';
import {
  NodeCommandRunner,
  resolveFfmpegBinaries,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';
import {
  collectionNameFor,
  ComfyUIVideoGenerationProvider,
  createVideoGenerationProvider,
  type MultimodalEmbeddingProvider,
  type QdrantClient,
} from '@combat/providers';

import { resolveEmbedder, resolveQdrant } from '../creative-memory/retrieval-commands';
import { parseProductionAssetManifest, permitsOutput } from '../production-assets';
import {
  executionModeFlagFor,
  executionModeRank,
  resolveAttainedExecutionMode,
  type AampExecutionMode,
  type DependencyEvidence,
} from './aamp-execution-mode';
import { parseAampCliEnv, probeFfmpeg, retrievalEnvFrom } from './dependency-factory';

/**
 * `pnpm aamp:doctor` — everything that has to be true before a run is worth
 * starting, checked without starting one.
 *
 * The factory refuses on the *first* problem it meets, which is correct for a
 * run and useless for an operator: being told Qdrant is down, fixing it, and
 * then being told the benchmark profile was never approved is two rounds of the
 * same conversation. So the doctor deliberately does not use the factory's
 * fail-fast path. It runs every check, reports all of them, and marks each one
 * as required or not *for the mode being asked about* — Qdrant is a blocker
 * under `--creative-memory required` and irrelevant under `off`.
 *
 * **Strictly read-only.** No generation call, no money, no database write, no
 * render. The one thing it writes is a probe file in the output directory,
 * which it removes — there is no way to establish writability without writing,
 * and reporting a directory as usable when it is not is the failure this check
 * exists to prevent.
 */

export const DOCTOR_STATUSES = ['READY', 'DEGRADED', 'BLOCKED', 'NOT_APPLICABLE'] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly remedy?: string;
  /** Whether a BLOCKED result here stops the requested mode, or is merely noted. */
  readonly required: boolean;
}

export interface DoctorReport {
  readonly reportVersion: 1;
  readonly requestedExecutionMode: AampExecutionMode | null;
  readonly creativeMemoryMode: CreativeMemoryMode;
  readonly workspaceId: string | null;
  readonly benchmarkProfileName: string | null;
  readonly status: 'READY' | 'DEGRADED' | 'BLOCKED';
  readonly checks: readonly DoctorCheck[];
  readonly blockers: readonly string[];
  /** The best mode the current environment could attain, from the same evidence rules a run uses. */
  readonly attainableExecutionMode: AampExecutionMode;
  readonly readOnly: true;
  readonly notice: string;
  readonly checkedAt: string;
}

/**
 * The database, plus the one thing the structural `ReferenceDataSource` cannot
 * express: which migrations Postgres says it has applied.
 */
export interface DoctorDatabase {
  readonly db: ReferenceDataSource;
  readonly kind: 'PRISMA_POSTGRESQL' | 'IN_MEMORY';
  appliedMigrationNames?(): Promise<readonly string[]>;
  close(): Promise<void>;
}

export interface DoctorOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly repositoryRoot: string;
  readonly requestedExecutionMode?: AampExecutionMode;
  readonly creativeMemoryMode: CreativeMemoryMode;
  readonly workspaceId?: string;
  readonly benchmarkProfileName?: string;
  /** Optional production asset manifest, so rights can be checked before a run. */
  readonly assetsPath?: string;
  readonly outputDirectory?: string;
  readonly now: Date;
  /** Injected by tests. Production opens a real PrismaClient through `openDatabase`. */
  readonly openDatabase?: () => Promise<DoctorDatabase>;
  readonly qdrant?: QdrantClient;
  readonly embedder?: MultimodalEmbeddingProvider;
  readonly runner?: CommandRunner;
  readonly binaries?: FfmpegBinaries;
}

const NOTICE =
  'aamp:doctor is read-only. It makes no generation call, spends no money, writes no database row and renders no media. Reference material remains analysis-only regardless of what is reported here.';

/** Collects checks and keeps the required/blocked bookkeeping in one place. */
class ChecklistBuilder {
  readonly checks: DoctorCheck[] = [];

  add(check: DoctorCheck): DoctorCheck {
    this.checks.push(check);
    return check;
  }

  ok(id: string, title: string, detail: string, required: boolean): DoctorCheck {
    return this.add({ id, title, status: 'READY', detail, required });
  }

  degraded(
    id: string,
    title: string,
    detail: string,
    remedy: string,
    required: boolean,
  ): DoctorCheck {
    return this.add({ id, title, status: 'DEGRADED', detail, remedy, required });
  }

  blocked(
    id: string,
    title: string,
    detail: string,
    remedy: string,
    required: boolean,
  ): DoctorCheck {
    return this.add({ id, title, status: 'BLOCKED', detail, remedy, required });
  }

  skip(id: string, title: string, detail: string): DoctorCheck {
    return this.add({ id, title, status: 'NOT_APPLICABLE', detail, required: false });
  }
}

/**
 * The default database opener.
 *
 * Kept here rather than in the CLI entry point so `runDoctor` has a working
 * production path with no wiring, and injectable so tests never touch Postgres.
 * `_prisma_migrations` is only ever read; nothing in this file writes to it.
 */
export async function openPrismaDoctorDatabase(): Promise<DoctorDatabase> {
  const { createPrismaClient } = await import('@combat/database');
  const prisma = createPrismaClient();
  await prisma.$connect();
  return {
    db: prisma as unknown as ReferenceDataSource,
    kind: 'PRISMA_POSTGRESQL',
    appliedMigrationNames: async () => {
      const rows = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name',
      );
      return rows.map((row) => row.migration_name);
    },
    close: () => prisma.$disconnect(),
  };
}

async function migrationsOnDisk(repositoryRoot: string): Promise<readonly string[]> {
  const directory = resolve(repositoryRoot, 'packages/database/prisma/migrations');
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const list = new ChecklistBuilder();
  const creativeMemoryOn = options.creativeMemoryMode !== 'off';
  const requested = options.requestedExecutionMode;
  const wantsLive = requested === 'LOCAL_PRODUCTION' || requested === 'PRODUCTION';
  const wantsProduction = requested === 'PRODUCTION';

  // Everything a run would need is also everything the attained-mode rules read,
  // so the doctor accumulates the same evidence and reports the same verdict.
  let persistence: DependencyEvidence['persistence'] = 'NOT_REQUIRED';
  let vectorSearch: DependencyEvidence['vectorSearch'] = 'NOT_REQUIRED';
  let rendering: DependencyEvidence['rendering'] = 'NOT_REQUIRED';

  // --- configuration --------------------------------------------------------
  let env;
  try {
    env = parseAampCliEnv(options.env);
    list.ok(
      'configuration',
      'Validated configuration',
      `NODE_ENV=${env.NODE_ENV}, REASONING_PROVIDER=${env.REASONING_PROVIDER}, VIDEO_GENERATION_PROVIDER=${env.VIDEO_GENERATION_PROVIDER}, CREATIVE_MEMORY_EMBEDDING_PROFILE=${env.CREATIVE_MEMORY_EMBEDDING_PROFILE}`,
      true,
    );
  } catch (error) {
    list.blocked(
      'configuration',
      'Validated configuration',
      error instanceof Error ? error.message.split('\n').slice(1).join('; ').trim() : String(error),
      'Correct the reported values in .env or the process environment.',
      true,
    );
    return finish(list, options, 'FIXTURE');
  }

  // --- PostgreSQL, migrations, governance, references ------------------------
  let database: DoctorDatabase | undefined;
  if (creativeMemoryOn || wantsLive) {
    if (!env.DATABASE_URL) {
      persistence = 'UNAVAILABLE';
      list.blocked(
        'postgresql',
        'PostgreSQL connectivity',
        'DATABASE_URL is not set',
        'Set DATABASE_URL, or run with --creative-memory off and --execution-mode fixture.',
        creativeMemoryOn || wantsLive,
      );
    } else {
      try {
        database = await (options.openDatabase ?? openPrismaDoctorDatabase)();
        persistence = database.kind === 'PRISMA_POSTGRESQL' ? 'PRISMA_POSTGRESQL' : 'IN_MEMORY';
        list.add({
          id: 'postgresql',
          title: 'PostgreSQL connectivity',
          status: database.kind === 'PRISMA_POSTGRESQL' ? 'READY' : 'DEGRADED',
          detail: `persistence is ${database.kind}`,
          ...(database.kind === 'IN_MEMORY'
            ? { remedy: 'An in-memory store cannot satisfy --execution-mode production.' }
            : {}),
          required: true,
        });
      } catch (error) {
        persistence = 'UNAVAILABLE';
        list.blocked(
          'postgresql',
          'PostgreSQL connectivity',
          `could not connect: ${error instanceof Error ? error.message : String(error)}`,
          'docker compose -f infrastructure/docker-compose.yml up -d postgres',
          true,
        );
      }
    }
  } else {
    list.skip('postgresql', 'PostgreSQL connectivity', 'not required by this mode');
  }

  try {
    if (database?.appliedMigrationNames) {
      const [applied, expected] = await Promise.all([
        database.appliedMigrationNames(),
        migrationsOnDisk(options.repositoryRoot),
      ]);
      const missing = expected.filter((name) => !applied.includes(name));
      const unknown = applied.filter((name) => !expected.includes(name));
      if (missing.length === 0 && unknown.length === 0) {
        list.ok(
          'prisma-migrations',
          'Prisma migration status',
          `${applied.length} migration(s) applied and in step with the repository`,
          true,
        );
      } else {
        list.blocked(
          'prisma-migrations',
          'Prisma migration status',
          [
            missing.length > 0 ? `not applied: ${missing.join(', ')}` : '',
            unknown.length > 0
              ? `applied but absent from this checkout: ${unknown.join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join('; '),
          'pnpm --filter @combat/database run migrate',
          true,
        );
      }
    } else if (database) {
      list.skip(
        'prisma-migrations',
        'Prisma migration status',
        'the injected database reports no migration history',
      );
    } else {
      list.skip('prisma-migrations', 'Prisma migration status', 'no database connection');
    }
  } catch (error) {
    list.degraded(
      'prisma-migrations',
      'Prisma migration status',
      `could not read migration history: ${error instanceof Error ? error.message : String(error)}`,
      'Confirm the connection user may read _prisma_migrations.',
      false,
    );
  }

  // --- Qdrant, collection, dimensions ---------------------------------------
  let embedder: MultimodalEmbeddingProvider | undefined;
  if (creativeMemoryOn) {
    try {
      embedder = options.embedder ?? resolveEmbedder(retrievalEnvFrom(env));
      const profile = embedder.getProfile();
      const health = await embedder.checkHealth();
      list.add({
        id: 'embedding-provider',
        title: 'Creative Memory embedding provider',
        status: health.available ? 'READY' : 'BLOCKED',
        detail: `${profile.profile} (${profile.neural ? 'neural' : 'NON_NEURAL_STRUCTURAL_BASELINE'}), revision ${profile.embeddingRevision}, ${profile.vectorDimension} dimensions`,
        ...(health.available ? {} : { remedy: health.problems.join('; ') }),
        required: true,
      });
    } catch (error) {
      list.blocked(
        'embedding-provider',
        'Creative Memory embedding provider',
        error instanceof Error ? error.message : String(error),
        'Set CREATIVE_MEMORY_EMBEDDING_ENDPOINT for a neural profile, or use STRUCTURAL_BASELINE_V1.',
        true,
      );
    }

    const qdrant = options.qdrant ?? resolveQdrant(retrievalEnvFrom(env));
    const healthy = await qdrant.isHealthy();
    if (!healthy) {
      vectorSearch = 'UNAVAILABLE';
      list.blocked(
        'qdrant',
        'Qdrant connectivity',
        `not reachable at ${env.QDRANT_URL}`,
        'docker compose -f infrastructure/docker-compose.yml up -d qdrant',
        true,
      );
      list.skip('qdrant-collection', 'Expected collection version', 'Qdrant is unreachable');
      list.skip('qdrant-dimension', 'Vector dimensions', 'Qdrant is unreachable');
    } else {
      vectorSearch = options.qdrant ? 'IN_PROCESS' : 'QDRANT_LIVE';
      list.ok('qdrant', 'Qdrant connectivity', `reachable at ${env.QDRANT_URL}`, true);

      if (embedder) {
        const profile = embedder.getProfile();
        const collection = collectionNameFor(profile);
        const dimension = await qdrant.collectionDimension(collection).catch(() => null);
        if (dimension === null) {
          // Reachable but empty is not usable: retrieval against a collection
          // that does not exist fails, so the evidence must not claim a live
          // vector search.
          vectorSearch = 'UNAVAILABLE';
          list.blocked(
            'qdrant-collection',
            'Expected collection version',
            `collection "${collection}" does not exist`,
            `pnpm aamp:reference index --workspace <uuid>`,
            true,
          );
          list.skip('qdrant-dimension', 'Vector dimensions', 'the collection does not exist');
        } else {
          list.ok('qdrant-collection', 'Expected collection version', collection, true);
          const matches = dimension === profile.vectorDimension;
          if (!matches) vectorSearch = 'UNAVAILABLE';
          list.add({
            id: 'qdrant-dimension',
            title: 'Vector dimensions',
            status: matches ? 'READY' : 'BLOCKED',
            detail: `collection holds ${dimension}-dimensional vectors; profile ${profile.profile} produces ${profile.vectorDimension}`,
            ...(matches
              ? {}
              : {
                  remedy:
                    'The profile or document schema changed without the collection name changing. Re-index under the correct profile.',
                }),
            required: true,
          });
        }
      } else {
        list.skip('qdrant-collection', 'Expected collection version', 'no embedding profile');
        list.skip('qdrant-dimension', 'Vector dimensions', 'no embedding profile');
      }
    }
  } else {
    for (const [id, title] of [
      ['embedding-provider', 'Creative Memory embedding provider'],
      ['qdrant', 'Qdrant connectivity'],
      ['qdrant-collection', 'Expected collection version'],
      ['qdrant-dimension', 'Vector dimensions'],
    ] as const) {
      list.skip(id, title, 'creative memory is off; no retrieval will happen');
    }
  }

  // --- governance and eligible references ------------------------------------
  if (creativeMemoryOn && database && options.workspaceId) {
    const profiles = await listBenchmarkProfiles(database.db, options.workspaceId).catch(() => []);
    const usable = profiles.filter(
      (profile) =>
        profile.reviewStatus === 'APPROVED' &&
        profile.active &&
        (!options.benchmarkProfileName || profile.name === options.benchmarkProfileName),
    );
    const covered = new Set(usable.map((profile) => profile.agentRole));
    const uncovered = CREATIVE_MEMORY_AGENT_ROLES.filter((role) => !covered.has(role));
    if (uncovered.length === 0) {
      list.ok(
        'benchmark-profile',
        'Approved benchmark profile',
        `${usable.length} approved, active profile(s) covering all four planning roles`,
        true,
      );
    } else {
      list.blocked(
        'benchmark-profile',
        'Approved benchmark profile',
        `no approved, active profile${options.benchmarkProfileName ? ` named "${options.benchmarkProfileName}"` : ''} for: ${uncovered.join(', ')}`,
        'pnpm aamp:reference benchmark-seed --workspace <uuid> --reviewer <id>',
        options.creativeMemoryMode === 'required',
      );
    }

    const ready = await listReferences(database.db, options.workspaceId, {
      processingState: 'READY_FOR_RETRIEVAL',
    }).catch(() => []);
    let eligible = 0;
    for (const reference of ready) {
      // eslint-disable-next-line no-await-in-loop -- counted in stable reference order
      const annotations = await database.db.referenceAnnotation.findMany({
        where: { workspaceId: options.workspaceId, referenceAdvertisementId: reference.id },
      });
      if (annotations.some((annotation) => annotation.approved)) eligible += 1;
    }
    list.add({
      id: 'eligible-references',
      title: 'Eligible approved references',
      status: eligible > 0 ? 'READY' : 'BLOCKED',
      detail: `${eligible} reference(s) in READY_FOR_RETRIEVAL with an approved annotation (of ${ready.length} ready)`,
      ...(eligible > 0
        ? {}
        : {
            remedy:
              'pnpm aamp:reference approve --workspace <uuid> --annotation <uuid>. Approval means "analysed and reviewed" — it still grants no output rights.',
          }),
      required: options.creativeMemoryMode === 'required',
    });
  } else if (creativeMemoryOn && !options.workspaceId) {
    list.skip('benchmark-profile', 'Approved benchmark profile', 'no --workspace supplied');
    list.skip('eligible-references', 'Eligible approved references', 'no --workspace supplied');
  } else {
    list.skip('benchmark-profile', 'Approved benchmark profile', 'creative memory is off');
    list.skip('eligible-references', 'Eligible approved references', 'creative memory is off');
  }

  // --- reasoning -------------------------------------------------------------
  if (env.REASONING_PROVIDER === 'claude' && env.ANTHROPIC_API_KEY?.trim()) {
    // Configuration only. Contacting Anthropic would cost money, and the doctor
    // spends none.
    list.ok(
      'reasoning-provider',
      'Reasoning provider',
      `claude / ${env.REASONING_MODEL} is configured (not contacted — the doctor spends nothing)`,
      wantsProduction,
    );
  } else {
    list.add({
      id: 'reasoning-provider',
      title: 'Reasoning provider',
      status: wantsProduction ? 'BLOCKED' : 'DEGRADED',
      detail:
        'no real reasoning provider is configured; a run would need --fixture-demo, whose creative replays committed fixtures and ignores the campaign prompt',
      remedy: 'Set REASONING_PROVIDER=claude and ANTHROPIC_API_KEY.',
      required: wantsProduction,
    });
  }

  // --- FFmpeg toolchain ------------------------------------------------------
  const binaries = options.binaries ?? resolveFfmpegBinaries(options.env);
  const runner = options.runner ?? new NodeCommandRunner();
  const ffmpeg = await probeFfmpeg(runner, binaries);
  if (ffmpeg.available) {
    rendering = 'FFMPEG_REAL';
    list.ok(
      'ffmpeg',
      'FFmpeg and ffprobe',
      `${ffmpeg.ffmpegVersion} / ${ffmpeg.ffprobeVersion}`,
      true,
    );
  } else {
    list.blocked(
      'ffmpeg',
      'FFmpeg and ffprobe',
      ffmpeg.problems.join('; '),
      'Install FFmpeg, or set FFMPEG_PATH and FFPROBE_PATH.',
      true,
    );
  }

  // --- ComfyUI ---------------------------------------------------------------
  if (env.VIDEO_GENERATION_PROVIDER === 'comfyui') {
    try {
      const provider = createVideoGenerationProvider({
        kind: 'comfyui',
        nodeEnv: env.NODE_ENV,
        comfyui: {
          baseUrl: env.COMFYUI_BASE_URL as string,
          workflowProfile: env.COMFYUI_WORKFLOW_PROFILE,
          clientId: env.COMFYUI_CLIENT_ID,
          outputTimeoutMs: env.COMFYUI_OUTPUT_TIMEOUT_MS,
          outputDirectory: resolve(options.repositoryRoot, env.COMFYUI_OUTPUT_DIR),
          ...(env.COMFYUI_API_KEY ? { apiKey: env.COMFYUI_API_KEY } : {}),
        },
      });
      if (provider instanceof ComfyUIVideoGenerationProvider) {
        const environment = await provider.verifyEnvironment();
        list.add({
          id: 'comfyui',
          title: 'ComfyUI endpoint and profile compatibility',
          status: environment.compatible ? 'READY' : 'BLOCKED',
          detail: environment.compatible
            ? `endpoint can run profile ${env.COMFYUI_WORKFLOW_PROFILE}`
            : environment.problems.join('; '),
          ...(environment.compatible
            ? {}
            : { remedy: 'This command never substitutes fixture footage for real generation.' }),
          required: wantsProduction,
        });
      } else {
        list.skip(
          'comfyui',
          'ComfyUI endpoint and profile compatibility',
          'not a ComfyUI provider',
        );
      }
    } catch (error) {
      list.blocked(
        'comfyui',
        'ComfyUI endpoint and profile compatibility',
        error instanceof Error ? error.message : String(error),
        'Set COMFYUI_BASE_URL to a working endpoint.',
        wantsProduction,
      );
    }
  } else {
    list.skip(
      'comfyui',
      'ComfyUI endpoint and profile compatibility',
      'VIDEO_GENERATION_PROVIDER is not comfyui; a source-only campaign needs no generation',
    );
  }

  // --- production asset rights ------------------------------------------------
  if (options.assetsPath) {
    try {
      const manifest = parseProductionAssetManifest(
        JSON.parse(await readFile(options.assetsPath, 'utf8')),
        options.assetsPath,
      );
      const problems: string[] = [];
      for (const asset of manifest.assets) {
        if (!permitsOutput(asset.rights.classification) || !asset.rights.permittedOutputUse) {
          problems.push(`${asset.id}: ${asset.rights.classification}`);
          continue;
        }
        if (asset.rights.expiresAt && new Date(asset.rights.expiresAt) <= options.now) {
          problems.push(`${asset.id}: licence expired ${asset.rights.expiresAt}`);
        }
      }
      list.add({
        id: 'production-asset-rights',
        title: 'Production asset rights',
        status: problems.length === 0 ? 'READY' : 'BLOCKED',
        detail:
          problems.length === 0
            ? `${manifest.assets.length} asset(s), all OWNED / COMMISSIONED / LICENSED_FOR_OUTPUT with permittedOutputUse and an unexpired licence`
            : problems.join('; '),
        ...(problems.length === 0
          ? {}
          : { remedy: 'Only output-permitted, unexpired assets may reach the renderer.' }),
        required: true,
      });
    } catch (error) {
      list.blocked(
        'production-asset-rights',
        'Production asset rights',
        error instanceof Error ? error.message : String(error),
        'Correct the production asset manifest.',
        true,
      );
    }
  } else {
    list.skip(
      'production-asset-rights',
      'Production asset rights',
      'no --assets manifest supplied',
    );
  }

  // --- storage and output directory ------------------------------------------
  const outputRoot = resolve(
    options.repositoryRoot,
    options.outputDirectory ?? '.aamp-output/runs',
  );
  list.ok(
    'storage',
    'Storage availability',
    'the CLI writes run directories to the local filesystem and holds no object-storage credential',
    true,
  );
  const probe = join(outputRoot, `.aamp-doctor-probe-${process.pid}`);
  try {
    await mkdir(outputRoot, { recursive: true });
    await writeFile(probe, 'aamp-doctor writability probe\n', 'utf8');
    await stat(probe);
    list.ok('output-directory', 'Output directory writability', `${outputRoot} is writable`, true);
  } catch (error) {
    list.blocked(
      'output-directory',
      'Output directory writability',
      `${outputRoot}: ${error instanceof Error ? error.message : String(error)}`,
      'Choose a writable --output-dir.',
      true,
    );
  } finally {
    // The probe file is removed on every path. A doctor that leaves litter in
    // the directory it just declared writable is its own counter-example.
    await rm(probe, { force: true }).catch(() => undefined);
  }

  await database?.close().catch(() => undefined);

  const evidence: DependencyEvidence = {
    persistence,
    vectorSearch,
    // The doctor reports what the *environment* could attain, so it assumes the
    // best reasoning and generation the configuration permits rather than what
    // a particular command line would select.
    reasoning:
      env.REASONING_PROVIDER === 'claude' && env.ANTHROPIC_API_KEY?.trim()
        ? 'REAL_MODEL'
        : 'FIXTURE_REPLAY',
    videoGeneration: 'NOT_REQUIRED',
    rendering,
    qa: rendering === 'FFMPEG_REAL' ? 'ACTUAL_MEDIA' : 'NOT_REQUIRED',
  };

  return finish(list, options, resolveAttainedExecutionMode(evidence));
}

function finish(
  list: ChecklistBuilder,
  options: DoctorOptions,
  attainable: AampExecutionMode,
): DoctorReport {
  // The individual checks say what is wrong; this one says whether the mode the
  // operator actually asked for is reachable. Both are needed: a run can fail
  // its mode floor with every check DEGRADED and none BLOCKED.
  const requested = options.requestedExecutionMode;
  if (requested) {
    const attained = executionModeRank(attainable) >= executionModeRank(requested);
    list.add({
      id: 'execution-mode',
      title: 'Requested execution mode',
      status: attained ? 'READY' : 'BLOCKED',
      detail: attained
        ? `--execution-mode ${executionModeFlagFor(requested)} is attainable (best available: ${attainable})`
        : `--execution-mode ${executionModeFlagFor(requested)} was requested but this environment can only attain ${attainable}`,
      ...(attained
        ? {}
        : { remedy: 'Resolve the blockers above, or request a lower execution mode.' }),
      required: true,
    });
  }

  const blockers = list.checks
    .filter((check) => check.status === 'BLOCKED' && check.required)
    .map((check) => `${check.id}: ${check.detail}`);
  const degraded = list.checks.some(
    (check) => check.status === 'DEGRADED' || (check.status === 'BLOCKED' && !check.required),
  );

  return {
    reportVersion: 1,
    requestedExecutionMode: options.requestedExecutionMode ?? null,
    creativeMemoryMode: options.creativeMemoryMode,
    workspaceId: options.workspaceId ?? null,
    benchmarkProfileName: options.benchmarkProfileName ?? null,
    status: blockers.length > 0 ? 'BLOCKED' : degraded ? 'DEGRADED' : 'READY',
    checks: list.checks,
    blockers,
    attainableExecutionMode: attainable,
    readOnly: true,
    notice: NOTICE,
    checkedAt: options.now.toISOString(),
  };
}
