import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import { grayLumaAt, readGrayFrames } from './notification-pixels';
import type { CardRect, DeliveryFrame } from './notification-timeline';

/**
 * Whether the notification sits in clean space, measured against the picture it
 * is placed over — every frame of it, not a sample.
 *
 * The specification is that the card sits between the subject's face and the
 * phone and covers neither, nor the eyes, nor the hair. The tempting way to
 * check that is to have somebody write down where the face and the phone are
 * and then compare rectangles. That check is only as true as the rectangles,
 * and nothing verifies them: a declared face box is a claim, and a claim
 * checked against itself always passes.
 *
 * So this measures the picture instead. Within the horizontal span the card
 * occupies, a row that contains any pixel at or above the subject-content
 * threshold is a row with lit subject in it — a face, hair, a hand, the phone's
 * rim, the rim light. Rows below the threshold carry nothing. The card must lie
 * inside one contiguous run of such rows, with clearance, on every frame. What
 * that establishes is exactly what the specification asks for and no more: not
 * "the card misses the declared face rectangle" but "there is no lit subject
 * detail anywhere the card can reach, at any point in the shot".
 *
 * It deliberately measures the **source** picture rather than the composited
 * one. The card is itself bright content, so measuring the output would find
 * the card and report it as the subject.
 *
 * What it cannot establish is that the clean run is *the gap between the face
 * and the phone* rather than some other empty part of the frame. That is a
 * person reading a picture, and the report says so rather than implying the
 * measurement covers it. The two nearest rows of subject content are recorded
 * above and below precisely so a reviewer can check that reading in numbers.
 */

export const PLACEMENT_PROFILE_VERSION = 1 as const;

/**
 * The luma at which a pixel is lit subject rather than unlit room.
 *
 * Calibrated against the authoritative Scene-1 plate: the clean torso band
 * measures a maximum of 19 across its whole width, the jaw and neck above it
 * reach 48–180, and the phone's top edge below reaches 51–96. Forty separates
 * them with room on both sides. Moving it is a profile-version bump, not an
 * edit: a run citing v1 describes this number.
 */
export const SUBJECT_CONTENT_LUMA_THRESHOLD = 40;

/** How much unlit room the card must keep on each side of itself. */
export const MINIMUM_CLEARANCE_PX = 20;

export interface FramePlacement {
  readonly frameIndex: number;
  readonly atSeconds: number;
  /** The contiguous run of rows carrying no subject content, in this frame. */
  readonly cleanBandTopPx: number;
  readonly cleanBandBottomPx: number;
  /** The nearest row of lit subject content above and below the card. */
  readonly nearestSubjectAbovePx: number | null;
  readonly nearestSubjectBelowPx: number | null;
  readonly clearanceAbovePx: number;
  readonly clearanceBelowPx: number;
  /** The brightest pixel anywhere the treatment can mark. */
  readonly maxLumaUnderTreatmentPx: number;
  readonly overlapsSubjectContent: boolean;
}

export interface PlacementReport {
  readonly profileVersion: typeof PLACEMENT_PROFILE_VERSION;
  readonly subjectContentLumaThreshold: number;
  readonly minimumClearancePx: number;
  readonly measuredAgainst: string;
  readonly frameCount: number;
  /** Everything the treatment can mark across every state, shadow included. */
  readonly treatmentOccupiedRect: CardRect;
  readonly restingCardRect: CardRect;
  readonly framesOverlappingSubjectContent: number;
  readonly worstClearanceAbovePx: number;
  readonly worstClearanceBelowPx: number;
  readonly maxLumaUnderTreatmentPx: number;
  readonly clearsSubjectContent: boolean;
  readonly frames: readonly FramePlacement[];
  readonly notMeasuredReason: string | null;
  readonly humanJudgementRequired: readonly string[];
  readonly notice: string;
}

export const PLACEMENT_NOTICE =
  'This is a measurement of the picture, not a judgement about it. It establishes that no lit subject detail falls anywhere the notification can mark, on any frame, within the horizontal span the notification occupies. It does not establish that the clean run it found is the gap between the face and the phone rather than some other empty region — that is a person reading the frames, and the nearest rows of subject content above and below are recorded so they can check it.';

