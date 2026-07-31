import { num } from '../render/filter-primitives';

/**
 * Exposure, measured rather than eyeballed.
 *
 * The cut this replaces was rejected for being crushed: roughly 80–99% of
 * sampled pixels sat below luma 16, which is the level at which a phone screen
 * in a lit room shows nothing at all. "Looks dark" is not a finding anybody can
 * act on, so this module turns it into five numbers per scene and one refusal.
 *
 * What it deliberately does **not** do is score a picture. A grade that is
 * technically readable can still be the wrong grade, and no function here
 * produces a quality number — the reports carry the measurements beside the
 * things only a person can judge, in the same shape every other report in this
 * repository uses.
 */

export class ExposureMeasurementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExposureMeasurementError';
  }
}

/**
 * The level below which a pixel carries no readable detail on an ordinary
 * phone screen. 16 is the floor the rejection named, and it is also the
 * conventional broadcast black level, so it is not an arbitrary choice.
 */
export const CRUSHED_LUMA_LEVEL = 16;

/**
 * The level at or above which a pixel is unambiguously visible on an ordinary
 * phone screen in a lit room.
 *
 * The counterpart to the crushed level, and the one the gate is built on. A
 * fighter lit against a black set is *legitimately* 80% black inside any
 * rectangle drawn around him — that is the composition, not a fault — so a
 * median or a crushed-fraction threshold over that rectangle refuses good
 * material. What actually answers "can the subject be read" is whether a
 * substantial part of the region is carrying real light.
 */
export const READABLE_LUMA_LEVEL = 48;

export interface LumaHistogram {
  /** 256 counts, one per 8-bit level. */
  readonly counts: Readonly<Record<number, number>> | readonly number[];
  readonly sampleCount: number;
}

export interface ExposureMeasurement {
  readonly meanLuma: number;
  readonly medianLuma: number;
  readonly percentile90Luma: number;
  readonly percentBelowCrushedLevel: number;
  /** Subject-region visibility: how much of the region is unambiguously lit. */
  readonly percentAtOrAboveReadableLevel: number;
  readonly sampleCount: number;
}

function histogramAt(histogram: LumaHistogram, level: number): number {
  const counts = histogram.counts as readonly number[] & Record<number, number>;
  return counts[level] ?? 0;
}

export function measureExposure(histogram: LumaHistogram): ExposureMeasurement {
  if (histogram.sampleCount <= 0) {
    throw new ExposureMeasurementError(
      'an exposure measurement needs at least one sample; a measurement that could not be taken is ' +
        'never reported as a passing one',
    );
  }
  let total = 0;
  let crushed = 0;
  let readable = 0;
  let median = 0;
  let percentile90 = 0;
  let cumulative = 0;
  const medianTarget = histogram.sampleCount / 2;
  const percentileTarget = histogram.sampleCount * 0.9;
  let medianFound = false;
  let percentileFound = false;

  for (let level = 0; level < 256; level += 1) {
    const count = histogramAt(histogram, level);
    total += level * count;
    if (level < CRUSHED_LUMA_LEVEL) crushed += count;
    if (level >= READABLE_LUMA_LEVEL) readable += count;
    cumulative += count;
    if (!medianFound && cumulative >= medianTarget) {
      median = level;
      medianFound = true;
    }
    if (!percentileFound && cumulative >= percentileTarget) {
      percentile90 = level;
      percentileFound = true;
    }
  }

  return {
    meanLuma: Number((total / histogram.sampleCount).toFixed(3)),
    medianLuma: median,
    percentile90Luma: percentile90,
    percentBelowCrushedLevel: Number(((100 * crushed) / histogram.sampleCount).toFixed(3)),
    percentAtOrAboveReadableLevel: Number(((100 * readable) / histogram.sampleCount).toFixed(3)),
    sampleCount: histogram.sampleCount,
  };
}

/**
 * What a live-action scene has to clear before a reviewer is asked to look at
 * it.
 *
 * Two independent conditions, because they fail differently. A scene can have
 * a perfectly readable subject sitting in a frame that is 95% black — that is
 * a *composition*, and refusing it would refuse every shot on a dark set. What
 * cannot stand is a scene where the subject itself is below the readable
 * floor, which is why the subject region is measured separately and holds the
 * binding threshold.
 */
