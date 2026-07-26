import { basename, dirname } from 'node:path';

import { NodeCommandRunner, type CommandRunner, type FfmpegBinaries } from '@combat/media';

import {
  cutsToScenes,
  DEFAULT_MIN_SCENE_SECONDS,
  DEFAULT_SCENE_DETECTION_TIMEOUT_MS,
  DEFAULT_SCENE_THRESHOLD,
  SceneDetectionError,
  type SceneDetectionProvider,
  type SceneDetectionRequest,
  type SceneDetectionResult,
} from './scene-detection';

/**
 * Content-aware scene detection using only the FFmpeg toolchain this
 * repository already pins.
 *
 * FFmpeg's `select=gt(scene,T)` filter scores each frame's difference from its
 * predecessor and emits the frames that exceed the threshold — the same
 * content-aware principle PySceneDetect's `detect-content` uses. Reading those
 * timestamps through `ffprobe -of json` gives real cut boundaries with no
 * additional dependency, which matters because PySceneDetect cannot be
 * installed here and a Creative Memory that cannot segment anything is not
 * worth shipping.
 *
 * The filter graph is built from numbers and a bare filename only. As
 * CLAUDE.md records, a Windows `C:\…` path inside a filter argument collides
 * with the `:` option separator, so the process runs with `cwd` set to the
 * file's directory and refers to it by name — the same discipline the renderer
 * uses.
 */
export class FfmpegSceneDetectionProvider implements SceneDetectionProvider {
  readonly name = 'ffmpeg-select-scene';

  constructor(
    private readonly binaries: FfmpegBinaries,
    private readonly runner: CommandRunner = new NodeCommandRunner(),
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.runner.run(this.binaries.ffprobe, ['-version'], { timeoutMs: 15_000 });
      return true;
    } catch {
      return false;
    }
  }

  async detectScenes(request: SceneDetectionRequest): Promise<SceneDetectionResult> {
    const threshold = request.threshold ?? DEFAULT_SCENE_THRESHOLD;
    const minSceneSeconds = request.minSceneSeconds ?? DEFAULT_MIN_SCENE_SECONDS;

    if (threshold <= 0 || threshold >= 1) {
      throw new SceneDetectionError(
        'DETECTION_FAILED',
        `scene threshold must be between 0 and 1, got ${threshold}`,
      );
    }

    // Only the numeric threshold is interpolated into the filter; the file is
    // addressed by bare name from its own directory.
    const filter = `movie=${basename(request.filePath)},select=gt(scene\\,${threshold})`;
    const args = [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      filter,
      '-show_entries',
      'frame=pts_time',
      '-of',
      'json',
    ];

    let result;
    try {
      result = await this.runner.run(this.binaries.ffprobe, args, {
        cwd: dirname(request.filePath),
        timeoutMs: request.timeoutMs ?? DEFAULT_SCENE_DETECTION_TIMEOUT_MS,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted) {
        throw new SceneDetectionError('CANCELLED', 'scene detection was cancelled', message);
      }
      if (/timeout|exceeded/i.test(message)) {
        throw new SceneDetectionError('TIMEOUT', 'scene detection exceeded its deadline', message);
      }
      throw new SceneDetectionError('DETECTION_FAILED', 'ffprobe scene detection failed', message);
    }

    const cuts = parseFrameTimestamps(result.stdout);
    const scenes = cutsToScenes(cuts, request.durationSeconds, minSceneSeconds);

    return {
      method: this.name,
      toolVersion: await this.toolVersion(),
      detectorConfig: { threshold, minSceneSeconds, filter: 'select=gt(scene,T)' },
      scenes,
      command: `${this.binaries.ffprobe} ${args.join(' ')}`,
    };
  }

  private async toolVersion(): Promise<string> {
    try {
      const { stdout } = await this.runner.run(this.binaries.ffprobe, ['-version'], {
        timeoutMs: 15_000,
      });
      return (stdout.split('\n')[0] ?? 'ffprobe').trim();
    } catch {
      return 'ffprobe (version unavailable)';
    }
  }
}

/** Reads `pts_time` out of ffprobe's JSON frame list. Rejects anything else. */
export function parseFrameTimestamps(stdout: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim().length === 0 ? '{}' : stdout);
  } catch (error) {
    throw new SceneDetectionError(
      'MALFORMED_OUTPUT',
      'ffprobe did not return JSON',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new SceneDetectionError('MALFORMED_OUTPUT', 'ffprobe returned a non-object body');
  }
  const frames = (parsed as { frames?: unknown }).frames;
  // No `frames` key at all is the legitimate "no cuts detected" answer for a
  // single-shot advertisement, not a parse failure.
  if (frames === undefined) return [];
  if (!Array.isArray(frames)) {
    throw new SceneDetectionError('MALFORMED_OUTPUT', 'ffprobe returned a non-array frames field');
  }

  const timestamps: number[] = [];
  for (const frame of frames) {
    if (typeof frame !== 'object' || frame === null) continue;
    const raw = (frame as { pts_time?: unknown }).pts_time;
    const value =
      typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
    if (Number.isFinite(value)) timestamps.push(value);
  }
  return timestamps;
}
