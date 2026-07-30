import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  buildScreenSamplePlan,
  verifyScreenCalibration,
  type SampledLuma,
  type ScreenCalibrationReport,
  type ScreenQuad,
} from '@combat/media';

import { ProductMotionError } from './product-motion-contracts';

const execFileAsync = promisify(execFile);

/**
 * Reading the plate's own pixels so a declared screen can be checked against
 * them.
 *
 * The whole plane is decoded to 8-bit luma once and indexed in memory rather
 * than invoking a probe per sample. Twenty-nine `ffprobe` calls per plate
 * would be twenty-nine process spawns, and — worse — twenty-nine chances for a
 * silently clamped coordinate to be read as a legitimate measurement.
 */
export interface PlateLumaPlane {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly luma: Uint8Array;
}

export async function readPlateLuma(options: {
  readonly ffmpegPath: string;
  readonly platePath: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly timeoutMs?: number;
}): Promise<PlateLumaPlane> {
  let stdout: Buffer;
  try {
    const result = await execFileAsync(
      options.ffmpegPath,
      ['-v', 'error', '-i', options.platePath, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
      {
        encoding: 'buffer',
        maxBuffer: 1 << 28,
        timeout: options.timeoutMs ?? 60_000,
      },
    );
    stdout = result.stdout;
  } catch (error) {
    throw new ProductMotionError(
      'ASSET_NOT_FOUND',
      `could not decode plate ${options.platePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const expected = options.widthPx * options.heightPx;
  if (stdout.length < expected) {
    throw new ProductMotionError(
      'ASSET_NOT_FOUND',
      `plate ${options.platePath} decoded to ${stdout.length} luma samples but the plan declares ` +
        `${options.widthPx}×${options.heightPx} (${expected}). The declared size is wrong, or the file is not the plate.`,
    );
  }

  return {
    widthPx: options.widthPx,
    heightPx: options.heightPx,
    luma: new Uint8Array(stdout.buffer, stdout.byteOffset, expected),
  };
}

/**
 * Bilinear read, clamped at the edges.
 *
 * Clamping is safe here only because the containment check runs against the
 * declared corners, not against these samples — a rim point a few pixels off
 * the plate is a legitimate measurement of the plate edge, while a *corner*
 * off the plate is a broken calibration and is refused separately.
 */
function sampleLuma(plane: PlateLumaPlane, xPx: number, yPx: number): number {
  const x = Math.min(plane.widthPx - 1, Math.max(0, xPx));
  const y = Math.min(plane.heightPx - 1, Math.max(0, yPx));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(plane.widthPx - 1, x0 + 1);
  const y1 = Math.min(plane.heightPx - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number): number => plane.luma[py * plane.widthPx + px] ?? 0;
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

export interface CalibratedScreen {
  readonly plateId: string;
  readonly report: ScreenCalibrationReport;
  readonly samples: readonly SampledLuma[];
}

export function calibrateScreen(options: {
  readonly plateId: string;
  readonly quad: ScreenQuad;
  readonly plane: PlateLumaPlane;
}): CalibratedScreen {
  const plan = buildScreenSamplePlan(options.quad);
  const samples: SampledLuma[] = plan.map((point) => ({
    label: point.label,
    zone: point.zone,
    xPx: point.xPx,
    yPx: point.yPx,
    luma: sampleLuma(options.plane, point.xPx, point.yPx),
  }));

  const report = verifyScreenCalibration({
    screenLabel: options.plateId,
    quad: options.quad,
    plateWidthPx: options.plane.widthPx,
    plateHeightPx: options.plane.heightPx,
    samples,
  });

  return { plateId: options.plateId, report, samples };
}
