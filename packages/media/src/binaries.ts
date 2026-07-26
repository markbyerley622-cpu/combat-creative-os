/**
 * Where the FFmpeg toolchain lives. Configurable rather than hardcoded to
 * bare `ffmpeg`/`ffprobe` because on Windows the binaries are commonly
 * installed outside `PATH` (a winget package directory, a Docker-bound
 * volume, a pinned build under `infrastructure/`), and a render worker must
 * be able to pin an exact build rather than inherit whatever the shell finds.
 *
 * `resolveFfmpegBinaries` takes the environment as an argument instead of
 * reading `process.env` — the composition roots (CLI, worker) pass it in, so
 * library code stays pure and testable. These are executable locations, not
 * credentials; nothing here belongs in `packages/config`'s secret-bearing
 * schema.
 */
export interface FfmpegBinaries {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export const DEFAULT_FFMPEG_BINARIES: FfmpegBinaries = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
};

export const FFMPEG_PATH_ENV_VAR = 'FFMPEG_PATH';
export const FFPROBE_PATH_ENV_VAR = 'FFPROBE_PATH';

export function resolveFfmpegBinaries(
  env: Readonly<Record<string, string | undefined>>,
): FfmpegBinaries {
  const ffmpeg = env[FFMPEG_PATH_ENV_VAR]?.trim();
  const ffprobe = env[FFPROBE_PATH_ENV_VAR]?.trim();
  return {
    ffmpeg: ffmpeg && ffmpeg.length > 0 ? ffmpeg : DEFAULT_FFMPEG_BINARIES.ffmpeg,
    ffprobe: ffprobe && ffprobe.length > 0 ? ffprobe : DEFAULT_FFMPEG_BINARIES.ffprobe,
  };
}

/** Default ceilings for the two kinds of FFmpeg work this package performs. */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
export const DEFAULT_RENDER_TIMEOUT_MS = 15 * 60_000;
