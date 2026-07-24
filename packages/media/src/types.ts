export const DECLARED_MEDIA_TYPES = ['IMAGE', 'VIDEO', 'AUDIO'] as const;
export type DeclaredMediaType = (typeof DECLARED_MEDIA_TYPES)[number];

export interface ImageProbeResult {
  readonly mediaType: 'IMAGE';
  readonly widthPx: number;
  readonly heightPx: number;
  readonly format: string;
  readonly colorSpace?: string;
}

export interface VideoProbeResult {
  readonly mediaType: 'VIDEO';
  readonly durationSeconds: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly frameRate: number;
  readonly videoCodec: string;
  readonly hasAudio: boolean;
  readonly audioCodec?: string;
}

export interface AudioProbeResult {
  readonly mediaType: 'AUDIO';
  readonly durationSeconds: number;
  readonly codec: string;
  readonly channels: number;
  readonly sampleRateHz: number;
}

export type MediaProbeResult = ImageProbeResult | VideoProbeResult | AudioProbeResult;

/** ffprobe ran but the input could not be read as any known media stream. */
export class CorruptMediaError extends Error {
  constructor(detail: string) {
    super(`Corrupt or unreadable media: ${detail}`);
    this.name = 'CorruptMediaError';
  }
}

/** ffprobe read the input successfully but its codec/container isn't in this package's supported allowlist. */
export class UnsupportedMediaFormatError extends Error {
  constructor(detail: string) {
    super(`Unsupported media format: ${detail}`);
    this.name = 'UnsupportedMediaFormatError';
  }
}

export class MediaTooLargeError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`Media exceeds configured size limit (${actualBytes} bytes > ${maxBytes} bytes)`);
    this.name = 'MediaTooLargeError';
  }
}

export class MediaTypeMismatchError extends Error {
  constructor(
    public readonly declared: DeclaredMediaType,
    public readonly detected: DeclaredMediaType,
  ) {
    super(`Declared media type ${declared} does not match detected type ${detected}`);
    this.name = 'MediaTypeMismatchError';
  }
}
