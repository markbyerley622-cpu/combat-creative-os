#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { aampCliEnvSchema, type AampCliEnv } from '@combat/config';
import {
  NodeCommandRunner,
  renderAdvertisement,
  resolveFfmpegBinaries,
  type CommandRunner,
} from '@combat/media';
import {
  createClaudeReasoningProvider,
  createVideoGenerationProvider,
  type ReasoningProvider,
  type VideoGenerationProvider,
} from '@combat/providers';

import { buildRenderManifest } from './build-render-manifest';
import { FIXTURE_CREATIVE_WARNING, createFixtureReasoningProvider } from './fixture-reasoning';
import { generateShots, type GeneratedShotResult } from './generate-shots';
import {
  GenerationManifestValidationError,
  parseGenerationManifest,
  type CampaignGenerationManifest,
  type ManifestAsset,
} from './generation-manifest';
import { runAgentPipeline } from './run-agents';

/**
 * `pnpm aamp:generate --manifest <campaign-generation-manifest.json>` — the
 * whole chain in one command: prompt → existing specialist agents → shot
 * specifications → real ComfyUI generation → generated clips → the existing
 * FFmpeg renderer → actual-media QA → a downloadable 1080×1920 MP4.
 *
 * It reuses, rather than re-implements, every stage that already exists:
 * `AGENT_REGISTRY` and `executeAgent` for the creative chain,
 * `VideoGenerationProvider` for generation, `@combat/media`'s
 * `renderAdvertisement` (which runs the real FFmpeg graph and the binding
 * actual-media QA) for the cut. There is no second agent framework and no
 * second renderer here — only composition.
 *
 * Like `runRenderCli`, the whole run is a function taking its environment as
 * arguments, so tests execute the real entry point.
 */

const DEFAULT_OUTPUT_DIRECTORY = '.aamp-output';

export interface GenerateCliOptions {
  readonly manifestPath: string;
  readonly outputRoot?: string;
  readonly json: boolean;
  /** Stops after the agents have produced shot briefs. Useful without an endpoint. */
  readonly planOnly: boolean;
}

export function parseGenerateCliArguments(argv: readonly string[]): GenerateCliOptions {
  let manifestPath: string | undefined;
  let outputRoot: string | undefined;
  let json = false;
  let planOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--manifest':
        manifestPath = argv[++i];
        break;
      case '--output-root':
        outputRoot = argv[++i];
        break;
      case '--json':
        json = true;
        break;
      case '--plan-only':
        planOnly = true;
        break;
      default:
        if (arg && arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    }
  }

  if (!manifestPath) {
    throw new Error('Usage: aamp:generate --manifest <absolute-or-repository-relative-json-path>');
  }
  return { manifestPath, ...(outputRoot ? { outputRoot } : {}), json, planOnly };
}

export async function findRepositoryRoot(startDir: string): Promise<string> {
  let current = resolve(startDir);
  for (;;) {
    try {
      await stat(resolve(current, 'pnpm-workspace.yaml'));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(startDir);
      current = parent;
    }
  }
}

export interface GenerateCliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly runner?: CommandRunner;
  readonly now?: () => Date;
  /** Overridable so an integration test can drive a fake endpoint. */
  readonly providerOverride?: VideoGenerationProvider;
  readonly workflowRunId?: string;
}

/**
 * `MockReasoningProvider` is deliberately not used here: it returns an empty
 * echo shape, so every agent would fail schema validation and the command
 * could not run at all without a paid key. The fixture provider replays
 * committed golden results instead — and the caller announces that the
 * creative is canned, because it is.
 */
async function resolveReasoning(
  env: AampCliEnv,
  shotCount: number,
): Promise<{ provider: ReasoningProvider; warning?: string }> {
  if (env.REASONING_PROVIDER === 'claude') {
    return { provider: await createClaudeReasoningProvider(env.ANTHROPIC_API_KEY!) };
  }
  return {
    provider: createFixtureReasoningProvider(shotCount),
    warning: FIXTURE_CREATIVE_WARNING,
  };
}

/**
 * Resolves a manifest-relative asset path and refuses anything outside the
 * allowed roots — the same containment discipline `@combat/media`'s source
 * resolution applies, enforced here too because this is where operator-
 * supplied paths first enter the system.
 */
function resolveAssetPath(
  asset: ManifestAsset,
  manifestDir: string,
  allowedRoots: readonly string[],
): string {
  const absolute = isAbsolute(asset.path) ? resolve(asset.path) : resolve(manifestDir, asset.path);
  const contained = allowedRoots.some((root) => {
    const normalisedRoot = resolve(root);
    return (
      absolute === normalisedRoot ||
      absolute.startsWith(`${normalisedRoot}\\`) ||
      absolute.startsWith(`${normalisedRoot}/`)
    );
  });
  if (!contained) {
    throw new Error(
      `Asset "${asset.id}" resolves to ${absolute}, which is outside every allowed source root`,
    );
  }
  return absolute;
}

