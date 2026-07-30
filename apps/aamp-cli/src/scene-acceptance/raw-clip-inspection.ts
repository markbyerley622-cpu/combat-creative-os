import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import { StoryboardVideoError } from '../storyboard-video/failures';
import {
  measureKeyframeAgreement,
  measureMotionEnergy,
  KEYFRAME_LAYOUT_AGREEMENT_FLOOR,
} from '../storyboard-video/motion-inspection';

/**
 * What the raw generated clip is, measured across its whole length.
 *
 * The existing `inspectSceneMotion` already measures the clip against the
 * window the locked cut would take from it — geometry, codec, black, freeze,
 * decode errors, motion energy, first-frame agreement. That runs unchanged.
 * This adds the two things a Scene-1 acceptance needs that a production
 * inspection does not:
 *
 * - **The whole clip, not just the edit window.** The run bought six seconds
 *   and a person is deciding whether those six seconds are usable, so the
 *   motion reading and the frame sampling cover all of it.
 * - **A contact sheet.** Six evenly spaced frames in one image is what a
 *   reviewer actually scans for a deformed hand, a bent phone or a face that
 *   changed halfway through. Individual PNGs make that a click each.
 *
 * Nothing here scores creative quality, and nothing here decides whether the
 * clip is acceptable. It measures, and it says what it could not measure.
 */

export const CONTACT_SHEET_FRAME_COUNT = 6;
export const CONTACT_SHEET_COLUMNS = 3;
export const CONTACT_SHEET_TILE_WIDTH_PX = 360;

export interface SampledFrame {
  readonly index: number;
  readonly atSeconds: number;
  readonly fileName: string;
}

export interface RawClipSurvey {
  readonly framesDirectory: string;
  readonly frames: readonly SampledFrame[];
  readonly contactSheetFileName: string;
  readonly wholeClipMotionEnergy: number | null;
  readonly wholeClipMotionNotMeasuredReason: string | null;
  readonly firstFrameAgreement: number | null;
  readonly firstFrameAgreementFloor: number;
  readonly firstFrameAgreementNotMeasuredReason: string | null;
}

export interface SurveyRawClipOptions {
  readonly clipPath: string;
  readonly platePath: string;
  readonly durationSeconds: number;
  readonly inspectionDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

export async function surveyRawClip(options: SurveyRawClipOptions): Promise<RawClipSurvey> {
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      'the raw clip reports no usable duration, so it cannot be sampled',
    );
  }
  await mkdir(options.inspectionDirectory, { recursive: true });
  options.onProgress?.(
    `sampling ${CONTACT_SHEET_FRAME_COUNT} evenly spaced frames across ${options.durationSeconds.toFixed(3)}s`,
  );

  // Evenly spaced across the clip, biased inside its ends: a sample taken
  // exactly at the final timestamp lands past the last decodable frame often
  // enough that it is not worth the ambiguity.
  const frames: SampledFrame[] = [];
  for (let index = 0; index < CONTACT_SHEET_FRAME_COUNT; index += 1) {
    const atSeconds = Number(
      ((options.durationSeconds * (index + 0.5)) / CONTACT_SHEET_FRAME_COUNT).toFixed(3),
    );
    const fileName = `raw-frame-${String(index + 1).padStart(2, '0')}.png`;
    // eslint-disable-next-line no-await-in-loop -- ordered so the sheet is stable
    const result = await options.runner.run(
      options.binaries.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        options.clipPath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${CONTACT_SHEET_TILE_WIDTH_PX}:-2:flags=lanczos`,
        '-y',
        join(options.inspectionDirectory, fileName),
      ],
      { timeoutMs: 120_000 },
    );
    if (result.exitCode !== 0) {
      throw new StoryboardVideoError(
        'INVALID_GENERATED_MEDIA',
        `a frame at ${atSeconds.toFixed(3)}s could not be extracted from the raw clip: ${result.stderr
          .trim()
          .slice(-300)}`,
      );
    }
    frames.push({ index: index + 1, atSeconds, fileName });
  }

  const contactSheetFileName = 'raw-contact-sheet.png';
  const sheet = await options.runner.run(
    options.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      join(options.inspectionDirectory, 'raw-frame-%02d.png'),
      '-vf',
      `tile=${CONTACT_SHEET_COLUMNS}x${Math.ceil(CONTACT_SHEET_FRAME_COUNT / CONTACT_SHEET_COLUMNS)}:margin=8:padding=8:color=black`,
      '-frames:v',
      '1',
      '-y',
      join(options.inspectionDirectory, contactSheetFileName),
    ],
    { timeoutMs: 120_000 },
  );
  if (sheet.exitCode !== 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `the contact sheet could not be built: ${sheet.stderr.trim().slice(-300)}`,
    );
  }

  // --- the two measurements, over the whole clip -----------------------------
  let wholeClipMotionEnergy: number | null = null;
  let wholeClipMotionNotMeasuredReason: string | null = null;
  try {
    wholeClipMotionEnergy = await measureMotionEnergy(
      options.runner,
      options.binaries,
      options.clipPath,
      options.durationSeconds,
    );
  } catch (error) {
    wholeClipMotionNotMeasuredReason = error instanceof Error ? error.message : String(error);
  }

  let firstFrameAgreement: number | null = null;
  let firstFrameAgreementNotMeasuredReason: string | null = null;
  try {
    firstFrameAgreement = await measureKeyframeAgreement({
      runner: options.runner,
      binaries: options.binaries,
      clipPath: options.clipPath,
      keyframePath: options.platePath,
      workingDirectory: options.inspectionDirectory,
      label: 'scene-01-acceptance',
    });
  } catch (error) {
    firstFrameAgreementNotMeasuredReason = error instanceof Error ? error.message : String(error);
  }

  return {
    framesDirectory: options.inspectionDirectory,
    frames,
    contactSheetFileName,
    wholeClipMotionEnergy,
    wholeClipMotionNotMeasuredReason,
    firstFrameAgreement,
    firstFrameAgreementFloor: KEYFRAME_LAYOUT_AGREEMENT_FLOOR,
    firstFrameAgreementNotMeasuredReason,
  };
}
