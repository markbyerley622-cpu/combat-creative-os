import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';
import {
  LTX_SUPPORTED_FPS,
  LTX_SUPPORTED_HEIGHT_PX,
  LTX_SUPPORTED_RESOLUTION,
  LTX_SUPPORTED_WIDTH_PX,
  smallestCoveringDuration,
  ltxGenerationCostCents,
  LtxVideoGenerationError,
  type LtxDurationSeconds,
  type LtxModel,
  type VideoGenerationProvider,
} from '@combat/providers';

import { StoryboardVideoError, type StoryboardVideoFailureKind } from './failures';
import { computeGenerationCacheKey, type GenerationCache } from './generation-cache';
import type { ResolvedKeyframe } from './keyframe-library';
import {
  MANUAL_GENERATION_PROVENANCE,
  PROVIDER_GENERATION_PROVENANCE,
  type GenerationProvenance,
} from './pre-generated-clips';
import type { SceneManifestEntry } from './scene-manifest';

/**
 * Turning a source into the clip a scene actually renders.
 *
 * Two stages, kept apart because they fail for different reasons and only one
 * of them costs money.
 *
 * **Generation** asks the provider for footage. It buys the smallest supported
 * duration that covers what the scene needs, keeps the complete original, and
 * never retries a paid call on its own — a failed generation stays failed
 * until a person reruns that scene.
 *
 * **Preparation** takes any moving source — generated, hand-animated, or a
 * real acquired plate — and produces the trimmed 1080x1920 clip the timeline
 * uses. It is non-destructive: the original is kept intact under
 * `generated-originals/` and the trim is written separately, so the discarded
 * footage is recoverable and the arithmetic is auditable.
 *
 * Nothing here stretches a short result to fit. A clip that cannot cover its
 * scene is a refusal, because time-stretching to hide a shortfall produces a
 * scene that plays wrong and reports fine.
 */

/** Handles the deterministic segment selector requires either side of a window. */
export const SCENE_TRIM_HANDLE_SECONDS = 0.35;

export interface GeneratedSceneClip {
  readonly sceneNumber: number;
  readonly provenance: GenerationProvenance;
  /** The complete clip as it arrived, never trimmed in place. */
  readonly originalPath: string;
  readonly originalChecksumSha256: string;
  readonly originalDurationSeconds: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly requestedDurationSeconds: number | null;
  readonly costCents: number;
  readonly cacheHit: boolean;
  readonly ltxCalled: boolean;
  readonly model: string | null;
  readonly promptSha256: string | null;
}

