import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  DEFAULT_EXPOSURE_REQUIREMENT,
  evaluateSceneExposure,
  INTERFACE_EXPOSURE_REQUIREMENT,
  measureExposure,
  type ExposureMeasurement,
  type ExposureRequirement,
  type SceneExposureVerdict,
} from '@combat/media';

import { ProductStoryError, type StoryRect } from './story-contracts';

const execFileAsync = promisify(execFile);

/**
 * Measuring what a scene's exposure actually is.
 *
 * The rejected cut was crushed — roughly 80–99% of sampled pixels below luma
 * 16 — and "it looks dark" is not a finding anyone can act on. Every scene is
 * sampled at its **opening, midpoint and ending**, twice: once over the whole
 * frame, and once over the region the subject occupies. The two are reported
 * separately because they mean different things. A shot on a dark set is
 * legitimately mostly black; a shot whose *subject* is mostly black is a shot
 * nobody can watch on a phone.
 *
 * Frames are decoded straight to 8-bit luma and histogrammed here rather than
 * asked of a filter, so the figures are taken from the pixels that will be
 * delivered rather than from something a filter reported about them.
 */

export interface SampledScene {
  readonly sceneNumber: number;
  readonly clipPath: string;
  readonly durationSeconds: number;
  /**
   * The scene's own window inside the clip: where its beat starts and how long
   * it runs, handles excluded.
   *
   * Sampled rather than the whole clip on purpose. The head and tail handles
   * are transition material the cut blends *through* — nobody watches them as
   * this scene — and measuring them reports the incoming shot's exposure as
   * this one's. It found a real false failure: the combat-breadth scene's tail
   * handle runs into the stock clip's own fade, so the ending sample measured a
   * frame the finished cut never shows on its own.
   */
  readonly windowStartSeconds: number;
  readonly windowDurationSeconds: number;
  readonly subjectRegion: StoryRect;
  /** Which profile this scene is judged against, and it is stated per scene. */
  readonly profile: 'LIVE_ACTION' | 'PRODUCT_INTERFACE';
}

export interface SceneExposureSample {
  readonly label: 'OPENING' | 'MIDPOINT' | 'ENDING';
  readonly atSeconds: number;
  readonly frame: ExposureMeasurement | null;
  readonly subject: ExposureMeasurement | null;
  readonly notMeasuredReason: string | null;
}

export interface SceneExposureRecord {
  readonly sceneNumber: number;
  readonly profile: SampledScene['profile'];
  readonly requirement: ExposureRequirement;
  readonly samples: readonly SceneExposureSample[];
  /** The worst of the three, which is what the verdict is taken on. */
  readonly verdict: SceneExposureVerdict;
}

async function decodeGrayFrame(input: {
  readonly ffmpegPath: string;
  readonly clipPath: string;
  readonly atSeconds: number;
  readonly crop: StoryRect | null;
}): Promise<{ widthPx: number; heightPx: number; luma: Uint8Array } | null> {
  const filters = [
    ...(input.crop
      ? [`crop=${input.crop.widthPx}:${input.crop.heightPx}:${input.crop.xPx}:${input.crop.yPx}`]
      : []),
    'format=gray',
  ].join(',');
  try {
    const { stdout } = await execFileAsync(
      input.ffmpegPath,
      [
        '-v',
        'error',
        '-ss',
        input.atSeconds.toFixed(6),
        '-i',
        input.clipPath,
        '-vf',
        filters,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-',
      ],
      { encoding: 'buffer', maxBuffer: 1 << 28, timeout: 120_000 },
    );
    if (stdout.length === 0) return null;
    return {
      widthPx: input.crop?.widthPx ?? 0,
      heightPx: input.crop?.heightPx ?? 0,
      luma: new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length),
    };
  } catch {
    return null;
  }
}

function histogram(luma: Uint8Array): { counts: number[]; sampleCount: number } {
  const counts = new Array<number>(256).fill(0);
  for (let index = 0; index < luma.length; index += 1) {
    const level = luma[index] ?? 0;
    counts[level] = (counts[level] ?? 0) + 1;
  }
  return { counts, sampleCount: luma.length };
}

async function measureAt(
  ffmpegPath: string,
  scene: SampledScene,
  label: SceneExposureSample['label'],
  atSeconds: number,
): Promise<SceneExposureSample> {
  const [full, subject] = await Promise.all([
    decodeGrayFrame({ ffmpegPath, clipPath: scene.clipPath, atSeconds, crop: null }),
    decodeGrayFrame({
      ffmpegPath,
      clipPath: scene.clipPath,
      atSeconds,
      crop: scene.subjectRegion,
    }),
  ]);
  if (!full || !subject) {
    return {
      label,
      atSeconds: Number(atSeconds.toFixed(6)),
      frame: null,
      subject: null,
      notMeasuredReason: `the frame at ${atSeconds.toFixed(3)}s could not be decoded`,
    };
  }
  return {
    label,
    atSeconds: Number(atSeconds.toFixed(6)),
    frame: measureExposure(histogram(full.luma)),
    subject: measureExposure(histogram(subject.luma)),
    notMeasuredReason: null,
  };
}