export async function runGenerateCli(
  argv: readonly string[],
  context: GenerateCliContext,
): Promise<number> {
  let options: GenerateCliOptions;
  try {
    options = parseGenerateCliArguments(argv);
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const repositoryRoot = await findRepositoryRoot(context.cwd);
  const manifestPath = isAbsolute(options.manifestPath)
    ? options.manifestPath
    : resolve(repositoryRoot, options.manifestPath);
  const manifestDir = dirname(manifestPath);
  const outputRoot = options.outputRoot
    ? resolve(repositoryRoot, options.outputRoot)
    : resolve(repositoryRoot, DEFAULT_OUTPUT_DIRECTORY);

  let env: AampCliEnv;
  try {
    env = aampCliEnvSchema.parse(context.env);
  } catch (error) {
    context.stderr(
      `Configuration is invalid:\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  let manifest: CampaignGenerationManifest;
  try {
    manifest = parseGenerationManifest(
      JSON.parse(await readFile(manifestPath, 'utf8')),
      manifestPath,
    );
  } catch (error) {
    context.stderr(
      `${error instanceof GenerationManifestValidationError ? error.message : `Could not read manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`}\n`,
    );
    return 2;
  }

  const progress = (message: string): void => {
    if (!options.json) context.stderr(`  ${message}\n`);
  };

  const workflowRunId = context.workflowRunId ?? `aamp-cli-${randomUUID()}`;

  let resolvedAssets: { asset: ManifestAsset; absolutePath: string }[];
  try {
    resolvedAssets = manifest.assets.map((asset) => ({
      asset,
      absolutePath: resolveAssetPath(asset, manifestDir, [repositoryRoot, manifestDir]),
    }));
    for (const entry of resolvedAssets) {
      // eslint-disable-next-line no-await-in-loop -- a missing asset should be reported in manifest order
      await stat(entry.absolutePath);
    }
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // --- 1-3: agents produce structured shot specifications -------------------
  let pipeline;
  try {
    const reasoning = await resolveReasoning(env, manifest.generation.shotCount);
    if (reasoning.warning) context.stderr(`WARNING: ${reasoning.warning}\n`);
    pipeline = await runAgentPipeline({
      manifest,
      reasoningProvider: reasoning.provider,
      workflowRunId,
      onProgress: progress,
    });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (options.planOnly) {
    context.stdout(
      `${JSON.stringify(
        { campaignId: manifest.campaignId, shotBriefs: pipeline.shotBriefs },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  // --- 4-6: real generation, retrieved and measured -------------------------
  let provider: VideoGenerationProvider;
  try {
    provider =
      context.providerOverride ??
      createVideoGenerationProvider({
        kind: env.VIDEO_GENERATION_PROVIDER,
        nodeEnv: env.NODE_ENV,
        ...(env.VIDEO_GENERATION_PROVIDER === 'comfyui'
          ? {
              comfyui: {
                baseUrl: env.COMFYUI_BASE_URL!,
                workflowProfile: manifest.generation.profile,
                clientId: env.COMFYUI_CLIENT_ID,
                outputTimeoutMs: env.COMFYUI_OUTPUT_TIMEOUT_MS,
                outputDirectory: resolve(repositoryRoot, env.COMFYUI_OUTPUT_DIR),
                ...(env.COMFYUI_API_KEY ? { apiKey: env.COMFYUI_API_KEY } : {}),
              },
            }
          : {}),
      });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const binaries = resolveFfmpegBinaries(context.env);
  let generatedShots: readonly GeneratedShotResult[];
  try {
    generatedShots = await generateShots({
      manifest,
      briefs: pipeline.shotBriefs,
      provider,
      binaries,
      workflowRunId,
      referenceAssets: resolvedAssets.filter((entry) => entry.asset.role === 'REFERENCE_IMAGE'),
      onProgress: progress,
    });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // --- 7-11: build the render manifest, render for real, QA the result ------
  let renderManifest;
  try {
    renderManifest = buildRenderManifest({
      manifest,
      generatedShots,
      resolvedAssets: resolvedAssets.filter((entry) => entry.asset.role !== 'REFERENCE_IMAGE'),
    });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Written out so a failed render can be re-run through `pnpm aamp:render`
  // against exactly the same timeline, without re-paying for generation.
  const builtManifestPath = resolve(outputRoot, `${manifest.name}.render-manifest.json`);
  await mkdir(dirname(builtManifestPath), { recursive: true });
  await writeFile(builtManifestPath, `${JSON.stringify(renderManifest, null, 2)}\n`, 'utf8');

  let result;
  try {
    result = await renderAdvertisement(context.runner ?? new NodeCommandRunner(), {
      manifest: renderManifest,
      manifestDir: outputRoot,
      allowedSourceRoots: [repositoryRoot, manifestDir, outputRoot],
      outputRoot,
      binaries,
      now: context.now ? context.now() : new Date(),
    });
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const { summary } = result.qaReport;
  if (options.json) {
    context.stdout(
      `${JSON.stringify(
        {
          campaignId: manifest.campaignId,
          generationProfile: manifest.generation.profile,
          generatedShotPaths: generatedShots.map((shot) => shot.localPath),
          outputPath: result.outputPath,
          qaReport: result.qaReport,
          qaReportPath: result.qaReportPath,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    context.stdout(
      `${[
        `campaign ID:       ${manifest.campaignId}`,
        `generation profile:${' '}${manifest.generation.profile}`,
        `generated shots:   ${generatedShots.map((shot) => shot.localPath).join('\n                   ')}`,
        `final MP4:         ${result.outputPath}`,
        `duration:          ${summary.durationSeconds === null ? 'unknown' : `${summary.durationSeconds.toFixed(3)}s`}`,
        `resolution:        ${summary.widthPx ?? '?'}x${summary.heightPx ?? '?'}`,
        `codecs:            ${summary.videoCodec ?? 'none'} / ${summary.audioCodec ?? 'none'}`,
        `QA status:         ${result.qaReport.verdict}`,
        `QA report:         ${result.qaReportPath}`,
      ].join('\n')}\n`,
    );
  }

  if (result.qaReport.verdict !== 'PASS') {
    const failures = result.qaReport.measurements.filter((m) => m.verdict === 'FAIL');
    context.stderr(
      `\nfailed checks:\n${failures
        .map((m) => `  - ${m.check}: measured ${String(m.measured)}, expected ${m.expected}`)
        .join('\n')}\n`,
    );
    return 1;
  }
  return 0;
}

if (require.main === module) {
  runGenerateCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
