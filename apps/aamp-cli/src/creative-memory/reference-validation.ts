import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { ReferenceManifestEntry } from '@combat/domain';
import {
  NodeCommandRunner,
  probeMedia,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';

/**
 * Validates a locally-held reference file before anything is derived from it.
 *
 * The original is treated as read-only throughout: this module opens it, hashes
 * it and probes it, and never writes to it. Everything the pipeline produces
 * goes to a separate analysis directory, so a failed ingestion can never damage
 * material the operator lawfully holds and may not be able to re-obtain.
 */

export const REFERENCE_VALIDATION_FAILURES = [
  'UNSAFE_PATH',
  'MISSING_MEDIA',
  'CHECKSUM_MISMATCH',
  'UNSUPPORTED_MEDIA',
  'TOO_LARGE',
  'TOO_LONG',
] as const;
export type ReferenceValidationFailure = (typeof REFERENCE_VALIDATION_FAILURES)[number];

export class ReferenceValidationError extends Error {
  constructor(
    public readonly kind: ReferenceValidationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ReferenceValidationError';
  }
}

export interface ValidatedReferenceMedia {
  readonly absolutePath: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly durationSeconds: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly frameRate: number;
  readonly videoCodec: string;
  readonly hasAudio: boolean;
  readonly audioCodec?: string;
}

export interface ValidateReferenceOptions {
  readonly entry: ReferenceManifestEntry;
  readonly manifestDir: string;
  /** Roots a reference file is permitted to live inside. */
  readonly referenceRoots: readonly string[];
  readonly binaries: FfmpegBinaries;
  readonly maxSizeBytes?: number;
  readonly maxDurationSeconds?: number;
  readonly runner?: CommandRunner;
}

export const DEFAULT_MAX_REFERENCE_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_REFERENCE_SECONDS = 15 * 60;

function isContained(absolute: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const normalised = resolve(root);
    return (
      absolute === normalised ||
      absolute.startsWith(`${normalised}\\`) ||
      absolute.startsWith(`${normalised}/`)
    );
  });
}

export async function validateReferenceMedia(
  options: ValidateReferenceOptions,
): Promise<ValidatedReferenceMedia> {
  const { entry } = options;
  const declared = entry.localAnalysisPath;
  if (!declared) {
    throw new ReferenceValidationError(
      'MISSING_MEDIA',
      `"${entry.referenceId}" has no localAnalysisPath to validate`,
    );
  }

  // --- containment, before the filesystem is touched ----------------------
  const absolutePath = isAbsolute(declared)
    ? resolve(declared)
    : resolve(options.manifestDir, declared);
  if (!isContained(absolutePath, options.referenceRoots)) {
    throw new ReferenceValidationError(
      'UNSAFE_PATH',
      `"${entry.referenceId}" resolves to ${absolutePath}, which is outside every configured reference root`,
    );
  }

  // --- existence and size --------------------------------------------------
  let sizeBytes: number;
  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile()) {
      throw new ReferenceValidationError('MISSING_MEDIA', `${absolutePath} is not a file`);
    }
    sizeBytes = stats.size;
  } catch (error) {
    if (error instanceof ReferenceValidationError) throw error;
    throw new ReferenceValidationError('MISSING_MEDIA', `${absolutePath} does not exist`);
  }
  if (sizeBytes === 0) {
    throw new ReferenceValidationError('MISSING_MEDIA', `${absolutePath} is empty`);
  }
  const maxBytes = options.maxSizeBytes ?? DEFAULT_MAX_REFERENCE_BYTES;
  if (sizeBytes > maxBytes) {
    throw new ReferenceValidationError(
      'TOO_LARGE',
      `${absolutePath} is ${sizeBytes} bytes, over the ${maxBytes}-byte reference ceiling`,
    );
  }

  // --- checksum -------------------------------------------------------------
  const checksumSha256 = createHash('sha256')
    .update(await readFile(absolutePath))
    .digest('hex');
  if (entry.expectedChecksumSha256 && entry.expectedChecksumSha256 !== checksumSha256) {
    throw new ReferenceValidationError(
      'CHECKSUM_MISMATCH',
      `"${entry.referenceId}" declared ${entry.expectedChecksumSha256} but the file hashes to ${checksumSha256}`,
    );
  }

  // --- decode ---------------------------------------------------------------
  let probe;
  try {
    probe = await probeMedia(options.runner ?? new NodeCommandRunner(), absolutePath, {
      ffprobePath: options.binaries.ffprobe,
    });
  } catch (error) {
    throw new ReferenceValidationError(
      'UNSUPPORTED_MEDIA',
      `${absolutePath} could not be read by ffprobe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (probe.mediaType !== 'VIDEO') {
    throw new ReferenceValidationError(
      'UNSUPPORTED_MEDIA',
      `${absolutePath} decodes as ${probe.mediaType}; a reference advertisement must be video`,
    );
  }

  const maxSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_REFERENCE_SECONDS;
  if (probe.durationSeconds > maxSeconds) {
    throw new ReferenceValidationError(
      'TOO_LONG',
      `${absolutePath} runs ${probe.durationSeconds.toFixed(1)}s, over the ${maxSeconds}s reference ceiling`,
    );
  }

  return {
    absolutePath,
    checksumSha256,
    sizeBytes,
    durationSeconds: probe.durationSeconds,
    widthPx: probe.widthPx,
    heightPx: probe.heightPx,
    frameRate: probe.frameRate,
    videoCodec: probe.videoCodec,
    hasAudio: probe.hasAudio,
    ...(probe.audioCodec ? { audioCodec: probe.audioCodec } : {}),
  };
}
