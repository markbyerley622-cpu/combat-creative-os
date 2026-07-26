import { dirname } from 'node:path';

import { NodeCommandRunner, type CommandRunner } from '@combat/media';

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
 * PySceneDetect adapter — the preferred detector when the operator has
 * installed it.
 *
 * **Pinned release: PySceneDetect 0.6.4.** Installation is an explicit
 * operator step; nothing here installs it, and nothing downloads anything:
 *
 *     python -m pip install "scenedetect[opencv]==0.6.4"
 *
 * When it is absent, `isAvailable()` returns false and the ingestion pipeline
 * falls back to `FfmpegSceneDetectionProvider`, which needs no extra
 * dependency. That fallback is why Creative Memory can segment references on a
 * machine where PySceneDetect was never installed.
 *
 * Uses `detect-adaptive`, which compares each frame against a rolling window
 * rather than a fixed threshold. That handles the fast cutting and hard
 * lighting changes typical of advertising far better than a content detector
 * with one global threshold.
 *
 * Output is read as CSV (`list-scenes -f`), never scraped from the progress
 * output the command prints to the terminal.
 */
export const PYSCENEDETECT_PINNED_VERSION = '0.6.4';
export const PYSCENEDETECT_INSTALL_COMMAND = 'python -m pip install "scenedetect[opencv]==0.6.4"';

export interface PySceneDetectOptions {
  /** Executable to invoke. Defaults to the console script installed by pip. */
  readonly executable?: string;
  readonly runner?: CommandRunner;
}

export class PySceneDetectProvider implements SceneDetectionProvider {
  readonly name = 'pyscenedetect-adaptive';
  private readonly executable: string;
  private readonly runner: CommandRunner;

  constructor(options: PySceneDetectOptions = {}) {
    this.executable = options.executable ?? 'scenedetect';
    this.runner = options.runner ?? new NodeCommandRunner();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.runner.run(this.executable, ['version'], { timeoutMs: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  async detectScenes(request: SceneDetectionRequest): Promise<SceneDetectionResult> {
    const threshold = request.threshold ?? DEFAULT_SCENE_THRESHOLD;
    const minSceneSeconds = request.minSceneSeconds ?? DEFAULT_MIN_SCENE_SECONDS;

    // Argument array, never a shell string: the file path is a single argv
    // entry, so spaces and shell metacharacters in a filename cannot become
    // command syntax.
    const args = [
      '--input',
      request.filePath,
      'detect-adaptive',
      '--min-scene-len',
      `${Math.max(1, Math.round(minSceneSeconds * 1000))}ms`,
      'list-scenes',
      '--filename',
      'scenes',
      '--output',
      dirname(request.filePath),
      '--quiet',
    ];

    let result;
    try {
      result = await this.runner.run(this.executable, args, {
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
      if (/ENOENT|not recognized|not found/i.test(message)) {
        throw new SceneDetectionError(
          'DETECTOR_UNAVAILABLE',
          `PySceneDetect is not installed. Install the pinned release with: ${PYSCENEDETECT_INSTALL_COMMAND}`,
          message,
        );
      }
      throw new SceneDetectionError('DETECTION_FAILED', 'PySceneDetect failed', message);
    }

    const cuts = parseSceneCsvStartSeconds(result.stdout);
    const scenes = cutsToScenes(cuts, request.durationSeconds, minSceneSeconds);

    return {
      method: this.name,
      toolVersion: `pyscenedetect ${PYSCENEDETECT_PINNED_VERSION}`,
      detectorConfig: { detector: 'detect-adaptive', threshold, minSceneSeconds },
      scenes,
      command: `${this.executable} ${args.join(' ')}`,
    };
  }
}

/**
 * Reads scene start times from PySceneDetect's `list-scenes` CSV.
 *
 * The format carries a preamble line before the header, and the start time is
 * the `Start Time (seconds)` column. Column *names* are matched rather than
 * positions, so a future release that adds a column does not silently shift
 * the values being read.
 */
export function parseSceneCsvStartSeconds(csv: string): number[] {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const headerIndex = lines.findIndex((line) => /start time \(seconds\)/i.test(line));
  if (headerIndex < 0) {
    // No header and no rows is the legitimate single-shot answer.
    if (lines.length === 0) return [];
    throw new SceneDetectionError(
      'MALFORMED_OUTPUT',
      'PySceneDetect CSV did not contain a "Start Time (seconds)" column',
    );
  }

  const header = (lines[headerIndex] as string).split(',').map((cell) => cell.trim().toLowerCase());
  const column = header.indexOf('start time (seconds)');
  if (column < 0) {
    throw new SceneDetectionError('MALFORMED_OUTPUT', 'PySceneDetect CSV header was unreadable');
  }

  const starts: number[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const value = Number(line.split(',')[column]?.trim());
    if (Number.isFinite(value)) starts.push(value);
  }
  return starts;
}