export interface PreparedSceneClip {
  readonly sceneNumber: number;
  /** The trimmed, normalised clip the render manifest resolves. */
  readonly absolutePath: string;
  readonly checksumSha256: string;
  readonly usedInSeconds: number;
  readonly usedDurationSeconds: number;
  readonly discardedSeconds: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Where inside the trimmed clip the beat's own window starts. */
  readonly pinnedInSeconds: number;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerateSceneClipOptions {
  readonly scene: SceneManifestEntry;
  readonly keyframe: ResolvedKeyframe;
  readonly lastFrame?: ResolvedKeyframe;
  readonly provider: VideoGenerationProvider;
  readonly model: LtxModel;
  readonly generateAudio: boolean;
  readonly requiredSourceSeconds: number;
  readonly cache: GenerationCache;
  readonly originalsDirectory: string;
  readonly workflowRunId: string;
  readonly pollIntervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

/**
 * Obtains one generated clip: from the cache when a byte-verified one exists,
 * otherwise from the provider.
 *
 * A cache hit makes **no** network call at all — not a status check, not a
 * re-download. That is the property that makes a second run of the same
 * storyboard free.
 */
export async function generateSceneClip(
  options: GenerateSceneClipOptions,
): Promise<GeneratedSceneClip> {
  const { scene, keyframe } = options;
  const requestedDurationSeconds = smallestCoveringDuration(options.requiredSourceSeconds);
  const promptSha256 = createHash('sha256').update(scene.motionPrompt, 'utf8').digest('hex');

  const cacheKey = computeGenerationCacheKey({
    inputFrameChecksumSha256: keyframe.checksumSha256,
    ...(options.lastFrame ? { lastFrameChecksumSha256: options.lastFrame.checksumSha256 } : {}),
    motionPromptSha256: promptSha256,
    model: options.model,
    durationSeconds: requestedDurationSeconds,
    resolution: LTX_SUPPORTED_RESOLUTION,
    fps: LTX_SUPPORTED_FPS,
    generateAudio: options.generateAudio,
    cameraMotion: scene.cameraMotion,
  });

  const cached = await options.cache.lookup(cacheKey);
  if (cached) {
    options.onProgress?.(
      `scene ${scene.sceneNumber}: reusing a byte-verified cached generation — no upload, no request, no charge`,
    );
    return {
      sceneNumber: scene.sceneNumber,
      provenance: PROVIDER_GENERATION_PROVENANCE,
      originalPath: options.cache.absolutePathFor(cached),
      originalChecksumSha256: cached.checksumSha256,
      originalDurationSeconds: cached.durationSeconds,
      widthPx: cached.widthPx,
      heightPx: cached.heightPx,
      requestedDurationSeconds: cached.requestedDurationSeconds,
      // A cache hit spends nothing. The original charge is recorded against
      // the run that actually paid it, not re-attributed to this one.
      costCents: 0,
      cacheHit: true,
      ltxCalled: false,
      model: cached.model,
      promptSha256,
    };
  }

  options.onProgress?.(
    `scene ${scene.sceneNumber}: submitting a ${requestedDurationSeconds}s ${options.model} generation (needs ${options.requiredSourceSeconds.toFixed(2)}s)`,
  );

  const idempotencyKey = `${options.workflowRunId}:scene-${scene.sceneNumber}:${cacheKey.slice(0, 16)}`;
  const shotId = `scene-${String(scene.sceneNumber).padStart(2, '0')}`;

  let handle;
  try {
    handle = await options.provider.submit({
      idempotencyKey,
      shotId,
      mode: 'IMAGE_TO_VIDEO',
      promptText: scene.motionPrompt,
      candidateCount: 1,
      referenceImages: [
        {
          assetId: keyframe.frameId,
          localPath: keyframe.absolutePath,
          mimeType: keyframe.mimeType,
          role: 'START_FRAME',
          rights: {
            usageClass: 'OWNED',
            rightsHolder: 'Combat Reviews',
            licenseType: 'OWNED_PRODUCTION_KEYFRAME',
          },
        },
        ...(options.lastFrame
          ? [
              {
                assetId: options.lastFrame.frameId,
                localPath: options.lastFrame.absolutePath,
                mimeType: options.lastFrame.mimeType,
                role: 'CONTINUITY' as const,
                rights: {
                  usageClass: 'OWNED' as const,
                  rightsHolder: 'Combat Reviews',
                  licenseType: 'OWNED_PRODUCTION_KEYFRAME',
                },
              },
            ]
          : []),
      ],
      params: {
        durationSeconds: requestedDurationSeconds,
        aspectRatio: '9:16',
        resolution: LTX_SUPPORTED_RESOLUTION,
        frameRate: LTX_SUPPORTED_FPS,
        providerOptions: {
          generateAudio: options.generateAudio,
          cameraMotion: scene.cameraMotion,
        },
      },
    });
  } catch (error) {
    throw translateProviderError(error, scene.sceneNumber, 'JOB_SUBMISSION_FAILED');
  }

  // ---- poll ---------------------------------------------------------------
  for (;;) {
    let status;
    try {
      status = await options.provider.getStatus(handle);
    } catch (error) {
      throw translateProviderError(error, scene.sceneNumber, 'GENERATION_FAILED');
    }

    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
      const failure = await options.provider.getFailure(handle).catch(() => null);
      throw new StoryboardVideoError(
        status === 'TIMED_OUT' ? 'POLLING_TIMEOUT' : 'GENERATION_FAILED',
        `scene ${scene.sceneNumber}: the generation ended ${status}${
          failure ? ` — ${failure.message}` : ''
        }. Nothing is retried automatically: rerun this scene with --regenerate-scene ${scene.sceneNumber} when you have decided to pay again.`,
        scene.sceneNumber,
      );
    }

    options.onProgress?.(`scene ${scene.sceneNumber}: ${status.toLowerCase()}`);
    await options.sleep(options.pollIntervalMs);
  }

  // ---- download, immediately ---------------------------------------------
  let candidates;
  try {
    candidates = await options.provider.fetchResult(handle);
  } catch (error) {
    throw translateProviderError(error, scene.sceneNumber, 'DOWNLOAD_FAILED');
  }
  const candidate = candidates[0];
  if (!candidate?.localPath) {
    throw new StoryboardVideoError(
      'DOWNLOAD_FAILED',
      `scene ${scene.sceneNumber}: the provider reported success but produced no local file`,
      scene.sceneNumber,
    );
  }

  const usage = await options.provider.getUsage(handle).catch(() => ({ costCents: 0 }));

  // ---- the bytes are measured, never taken on the provider's word ---------
  const bytes = await readFile(candidate.localPath);
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const measured = await probeClip(candidate.localPath, options.runner, options.binaries);
  assertGeneratedMediaUsable(measured, scene.sceneNumber, options.requiredSourceSeconds);

  await mkdir(options.originalsDirectory, { recursive: true });
  const originalPath = join(
    options.originalsDirectory,
    `scene-${String(scene.sceneNumber).padStart(2, '0')}-${checksumSha256.slice(0, 16)}.mp4`,
  );
  await writeFile(originalPath, bytes);

  await options.cache.record({
    cacheKey,
    sceneNumber: scene.sceneNumber,
    relativePath: `originals/scene-${String(scene.sceneNumber).padStart(2, '0')}-${checksumSha256.slice(0, 16)}.mp4`,
    checksumSha256,
    sizeBytes: bytes.byteLength,
    durationSeconds: measured.durationSeconds,
    widthPx: measured.widthPx,
    heightPx: measured.heightPx,
    model: options.model,
    requestedDurationSeconds,
    costCents: usage.costCents,
    recordedAt: `run:${options.workflowRunId}`,
  });

  return {
    sceneNumber: scene.sceneNumber,
    provenance: PROVIDER_GENERATION_PROVENANCE,
    originalPath,
    originalChecksumSha256: checksumSha256,
    originalDurationSeconds: measured.durationSeconds,
    widthPx: measured.widthPx,
    heightPx: measured.heightPx,
    requestedDurationSeconds,
    costCents:
      usage.costCents ||
      ltxGenerationCostCents(options.model, LTX_SUPPORTED_RESOLUTION, requestedDurationSeconds),
    cacheHit: false,
    ltxCalled: true,
    model: options.model,
    promptSha256,
  };
}

/**
 * What "the bytes are usable" means, measured rather than declared.
 *
 * A provider reporting success and a playable clip at the right geometry are
 * different facts, and the gap between them is where a run silently produces
 * an advertisement built from a broken download.
 */
export function assertGeneratedMediaUsable(
  measured: ProbedClip,
  sceneNumber: number,
  requiredSeconds: number,
): void {
  const problems: string[] = [];
  if (
    measured.widthPx !== LTX_SUPPORTED_WIDTH_PX ||
    measured.heightPx !== LTX_SUPPORTED_HEIGHT_PX
  ) {
    problems.push(
      `is ${measured.widthPx}x${measured.heightPx}, not ${LTX_SUPPORTED_WIDTH_PX}x${LTX_SUPPORTED_HEIGHT_PX}`,
    );
  }
  if (!Number.isFinite(measured.durationSeconds) || measured.durationSeconds <= 0) {
    problems.push('reports no duration, so it is not footage');
  } else if (measured.durationSeconds + 1e-6 < requiredSeconds) {
    problems.push(
      `runs ${measured.durationSeconds.toFixed(2)}s, short of the ${requiredSeconds.toFixed(2)}s this scene needs. A short result is never stretched to fit.`,
    );
  }
  if (!measured.videoCodec || measured.videoCodec === 'unknown') {
    problems.push('has no recognisable video codec');
  }
  if (problems.length > 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `scene ${sceneNumber}: the generated clip ${problems.join('; ')}`,
      sceneNumber,
    );
  }
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

export interface PrepareSceneClipOptions {
  readonly sceneNumber: number;
  readonly sourcePath: string;
  readonly sourceDurationSeconds: number;
  readonly beatDurationSeconds: number;
  readonly hasTransitionIn: boolean;
  readonly hasTransitionOut: boolean;
  readonly trimmedDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

/**
 * Trims and normalises one moving source into the clip the timeline uses.
 *
 * The window is the beat plus a handle at each end the transitions will blend
 * into, taken from the head of the source — the head is what an
 * image-to-video generation animates *away from*, so it is the part that
 * matches the approved keyframe most closely.
 *
 * Landscape and oversized sources are centre-cropped to 9:16 and scaled, which
 * is the one place this module changes framing. It is recorded rather than
 * hidden: the crop is stated in the returned dimensions and the report.
 */
export async function prepareSceneClip(
  options: PrepareSceneClipOptions,
): Promise<PreparedSceneClip> {
  const headHandle = options.hasTransitionIn ? SCENE_TRIM_HANDLE_SECONDS : 0;
  const tailHandle = options.hasTransitionOut ? SCENE_TRIM_HANDLE_SECONDS : 0;
  const usedDurationSeconds = Number(
    (options.beatDurationSeconds + headHandle + tailHandle).toFixed(6),
  );

  if (options.sourceDurationSeconds + 1e-6 < usedDurationSeconds) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `scene ${options.sceneNumber}: the source runs ${options.sourceDurationSeconds.toFixed(2)}s but the scene needs ${usedDurationSeconds.toFixed(2)}s once transition handles are reserved. Refused rather than time-stretched.`,
      options.sceneNumber,
    );
  }

