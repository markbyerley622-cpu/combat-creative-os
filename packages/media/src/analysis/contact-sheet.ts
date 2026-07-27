import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_FFMPEG_BINARIES } from '../binaries';
import type { CommandRunner } from '../command-runner';

/**
 * Still frames pulled from source clips, and the tiled sheet of them.
 *
 * This is the *preview* half of the pipeline: a reviewer approving a cut
 * before it is rendered needs to see what each beat will actually look like,
 * and a JSON storyboard listing timecodes does not answer "is that the right
 * shot?". A contact sheet does.
 *
 * The frames come from the same in-points the render will use, so the sheet
 * shows the cut that is about to be made rather than a representative sample
 * of the library. Everything is deterministic: fixed times, fixed geometry,
 * no clock.
 */

export class ContactSheetError extends Error {
  constructor(detail: string) {
    super(`Could not build the contact sheet: ${detail}`);
    this.name = 'ContactSheetError';
  }
}

export interface StoryboardFrameRequest {
  /** Stable identifier; becomes the extracted file's name. */
  readonly id: string;
  readonly sourcePath: string;
  /** Where in the source to take the frame — the beat's own in-point. */
  readonly atSeconds: number;
  /** Stills have no timeline, so a still's frame is taken at 0 regardless. */
  readonly isStill: boolean;
}

export interface ExtractedFrame {
  readonly id: string;
  /** Relative to the directory the frames were written into. */
  readonly fileName: string;
  readonly atSeconds: number;
}

export interface BuildContactSheetOptions {
  readonly ffmpegPath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Width of each tile. Height follows 9:16. */
  readonly tileWidthPx?: number;
  readonly columns?: number;
}

const DEFAULT_TILE_WIDTH_PX = 216;
const DEFAULT_COLUMNS = 5;
const DEFAULT_TIMEOUT_MS = 60_000;
export const CONTACT_SHEET_FILENAME = 'contact-sheet.png';
export const STORYBOARD_FRAME_DIRECTORY = 'storyboard-frames';

function tileHeightFor(widthPx: number): number {
  // 9:16, rounded to an even number so every encoder accepts it.
  return Math.round((widthPx * 16) / 9 / 2) * 2;
}

/**
 * Extracts one frame per beat.
 *
 * Each extraction is its own invocation with `-ss` before `-i`, which seeks
 * rather than decoding from the start — the difference between a sheet that
 * builds in a second and one that decodes every clip end to end.
 */
export async function extractStoryboardFrames(
  runner: CommandRunner,
  requests: readonly StoryboardFrameRequest[],
  outputDirectory: string,
  options: BuildContactSheetOptions = {},
): Promise<readonly ExtractedFrame[]> {
  await mkdir(outputDirectory, { recursive: true });
  const tileWidth = options.tileWidthPx ?? DEFAULT_TILE_WIDTH_PX;
  const tileHeight = tileHeightFor(tileWidth);
  const extracted: ExtractedFrame[] = [];

  for (const [index, request] of requests.entries()) {
    const fileName = `${String(index).padStart(2, '0')}-${sanitiseFrameId(request.id)}.png`;
    const atSeconds = request.isStill ? 0 : Math.max(0, request.atSeconds);
    const result = await runner.run(
      options.ffmpegPath ?? DEFAULT_FFMPEG_BINARIES.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        ...(atSeconds > 0 ? ['-ss', atSeconds.toFixed(3)] : []),
        '-i',
        request.sourcePath,
        '-frames:v',
        '1',
        '-vf',
        // The same COVER framing the render uses, so the tile is the frame the
        // viewer will see rather than the source's own aspect.
        `scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=increase,crop=${tileWidth}:${tileHeight}`,
        '-y',
        join(outputDirectory, fileName),
      ],
      {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (result.exitCode !== 0) {
      throw new ContactSheetError(
        `frame for "${request.id}" at ${atSeconds}s: ${result.stderr.trim() || `ffmpeg exited ${result.exitCode}`}`,
      );
    }
    extracted.push({ id: request.id, fileName, atSeconds });
  }

  return extracted;
}

/**
 * Tiles the extracted frames into one PNG.
 *
 * Built with FFmpeg's own `tile` filter over the extracted stills rather than
 * by compositing in-process: this package has exactly one image toolchain and
 * adding a second would be a dependency with no other purpose.
 */
export async function buildContactSheet(
  runner: CommandRunner,
  frames: readonly ExtractedFrame[],
  frameDirectory: string,
  outputPath: string,
  options: BuildContactSheetOptions = {},
): Promise<string> {
  if (frames.length === 0) {
    throw new ContactSheetError('no frames were extracted, so there is nothing to tile');
  }
  const columns = Math.min(options.columns ?? DEFAULT_COLUMNS, frames.length);
  const rows = Math.ceil(frames.length / columns);

  // A glob-free, deterministic input list: `concat` demuxer over the exact
  // files, in the exact order the beats run.
  const inputs = frames.flatMap((frame) => ['-i', join(frameDirectory, frame.fileName)]);
  const streams = frames.map((_, index) => `[${index}:v]`).join('');

  const result = await runner.run(
    options.ffmpegPath ?? DEFAULT_FFMPEG_BINARIES.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      ...inputs,
      '-filter_complex',
      `${streams}xstack=inputs=${frames.length}:layout=${stackLayout(frames.length, columns)}:fill=black[sheet]`,
      '-map',
      '[sheet]',
      '-frames:v',
      '1',
      '-y',
      outputPath,
    ],
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (result.exitCode !== 0) {
    throw new ContactSheetError(
      `tiling ${frames.length} frames into ${rows}×${columns}: ${result.stderr.trim() || `ffmpeg exited ${result.exitCode}`}`,
    );
  }
  return outputPath;
}

/**
 * `xstack`'s grid layout, as explicit per-input coordinates.
 *
 * `xstack` has no "columns" parameter — it takes the position of every input,
 * which is why this is arithmetic rather than a filter option. Written out in
 * terms of earlier inputs' widths and heights (`w0`, `h0`) so the layout holds
 * whatever tile size the caller chose.
 */
export function stackLayout(count: number, columns: number): string {
  const positions: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column === 0 ? '0' : Array.from({ length: column }, (_, i) => `w${i}`).join('+');
    const y = row === 0 ? '0' : Array.from({ length: row }, (_, i) => `h${i * columns}`).join('+');
    positions.push(`${x}_${y}`);
  }
  return positions.join('|');
}

/** Frame ids become filenames, so they are reduced to a safe alphabet. */
function sanitiseFrameId(id: string): string {
  const safe = id
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return safe.length > 0 ? safe : 'frame';
}
