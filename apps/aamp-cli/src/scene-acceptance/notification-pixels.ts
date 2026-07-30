import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import { StoryboardVideoError } from '../storyboard-video/failures';

/**
 * Reading actual pixels back, so the reports are measurements rather than
 * restatements of what the plan asked for.
 *
 * Everything downstream of here — where the card sits relative to the subject,
 * whether a state is a blank rectangle, whether the accent pulsed — is answered
 * from decoded frames. A report built from the timeline would agree with the
 * timeline whatever the compositor did, which is the failure mode that makes a
 * report worth less than no report.
 *
 * Frames come out as planar 8-bit grey or packed RGBA, whole, in one FFmpeg
 * invocation each. Bounded by construction: a caller states the geometry it
 * expects and a stream that does not divide into that many frames of that size
 * is a typed failure, not a short read three call frames later.
 */

export interface GrayFrames {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly frameCount: number;
  readonly bytes: Buffer;
}

export function grayLumaAt(frames: GrayFrames, frameIndex: number, x: number, y: number): number {
  const offset = frameIndex * frames.widthPx * frames.heightPx + y * frames.widthPx + x;
  return frames.bytes[offset] ?? 0;
}

/** Every frame of `clipPath` up to `durationSeconds`, as planar 8-bit grey. */
export async function readGrayFrames(options: {
  readonly clipPath: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly durationSeconds: number;
  readonly workingDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
}): Promise<GrayFrames> {
  await mkdir(options.workingDirectory, { recursive: true });
  const target = join(options.workingDirectory, 'placement-frames.gray');
  const result = await options.runner.run(
    options.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      options.clipPath,
      '-t',
      options.durationSeconds.toFixed(6),
      '-vf',
      `scale=${options.widthPx}:${options.heightPx}:flags=lanczos`,
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      '-y',
      target,
    ],
    { timeoutMs: 300_000 },
  );
  if (result.exitCode !== 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `the picture could not be decoded for measurement: ${result.stderr.trim().slice(-300)}`,
    );
  }

  const bytes = await readFile(target);
  await rm(target, { force: true });
  const frameBytes = options.widthPx * options.heightPx;
  if (bytes.byteLength === 0 || bytes.byteLength % frameBytes !== 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `the decoded picture is ${bytes.byteLength} bytes, which is not a whole number of ${options.widthPx}x${options.heightPx} frames`,
    );
  }
  return {
    widthPx: options.widthPx,
    heightPx: options.heightPx,
    frameCount: bytes.byteLength / frameBytes,
    bytes,
  };
}

export interface RgbFrames {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly frameCount: number;
  readonly bytes: Buffer;
}

/**
 * A cropped strip of every frame, in packed RGB.
 *
 * Cropped rather than whole because the only thing colour is needed for here is
 * the accent edge, and decoding a full-frame RGB sequence to read five rows of
 * it would cost two orders of magnitude more memory for the same answer.
 */
export async function readRgbFrames(options: {
  readonly clipPath: string;
  readonly cropRect: { xPx: number; yPx: number; widthPx: number; heightPx: number };
  readonly durationSeconds: number;
  readonly workingDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
}): Promise<RgbFrames> {
  await mkdir(options.workingDirectory, { recursive: true });
  const target = join(options.workingDirectory, 'accent-strip.rgb');
  const crop = options.cropRect;
  const result = await options.runner.run(
    options.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      options.clipPath,
      '-t',
      options.durationSeconds.toFixed(6),
      '-vf',
      // The conversion to RGB happens **before** the crop, deliberately.
      // `crop` on a chroma-subsampled format silently snaps to even dimensions,
      // so a five-pixel accent band comes back four pixels tall and the whole
      // stream is then the wrong length. Found the hard way; the size check
      // below is what caught it.
      `format=rgb24,crop=${crop.widthPx}:${crop.heightPx}:${crop.xPx}:${crop.yPx}`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-y',
      target,
    ],
    { timeoutMs: 300_000 },
  );
  if (result.exitCode !== 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `the accent strip could not be decoded for measurement: ${result.stderr.trim().slice(-300)}`,
    );
  }
  const bytes = await readFile(target);
  await rm(target, { force: true });
  const frameBytes = crop.widthPx * crop.heightPx * 3;
  if (bytes.byteLength === 0 || bytes.byteLength % frameBytes !== 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `the accent strip is ${bytes.byteLength} bytes, which is not a whole number of ${crop.widthPx}x${crop.heightPx} frames`,
    );
  }
  return {
    widthPx: crop.widthPx,
    heightPx: crop.heightPx,
    frameCount: bytes.byteLength / frameBytes,
    bytes,
  };
}

export interface RgbaImage {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly bytes: Buffer;
}

/** One still, as packed RGBA, so alpha and colour can both be read. */
export async function readRgbaImage(options: {
  readonly imagePath: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly workingDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly label: string;
}): Promise<RgbaImage> {
  await mkdir(options.workingDirectory, { recursive: true });
  const target = join(options.workingDirectory, `${options.label}.rgba`);
  const result = await options.runner.run(
    options.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      options.imagePath,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      '-y',
      target,
    ],
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `${options.label} could not be decoded for measurement: ${result.stderr.trim().slice(-300)}`,
    );
  }
  const bytes = await readFile(target);
  await rm(target, { force: true });
  const expected = options.widthPx * options.heightPx * 4;
  if (bytes.byteLength !== expected) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `${options.label} decoded to ${bytes.byteLength} bytes, not the ${expected} a ${options.widthPx}x${options.heightPx} RGBA image occupies`,
    );
  }
  return { widthPx: options.widthPx, heightPx: options.heightPx, bytes };
}

/** Rec.601 luma, which is what the black/freeze detectors elsewhere read. */
export function luma(red: number, green: number, blue: number): number {
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}