  await mkdir(options.trimmedDirectory, { recursive: true });
  const targetPath = join(
    options.trimmedDirectory,
    `scene-${String(options.sceneNumber).padStart(2, '0')}.mp4`,
  );

  options.onProgress?.(
    `scene ${options.sceneNumber}: trimming ${usedDurationSeconds.toFixed(2)}s of ${options.sourceDurationSeconds.toFixed(2)}s (discarding ${(options.sourceDurationSeconds - usedDurationSeconds).toFixed(2)}s), preserving 9:16`,
  );

  // Centre-crop to 9:16 then scale — `increase` guarantees the crop source is
  // at least the target in both axes, so no edge is ever padded.
  const filter = [
    `scale=${LTX_SUPPORTED_WIDTH_PX}:${LTX_SUPPORTED_HEIGHT_PX}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${LTX_SUPPORTED_WIDTH_PX}:${LTX_SUPPORTED_HEIGHT_PX}`,
    'setsar=1',
    `fps=${LTX_SUPPORTED_FPS}`,
    'format=yuv420p',
  ].join(',');

  const result = await options.runner.run(
    options.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      '0',
      '-t',
      usedDurationSeconds.toFixed(6),
      '-i',
      options.sourcePath,
      '-vf',
      filter,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      targetPath,
    ],
    { timeoutMs: 600_000 },
  );
  if (result.exitCode !== 0) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `scene ${options.sceneNumber}: the trim failed — ${result.stderr.trim().slice(-400)}`,
      options.sceneNumber,
    );
  }

  const bytes = await readFile(targetPath);
  return {
    sceneNumber: options.sceneNumber,
    absolutePath: targetPath,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    usedInSeconds: 0,
    usedDurationSeconds,
    discardedSeconds: Number((options.sourceDurationSeconds - usedDurationSeconds).toFixed(6)),
    widthPx: LTX_SUPPORTED_WIDTH_PX,
    heightPx: LTX_SUPPORTED_HEIGHT_PX,
    // The beat's own window sits after the head handle, so an entering
    // transition has material to blend from.
    pinnedInSeconds: headHandle,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export interface ProbedClip {
  readonly durationSeconds: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly videoCodec: string;
  readonly hasAudio: boolean;
}

export async function probeClip(
  absolutePath: string,
  runner: CommandRunner,
  binaries: FfmpegBinaries,
): Promise<ProbedClip> {
  const probe = await runner.run(
    binaries.ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height:format=duration',
      '-of',
      'json',
      absolutePath,
    ],
    { timeoutMs: 60_000 },
  );
  if (probe.exitCode !== 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `${absolutePath} could not be probed: ${probe.stderr.trim().slice(-300)}`,
    );
  }
  const parsed = JSON.parse(probe.stdout) as {
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  return {
    durationSeconds: Number(parsed.format?.duration ?? 0),
    widthPx: video?.width ?? 0,
    heightPx: video?.height ?? 0,
    videoCodec: video?.codec_name ?? 'unknown',
    hasAudio: (parsed.streams ?? []).some((stream) => stream.codec_type === 'audio'),
  };
}

