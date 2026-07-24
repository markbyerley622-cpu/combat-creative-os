import type { CommandRunner } from './command-runner';
import { probeMedia } from './ffprobe';
import {
  MediaTooLargeError,
  MediaTypeMismatchError,
  UnsupportedMediaFormatError,
  type DeclaredMediaType,
  type MediaProbeResult,
} from './types';

/**
 * Codec/container allowlists — deliberately a code-level constant rather
 * than env-configurable (packages/config's `assetEnvSchema` doc comment
 * explains why: a MIME-to-limit map doesn't serialize cleanly through env
 * vars, and this list is expected to grow with generation-provider output
 * formats in later milestones, which is a code change either way).
 */
export const SUPPORTED_VIDEO_CODECS = ['h264', 'hevc', 'vp9', 'vp8', 'av1'] as const;
export const SUPPORTED_AUDIO_CODECS = ['aac', 'mp3', 'pcm_s16le', 'opus', 'flac'] as const;

export interface InspectMediaInput {
  readonly filePath: string;
  readonly declaredMediaType: DeclaredMediaType;
  readonly actualSizeBytes: number;
  readonly maxBytes: number;
}

/**
 * Probes `filePath` and enforces every M5 rejection rule in one place:
 * size limit, corrupt/unreadable input (via `probeMedia`), declared-vs-
 * detected type mismatch, and unsupported codec. Order matters — the size
 * check runs before ever invoking ffprobe, since there's no reason to probe
 * (or risk ffprobe struggling with) a file that's already over the limit.
 */
export async function inspectMedia(
  runner: CommandRunner,
  input: InspectMediaInput,
): Promise<MediaProbeResult> {
  if (input.actualSizeBytes > input.maxBytes) {
    throw new MediaTooLargeError(input.actualSizeBytes, input.maxBytes);
  }

  const result = await probeMedia(runner, input.filePath);

  if (result.mediaType !== input.declaredMediaType) {
    throw new MediaTypeMismatchError(input.declaredMediaType, result.mediaType);
  }

  assertSupportedFormat(result);

  return result;
}

function assertSupportedFormat(result: MediaProbeResult): void {
  if (
    result.mediaType === 'VIDEO' &&
    !SUPPORTED_VIDEO_CODECS.includes(result.videoCodec as never)
  ) {
    throw new UnsupportedMediaFormatError(`video codec "${result.videoCodec}"`);
  }
  if (result.mediaType === 'AUDIO' && !SUPPORTED_AUDIO_CODECS.includes(result.codec as never)) {
    throw new UnsupportedMediaFormatError(`audio codec "${result.codec}"`);
  }
}
