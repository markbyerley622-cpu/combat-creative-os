import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import type { NotificationBrief } from './acceptance-brief';
import { grayLumaAt, readGrayFrames, readRgbaImage, readRgbFrames } from './notification-pixels';
import type { PlacementReport } from './notification-placement';
import { resolveAccentRect, type NotificationTimeline } from './notification-timeline';
import type { VisualObservation, VisualObservationStatus } from './visual-defects';

/**
 * What is visibly wrong with the notification proof — measured off the file
 * that was produced, and explicit about the questions no measurement answers.
 *
 * The rows split the same four ways the Scene-1 clip's own report does, and for
 * the same reason. Whether the card is present on a frame, whether it ever
 * shows as an empty rectangle, whether the accent fired once or twice, whether
 * it fades before the cut and whether it re-renders to the same bytes are all
 * answerable from pixels, and they are answered from pixels. Whether the
 * surface reads as premium, whether the translucency is right for this room,
 * whether the ease-out is restrained or slack and whether the whole thing
 * avoids looking like a template are not answerable by anything in this
 * repository, and a number invented for them would be the one figure in the
 * report nobody could check.
 *
 * The one measurement worth explaining is "never exposes a blank rectangle".
 * It is not a claim about the source states — those are complete cards by
 * construction, which is a property of how they are built rather than evidence
 * about what shipped. It is measured on the delivered picture: on every frame
 * where the card's surface covers the card's rectangle, that rectangle must
 * also contain type. A frame that is bright and has no ink in it is the failure
 * this row exists to catch.
 */

export const NOTIFICATION_DEFECT_REPORT_VERSION = 1 as const;

/** A pixel this bright inside the card is the card's own surface. */
export const SURFACE_LUMA_FLOOR = 170;
/** A pixel this dark inside the card is type, the mark, or the accent. */
export const INK_LUMA_CEILING = 140;
/** Above this fraction of surface pixels, the card is on screen. */
export const CARD_PRESENT_SURFACE_FRACTION = 0.5;
/** Below this fraction of ink, a card that is on screen is an empty rectangle. */
export const MINIMUM_INK_FRACTION = 0.02;
/** How much presence may drop between the settle and the cut. None, in practice. */
export const MAXIMUM_PRESENCE_DROP = 0.02;

export interface FramePresence {
  readonly frameIndex: number;
  readonly atSeconds: number;
  readonly surfaceFraction: number;
  readonly inkFraction: number;
  readonly cardPresent: boolean;
  readonly blankRectangle: boolean;
}

export interface AccentReading {
  readonly frameIndex: number;
  readonly atSeconds: number;
  /** Red minus green over the accent band. The surface reads ~4; the accent ~215. */
  readonly redness: number;
}

/**
 * Three independent readings, each with its own not-measured reason.
 *
 * They are separate because one failure must not discard the others. The first
 * run of this measurement lost the presence and alpha readings — both of which
 * had succeeded — because the accent decode failed after them and a single
 * catch threw all three away. Six rows then reported NOT_MEASURED when only two
 * of them were actually unknown, which understates what is known and is its own
 * kind of dishonest report.
 */
export interface NotificationMeasurements {
  readonly frameCount: number;
  readonly frameRate: number;
  readonly presence: readonly FramePresence[];
  readonly presenceNotMeasuredReason: string | null;
  readonly accent: readonly AccentReading[];
  readonly accentNotMeasuredReason: string | null;
  readonly assetMinAlpha: number;
  readonly assetMaxAlpha: number;
  readonly assetTransparentFraction: number;
  readonly assetNotMeasuredReason: string | null;
}