/**
 * Maps a provider failure onto this command's own exit vocabulary.
 *
 * The transport kind is preserved through `LtxVideoGenerationError` precisely
 * so this mapping can exist: a 402 and a 429 and a malformed body are three
 * different operator actions, and collapsing them into "generation failed"
 * would make the exit code useless for the thing exit codes are for.
 */
export function translateProviderError(
  error: unknown,
  sceneNumber: number,
  fallback: StoryboardVideoFailureKind,
): StoryboardVideoError {
  if (error instanceof StoryboardVideoError) return error;
  if (error instanceof LtxVideoGenerationError) {
    const kind: StoryboardVideoFailureKind =
      error.ltxKind === 'PAYMENT_REQUIRED'
        ? 'PAYMENT_REQUIRED'
        : error.ltxKind === 'RATE_LIMITED'
          ? 'RATE_LIMITED'
          : error.ltxKind === 'UNAUTHORIZED'
            ? 'MISSING_API_KEY'
            : error.ltxKind === 'MALFORMED_RESPONSE'
              ? 'MALFORMED_RESPONSE'
              : error.ltxKind === 'EXPIRED'
                ? 'EXPIRED_RESULT'
                : error.ltxKind === 'TIMEOUT'
                  ? 'POLLING_TIMEOUT'
                  : error.ltxKind === 'UNSUPPORTED_REQUEST'
                    ? 'UNSUPPORTED_MODEL_OR_DURATION'
                    : fallback;
    return new StoryboardVideoError(kind, `scene ${sceneNumber}: ${error.message}`, sceneNumber);
  }
  return new StoryboardVideoError(
    fallback,
    `scene ${sceneNumber}: ${error instanceof Error ? error.message : String(error)}`,
    sceneNumber,
  );
}

export { MANUAL_GENERATION_PROVENANCE, PROVIDER_GENERATION_PROVENANCE };
export type { LtxDurationSeconds };
