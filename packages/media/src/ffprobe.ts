import type { CommandRunner } from './command-runner';
import { CorruptMediaError, type MediaProbeResult } from './types';

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  nb_frames?: string;
  color_space?: string;
  pix_fmt?: string;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function parseFrameRate(value: string | undefined): number {
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
): Promise<MediaProbeResult> {
  const result = await runner.run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  if (result.exitCode !== 0) {
    throw new CorruptMediaError(
      result.stderr.trim() || `ffprobe exited with code ${result.exitCode}`,
    );
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeOutput;
  } catch {
    throw new CorruptMediaError('ffprobe output was not valid JSON');
  }

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