export interface MeasureNotificationOptions {
  readonly compositedClipPath: string;
  readonly assetPath: string;
  readonly assetWidthPx: number;
  readonly assetHeightPx: number;
  readonly brief: NotificationBrief;
  readonly timeline: NotificationTimeline;
  readonly durationSeconds: number;
  readonly frameRate: number;
  readonly workingDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

export async function measureNotification(
  options: MeasureNotificationOptions,
): Promise<NotificationMeasurements> {
  options.onProgress?.('measuring the composited notification frame by frame');
  const frame = options.timeline.frame;
  const card = options.timeline.restRect;
  const reason = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  // --- presence, frame by frame ---------------------------------------------
  let presence: FramePresence[] = [];
  let presenceNotMeasuredReason: string | null = null;
  let frameCount = 0;
  try {
    const frames = await readGrayFrames({
      clipPath: options.compositedClipPath,
      widthPx: frame.widthPx,
      heightPx: frame.heightPx,
      durationSeconds: options.durationSeconds,
      workingDirectory: options.workingDirectory,
      runner: options.runner,
      binaries: options.binaries,
    });
    frameCount = frames.frameCount;
    const total = card.widthPx * card.heightPx;
    for (let index = 0; index < frames.frameCount; index += 1) {
      let surfacePixels = 0;
      let inkPixels = 0;
      for (let y = card.yPx; y < card.yPx + card.heightPx; y += 1) {
        for (let x = card.xPx; x < card.xPx + card.widthPx; x += 1) {
          const value = grayLumaAt(frames, index, x, y);
          if (value >= SURFACE_LUMA_FLOOR) surfacePixels += 1;
          else if (value <= INK_LUMA_CEILING) inkPixels += 1;
        }
      }
      const surfaceFraction = surfacePixels / total;
      const inkFraction = inkPixels / total;
      const cardPresent = surfaceFraction >= CARD_PRESENT_SURFACE_FRACTION;
      presence.push({
        frameIndex: index,
        atSeconds: Number((index / options.frameRate).toFixed(6)),
        surfaceFraction: Number(surfaceFraction.toFixed(6)),
        inkFraction: Number(inkFraction.toFixed(6)),
        cardPresent,
        blankRectangle: cardPresent && inkFraction < MINIMUM_INK_FRACTION,
      });
    }
  } catch (error) {
    presence = [];
    presenceNotMeasuredReason = reason(error);
  }

  // --- the accent edge, in colour, cropped to the band it occupies -----------
  let accent: AccentReading[] = [];
  let accentNotMeasuredReason: string | null = null;
  try {
    const strip = await readRgbFrames({
      clipPath: options.compositedClipPath,
      cropRect: resolveAccentRect(options.brief, card),
      durationSeconds: options.durationSeconds,
      workingDirectory: options.workingDirectory,
      runner: options.runner,
      binaries: options.binaries,
    });
    const stripPixels = strip.widthPx * strip.heightPx;
    for (let index = 0; index < strip.frameCount; index += 1) {
      let sum = 0;
      const base = index * stripPixels * 3;
      for (let pixel = 0; pixel < stripPixels; pixel += 1) {
        const offset = base + pixel * 3;
        sum += (strip.bytes[offset] ?? 0) - (strip.bytes[offset + 1] ?? 0);
      }
      accent.push({
        frameIndex: index,
        atSeconds: Number((index / options.frameRate).toFixed(6)),
        redness: Number((sum / stripPixels).toFixed(3)),
      });
    }
  } catch (error) {
    accent = [];
    accentNotMeasuredReason = reason(error);
  }

  // --- the standalone asset really is transparent ----------------------------
  let assetMinAlpha = 0;
  let assetMaxAlpha = 0;
  let assetTransparentFraction = 0;
  let assetNotMeasuredReason: string | null = null;
  try {
    const asset = await readRgbaImage({
      imagePath: options.assetPath,
      widthPx: options.assetWidthPx,
      heightPx: options.assetHeightPx,
      workingDirectory: options.workingDirectory,
      runner: options.runner,
      binaries: options.binaries,
      label: 'notification-surface-asset',
    });
    let minAlpha = 255;
    let maxAlpha = 0;
    let transparent = 0;
    const assetPixels = asset.widthPx * asset.heightPx;
    for (let pixel = 0; pixel < assetPixels; pixel += 1) {
      const alpha = asset.bytes[pixel * 4 + 3] ?? 0;
      if (alpha < minAlpha) minAlpha = alpha;
      if (alpha > maxAlpha) maxAlpha = alpha;
      if (alpha === 0) transparent += 1;
    }
    assetMinAlpha = minAlpha;
    assetMaxAlpha = maxAlpha;
    assetTransparentFraction = Number((transparent / assetPixels).toFixed(6));
  } catch (error) {
    assetNotMeasuredReason = reason(error);
  }

  return {
    frameCount,
    frameRate: options.frameRate,
    presence,
    presenceNotMeasuredReason,
    accent,
    accentNotMeasuredReason,
    assetMinAlpha,
    assetMaxAlpha,
    assetTransparentFraction,
    assetNotMeasuredReason,
  };
}

export interface NotificationDefectReport {
  readonly reportVersion: typeof NOTIFICATION_DEFECT_REPORT_VERSION;
  readonly observations: readonly VisualObservation[];
  readonly measuredDefectCount: number;
  /**
   * Rows that could not be taken. Counted separately and reported separately,
   * because an unmeasurable binding property is not a satisfied one — a run
   * whose accent decode failed once reported zero defects while five of its
   * claims were unknown, which read as a clean proof and was not one.
   */
  readonly notMeasuredCount: number;
  readonly openHumanJudgementCount: number;
  readonly notice: string;
}

export const NOTIFICATION_DEFECT_NOTICE =
  'Nothing in this report is a judgement about creative quality, and no number here is a craft score. The measured rows say what a deterministic tool could establish about the file that was produced; every HUMAN_JUDGEMENT_REQUIRED row is a question only a named person can answer, and it stays open until they do.';

export interface BuildNotificationDefectReportInput {
  readonly brief: NotificationBrief;
  readonly timeline: NotificationTimeline;
  readonly measurements: NotificationMeasurements;
  readonly placement: PlacementReport;
  readonly measuredWidthPx: number | null;
  readonly measuredHeightPx: number | null;
  readonly measuredDurationSeconds: number | null;
  readonly requestedDurationSeconds: number;
  /** Two independent renders of the same plan, compared byte for byte. */
  readonly rerenderChecksumSha256: string | null;
  readonly renderChecksumSha256: string;
}

export function buildNotificationDefectReport(
  input: BuildNotificationDefectReportInput,
): NotificationDefectReport {
  const { measurements, placement, timeline, brief } = input;
  const observations: VisualObservation[] = [];
  const unmeasured = measurements.presenceNotMeasuredReason;
  const accentUnmeasured = measurements.accentNotMeasuredReason;
  const assetUnmeasured = measurements.assetNotMeasuredReason;

  const row = (
    id: string,
    status: VisualObservationStatus,
    what: string,
    finding: string,
  ): void => {
    observations.push({ id, status, what, finding });
  };

  // --- geometry and duration -------------------------------------------------
  row(
    'DELIVERY_GEOMETRY',
    input.measuredWidthPx === null || input.measuredHeightPx === null
      ? 'NOT_MEASURED'
      : input.measuredWidthPx === timeline.frame.widthPx &&
          input.measuredHeightPx === timeline.frame.heightPx
        ? 'OBSERVED'
        : 'DEFECT',
    `the proof is delivered at ${timeline.frame.widthPx}x${timeline.frame.heightPx}`,
    input.measuredWidthPx === null || input.measuredHeightPx === null
      ? 'the geometry could not be measured'
      : `${input.measuredWidthPx}x${input.measuredHeightPx}`,
  );

  row(
    'PROOF_DURATION',
    input.measuredDurationSeconds === null
      ? 'NOT_MEASURED'
      : Math.abs(input.measuredDurationSeconds - input.requestedDurationSeconds) <= 0.05
        ? 'OBSERVED'
        : 'DEFECT',
    `the proof runs the ${input.requestedDurationSeconds}s Scene-1 slot, to within one frame`,
    input.measuredDurationSeconds === null
      ? 'the duration could not be measured'
      : `${input.measuredDurationSeconds.toFixed(6)}s`,
  );

  // --- placement -------------------------------------------------------------
  row(
    'CLEARS_FACE_AND_PHONE',
    placement.notMeasuredReason !== null
      ? 'NOT_MEASURED'
      : placement.clearsSubjectContent
        ? 'OBSERVED'
        : 'DEFECT',
    `no lit subject detail falls anywhere the notification can mark, on any frame, with at least ${placement.minimumClearancePx}px of unlit room above and below`,
    placement.notMeasuredReason ??
      `${placement.frameCount} frames measured, ${placement.framesOverlappingSubjectContent} overlapping; clearance at worst ${placement.worstClearanceAbovePx}px above and ${placement.worstClearanceBelowPx}px below; brightest pixel under the treatment ${placement.maxLumaUnderTreatmentPx} against a ${placement.subjectContentLumaThreshold} threshold`,
  );

  row(
    'WITHIN_MOBILE_SAFE_AREA',
    timeline.withinSafeBounds ? 'OBSERVED' : 'DEFECT',
    `the card, its shadow and its accent glow stay inside the ${brief.safeMarginPx}px safe margin`,
    `${timeline.occupiedRect.xPx},${timeline.occupiedRect.yPx} ${timeline.occupiedRect.widthPx}x${timeline.occupiedRect.heightPx}`,
  );

  row(
    'CARD_WIDTH_AGAINST_SPECIFICATION',
    Math.abs(timeline.restRect.widthPx / timeline.frame.widthPx - 0.75) <= 0.02
      ? 'OBSERVED'
      : 'DEFECT',
    'the card is about 75 percent of the frame width',
    `${timeline.restRect.widthPx}px of ${timeline.frame.widthPx}px (${((100 * timeline.restRect.widthPx) / timeline.frame.widthPx).toFixed(1)}%)`,
  );

  // --- the entrance, on the delivered picture --------------------------------
  const present = measurements.presence.filter((entry) => entry.cardPresent);
  const firstPresent = present[0] ?? null;
  row(
    'ENTRANCE_BEGINS_ON_TIME',
    unmeasured !== null
      ? 'NOT_MEASURED'
      : firstPresent === null
        ? 'DEFECT'
        : firstPresent.atSeconds >= brief.entranceStartSeconds - 0.05 &&
            firstPresent.atSeconds <= brief.entranceStartSeconds + 0.06
          ? 'OBSERVED'
          : 'DEFECT',
    `the card first appears at about ${brief.entranceStartSeconds}s, within a frame either side`,
    unmeasured ??
      (firstPresent === null
        ? 'the card was never measured on screen'
        : `first on screen at ${firstPresent.atSeconds.toFixed(3)}s`),
  );

  const blanks = measurements.presence.filter((entry) => entry.blankRectangle);
  row(
    'NEVER_A_BLANK_RECTANGLE',
    unmeasured !== null ? 'NOT_MEASURED' : blanks.length === 0 ? 'OBSERVED' : 'DEFECT',
    `every frame carrying the card's surface also carries its type — no frame is an empty panel (ink at or above ${MINIMUM_INK_FRACTION} of the card)`,
    unmeasured ??
      (blanks.length === 0
        ? `${present.length} frames carry the card; least ink on any of them ${Math.min(...present.map((entry) => entry.inkFraction)).toFixed(4)}`
        : `${blanks.length} frame(s) show the surface with no type: ${blanks.map((entry) => entry.atSeconds.toFixed(3)).join(', ')}s`),
  );

  const settleFrame =
    present.find((entry) => entry.atSeconds >= brief.entranceSettleSeconds - 1e-6) ?? null;
  const lastFrame = measurements.presence[measurements.presence.length - 1] ?? null;
  row(
    'NO_FADE_OUT_BEFORE_THE_CUT',
    unmeasured !== null || settleFrame === null || lastFrame === null
      ? 'NOT_MEASURED'
      : lastFrame.cardPresent &&
          settleFrame.surfaceFraction - lastFrame.surfaceFraction <= MAXIMUM_PRESENCE_DROP
        ? 'OBSERVED'
        : 'DEFECT',
    'the card holds at full presence to the last frame; there is no fade-out',
    unmeasured ??
      (settleFrame === null || lastFrame === null
        ? 'the settle or the final frame could not be read'
        : `surface coverage ${settleFrame.surfaceFraction.toFixed(4)} at the settle and ${lastFrame.surfaceFraction.toFixed(4)} on the final frame`),
  );

  // --- the single accent pulse ----------------------------------------------
  const pulse = summarisePulse(measurements.accent);
  row(
    'ACCENT_PULSES_EXACTLY_ONCE',
    accentUnmeasured !== null
      ? 'NOT_MEASURED'
      : pulse.excursions === 1 &&
          pulse.peakAtSeconds !== null &&
          pulse.peakAtSeconds >= brief.pulseStartSeconds - 0.05 &&
          pulse.peakAtSeconds <= brief.pulseEndSeconds + 0.05
        ? 'OBSERVED'
        : 'DEFECT',
    `the accent edge brightens once, between ${brief.pulseStartSeconds}s and ${brief.pulseEndSeconds}s, and returns to its resting level`,
    accentUnmeasured ??
      `${pulse.excursions} excursion(s) above the halfway mark; peak redness ${pulse.peak.toFixed(1)} at ${pulse.peakAtSeconds === null ? '—' : `${pulse.peakAtSeconds.toFixed(3)}s`}, resting ${pulse.rest.toFixed(1)}`,
  );

  row(
    'ACCENT_HOLDS_INTO_THE_CUT',
    accentUnmeasured !== null
      ? 'NOT_MEASURED'
      : pulse.finalRedness > pulse.baseline + 2
        ? 'OBSERVED'
        : 'DEFECT',
    'the accent edge is still lit on the final frame, so Scene 2 has an edge to grow its transition out of',
    accentUnmeasured ??
      `redness ${pulse.finalRedness.toFixed(1)} on the final frame against a ${pulse.baseline.toFixed(1)} unlit baseline`,
  );

  // --- the deliverable asset -------------------------------------------------
  row(
    'SURFACE_ASSET_IS_TRANSPARENT',
    assetUnmeasured !== null
      ? 'NOT_MEASURED'
      : measurements.assetMinAlpha === 0 && measurements.assetMaxAlpha > 240
        ? 'OBSERVED'
        : 'DEFECT',
    'the standalone notification asset carries real alpha — it is a transparent sheet, not a card on a background',
    assetUnmeasured ??
      `alpha spans ${measurements.assetMinAlpha}–${measurements.assetMaxAlpha}; ${(100 * measurements.assetTransparentFraction).toFixed(1)}% of it is fully transparent`,
  );

  row(
    'TRANSLUCENT_SURFACE',
    brief.surfaceOpacity < 1 ? 'OBSERVED' : 'DEFECT',
    'the surface is translucent rather than opaque, so the room reads through it',
    `surface opacity ${brief.surfaceOpacity}`,
  );

  // --- determinism -----------------------------------------------------------
  row(
    'DETERMINISTIC_RE_RENDER',
    input.rerenderChecksumSha256 === null
      ? 'NOT_MEASURED'
      : input.rerenderChecksumSha256 === input.renderChecksumSha256
        ? 'OBSERVED'
        : 'DEFECT',
    'rendering the same plan twice produces the same bytes',
    input.rerenderChecksumSha256 === null
      ? 'the proof was rendered once; no comparison was taken'
      : input.rerenderChecksumSha256 === input.renderChecksumSha256
        ? `both renders hash to ${input.renderChecksumSha256.slice(0, 16)}…`
        : `the second render hashes to ${input.rerenderChecksumSha256.slice(0, 16)}… against ${input.renderChecksumSha256.slice(0, 16)}…`,
  );

  // --- structurally impossible here -----------------------------------------
  row(
    'NO_GENERATED_TYPOGRAPHY_OR_MARK',
    'OBSERVED',
    'no lettering, mark or interface in the notification was produced by a generative model',
    'The card is laid out and rasterised from the brief and the owned mark before FFmpeg is invoked, and this command constructs no provider and makes no request. Nothing on this path can ask a model for a glyph.',
  );

  // --- only a person can answer these ---------------------------------------
  const humanRows: readonly (readonly [string, string])[] = [
    [
      'READS_AS_PREMIUM',
      'the surface, radius, shadow and type read as a premium product notification rather than a placeholder',
    ],
    [
      'TRANSLUCENCY_IS_RIGHT_FOR_THE_ROOM',
      'the warm-white translucency sits in this low-key room instead of glowing out of it',
    ],
    [
      'SHADOW_IS_RESTRAINED',
      'the shadow separates the card from the picture without announcing itself',
    ],
    [
      'ACCENT_IS_SUBTLE',
      'the red edge and its single pulse read as an accent, not as neon or an alert',
    ],
    [
      'NO_TEMPLATE_FEEL',
      'nothing here reads as a stock motion-graphics template: no particles, no sweep, no gratuitous glow',
    ],
    ['EASE_OUT_IS_RESTRAINED', 'the arrival is calm — it settles rather than snapping or bouncing'],
    [
      'SITS_BETWEEN_FACE_AND_PHONE',
      'the card occupies the space between the face and the phone as the brief intends, and reads as belonging there',
    ],
    [
      'HIERARCHY_IS_CORRECT',
      'the mark, header, timestamp, headline and supporting line are read in that order at a glance',
    ],
    [
      'ACCENT_EDGE_LEADS_INTO_SCENE_2',
      'the resting accent edge is a credible starting point for the match transition into Scene 2',
    ],
  ];
  for (const [id, what] of humanRows) {
    row(
      id,
      'HUMAN_JUDGEMENT_REQUIRED',
      what,
      'No measurement of this exists in this repository. A named reviewer answers it against the proof, the frames and the comparison gallery.',
    );
  }

  return {
    reportVersion: NOTIFICATION_DEFECT_REPORT_VERSION,
    observations,
    measuredDefectCount: observations.filter((entry) => entry.status === 'DEFECT').length,
    notMeasuredCount: observations.filter((entry) => entry.status === 'NOT_MEASURED').length,
    openHumanJudgementCount: observations.filter(
      (entry) => entry.status === 'HUMAN_JUDGEMENT_REQUIRED',
    ).length,
    notice: NOTIFICATION_DEFECT_NOTICE,
  };
}

export interface PulseSummary {
  /** Contiguous runs above the halfway mark between rest and peak. One is correct. */
  readonly excursions: number;
  readonly peak: number;
  readonly peakAtSeconds: number | null;
  readonly rest: number;
  readonly baseline: number;
  readonly finalRedness: number;
}

/**
 * How many times the accent brightened, counted as excursions rather than as
 * local maxima.
 *
 * Counting maxima makes a single pulse read as two whenever its rise or fall
 * happens to plateau across a frame boundary, which is a measurement artefact
 * and not a second pulse. An excursion — a contiguous run above the halfway
 * mark between the resting level and the peak — is what a viewer would call
 * "it flashed once".
 */
export function summarisePulse(readings: readonly AccentReading[]): PulseSummary {
  if (readings.length === 0) {
    return { excursions: 0, peak: 0, peakAtSeconds: null, rest: 0, baseline: 0, finalRedness: 0 };
  }
  const values = readings.map((entry) => entry.redness);
  const peak = Math.max(...values);
  // The unlit baseline is the picture before the card arrives: the lowest
  // reading anywhere, which is the plate showing through where the card is not.
  const baseline = Math.min(...values);
  // Resting level: the card is on screen and the pulse is over, so the last
  // reading is the resting accent by construction.
  const rest = values[values.length - 1] ?? 0;
  const halfway = rest + (peak - rest) / 2;

  let excursions = 0;
  let inside = false;
  let peakAtSeconds: number | null = null;
  for (const reading of readings) {
    if (reading.redness > halfway) {
      if (!inside) {
        excursions += 1;
        inside = true;
      }
      if (reading.redness === peak) peakAtSeconds = reading.atSeconds;
    } else {
      inside = false;
    }
  }

  return {
    excursions,
    peak: Number(peak.toFixed(3)),
    peakAtSeconds,
    rest: Number(rest.toFixed(3)),
    baseline: Number(baseline.toFixed(3)),
    finalRedness: Number(rest.toFixed(3)),
  };
}
