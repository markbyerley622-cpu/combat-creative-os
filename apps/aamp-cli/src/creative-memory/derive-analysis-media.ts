import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { NodeCommandRunner, type CommandRunner, type FfmpegBinaries } from '@combat/media';
import type { DetectedScene } from '@combat/providers';

/**
 * Produces the low-resolution proxy and representative frames Creative Memory
 * browses, and records exactly how each was made.
 *
 * Two rules govern everything here. **The original is never touched** — every
 * command reads it and writes elsewhere. And **every derived byte carries
 * provenance**: the source checksum, the exact argv, and the tool version, so
 * a frame found on disk in six months can be traced back to the advertisement
 * it came from. A derived file whose origin cannot be named is
 * indistinguishable from material of unknown rights, which is precisely the
 * situation Creative Memory exists to avoid.
 */

export class DerivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerivationError';
  }
}

export interface DerivedArtifact {
  readonly kind: 'PROXY' | 'FRAME' | 'SCENE_CLIP';
  readonly localPath: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly extractionCommand: string;
  readonly toolVersion: string;
  /** Set for frames: which scene and which position within it. */
  readonly sceneIndex?: number;
  readonly frameKind?: 'START' | 'MIDPOINT' | 'END';
  readonly timestampSeconds?: number;
}

export interface DeriveOptions {
  readonly sourcePath: string;
  readonly sourceChecksumSha256: string;
  readonly durationSeconds: number;
  readonly scenes: readonly DetectedScene[];
  /** Analysis directory for this reference. Created if absent. Never a production namespace. */
  readonly outputDirectory: string;
  readonly binaries: FfmpegBinaries;
  readonly toolVersion: string;
  /** Off by default: per-scene clips multiply storage for marginal analytic gain. */
  readonly extractSceneClips?: boolean;
  /** Longest edge of the analysis proxy. */
  readonly proxyHeightPx?: number;
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
}

async function fileFacts(path: string): Promise<{ checksumSha256: string; sizeBytes: number }> {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0) {
    throw new DerivationError(`${path} was produced empty`);
  }
  return {
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  };
}

/**
 * Frame timestamps for a scene: its start, its midpoint and just before its
 * end. The end frame is pulled back slightly because seeking to a scene's
 * exact final timestamp frequently lands on the first frame of the *next*
 * shot, which would quietly mislabel every cut in the library.
 */
export function frameTimestampsFor(scene: DetectedScene): {
  START: number;
  MIDPOINT: number;
  END: number;
} {
  const epsilon = Math.min(0.04, scene.durationSeconds / 4);
  return {
    START: Number(scene.startSeconds.toFixed(3)),
    MIDPOINT: Number((scene.startSeconds + scene.durationSeconds / 2).toFixed(3)),
    END: Number(Math.max(scene.startSeconds, scene.endSeconds - epsilon).toFixed(3)),
  };
}

export async function deriveAnalysisMedia(
  options: DeriveOptions,
): Promise<readonly DerivedArtifact[]> {
  const runner = options.runner ?? new NodeCommandRunner();
  await mkdir(options.outputDirectory, { recursive: true });
  const artifacts: DerivedArtifact[] = [];

  const run = async (args: readonly string[], target: string, label: string): Promise<void> => {
    try {
      await runner.run(options.binaries.ffmpeg, args, {
        timeoutMs: 10 * 60_000,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw new DerivationError(
        `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await stat(target);
    } catch {
      throw new DerivationError(`${label} reported success but produced no file at ${target}`);
    }
  };

  // --- analysis proxy -------------------------------------------------------
  const proxyHeight = options.proxyHeightPx ?? 480;
  const proxyPath = join(options.outputDirectory, 'proxy.mp4');
  const proxyArgs = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    options.sourcePath,
    '-vf',
    `scale=-2:${proxyHeight}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-an',
    proxyPath,
  ];
  await run(proxyArgs, proxyPath, 'analysis proxy');
  artifacts.push({
    kind: 'PROXY',
    localPath: proxyPath,
    ...(await fileFacts(proxyPath)),
    extractionCommand: `${options.binaries.ffmpeg} ${proxyArgs.join(' ')}`,
    toolVersion: options.toolVersion,
  });

  // --- representative frames per scene --------------------------------------
  for (const scene of options.scenes) {
    const timestamps = frameTimestampsFor(scene);
    for (const kind of ['START', 'MIDPOINT', 'END'] as const) {
      const timestampSeconds = timestamps[kind];
      const framePath = join(
        options.outputDirectory,
        `scene-${String(scene.sceneIndex).padStart(3, '0')}-${kind.toLowerCase()}.jpg`,
      );
      // `-ss` before `-i` seeks by keyframe and is far faster; accuracy to the
      // frame is not required for a representative still.
      const frameArgs = [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-ss',
        timestampSeconds.toFixed(3),
        '-i',
        options.sourcePath,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        framePath,
      ];
      // eslint-disable-next-line no-await-in-loop -- frames are extracted in scene order so indices stay stable
      await run(frameArgs, framePath, `frame ${kind} for scene ${scene.sceneIndex}`);
      artifacts.push({
        kind: 'FRAME',
        localPath: framePath,
        // eslint-disable-next-line no-await-in-loop -- same ordering rationale
        ...(await fileFacts(framePath)),
        extractionCommand: `${options.binaries.ffmpeg} ${frameArgs.join(' ')}`,
        toolVersion: options.toolVersion,
        sceneIndex: scene.sceneIndex,
        frameKind: kind,
        timestampSeconds,
      });
    }

    if (options.extractSceneClips) {
      const clipPath = join(
        options.outputDirectory,
        `scene-${String(scene.sceneIndex).padStart(3, '0')}.mp4`,
      );
      const clipArgs = [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-ss',
        scene.startSeconds.toFixed(3),
        '-t',
        scene.durationSeconds.toFixed(3),
        '-i',
        options.sourcePath,
        '-vf',
        `scale=-2:${proxyHeight}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-an',
        clipPath,
      ];
      // eslint-disable-next-line no-await-in-loop -- same ordering rationale
      await run(clipArgs, clipPath, `scene clip ${scene.sceneIndex}`);
      artifacts.push({
        kind: 'SCENE_CLIP',
        localPath: clipPath,
        // eslint-disable-next-line no-await-in-loop -- same ordering rationale
        ...(await fileFacts(clipPath)),
        extractionCommand: `${options.binaries.ffmpeg} ${clipArgs.join(' ')}`,
        toolVersion: options.toolVersion,
        sceneIndex: scene.sceneIndex,
      });
    }
  }

  return artifacts;
}
