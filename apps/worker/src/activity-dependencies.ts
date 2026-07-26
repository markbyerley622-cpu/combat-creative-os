import { resolve } from 'node:path';

import { AGENT_REGISTRY } from '@combat/agents';
import type { WorkerEnv } from '@combat/config';
import { createPrismaClient, type PrismaClient } from '@combat/database';
import { NodeCommandRunner, probeMedia, resolveFfmpegBinaries } from '@combat/media';
import type { Logger } from '@combat/observability';
import {
  MockMotionGraphicsProvider,
  MockReasoningProvider,
  createClaudeReasoningProvider,
  createVideoGenerationProvider,
  type ReasoningProvider,
  type VideoGenerationProvider,
} from '@combat/providers';
import type {
  GeneratedMediaInspector,
  WorkerActivityCostEstimates,
  WorkerActivityDependencies,
} from '@combat/workflows';
import { createPrismaActivityDatabase } from './prisma-activity-database';

/**
 * Reservation-sizing estimates. Deliberately code-level constants rather than
 * env vars: they only size a pre-dispatch RESERVATION, and every one is trued
 * up against the provider's reported usage when the job settles
 * (`settleBudgetReservation`), so an imprecise estimate costs nothing but a
 * temporarily larger hold. They match the values the Activity unit tests use.
 */
const COST_ESTIMATES: WorkerActivityCostEstimates = {
  shotGenerationCentsPerSecond: 50,
  compositionCentsPerFrame: 2,
  variantCentsPerFrame: 2,
};

/**
 * Resolves the reasoning provider from validated config only.
 *
 * `workerEnvSchema` already fails closed when `REASONING_PROVIDER=claude`
 * arrives without an `ANTHROPIC_API_KEY` (M14), so by the time this runs the
 * key is guaranteed present for the `claude` branch — the check below is a
 * type narrowing, not a second policy. `process.env` is never read here
 * (CLAUDE.md provider-adapter rule).
 */
export async function resolveReasoningProvider(env: WorkerEnv): Promise<ReasoningProvider> {
  if (env.REASONING_PROVIDER === 'claude') {
    return createClaudeReasoningProvider(env.ANTHROPIC_API_KEY!);
  }
  return new MockReasoningProvider();
}

/**
 * Resolves the video-generation provider from validated config only.
 *
 * This replaced an unconditional `new MockVideoGenerationProvider()`. That was
 * the honest wiring while no real adapter existed; now that one does, leaving
 * it would mean a production Worker silently producing placeholder "footage".
 * `workerEnvSchema` already refuses `mock` in production and refuses `comfyui`
 * without an endpoint, and `createVideoGenerationProvider` refuses the same
 * combinations again at construction — belt and braces, because the failure
 * mode being guarded against is *silent* fabrication.
 *
 * `process.env` is never read here (CLAUDE.md provider-adapter rule); every
 * value arrives through the validated `WorkerEnv`.
 */
export function resolveVideoGenerationProvider(
  env: WorkerEnv,
  repositoryRoot: string,
): VideoGenerationProvider {
  return createVideoGenerationProvider({
    kind: env.VIDEO_GENERATION_PROVIDER,
    nodeEnv: env.NODE_ENV,
    ...(env.VIDEO_GENERATION_PROVIDER === 'comfyui'
      ? {
          comfyui: {
            // Non-null: `refineVideoGenerationConfig` has already refused a
            // `comfyui` selection with no base URL.
            baseUrl: env.COMFYUI_BASE_URL!,
            workflowProfile: env.COMFYUI_WORKFLOW_PROFILE,
            clientId: env.COMFYUI_CLIENT_ID,
            outputTimeoutMs: env.COMFYUI_OUTPUT_TIMEOUT_MS,
            outputDirectory: resolve(repositoryRoot, env.COMFYUI_OUTPUT_DIR),
            ...(env.COMFYUI_API_KEY ? { apiKey: env.COMFYUI_API_KEY } : {}),
          },
        }
      : {}),
  });
}

/**
 * Measures a generated clip with ffprobe, so `pollShotGenerationActivity` can
 * refuse to mark unverified media READY. Uses the same `@combat/media`
 * toolchain resolution the renderer does, so a pinned FFmpeg build is honoured
 * here too.
 */
export function createFfprobeMediaInspector(
  env: Readonly<Record<string, string | undefined>>,
): GeneratedMediaInspector {
  const runner = new NodeCommandRunner();
  const binaries = resolveFfmpegBinaries(env);
  return async ({ localPath, sizeBytes }) => {
    const probe = await probeMedia(runner, localPath, { ffprobePath: binaries.ffprobe });
    if (probe.mediaType !== 'VIDEO') {
      // A generation provider that handed back a still or an audio file has
      // not produced a shot, whatever its job status said.
      throw new Error(
        `Expected a VIDEO file at ${localPath} but ffprobe reported ${probe.mediaType}`,
      );
    }
    return {
      durationSeconds: probe.durationSeconds,
      widthPx: probe.widthPx,
      heightPx: probe.heightPx,
      videoCodec: probe.videoCodec,
      sizeBytes,
    };
  };
}

export interface ActivityDependencyOptions {
  readonly env: WorkerEnv;
  readonly logger: Logger;
  /** Temporal's per-Activity attempt counter, supplied by the caller so this module needs no `@temporalio/activity` import. */
  readonly getAttempt?: () => number;
  /** Overridable so the wiring can be exercised without a live Postgres. */
  readonly prisma?: PrismaClient;
  /** Root the ComfyUI output directory is resolved against. Defaults to the process cwd. */
  readonly repositoryRoot?: string;
  /** Raw environment, read only for the FFmpeg binary locations (`FFMPEG_PATH`/`FFPROBE_PATH`). */
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * Builds the concrete collaborators `createWorkerActivities` needs.
 *
 * Video generation is now configuration-driven and can be a real ComfyUI
 * endpoint (AAMP generation vertical slice 2). Motion graphics still resolves
 * to its deterministic mock: no real aerender worker exists in this
 * repository, and CLAUDE.md forbids connecting one without an explicit,
 * separate decision. The FFmpeg *renderer* is reached through
 * `@combat/media` from the CLI, not through `MotionGraphicsProvider` here.
 */
export async function createActivityDependencies(
  options: ActivityDependencyOptions,
): Promise<{ deps: WorkerActivityDependencies; prisma: PrismaClient }> {
  const prisma = options.prisma ?? createPrismaClient();
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const processEnv = options.processEnv ?? process.env;

  const deps: WorkerActivityDependencies = {
    db: createPrismaActivityDatabase(prisma),
    videoGenerationProvider: resolveVideoGenerationProvider(options.env, repositoryRoot),
    motionGraphicsProvider: new MockMotionGraphicsProvider(),
    reasoningProvider: await resolveReasoningProvider(options.env),
    agentRegistry: AGENT_REGISTRY,
    costEstimates: COST_ESTIMATES,
    // Only wired when a provider that produces real files is selected — the
    // mock has no bytes to probe, and requiring ffprobe for it would make
    // every local test depend on an FFmpeg install.
    ...(options.env.VIDEO_GENERATION_PROVIDER === 'comfyui'
      ? { generatedMediaInspector: createFfprobeMediaInspector(processEnv) }
      : {}),
    logger: options.logger,
    getAttempt: options.getAttempt,
  };

  return { deps, prisma };
}
