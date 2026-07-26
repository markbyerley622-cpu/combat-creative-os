import { DEFAULT_FFMPEG_BINARIES, DEFAULT_PROBE_TIMEOUT_MS } from './binaries';
import type { CommandRunner } from './command-runner';
import { CorruptMediaError, type MediaProbeResult } from './types';

export interface ProbeOptions {
  readonly ffprobePath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  nb_frames?: string;
  color_space?: string;
  pix_fmt?: string;
  display_aspect_ratio?: string;
  sample_aspect_ratio?: string;
  duration?: string;
  bit_rate?: string;
}

export interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  nb_streams?: number;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  const safeNumerator = numerator ?? 0;
  if (!denominator) return safeNumerator;
  return safeNumerator / denominator;
}

/**
 * Runs `ffprobe` on a local file path and returns a typed probe result.
 * Image vs. video is disambiguated by frame count: a single-frame,
 * zero-duration video-coded stream (how ffprobe reports a still image) is
 * `IMAGE`; anything else with a video stream is `VIDEO`; a file with only
 * an audio stream is `AUDIO`.
 */
export async function probeMedia(
  runner: CommandRunner,
  filePath: string,
  options: ProbeOptions = {},
): Promise<MediaProbeResult> {
  const parsed = await probeRaw(runner, filePath, options);

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

  if (!videoStream && !audioStream) {
    throw new CorruptMediaError('no video or audio stream found');
  }

  const durationSeconds = Number(parsed.format?.duration ?? 0);

  if (videoStream) {
    if (!videoStream.width || !videoStream.height) {
      throw new CorruptMediaError('video/image stream is missing width/height');
    }
    const nbFrames = Number(videoStream.nb_frames ?? 0);
    const isImage = nbFrames <= 1 && durationSeconds === 0;

    if (isImage) {
      return {
        mediaType: 'IMAGE',
        widthPx: videoStream.width,
        heightPx: videoStream.height,
        format: parsed.format?.format_name ?? 'unknown',
        colorSpace: videoStream.color_space ?? videoStream.pix_fmt,
      };
    }

    return {
      mediaType: 'VIDEO',
      durationSeconds,
      widthPx: videoStream.width,
      heightPx: videoStream.height,
      frameRate: parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
      videoCodec: videoStream.codec_name ?? 'unknown',
      hasAudio: Boolean(audioStream),
      audioCodec: audioStream?.codec_name,
    };
  }

  return {
    mediaType: 'AUDIO',
    durationSeconds,
    codec: audioStream?.codec_name ?? 'unknown',
    channels: audioStream?.channels ?? 0,
    sampleRateHz: Number(audioStream?.sample_rate ?? 0),
  };
}

/**
 * The unreduced ffprobe view. `probeMedia` collapses this into the small
 * ingestion-shaped `MediaProbeResult`; actual-media QA needs the fields that
 * collapse discards — `pix_fmt`, `profile`, `display_aspect_ratio`,
 * `format_name`, per-stream durations — and every one of them must come from
 * the produced file rather than from what was requested.
 */
export async function probeRaw(
  runner: CommandRunner,
  filePath: string,
  options: ProbeOptions = {},
): Promise<FfprobeOutput> {
  const result = await runner.run(
    options.ffprobePath ?? DEFAULT_FFMPEG_BINARIES.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, signal: options.signal },
  );

  if (result.exitCode !== 0) {
    throw new CorruptMediaError(
      result.stderr.trim() || `ffprobe exited with code ${result.exitCode}`,
    );
  }

  try {
    return JSON.parse(result.stdout) as FfprobeOutput;
  } catch {
    throw new CorruptMediaError('ffprobe output was not valid JSON');
  }
}