/**
 * Three samples per scene, and the verdict taken on the worst of them.
 *
 * The worst rather than the mean, because a scene whose ending is unreadable
 * is an unreadable scene: averaging it against a bright opening would report a
 * defect as an acceptable middle.
 */
export async function measureSceneExposure(input: {
  readonly ffmpegPath: string;
  readonly scenes: readonly SampledScene[];
  readonly onProgress?: (message: string) => void;
}): Promise<readonly SceneExposureRecord[]> {
  const records: SceneExposureRecord[] = [];
  for (const scene of input.scenes) {
    // A hair inside each end of the beat's own window: seeking to exactly a
    // frame boundary lands past it on some containers and returns nothing,
    // which would be recorded as an unmeasurable scene rather than as the seek
    // it is.
    const start = scene.windowStartSeconds;
    const end = Math.min(
      scene.durationSeconds,
      scene.windowStartSeconds + scene.windowDurationSeconds,
    );
    // eslint-disable-next-line no-await-in-loop -- scenes measure in order so progress is legible
    const samples = await Promise.all([
      measureAt(input.ffmpegPath, scene, 'OPENING', start + 0.02),
      measureAt(input.ffmpegPath, scene, 'MIDPOINT', (start + end) / 2),
      measureAt(input.ffmpegPath, scene, 'ENDING', Math.max(start, end - 0.04)),
    ]);

    const measured = samples.filter((sample) => sample.frame && sample.subject);
    // The dimmest of the three by subject visibility, because a scene whose
    // ending is unreadable is an unreadable scene. Averaging would report a
    // defect as an acceptable middle.
    const worst = measured.reduce<SceneExposureSample | null>((worstSoFar, candidate) => {
      if (!worstSoFar) return candidate;
      return (candidate.subject?.percentAtOrAboveReadableLevel ?? 100) <
        (worstSoFar.subject?.percentAtOrAboveReadableLevel ?? 100)
        ? candidate
        : worstSoFar;
    }, null);

    const requirement =
      scene.profile === 'PRODUCT_INTERFACE'
        ? INTERFACE_EXPOSURE_REQUIREMENT
        : DEFAULT_EXPOSURE_REQUIREMENT;
    records.push({
      sceneNumber: scene.sceneNumber,
      profile: scene.profile,
      requirement,
      samples,
      verdict: evaluateSceneExposure({
        sceneNumber: scene.sceneNumber,
        requirement,
        frame: worst?.frame ?? null,
        subject: worst?.subject ?? null,
        notMeasuredReason:
          worst === null
            ? 'none of the three sampled frames could be decoded, so this scene has no exposure measurement'
            : null,
      }),
    });
    input.onProgress?.(
      `scene ${scene.sceneNumber}: exposure ${records[records.length - 1]?.verdict.status}` +
        (worst?.subject
          ? ` — subject median ${worst.subject.medianLuma}, p90 ${worst.subject.percentile90Luma}, ` +
            `${worst.subject.percentAtOrAboveReadableLevel}% readable, ${worst.subject.percentBelowCrushedLevel}% below luma 16`
          : ''),
    );
  }
  return records;
}

/**
 * Refuses any scene a viewer could not read, each against its own profile.
 *
 * Two profiles, because they detect different defects. A live-action scene
 * fails when the subject is lost in the shadows; a product-interface scene
 * fails when the handset is showing nothing — an empty display, which is a
 * named rejection criterion and is exactly what an interface that failed to map
 * looks like. Both are binding, and an unmeasurable scene is never a passing
 * one.
 */
export function assertSceneExposureReadable(records: readonly SceneExposureRecord[]): void {
  const failed = records.filter((record) => record.verdict.status !== 'PASS');
  if (failed.length === 0) return;
  throw new ProductStoryError(
    'EXPOSURE_UNREADABLE',
    `${failed.length} scene(s) cannot be read on an ordinary phone screen:\n${failed
      .map(
        (record) =>
          `  - scene ${record.sceneNumber} (${record.profile}, ${record.verdict.status}): ${
            record.verdict.status === 'NOT_MEASURED'
              ? (record.verdict.notMeasuredReason ?? 'not measured')
              : record.verdict.failures.join('; ')
          }`,
      )
      .join('\n')}\nAn unmeasurable scene is never a passing one.`,
    failed[0]?.sceneNumber,
  );
}
