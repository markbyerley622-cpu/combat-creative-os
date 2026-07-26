import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_FFMPEG_BINARIES, DEFAULT_PROBE_TIMEOUT_MS } from '../binaries';
import type { CommandRunner } from '../command-runner';

/**
 * Pixel measurement for actual-media QA.
 *
 * Frames are extracted as raw RGB24 into the QA working directory and read
 * back as bytes, rather than piped through the command runner: the runner
 * decodes to UTF-8, which would corrupt binary, and raw video needs no image
 * decoder on this side. Everything downstream — blankness, CTA presence,
 * caption presence — is then arithmetic over real pixels from the produced
 * file, which is the whole point of measuring rather than asserting nominal
 * values.
 */

/** Sampled at 1/4 scale: enough for a 56 px caption to remain several pixels tall, cheap enough to sample freely. */
export const SAMPLE_WIDTH = 270;
export const SAMPLE_HEIGHT = 480;

export class FrameSamplingError extends Error {
  constructor(
    public readonly timeSeconds: number,
    detail: string,
  ) {
    super(`Could not sample a frame at ${timeSeconds}s: ${detail}`);
    this.name = 'FrameSamplingError';
  }
}

export interface SampledFrame {
  readonly timeSeconds: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** RGB24, row-major, 3 bytes per pixel. */
  readonly pixels: Buffer;
}

export interface SampleFrameOptions {
  readonly ffmpegPath?: string;
  readonly workDir: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly widthPx?: number;
  readonly heightPx?: number;
  /**
   * Crop, in output pixels, taken at native resolution instead of scaling
   * the whole frame. Text measurement needs this: a 4 px caption outline
   * disappears at quarter scale, and with it the only signal that separates
   * burned-in white type from bright footage.
   */
  readonly crop?: Region;
}

