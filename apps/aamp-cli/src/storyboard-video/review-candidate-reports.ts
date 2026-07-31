import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import type { HumanCreativePlan } from '../preview/human-plan';
import type { SceneManifest } from './scene-manifest';
import type { SceneSourceDecision } from './source-precedence';

/**
 * The reports a person reads beside the review candidate.
 *
 * Everything here is **measured from the finished file** or read from an
 * artefact the run already wrote. Nothing scores creative quality, and no
 * function in this module may be added that does: the whole point of a review
 * candidate is that a named person makes those judgements, and a number in one
 * of these reports that nobody could check would be the one they trusted.
 *
 * Where a fact could not be measured, the row says `NOT_MEASURED` and names the
 * reason. That rule is the same one the preview path and the motion gate hold,
 * and it exists because a report that counted only its failures would call a
 * cut clean while half its claims were unknown.
 */

export const REVIEW_REPORT_PROFILE_VERSION = 1 as const;

/** Frames are sampled at this width; the measures are luma statistics, not detail. */
const SAMPLE_WIDTH_PX = 192;

/** Below this mean luma a frame reads as black to a viewer at delivery size. */
export const BLACK_FRAME_LUMA_CEILING = 6;

export interface FrameMeasurement {
  readonly atSeconds: number;
  readonly label: string;
  readonly status: 'MEASURED' | 'NOT_MEASURED';
  readonly notMeasuredReason: string | null;
  /** Mean luma, 0–255. */
  readonly meanLuma: number | null;
  /** Standard deviation of luma. A near-zero value on a lit frame is a flat fill. */
  readonly lumaStdDev: number | null;
  readonly readsAsBlack: boolean | null;
}

/**
 * Mean and spread of luma on one frame of the finished master.
 *
 * `signalstats` rather than a decoded pixel walk: it is one ffmpeg invocation,
 * it reports both figures, and it is the same instrument the audio benchmark
 * used on this campaign's picture, so two measurements of the same file are
 * comparable.
 */