export interface ExposureRequirement {
  /** The subject region's 90th percentile must reach this: some highlight must exist. */
  readonly minSubjectPercentile90Luma: number;
  /** How much of the subject region must be unambiguously lit. */
  readonly minSubjectReadablePercent: number;
}

/**
 * Calibrated against the material, not chosen for roundness.
 *
 * The first version of this gate held the subject region to a median floor and
 * a crushed-fraction ceiling, and it refused the combat-breadth scene outright
 * — correctly by its own arithmetic and wrongly about the picture. A fighter
 * lit against a black set has a median of 0 inside any rectangle around him,
 * because most of that rectangle is the set. The median was measuring the
 * background and reporting it as the subject.
 *
 * What replaced it says the thing directly: some part of the region must carry
 * real light (the 90th percentile), and enough of it must (the readable
 * fraction). Both figures survive a black background, and both fail a scene
 * that is genuinely too dark to watch. Mean, median and the crushed fraction
 * are still measured and still reported — they are what a person reads to
 * understand *why* — they simply no longer decide.
 */
export const DEFAULT_EXPOSURE_REQUIREMENT: ExposureRequirement = {
  minSubjectPercentile90Luma: 90,
  minSubjectReadablePercent: 8,
};

/**
 * The profile a composited product-interface scene is held to.
 *
 * A different question, so a different threshold. A dark-themed interface on a
 * handset is *meant* to be mostly near-black — the type and the accents are the
 * light — so the live-action floors would refuse every correctly-composited
 * screen in the cut. What this profile detects is the thing that is actually a
 * defect: **an empty display**, which is a named rejection criterion and looks
 * exactly like an interface that failed to map.
 *
 * It is binding, not advisory. A handset with nothing on it passes every other
 * technical gate.
 *
 * The figures are what separates a mapped interface from an unmapped one on
 * this material, and nothing finer. A screen carrying the product measures a
 * 90th percentile of 17–35 and 3–14% readable; the black glass of an unmapped
 * plate measures a 90th percentile of 2–5 and essentially nothing readable.
 * This profile detects an **empty** display. It does not, and is not claimed
 * to, detect a dim one — that is a person's judgement about a picture.
 */
export const INTERFACE_EXPOSURE_REQUIREMENT: ExposureRequirement = {
  minSubjectPercentile90Luma: 14,
  minSubjectReadablePercent: 1.5,
};

export interface SceneExposureVerdict {
  readonly sceneNumber: number;
  readonly status: 'PASS' | 'FAIL' | 'NOT_MEASURED';
  readonly frame: ExposureMeasurement | null;
  readonly subject: ExposureMeasurement | null;
  readonly notMeasuredReason: string | null;
  readonly failures: readonly string[];
}

export function evaluateSceneExposure(input: {
  readonly sceneNumber: number;
  readonly frame: ExposureMeasurement | null;
  readonly subject: ExposureMeasurement | null;
  readonly notMeasuredReason?: string | null;
  readonly requirement?: ExposureRequirement;
}): SceneExposureVerdict {
  const requirement = input.requirement ?? DEFAULT_EXPOSURE_REQUIREMENT;
  if (!input.frame || !input.subject) {
    return {
      sceneNumber: input.sceneNumber,
      status: 'NOT_MEASURED',
      frame: input.frame,
      subject: input.subject,
      notMeasuredReason:
        input.notMeasuredReason ??
        'the scene could not be decoded, so no exposure measurement exists for it',
      failures: [],
    };
  }
  const failures: string[] = [];
  if (input.subject.percentile90Luma < requirement.minSubjectPercentile90Luma) {
    failures.push(
      `subject-region 90th-percentile luma is ${num(input.subject.percentile90Luma)}, below the ` +
        `${num(requirement.minSubjectPercentile90Luma)} floor — the shot carries no highlight at all`,
    );
  }
  if (input.subject.percentAtOrAboveReadableLevel < requirement.minSubjectReadablePercent - 1e-9) {
    failures.push(
      `only ${num(input.subject.percentAtOrAboveReadableLevel)}% of the subject region reaches luma ` +
        `${num(READABLE_LUMA_LEVEL)}, below the ${num(requirement.minSubjectReadablePercent)}% floor — ` +
        'there is not enough lit subject in this frame to read',
    );
  }
  return {
    sceneNumber: input.sceneNumber,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    frame: input.frame,
    subject: input.subject,
    notMeasuredReason: null,
    failures,
  };
}