export async function sampleFrame(
  runner: CommandRunner,
  videoPath: string,
  timeSeconds: number,
  options: SampleFrameOptions,
): Promise<SampledFrame> {
  const crop = options.crop;
  const widthPx = crop ? crop.width : (options.widthPx ?? SAMPLE_WIDTH);
  const heightPx = crop ? crop.height : (options.heightPx ?? SAMPLE_HEIGHT);
  const label = crop
    ? `crop-${crop.x}-${crop.y}-${crop.width}-${crop.height}`
    : `full-${widthPx}x${heightPx}`;
  const outputName = `frame-${Math.round(timeSeconds * 1000)}-${label}.rgb`;
  const outputPath = join(options.workDir, outputName);

  const result = await runner.run(
    options.ffmpegPath ?? DEFAULT_FFMPEG_BINARIES.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-ss',
      timeSeconds.toFixed(3),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      crop
        ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`
        : `scale=${widthPx}:${heightPx}`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-y',
      outputPath,
    ],
    { timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, signal: options.signal },
  );

  if (result.exitCode !== 0) {
    throw new FrameSamplingError(
      timeSeconds,
      result.stderr.trim() || `ffmpeg exited ${result.exitCode}`,
    );
  }

  let pixels: Buffer;
  try {
    pixels = await readFile(outputPath);
  } catch {
    throw new FrameSamplingError(timeSeconds, 'ffmpeg wrote no frame');
  }
  await unlink(outputPath).catch(() => undefined);

  const expectedBytes = widthPx * heightPx * 3;
  if (pixels.length < expectedBytes) {
    throw new FrameSamplingError(
      timeSeconds,
      `expected ${expectedBytes} bytes of RGB24, got ${pixels.length}`,
    );
  }

  return { timeSeconds, widthPx, heightPx, pixels: pixels.subarray(0, expectedBytes) };
}

export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RegionStatistics {
  /** Mean Rec.709 luma, 0–255. */
  readonly meanLuma: number;
  readonly stdDevLuma: number;
  readonly meanR: number;
  readonly meanG: number;
  readonly meanB: number;
  /** Fraction of pixels brighter than 200 — how burned-in white text shows up. */
  readonly brightPixelFraction: number;
  readonly pixelCount: number;
}

export function wholeFrame(frame: SampledFrame): Region {
  return { x: 0, y: 0, width: frame.widthPx, height: frame.heightPx };
}

/** Converts a region expressed in output (1080×1920) pixels into sample coordinates. */
export function scaleRegion(
  region: Region,
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): Region {
  const sx = toWidth / fromWidth;
  const sy = toHeight / fromHeight;
  return {
    x: Math.max(0, Math.floor(region.x * sx)),
    y: Math.max(0, Math.floor(region.y * sy)),
    width: Math.max(1, Math.floor(region.width * sx)),
    height: Math.max(1, Math.floor(region.height * sy)),
  };
}

export function measureRegion(frame: SampledFrame, region: Region): RegionStatistics {
  const x0 = Math.max(0, Math.min(frame.widthPx - 1, region.x));
  const y0 = Math.max(0, Math.min(frame.heightPx - 1, region.y));
  const x1 = Math.max(x0 + 1, Math.min(frame.widthPx, region.x + region.width));
  const y1 = Math.max(y0 + 1, Math.min(frame.heightPx, region.y + region.height));

  let sumLuma = 0;
  let sumLumaSquared = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let bright = 0;
  let count = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * frame.widthPx + x) * 3;
      const r = frame.pixels[offset] ?? 0;
      const g = frame.pixels[offset + 1] ?? 0;
      const b = frame.pixels[offset + 2] ?? 0;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumLuma += luma;
      sumLumaSquared += luma * luma;
      sumR += r;
      sumG += g;
      sumB += b;
      if (luma > 200) bright += 1;
      count += 1;
    }
  }

  if (count === 0) {
    return {
      meanLuma: 0,
      stdDevLuma: 0,
      meanR: 0,
      meanG: 0,
      meanB: 0,
      brightPixelFraction: 0,
      pixelCount: 0,
    };
  }

  const meanLuma = sumLuma / count;
  const variance = Math.max(0, sumLumaSquared / count - meanLuma * meanLuma);

  return {
    meanLuma,
    stdDevLuma: Math.sqrt(variance),
    meanR: sumR / count,
    meanG: sumG / count,
    meanB: sumB / count,
    brightPixelFraction: bright / count,
    pixelCount: count,
  };
}

/**
 * The signature of burned-in typography, as distinct from bright picture
 * content: a near-white pixel with a near-black pixel within a couple of
 * pixels of it. That is exactly what an outlined caption produces and what
 * ordinary footage — even footage containing white areas — does not, because
 * a white region in a photograph is not bounded by pure black two pixels
 * away. Measured at native resolution; at quarter scale the outline is gone
 * and with it the whole signal.
 */
export function measureTextContrastScore(frame: SampledFrame, region: Region): number {
  const brightThreshold = 225;
  const darkThreshold = 70;
  const radius = 3;

  const x0 = Math.max(0, region.x);
  const y0 = Math.max(0, region.y);
  const x1 = Math.min(frame.widthPx, region.x + region.width);
  const y1 = Math.min(frame.heightPx, region.y + region.height);

  const lumaAt = (x: number, y: number): number => {
    const offset = (y * frame.widthPx + x) * 3;
    return (
      0.2126 * (frame.pixels[offset] ?? 0) +
      0.7152 * (frame.pixels[offset + 1] ?? 0) +
      0.0722 * (frame.pixels[offset + 2] ?? 0)
    );
  };

  let outlined = 0;
  let total = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      total += 1;
      if (lumaAt(x, y) < brightThreshold) continue;
      let hasDarkNeighbour = false;
      for (let dy = -radius; dy <= radius && !hasDarkNeighbour; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= frame.widthPx || ny >= frame.heightPx) continue;
          if (lumaAt(nx, ny) < darkThreshold) {
            hasDarkNeighbour = true;
            break;
          }
        }
      }
      if (hasDarkNeighbour) outlined += 1;
    }
  }

  return total === 0 ? 0 : outlined / total;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

/** Largest per-channel difference between a measured region and an expected colour. */
export function maxChannelDistance(
  stats: RegionStatistics,
  expected: { r: number; g: number; b: number },
): number {
  return Math.max(
    Math.abs(stats.meanR - expected.r),
    Math.abs(stats.meanG - expected.g),
    Math.abs(stats.meanB - expected.b),
  );
}