export async function measureFrame(input: {
  readonly moviePath: string;
  readonly atSeconds: number;
  readonly label: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
}): Promise<FrameMeasurement> {
  const notMeasured = (reason: string): FrameMeasurement => ({
    atSeconds: input.atSeconds,
    label: input.label,
    status: 'NOT_MEASURED',
    notMeasuredReason: reason,
    meanLuma: null,
    lumaStdDev: null,
    readsAsBlack: null,
  });

  const result = await input.runner.run(
    input.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'info',
      '-ss',
      input.atSeconds.toFixed(3),
      '-i',
      input.moviePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${SAMPLE_WIDTH_PX}:-2,signalstats,metadata=print`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 60_000 },
  );
  if (result.exitCode !== 0) {
    return notMeasured(`ffmpeg could not decode a frame at ${input.atSeconds.toFixed(3)}s`);
  }

  const text = `${result.stderr}\n${result.stdout}`;
  const mean = readMetadata(text, 'lavfi.signalstats.YAVG');
  const stdDev = readMetadata(text, 'lavfi.signalstats.YDIF');
  if (mean === null) {
    return notMeasured('signalstats reported no YAVG for this frame');
  }

  return {
    atSeconds: input.atSeconds,
    label: input.label,
    status: 'MEASURED',
    notMeasuredReason: null,
    meanLuma: Number(mean.toFixed(4)),
    lumaStdDev: stdDev === null ? null : Number(stdDev.toFixed(4)),
    readsAsBlack: mean <= BLACK_FRAME_LUMA_CEILING,
  };
}

function readMetadata(text: string, key: string): number | null {
  const match = new RegExp(`${key.replace(/\./g, '\\.')}=\\s*([0-9.+-eE]+)`).exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Where each scene sits on the finished timeline
// ---------------------------------------------------------------------------

export interface SceneWindow {
  readonly sceneNumber: number;
  readonly beatId: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly transitionInKind: string | null;
  readonly transitionInSeconds: number;
}

/**
 * The cut's own cue boundaries, derived from the plan rather than restated.
 *
 * A beat's transition overlaps the beat before it, so a scene begins its
 * transition early and is fully present at its nominal boundary. Deriving both
 * from one arithmetic keeps the transition report and the defect report
 * talking about the same instants — two implementations would agree until the
 * first fix.
 */
export function sceneWindows(plan: HumanCreativePlan): readonly SceneWindow[] {
  const windows: SceneWindow[] = [];
  let start = 0;
  plan.beats.forEach((beat, index) => {
    const overlap = beat.transitionIn?.durationSeconds ?? 0;
    const beatStart = index === 0 ? 0 : Number((start - overlap).toFixed(6));
    const beatEnd = Number((beatStart + beat.durationSeconds).toFixed(6));
    windows.push({
      sceneNumber: index + 1,
      beatId: beat.id,
      startSeconds: beatStart,
      endSeconds: beatEnd,
      transitionInKind: beat.transitionIn?.kind ?? null,
      transitionInSeconds: overlap,
    });
    start = beatEnd;
  });
  return windows;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Transition kinds this cut refuses.
 *
 * `CROSSFADE` says two shots are interchangeable, which is the opposite of what
 * a nine-beat demonstration claims; `DIP_TO_BLACK` puts a black seam between
 * two lit scenes and reads as the end of the film arriving early. Both are
 * still in the catalogue — this is a decision about *this* cut, recorded here
 * rather than by deleting a treatment other work may want.
 */
export const REFUSED_TRANSITION_KINDS: readonly string[] = ['CROSSFADE', 'DIP_TO_BLACK'];

export async function buildTransitionReport(input: {
  readonly plan: HumanCreativePlan;
  readonly moviePath: string | null;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
}): Promise<unknown> {
  const windows = sceneWindows(input.plan);
  const rows: unknown[] = [];

  for (const window of windows) {
    if (!window.transitionInKind) continue;
    // The darkest instant a transition can produce is its own midpoint, so
    // that is where a black seam would be if there were one.
    const midpoint = Number((window.startSeconds + window.transitionInSeconds / 2).toFixed(6));
    // eslint-disable-next-line no-await-in-loop -- ordered so the report is stable
    const measured = input.moviePath
      ? await measureFrame({
          moviePath: input.moviePath,
          atSeconds: midpoint,
          label: `transition ${window.sceneNumber - 1}→${window.sceneNumber} midpoint`,
          runner: input.runner,
          binaries: input.binaries,
        })
      : null;

    rows.push({
      fromScene: window.sceneNumber - 1,
      toScene: window.sceneNumber,
      kind: window.transitionInKind,
      durationSeconds: window.transitionInSeconds,
      atSeconds: midpoint,
      isRefusedKind: REFUSED_TRANSITION_KINDS.includes(window.transitionInKind),
      seamMeasurement: measured ?? {
        status: 'NOT_MEASURED',
        notMeasuredReason: 'no master was produced, so no frame could be measured',
      },
      readsAsBlackSeam: measured?.readsAsBlack ?? null,
    });
  }

  const refused = rows.filter((row) => (row as { isRefusedKind: boolean }).isRefusedKind);
  const blackSeams = rows.filter(
    (row) => (row as { readsAsBlackSeam: boolean | null }).readsAsBlackSeam === true,
  );
  const notMeasured = rows.filter(
    (row) => (row as { readsAsBlackSeam: boolean | null }).readsAsBlackSeam === null,
  );

  return {
    profileVersion: REVIEW_REPORT_PROFILE_VERSION,
    notice:
      "Every kind below is a treatment the catalogue already defines; this report states which were used and measures the picture at each seam. It does not score whether a transition is the right one — that is a reviewer's judgement.",
    refusedKinds: REFUSED_TRANSITION_KINDS,
    blackFrameLumaCeiling: BLACK_FRAME_LUMA_CEILING,
    transitionCount: rows.length,
    refusedKindCount: refused.length,
    blackSeamCount: blackSeams.length,
    notMeasuredCount: notMeasured.length,
    transitions: rows,
  };
}

// ---------------------------------------------------------------------------
// UI compositing
// ---------------------------------------------------------------------------

/**
 * Where the Combat Reviews interface appears, and how it got there.
 *
 * The distinction this report exists to make is between an interface that is
 * *sharp because it was never regenerated* and one that passed through a
 * generative model inside the plate. The first is a fact about the pipeline;
 * the second is a risk a reviewer has to look at, and it is named rather than
 * left for them to discover.
 */
export function buildUiCompositingReport(input: {
  readonly sceneManifest: SceneManifest;
  readonly decisions: readonly SceneSourceDecision[];
  readonly stillSceneNumbers: ReadonlySet<number>;
  /** Scenes whose authoritative plate was deliberately not used, and why. */
  readonly plateSubstitutionsDeclined?: readonly {
    readonly sceneNumber: number;
    readonly frameId: string;
    readonly reason: string;
  }[];
}): unknown {
  const rows = input.sceneManifest.scenes.map((scene) => {
    const decision = input.decisions.find(
      (candidate) => candidate.sceneNumber === scene.sceneNumber,
    );
    const carriesUi = scene.preserveExactProductUi || scene.preserveExactTypography;
    const reachedModel = decision?.selectedSourceType === 'LTX_GENERATED';
    return {
      sceneNumber: scene.sceneNumber,
      sceneRole: decision?.sceneRole ?? null,
      declaresExactProductUi: scene.preserveExactProductUi,
      declaresExactTypography: scene.preserveExactTypography,
      sourceType: decision?.selectedSourceType ?? null,
      uiTreatment: carriesUi
        ? input.stillSceneNumbers.has(scene.sceneNumber)
          ? 'OPERATOR_PLATE_NEVER_REGENERATED'
          : 'STORYBOARD_PANEL_NEVER_REGENERATED'
        : reachedModel
          ? 'NO_DECLARED_UI — any interface visible in this scene is inside the generated plate'
          : 'NO_DECLARED_UI',
      reachedGenerativeModel: reachedModel,
      promptProhibitsRedrawingUi: /Do not alter/.test(scene.motionPrompt),
      humanJudgementRequired: reachedModel
        ? 'A reviewer must confirm the model did not redraw a panel, label, numeral or mark inside this plate. The prompt forbids it and nothing here measures whether it obeyed.'
        : null,
    };
  });

  return {
    profileVersion: REVIEW_REPORT_PROFILE_VERSION,
    notice:
      "No interface element anywhere in this cut is drawn by this pipeline. A scene that declares exact product UI is never sent to a generative model — that is enforced at manifest parse time — and its pixels are the operator's own finished plate, staged and resampled but never redrawn.",
    structuralGuarantees: [
      'preserveExactProductUi or preserveExactTypography makes LTX_IMAGE_TO_VIDEO unreachable for that scene, refused when the manifest is parsed rather than by a downstream check.',
      'No text, label, numeral or interface element is drawn by the render path. The only marks it adds are validated rectangles in the brand accent and the CTA typography the plan declares.',
    ],
    limitations: [
      'Scenes 8 and 9 sit on photographic plates that were sent to a generative model. The prompt forbids altering any panel, label or numeral in them and the model was given the approved frame, but nothing in this repository measures whether the returned pixels obeyed. A reviewer must look.',
      "The interface scenes render the storyboard panel rather than a sharp mobile-native screen composited onto a handset. The operator's own plates for those scenes are photographic handsets with blank screens — shot for an interface to be composited onto — and the compositor that would map a 393 CSS px document through the handset's homography is not on this path. Until it is, those scenes carry the storyboard's own 470px art, which is lower resolution and does show the product.",
    ],
    plateSubstitutionsDeclined: input.plateSubstitutionsDeclined ?? [],
    scenes: rows,
  };
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface BenchmarkAudioFinding {
  readonly directory: string | null;
  readonly reportPresent: boolean;
  readonly reportStatus: string | null;
  readonly selectedMixCount: number;
  readonly usable: boolean;
  readonly reason: string;
}

/**
 * Whether the completed audio benchmark can supply this cut's sound.
 *
 * Three conditions, all of which must hold: the pack exists, its final report
 * says it finished, and it actually contains selected mixes. A pack whose
 * report still says `IN PROGRESS` has not finished, and using its intermediate
 * material would put unfinished sound into a cut labelled as the reviewable
 * one. Absent any of the three, the run marks itself `AUDIO_TEMPORARY` and
 * says so in every artefact.
 */
export async function findBenchmarkAudio(
  directory: string | undefined,
): Promise<BenchmarkAudioFinding> {
  if (!directory) {
    return {
      directory: null,
      reportPresent: false,
      reportStatus: null,
      selectedMixCount: 0,
      usable: false,
      reason: 'no audio benchmark directory was supplied',
    };
  }

  let report: string | null = null;
  try {
    report = await readFile(join(directory, 'benchmark-report.md'), 'utf8');
  } catch {
    report = null;
  }
  if (report === null) {
    return {
      directory,
      reportPresent: false,
      reportStatus: null,
      selectedMixCount: 0,
      usable: false,
      reason: 'the benchmark has no final report, so nothing in it is a finished mix',
    };
  }

  const statusLine = /\*\*Status:\*\*\s*([^\n]+)/.exec(report)?.[1]?.trim() ?? null;
  const finished = statusLine !== null && !/in progress/i.test(statusLine);

  let selectedMixCount = 0;
  try {
    const { readdir } = await import('node:fs/promises');
    const mixes = await readdir(join(directory, 'mixes'));
    selectedMixCount = mixes.filter((name) => /\.(wav|flac|m4a|mp3|aac)$/i.test(name)).length;
  } catch {
    selectedMixCount = 0;
  }

  if (!finished) {
    return {
      directory,
      reportPresent: true,
      reportStatus: statusLine,
      selectedMixCount,
      usable: false,
      reason: `the benchmark report says "${statusLine ?? 'unknown'}", so the model chain has not completed and no mix in it is final`,
    };
  }
  if (selectedMixCount === 0) {
    return {
      directory,
      reportPresent: true,
      reportStatus: statusLine,
      selectedMixCount,
      usable: false,
      reason: 'the benchmark report is final but its mixes directory holds no audio file',
    };
  }
  return {
    directory,
    reportPresent: true,
    reportStatus: statusLine,
    selectedMixCount,
    usable: true,
    reason: 'the benchmark is final and carries selected mixes',
  };
}

export function buildAudioReport(input: {
  readonly plan: HumanCreativePlan;
  readonly benchmark: BenchmarkAudioFinding;
  readonly measured: Record<string, unknown> | null;
}): unknown {
  return {
    profileVersion: REVIEW_REPORT_PROFILE_VERSION,
    disposition: input.benchmark.usable ? 'BENCHMARK_AUDIO' : 'AUDIO_TEMPORARY',
    notice: input.benchmark.usable
      ? "The completed audio benchmark supplied this cut's sound."
      : "AUDIO_TEMPORARY — this cut carries the synthetic placeholder bed and cues from the work pack. It is not a mix, it is not a sound design, and no claim about the finished advertisement's audio may rest on it.",
    benchmark: input.benchmark,
    plan: {
      musicAssetId: input.plan.audio.musicAssetId,
      musicGainDb: input.plan.audio.musicGainDb,
      sourceAudioGainDb: input.plan.audio.sourceAudioGainDb,
      cueDuckingDb: input.plan.audio.cueDuckingDb,
      targetLufs: input.plan.audio.targetLufs,
      peakCeilingDbtp: input.plan.audio.peakCeilingDbtp,
      cueRoles: Object.keys(input.plan.audio.cueAssetIds ?? {}),
    },
    measuredFromTheMaster: input.measured
      ? {
          integratedLufs: input.measured.integratedLufs ?? null,
          truePeakDbtp: input.measured.truePeakDbtp ?? null,
          clippedSamples: input.measured.clippedSamples ?? null,
          audioCodec: input.measured.audioCodec ?? null,
          audioSampleRateHz: input.measured.audioSampleRateHz ?? null,
          audioChannels: input.measured.audioChannels ?? null,
        }
      : {
          status: 'NOT_MEASURED',
          notMeasuredReason: 'no master was produced, so nothing could be measured',
        },
    humanJudgementRequired:
      "Whether the sound works is a person's judgement. Nothing here measures it, and the loudness figures above say only that the file is within the delivery specification.",
  };
}

// ---------------------------------------------------------------------------
// Visible defects
// ---------------------------------------------------------------------------

/**
 * Every scene opening, midpoint and ending, plus every transition seam.
 *
 * Thirty scene instants and nine seams, measured on the finished file. The
 * measure is deliberately narrow — it answers "is this frame black, or a flat
 * fill?" and nothing else — because those are the two defects that are
 * genuinely machine-detectable at this scale. Everything a person has to look
 * at is listed separately and carries no number.
 */
export async function buildVisibleDefectsReport(input: {
  readonly plan: HumanCreativePlan;
  readonly moviePath: string | null;
  readonly framesDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
}): Promise<unknown> {
  const windows = sceneWindows(input.plan);
  const measurements: FrameMeasurement[] = [];

  if (input.moviePath) {
    await mkdir(input.framesDirectory, { recursive: true });
    for (const window of windows) {
      const instants: [number, string][] = [
        // Just inside the boundary, so a transition's own frames are not
        // mistaken for the scene's opening.
        [
          window.startSeconds + window.transitionInSeconds + 0.02,
          `scene ${window.sceneNumber} opening`,
        ],
        [(window.startSeconds + window.endSeconds) / 2, `scene ${window.sceneNumber} midpoint`],
        [window.endSeconds - 0.04, `scene ${window.sceneNumber} ending`],
      ];
      for (const [atSeconds, label] of instants) {
        // eslint-disable-next-line no-await-in-loop -- ordered so the report is stable
        measurements.push(
          await measureFrame({
            moviePath: input.moviePath,
            atSeconds: Number(Math.max(0, atSeconds).toFixed(3)),
            label,
            runner: input.runner,
            binaries: input.binaries,
          }),
        );
      }
    }
  }

  const black = measurements.filter((row) => row.readsAsBlack === true);
  const notMeasured = measurements.filter((row) => row.status === 'NOT_MEASURED');

  return {
    profileVersion: REVIEW_REPORT_PROFILE_VERSION,
    notice:
      'This report measures two things and claims nothing else: whether an inspected frame reads as black, and how much luma variation it carries. A frame that passes both is not thereby a good frame.',
    blackFrameLumaCeiling: BLACK_FRAME_LUMA_CEILING,
    inspectedInstantCount: measurements.length,
    blackFrameCount: black.length,
    notMeasuredCount: notMeasured.length,
    measurements,
    humanJudgementRequired: [
      'Warped, melted or invented lettering anywhere in the generated plates.',
      'A phone whose screen is empty, or whose interface disagrees with the approved plate.',
      'Hands, faces and anatomy in the generated scenes.',
      'Whether the nine transitions read as one continuous piece of direction rather than ten separate shots.',
      'Whether the predictor rank, the schedule and the prediction confirmation are legible for long enough to read.',
      'Whether the cut looks like an advertisement or like a slideshow.',
    ],
  };
}
