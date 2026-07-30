import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';
import { LTX_SUPPORTED_HEIGHT_PX, LTX_SUPPORTED_WIDTH_PX } from '@combat/providers';

import { StoryboardVideoError } from '../storyboard-video/failures';
import { assertNotPermanentlyRejected, type ResolvedPlate } from './plate-library';

/**
 * Copying the authoritative plate into a directory this run owns, and
 * preparing the exact bytes that will be uploaded.
 *
 * Two properties, and both are the reason this is a module rather than two
 * lines inline:
 *
 * **The external folder is read-only.** The plate is *copied* out, and the
 * copy's checksum is recomputed from the bytes that landed and compared to the
 * source's before anything downstream is allowed to use it. Nothing is
 * written, renamed, moved or deleted inside the operator's folder.
 *
 * **The upload image is a declared resample, never a claim of detail.** LTX
 * generates at 1080x1920 and the plate is smaller, so something has to resize
 * it. Doing it here, deterministically, with lanczos, and recording the exact
 * scale factors means the upscale is a stated fact in the provenance rather
 * than an invisible step inside a vendor's pipeline. `createsNewDetail` is
 * written as `false` explicitly: a resample moves pixels about, it does not
 * add information, and an artefact that left that to be inferred would be read
 * as a quality claim.
 *
 * A plate already at delivery geometry is passed through unchanged, and the
 * record says so — resampling an image that is already the right size would be
 * a pointless generation loss.
 */

export const STAGED_PLATE_DIRECTORY = 'staged-plate';

export interface PlatePreparation {
  /** The verified copy of the operator's original, byte-identical to it. */
  readonly stagedPath: string;
  readonly stagedChecksumSha256: string;
  /** The bytes actually uploaded. The same file when no resample was needed. */
  readonly uploadPath: string;
  readonly uploadChecksumSha256: string;
  readonly uploadMimeType: string;
  readonly uploadWidthPx: number;
  readonly uploadHeightPx: number;
  readonly resample: {
    readonly applied: boolean;
    readonly method: string;
    readonly horizontalScale: number;
    readonly verticalScale: number;
    /** How far from uniform the two scales are, as a fraction. Reported, never corrected. */
    readonly anisotropy: number;
    readonly createsNewDetail: false;
    readonly note: string;
  };
}

export interface PreparePlateOptions {
  readonly plate: ResolvedPlate;
  readonly outputDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

export async function preparePlateForUpload(
  options: PreparePlateOptions,
): Promise<PlatePreparation> {
  const { plate } = options;
  assertNotPermanentlyRejected(plate.absolutePath, `the ${plate.frameId} plate`);

  const directory = join(options.outputDirectory, STAGED_PLATE_DIRECTORY);
  await mkdir(directory, { recursive: true });

  // --- the verified copy ----------------------------------------------------
  const sourceBytes = await readFile(plate.absolutePath);
  const sourceChecksum = createHash('sha256').update(sourceBytes).digest('hex');
  if (sourceChecksum !== plate.checksumSha256) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `${plate.fileName} changed between discovery and staging (${plate.checksumSha256.slice(0, 16)}… became ${sourceChecksum.slice(0, 16)}…). Nothing has been uploaded.`,
    );
  }

  const extension = plate.mimeType === 'image/png' ? '.png' : '.jpg';
  const stagedPath = join(directory, `${plate.frameId}-${sourceChecksum.slice(0, 16)}${extension}`);
  await writeFile(stagedPath, sourceBytes);

  const stagedChecksum = createHash('sha256')
    .update(await readFile(stagedPath))
    .digest('hex');
  if (stagedChecksum !== sourceChecksum) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `the staged copy of ${plate.fileName} does not hash to its source. Nothing has been uploaded.`,
    );
  }

  // --- the upload bytes ------------------------------------------------------
  const alreadyAtDelivery =
    plate.widthPx === LTX_SUPPORTED_WIDTH_PX && plate.heightPx === LTX_SUPPORTED_HEIGHT_PX;
  if (alreadyAtDelivery) {
    return {
      stagedPath,
      stagedChecksumSha256: stagedChecksum,
      uploadPath: stagedPath,
      uploadChecksumSha256: stagedChecksum,
      uploadMimeType: plate.mimeType,
      uploadWidthPx: plate.widthPx,
      uploadHeightPx: plate.heightPx,
      resample: {
        applied: false,
        method: 'none',
        horizontalScale: 1,
        verticalScale: 1,
        anisotropy: 0,
        createsNewDetail: false,
        note: 'The plate is already at delivery geometry and was uploaded unchanged.',
      },
    };
  }

  const horizontalScale = Number((LTX_SUPPORTED_WIDTH_PX / plate.widthPx).toFixed(6));
  const verticalScale = Number((LTX_SUPPORTED_HEIGHT_PX / plate.heightPx).toFixed(6));
  const anisotropy = Number(
    (Math.abs(horizontalScale - verticalScale) / Math.max(horizontalScale, verticalScale)).toFixed(
      6,
    ),
  );

  const uploadPath = join(directory, `${plate.frameId}-upload-1080x1920.png`);
  options.onProgress?.(
    `staging ${plate.frameId} for upload: ${plate.widthPx}x${plate.heightPx} resampled to ${LTX_SUPPORTED_WIDTH_PX}x${LTX_SUPPORTED_HEIGHT_PX} (lanczos, no new detail)`,
  );

  const result = await options.runner.run(
    options.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      stagedPath,
      '-vf',
      `scale=${LTX_SUPPORTED_WIDTH_PX}:${LTX_SUPPORTED_HEIGHT_PX}:flags=lanczos`,
      '-frames:v',
      '1',
      '-y',
      uploadPath,
    ],
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `${plate.fileName} could not be resampled to delivery geometry: ${result.stderr.trim().slice(-300)}`,
    );
  }

  const uploadBytes = await readFile(uploadPath);
  if (uploadBytes.byteLength === 0) {
    throw new StoryboardVideoError(
      'MISSING_FRAME',
      `the resampled upload image for ${plate.frameId} is empty. Nothing has been uploaded.`,
    );
  }

  return {
    stagedPath,
    stagedChecksumSha256: stagedChecksum,
    uploadPath,
    uploadChecksumSha256: createHash('sha256').update(uploadBytes).digest('hex'),
    uploadMimeType: 'image/png',
    uploadWidthPx: LTX_SUPPORTED_WIDTH_PX,
    uploadHeightPx: LTX_SUPPORTED_HEIGHT_PX,
    resample: {
      applied: true,
      method: 'ffmpeg scale, lanczos',
      horizontalScale,
      verticalScale,
      anisotropy,
      createsNewDetail: false,
      note: `The plate is ${plate.widthPx}x${plate.heightPx} and delivery is ${LTX_SUPPORTED_WIDTH_PX}x${LTX_SUPPORTED_HEIGHT_PX}. This is a deterministic resample: it moves pixels, it does not add information, and the generated clip is bounded by the detail the plate already had.`,
    },
  };
}