export interface MeasureNotificationPlacementOptions {
  /** The picture the card is placed over, **before** it is composited. */
  readonly sourceClipPath: string;
  readonly frame: DeliveryFrame;
  readonly treatmentOccupiedRect: CardRect;
  readonly restingCardRect: CardRect;
  readonly durationSeconds: number;
  readonly frameRate: number;
  readonly workingDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

export async function measureNotificationPlacement(
  options: MeasureNotificationPlacementOptions,
): Promise<PlacementReport> {
  const rect = options.treatmentOccupiedRect;
  const empty = (notMeasuredReason: string): PlacementReport => ({
    profileVersion: PLACEMENT_PROFILE_VERSION,
    subjectContentLumaThreshold: SUBJECT_CONTENT_LUMA_THRESHOLD,
    minimumClearancePx: MINIMUM_CLEARANCE_PX,
    measuredAgainst: 'the source picture, before the notification was composited',
    frameCount: 0,
    treatmentOccupiedRect: rect,
    restingCardRect: options.restingCardRect,
    framesOverlappingSubjectContent: 0,
    worstClearanceAbovePx: 0,
    worstClearanceBelowPx: 0,
    maxLumaUnderTreatmentPx: 0,
    // Not measurable is never satisfied. The same rule the preview path holds.
    clearsSubjectContent: false,
    frames: [],
    notMeasuredReason,
    humanJudgementRequired: HUMAN_JUDGEMENT_ROWS,
    notice: PLACEMENT_NOTICE,
  });

  let frames;
  try {
    options.onProgress?.(
      `measuring notification placement against every frame of the first ${options.durationSeconds.toFixed(3)}s`,
    );
    frames = await readGrayFrames({
      clipPath: options.sourceClipPath,
      widthPx: options.frame.widthPx,
      heightPx: options.frame.heightPx,
      durationSeconds: options.durationSeconds,
      workingDirectory: options.workingDirectory,
      runner: options.runner,
      binaries: options.binaries,
    });
  } catch (error) {
    return empty(error instanceof Error ? error.message : String(error));
  }

  const left = Math.max(0, rect.xPx);
  const right = Math.min(options.frame.widthPx, rect.xPx + rect.widthPx);
  const top = Math.max(0, rect.yPx);
  const bottom = Math.min(options.frame.heightPx, rect.yPx + rect.heightPx);

  const measured: FramePlacement[] = [];
  for (let index = 0; index < frames.frameCount; index += 1) {
    // The brightest pixel in each row, across the card's own horizontal span.
    const rowMaxima = new Array<number>(options.frame.heightPx).fill(0);
    for (let y = 0; y < options.frame.heightPx; y += 1) {
      let max = 0;
      for (let x = left; x < right; x += 1) {
        const value = grayLumaAt(frames, index, x, y);
        if (value > max) max = value;
      }
      rowMaxima[y] = max;
    }

    const isClean = (y: number): boolean => (rowMaxima[y] ?? 255) < SUBJECT_CONTENT_LUMA_THRESHOLD;

    // The run containing the card's own centre. If that row is not clean the
    // card is already over subject content and there is no run to grow.
    const centre = Math.round((top + bottom) / 2);
    let bandTop = centre;
    let bandBottom = centre;
    const centreIsClean = isClean(centre);
    if (centreIsClean) {
      while (bandTop > 0 && isClean(bandTop - 1)) bandTop -= 1;
      while (bandBottom < options.frame.heightPx - 1 && isClean(bandBottom + 1)) bandBottom += 1;
    }

    const nearestSubjectAbovePx = bandTop > 0 ? bandTop - 1 : null;
    const nearestSubjectBelowPx = bandBottom < options.frame.heightPx - 1 ? bandBottom + 1 : null;
    const clearanceAbovePx = centreIsClean ? top - bandTop : 0;
    const clearanceBelowPx = centreIsClean ? bandBottom - (bottom - 1) : 0;

    let maxLumaUnderTreatmentPx = 0;
    for (let y = top; y < bottom; y += 1) {
      const value = rowMaxima[y] ?? 0;
      if (value > maxLumaUnderTreatmentPx) maxLumaUnderTreatmentPx = value;
    }

    measured.push({
      frameIndex: index,
      atSeconds: Number((index / options.frameRate).toFixed(6)),
      cleanBandTopPx: bandTop,
      cleanBandBottomPx: bandBottom,
      nearestSubjectAbovePx,
      nearestSubjectBelowPx,
      clearanceAbovePx,
      clearanceBelowPx,
      maxLumaUnderTreatmentPx,
      overlapsSubjectContent:
        !centreIsClean || maxLumaUnderTreatmentPx >= SUBJECT_CONTENT_LUMA_THRESHOLD,
    });
  }

  const framesOverlappingSubjectContent = measured.filter(
    (row) => row.overlapsSubjectContent,
  ).length;
  const worstClearanceAbovePx = Math.min(...measured.map((row) => row.clearanceAbovePx));
  const worstClearanceBelowPx = Math.min(...measured.map((row) => row.clearanceBelowPx));
  const maxLumaUnderTreatmentPx = Math.max(...measured.map((row) => row.maxLumaUnderTreatmentPx));

  return {
    profileVersion: PLACEMENT_PROFILE_VERSION,
    subjectContentLumaThreshold: SUBJECT_CONTENT_LUMA_THRESHOLD,
    minimumClearancePx: MINIMUM_CLEARANCE_PX,
    measuredAgainst: 'the source picture, before the notification was composited',
    frameCount: measured.length,
    treatmentOccupiedRect: rect,
    restingCardRect: options.restingCardRect,
    framesOverlappingSubjectContent,
    worstClearanceAbovePx,
    worstClearanceBelowPx,
    maxLumaUnderTreatmentPx,
    clearsSubjectContent:
      framesOverlappingSubjectContent === 0 &&
      worstClearanceAbovePx >= MINIMUM_CLEARANCE_PX &&
      worstClearanceBelowPx >= MINIMUM_CLEARANCE_PX,
    frames: measured,
    notMeasuredReason: null,
    humanJudgementRequired: HUMAN_JUDGEMENT_ROWS,
    notice: PLACEMENT_NOTICE,
  };
}

const HUMAN_JUDGEMENT_ROWS: readonly string[] = [
  'that the clean run the measurement found is the space between the face and the phone, and not some other empty region of the frame',
  'that the card reads as sitting in that space rather than floating in front of the subject',
  'that nothing the measurement calls unlit room is in fact dark clothing a viewer reads as the subject',
];
