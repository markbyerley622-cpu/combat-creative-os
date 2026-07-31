import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { evenPx, num, type CommandRunner, type FfmpegBinaries } from '@combat/media';
import { LTX_SUPPORTED_FPS } from '@combat/providers';

import { StoryboardVideoError } from './failures';
import { probeClip } from './scene-media';
import type { ScenePostMotion } from './scene-manifest';

/**
 * The second stage of a two-stage camera motion, executed.
 *
 * `routeLtxCameraMotion` decides that a move the provider cannot express is
 * asked for as `static` and supplied afterwards; `scene-manifest.ts` refuses a
 * routed scene that does not say what its second stage is. This module is the
 * part that actually moves the picture, and until it existed the contract was
 * half a promise: every artefact said a drift would be applied and nothing
 * applied one.
 *
 * ## Why it is a separate FFmpeg pass
 *
 * It runs on the trimmed scene clip, after `prepareSceneClip` and before the
 * clip reaches the render path — one input, one output, one invocation. Three
 * reasons, and none of them is convenience:
 *
 * - **The window is the scene's own.** The authored magnitude is "2% across
 *   this shot", and the shot is the trimmed window, not the six seconds LTX
 *   billed for. Applying it to the original would spread the move over
 *   material the cut discards.
 * - **The render is not reimplemented.** The clip that reaches
 *   `runFlagshipV2` is the same shape it has always been: a trimmed
 *   1080x1920 h264 file at the delivery frame rate. Nothing downstream learns
 *   that a second stage happened.
 * - **It is measurable.** The pass has its own input and output checksums, so
 *   the post-motion report can state that these exact bytes became those
 *   exact bytes, rather than asserting that a filter was somewhere in a graph.
 *
 * ## Why no border is ever exposed
 *
 * Both treatments are **crop-from-oversampled**, never translate-the-frame.
 * The source is scaled up once by a constant headroom factor and the delivery
 * window is cropped out of the middle of it; every window the move can reach
 * lies inside the oversampled picture by construction. A treatment that
 * translated the picture and left the vacated strip to be padded, mirrored or
 * edge-replicated is not expressible here — there is no `pad`, no
 * `fillborders` and no negative `overlay` offset in anything this module
 * compiles.
 *
 * ## Why the drift's scale is constant, and why that is not a zoom
 *
 * `SMOOTH_HORIZONTAL_DRIFT` prohibits zoom. The headroom scale it needs is
 * applied **once, for the whole interval**, and `zoom` is a literal in the
 * compiled expression rather than a function of `on`. The picture is therefore
 * at one magnification from the first frame to the last, which is what "no
 * zoom" means to a viewer; `assertNoZoomOverTime` proves it about the grammar
 * rather than leaving it to be read.
 *
 * ## What cannot be expressed
 *
 * No rotation, no shake, no randomness, no per-frame jitter and no easing that
 * is not a pure function of the output frame index. Two runs of the same plan
 * over the same bytes produce the same bytes — `POST_MOTION_TREATMENTS` was
 * written as a closed vocabulary of smooth deterministic transforms and this
 * module is where that stops being a promise.
 */

/**
 * Bumped whenever a treatment's geometry, easing or headroom changes.
 *
 * Travels in every post-motion record. Two runs citing different versions
 * describe different pictures, and a report that could not tell them apart
 * would be the one artefact a reviewer could not check.
 */
export const POST_MOTION_PROFILE_VERSION = 1 as const;

/**
 * Filters this module is permitted to emit.
 *
 * An allow-list rather than a deny-list, because the interesting failure is a
 * filter nobody thought to ban. `assertOnlyPermittedFilters` walks the compiled
 * chain and refuses anything outside it, so a future edit that reached for
 * `rotate`, `noise`, `pad` or `vibrance` fails a test rather than shipping a
 * shake into an advertisement.
 */
export const PERMITTED_POST_MOTION_FILTERS: readonly string[] = [
  'fps',
  'scale',
  'zoompan',
  'setsar',
  'setpts',
  'format',
];

/**
 * The eased progress every treatment uses.
 *
 * Smoothstep on the output frame index: zero velocity at both ends, so the
 * move starts and stops without a visible flick, and monotonic in between, so
 * it never overshoots and comes back. Driven by `on` rather than accumulated
 * onto the previous `zoom`, for the reason the scene catalogue already
 * documents — an accumulating expression drifts off its intended end point.
 */
export function smoothstepProgress(lastFrame: number): string {
  const p = `(on/${num(Math.max(1, lastFrame))})`;
  return `(${p}*${p}*(3-2*${p}))`;
}

/**
 * An authored rectangle the move must not crop, as fractions of the frame.
 *
 * Optional, and its absence is honest rather than convenient: the manifest's
 * `preservedRegion` is a person's prose, and prose cannot be checked. When a
 * rectangle is supplied the check is real arithmetic against the tightest
 * window the move ever reaches; when it is not, the record says the geometric
 * check was `NOT_MEASURED` and names the reason, exactly as an unmeasurable
 * QA check does.
 */
export interface PreservedRegionRect {
  readonly xFraction: number;
  readonly yFraction: number;
  readonly widthFraction: number;
  readonly heightFraction: number;
}

export interface CompilePostMotionInput {
  readonly postMotion: ScenePostMotion;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly durationSeconds: number;
  readonly frameRate: number;
  readonly preservedRegionRect?: PreservedRegionRect;
}

export interface CompiledPostMotion {
  readonly treatment: ScenePostMotion['treatment'];
  readonly profileVersion: typeof POST_MOTION_PROFILE_VERSION;
  readonly magnitudePercent: number;
  readonly direction: ScenePostMotion['direction'] | null;
  /** The comma-joined `-vf` chain. One input, one output, no labels. */
  readonly filterChain: string;
  /** Constant headroom the source is scaled to before the window is cropped. */
  readonly headroomScale: number;
  readonly oversampledWidthPx: number;
  readonly oversampledHeightPx: number;
  readonly frameCount: number;
  /** True only for the push: the drift holds one magnification throughout. */
  readonly magnificationChangesOverTime: boolean;
  /** The tightest fraction of the original frame the move ever shows. */
  readonly narrowestVisibleFraction: number;
  readonly preservedRegionCheck: PreservedRegionCheck;
  readonly description: string;
}

export interface PreservedRegionCheck {
  readonly status: 'PRESERVED' | 'NOT_MEASURED';
  readonly notMeasuredReason: string | null;
  readonly declaredRegion: PreservedRegionRect | null;
  /** How much margin the region keeps inside the tightest window, as a fraction. */
  readonly worstCaseMarginFraction: number | null;
}

/**
 * Turns one authored post-motion block into the filter chain that executes it.
 *
 * Pure. Every refusal here happens before FFmpeg is invoked and before the
 * clip is touched, so a plan that cannot be executed is refused with the
 * author's own vocabulary rather than discovered as a broken output.
 */
export function compilePostMotion(input: CompilePostMotionInput): CompiledPostMotion {
  const { postMotion } = input;

  if (input.widthPx <= 0 || input.heightPx <= 0) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `a ${postMotion.treatment} needs a real frame size; ${input.widthPx}x${input.heightPx} is not one`,
    );
  }
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `a ${postMotion.treatment} needs a positive duration, got ${input.durationSeconds}`,
    );
  }
  if (!Number.isFinite(input.frameRate) || input.frameRate <= 0) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `a ${postMotion.treatment} needs a positive frame rate, got ${input.frameRate}`,
    );
  }

  const frameCount = Math.max(1, Math.round(input.durationSeconds * input.frameRate));
  if (frameCount < 2) {
    // A single frame cannot carry a move. Refused rather than emitted as a
    // still, because a still labelled as a drift is the exact substitution the
    // routing contract exists to prevent.
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `scene material of ${input.durationSeconds.toFixed(3)}s at ${input.frameRate} fps is ${frameCount} frame(s); a ${postMotion.treatment} needs at least two frames to move across`,
    );
  }

  if (postMotion.treatment === 'SMOOTH_HORIZONTAL_DRIFT' && !postMotion.direction) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      'a horizontal drift states no direction; left and right are different shots',
    );
  }
  if (postMotion.treatment === 'SMOOTH_PUSH' && postMotion.direction) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      'a push along the lens axis has no horizontal direction',
    );
  }

  const headroomScale = Number((1 + postMotion.magnitudePercent / 100).toFixed(6));
  const oversampledWidthPx = evenPx(input.widthPx * headroomScale);
  const oversampledHeightPx = evenPx(input.heightPx * headroomScale);
  const lastFrame = frameCount - 1;
  const progress = smoothstepProgress(lastFrame);

  // The delivery window is always cropped out of the oversampled picture, so
  // its edges are inside the source at every instant of every move. That is
  // what makes "no exposed border" structural rather than a bound somebody has
  // to keep checking.
  const centredY = `ih/2-(ih/zoom/2)`;
  let zoomExpression: string;
  let xExpression: string;
  let magnificationChangesOverTime: boolean;
  let narrowestVisibleFraction: number;
  let description: string;

  if (postMotion.treatment === 'SMOOTH_PUSH') {
    // Opens showing the whole oversampled frame and closes on a 1:1 window, so
    // the move ends at native resolution rather than at its softest point.
    zoomExpression = `1+${num(postMotion.magnitudePercent / 100)}*${progress}`;
    xExpression = `iw/2-(iw/zoom/2)`;
    magnificationChangesOverTime = true;
    narrowestVisibleFraction = Number((1 / headroomScale).toFixed(6));
    description = `a smooth ${num(postMotion.magnitudePercent)}% push about the frame centre over ${num(input.durationSeconds)}s, eased in and out, cropped from a ${num(headroomScale)}x oversample so no edge is ever exposed`;
  } else {
    // Constant magnification. `zoom` is a literal, so the picture is at one
    // scale from the first frame to the last and the only thing that changes
    // is which window of it is shown.
    zoomExpression = num(headroomScale);
    const travel = `(iw-iw/zoom)`;
    xExpression =
      postMotion.direction === 'LEFT'
        ? // Drifting left means the window walks right across the picture, so
          // the content appears to move left.
          `${travel}*${progress}`
        : `${travel}*(1-${progress})`;
    magnificationChangesOverTime = false;
    narrowestVisibleFraction = Number((1 / headroomScale).toFixed(6));
    description = `a smooth ${num(postMotion.magnitudePercent)}% lateral drift ${String(postMotion.direction).toLowerCase()} over ${num(input.durationSeconds)}s at a single constant magnification, cropped from a ${num(headroomScale)}x oversample so no edge is ever exposed`;
  }

  // Deliberately no `trim`. The input is already exactly the scene's window —
  // `prepareSceneClip` cut it to the beat plus its transition handles — and
  // trimming to a nominal duration here quantises to the frame grid and can
  // come back a few milliseconds short. That shortfall is invisible in the
  // file and fatal downstream: the segment selector needs a full handle after
  // the beat's window, and a clip 0.02s short has none, so the render refuses
  // a scene whose picture is perfectly fine. Found exactly that way.
  const filterChain = [
    `fps=${num(input.frameRate)}`,
    `scale=${num(oversampledWidthPx)}:${num(oversampledHeightPx)}:flags=lanczos`,
    `zoompan=z='${zoomExpression}':x='${xExpression}':y='${centredY}':d=1:s=${num(input.widthPx)}x${num(input.heightPx)}:fps=${num(input.frameRate)}`,
    'setsar=1',
    'setpts=PTS-STARTPTS',
    'format=yuv420p',
  ].join(',');

  assertOnlyPermittedFilters(filterChain);
  if (!magnificationChangesOverTime) assertNoZoomOverTime(zoomExpression);

  const preservedRegionCheck = checkPreservedRegion({
    ...(input.preservedRegionRect ? { rect: input.preservedRegionRect } : {}),
    narrowestVisibleFraction,
    treatment: postMotion.treatment,
    ...(postMotion.direction ? { direction: postMotion.direction } : {}),
  });
  if (preservedRegionCheck.status === 'NOT_MEASURED' && preservedRegionCheck.declaredRegion) {
    // Unreachable by construction — a declared rectangle is always measurable —
    // but stated so the two fields can never drift apart silently.
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      'a preserved region was declared but could not be measured',
    );
  }

  return {
    treatment: postMotion.treatment,
    profileVersion: POST_MOTION_PROFILE_VERSION,
    magnitudePercent: postMotion.magnitudePercent,
    direction: postMotion.direction ?? null,
    filterChain,
    headroomScale,
    oversampledWidthPx,
    oversampledHeightPx,
    frameCount,
    magnificationChangesOverTime,
    narrowestVisibleFraction,
    preservedRegionCheck,
    description,
  };
}

/**
 * Whether the tightest window the move ever reaches still contains the region
 * the author said must survive.
 *
 * Both treatments narrow the visible picture to `1/headroom` of the original.
 * A push takes that narrowing from the centre outward; a drift takes it
 * entirely from one side. The two therefore have different worst cases and are
 * computed separately rather than approximated with the pessimistic one — a
 * check that refused a legal drift would be worked around.
 */
export function checkPreservedRegion(input: {
  readonly rect?: PreservedRegionRect;
  readonly narrowestVisibleFraction: number;
  readonly treatment: ScenePostMotion['treatment'];
  readonly direction?: NonNullable<ScenePostMotion['direction']>;
}): PreservedRegionCheck {
  if (!input.rect) {
    return {
      status: 'NOT_MEASURED',
      notMeasuredReason:
        'the scene declares its preserved region in prose only, so no rectangle exists to check the transform against. A person must read the frames.',
      declaredRegion: null,
      worstCaseMarginFraction: null,
    };
  }

  const rect = input.rect;
  const bad: string[] = [];
  for (const [name, value] of [
    ['xFraction', rect.xFraction],
    ['yFraction', rect.yFraction],
    ['widthFraction', rect.widthFraction],
    ['heightFraction', rect.heightFraction],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      bad.push(`${name} must be between 0 and 1, got ${value}`);
    }
  }
  if (rect.xFraction + rect.widthFraction > 1 + 1e-9) {
    bad.push('the region extends past the right edge of the frame');
  }
  if (rect.yFraction + rect.heightFraction > 1 + 1e-9) {
    bad.push('the region extends past the bottom edge of the frame');
  }
  if (bad.length > 0) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `the declared preserved region is not a rectangle inside the frame:\n${bad
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
  }

  const visible = input.narrowestVisibleFraction;
  // The window at its tightest, expressed as [left, right] and [top, bottom]
  // fractions of the original frame.
  let left: number;
  if (input.treatment === 'SMOOTH_PUSH') {
    left = (1 - visible) / 2;
  } else {
    // A drift's window reaches both extremes over the interval, so the region
    // must survive the worse of the two rather than the one it ends on.
    left = 1 - visible;
  }
  const horizontalWindows: (readonly [number, number])[] =
    input.treatment === 'SMOOTH_PUSH'
      ? [[left, left + visible]]
      : [
          [0, visible],
          [1 - visible, 1],
        ];
  const verticalTop = input.treatment === 'SMOOTH_PUSH' ? (1 - visible) / 2 : 0;
  const verticalWindow: readonly [number, number] =
    input.treatment === 'SMOOTH_PUSH' ? [verticalTop, verticalTop + visible] : [0, 1];

  let worstMargin = Number.POSITIVE_INFINITY;
  const violations: string[] = [];
  for (const [windowLeft, windowRight] of horizontalWindows) {
    const marginLeft = rect.xFraction - windowLeft;
    const marginRight = windowRight - (rect.xFraction + rect.widthFraction);
    worstMargin = Math.min(worstMargin, marginLeft, marginRight);
    if (marginLeft < -1e-9 || marginRight < -1e-9) {
      violations.push(
        `horizontally: the window [${num(windowLeft)}, ${num(windowRight)}] does not contain [${num(rect.xFraction)}, ${num(rect.xFraction + rect.widthFraction)}]`,
      );
    }
  }
  const marginTop = rect.yFraction - verticalWindow[0];
  const marginBottom = verticalWindow[1] - (rect.yFraction + rect.heightFraction);
  worstMargin = Math.min(worstMargin, marginTop, marginBottom);
  if (marginTop < -1e-9 || marginBottom < -1e-9) {
    violations.push(
      `vertically: the window [${num(verticalWindow[0])}, ${num(verticalWindow[1])}] does not contain [${num(rect.yFraction)}, ${num(rect.yFraction + rect.heightFraction)}]`,
    );
  }

  if (violations.length > 0) {
    throw new StoryboardVideoError(
      'POST_MOTION_WOULD_CROP_PRESERVED_REGION',
      `a ${input.treatment}${input.direction ? ` ${input.direction.toLowerCase()}` : ''} at this magnitude would crop the region the scene says must survive:\n${violations
        .map((problem) => `  - ${problem}`)
        .join('\n')}\nReduce the magnitude, or move the region. Nothing has been rendered.`,
    );
  }

  return {
    status: 'PRESERVED',
    notMeasuredReason: null,
    declaredRegion: rect,
    worstCaseMarginFraction: Number(worstMargin.toFixed(6)),
  };
}

/** Refuses a chain containing any filter this module is not permitted to emit. */
export function assertOnlyPermittedFilters(filterChain: string): void {
  const used = filterChain
    .split(',')
    .map((step) => step.trim())
    // A `zoompan` expression legitimately contains commas only inside quotes;
    // splitting on the top level is safe here because every expression this
    // module emits is comma-free. A step with no `=` is a bare filter name.
    .map((step) => (step.includes('=') ? (step.split('=')[0] as string) : step))
    .filter((name) => name.length > 0);
  const forbidden = used.filter((name) => !PERMITTED_POST_MOTION_FILTERS.includes(name));
  if (forbidden.length > 0) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `the compiled post-motion uses filter(s) this treatment may not emit: ${[
        ...new Set(forbidden),
      ].join(', ')}. Permitted: ${PERMITTED_POST_MOTION_FILTERS.join(', ')}.`,
    );
  }
}

/**
 * Refuses a drift whose magnification is a function of time.
 *
 * `on` and `t` are the only ways an expression can vary per frame, so their
 * absence from the zoom expression is what "no zoom" means in grammar. A
 * prohibition checked against the thing it prohibits, rather than against a
 * comment claiming it.
 */
export function assertNoZoomOverTime(zoomExpression: string): void {
  if (/\b(on|t|n|in_time|out_time)\b/.test(zoomExpression)) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `a horizontal drift prohibits zoom, but its magnification expression "${zoomExpression}" varies with time`,
    );
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export const POST_MOTION_DIRECTORY = 'post-motion-scenes';

/**
 * How much shorter than its source an output may measure and still be the same
 * length.
 *
 * One frame at 24 fps is 0.0417s; container duration rounds against the
 * timebase, so a strict comparison would fail on arithmetic rather than on a
 * defect. Half a frame is tight enough to catch a real shortfall — the one
 * that matters strips a 0.35s handle — and loose enough not to invent one.
 */
export const FRAME_TOLERANCE_SECONDS = 0.021;

export interface ApplyPostMotionOptions {
  readonly sceneNumber: number;
  readonly sourcePath: string;
  readonly sourceChecksumSha256: string;
  readonly durationSeconds: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly postMotion: ScenePostMotion;
  readonly preservedRegionRect?: PreservedRegionRect;
  readonly outputDirectory: string;
  readonly frameRate?: number;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

export interface AppliedPostMotion {
  readonly sceneNumber: number;
  readonly compiled: CompiledPostMotion;
  readonly inputPath: string;
  readonly inputChecksumSha256: string;
  readonly outputPath: string;
  readonly outputChecksumSha256: string;
  readonly outputSizeBytes: number;
  /** Measured from the produced file, never taken from the request. */
  readonly measuredDurationSeconds: number;
}

/**
 * Applies the compiled second stage to one trimmed scene clip.
 *
 * The output replaces the input everywhere downstream, and both checksums are
 * recorded, so the post-motion report can name the exact bytes on each side of
 * the transform. Nothing is written over the input: the pre-motion clip stays
 * on disk, which is what makes an operator able to compare the two.
 */
export async function applyPostMotion(options: ApplyPostMotionOptions): Promise<AppliedPostMotion> {
  const compiled = compilePostMotion({
    postMotion: options.postMotion,
    widthPx: options.widthPx,
    heightPx: options.heightPx,
    durationSeconds: options.durationSeconds,
    frameRate: options.frameRate ?? LTX_SUPPORTED_FPS,
    ...(options.preservedRegionRect ? { preservedRegionRect: options.preservedRegionRect } : {}),
  });

  await mkdir(options.outputDirectory, { recursive: true });
  const outputPath = join(
    options.outputDirectory,
    `scene-${String(options.sceneNumber).padStart(2, '0')}-post-motion.mp4`,
  );

  options.onProgress?.(`scene ${options.sceneNumber}: applying ${compiled.description}`);

  const result = await options.runner.run(
    options.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      options.sourcePath,
      '-vf',
      compiled.filterChain,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    ],
    { timeoutMs: 600_000 },
  );
  if (result.exitCode !== 0) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `scene ${options.sceneNumber}: the ${options.postMotion.treatment} pass failed — ${result.stderr
        .trim()
        .slice(-400)}`,
      options.sceneNumber,
    );
  }

  const bytes = await readFile(outputPath);
  if (bytes.byteLength === 0) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `scene ${options.sceneNumber}: the ${options.postMotion.treatment} pass produced an empty file`,
      options.sceneNumber,
    );
  }

  // The clip that comes out must be at least as long as the one that went in,
  // and it is *measured* rather than assumed. A pass that quietly shortened a
  // scene by a few milliseconds would strip the transition handle the segment
  // selector requires, and the render would then refuse a scene whose picture
  // is perfectly good — a failure two stages away from its cause.
  const measured = await probeClip(outputPath, options.runner, options.binaries);
  if (measured.durationSeconds + FRAME_TOLERANCE_SECONDS < options.durationSeconds) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `scene ${options.sceneNumber}: the ${options.postMotion.treatment} pass returned ${measured.durationSeconds.toFixed(3)}s from a ${options.durationSeconds.toFixed(3)}s source. A second stage may move the picture; it may never shorten the scene, because the trim's transition handles are cut to the frame.`,
      options.sceneNumber,
    );
  }
  if (measured.widthPx !== options.widthPx || measured.heightPx !== options.heightPx) {
    throw new StoryboardVideoError(
      'POST_MOTION_NOT_EXECUTABLE',
      `scene ${options.sceneNumber}: the ${options.postMotion.treatment} pass returned ${measured.widthPx}x${measured.heightPx} from a ${options.widthPx}x${options.heightPx} source. The second stage reframes inside the delivery geometry; it never changes it.`,
      options.sceneNumber,
    );
  }

  return {
    sceneNumber: options.sceneNumber,
    compiled,
    inputPath: options.sourcePath,
    inputChecksumSha256: options.sourceChecksumSha256,
    outputPath,
    outputChecksumSha256: createHash('sha256').update(bytes).digest('hex'),
    outputSizeBytes: bytes.byteLength,
    measuredDurationSeconds: Number(measured.durationSeconds.toFixed(6)),
  };
}

/**
 * The report a person reads to answer "did the drift actually happen, and how
 * far did it go?".
 *
 * It states the authored intention, the executed geometry and the two
 * checksums side by side. It does **not** score how the move looks: no
 * measurement of that exists here, and a number in this report that nobody
 * could check would be the one an operator trusted.
 */
export function buildPostMotionReport(input: {
  readonly applied: readonly AppliedPostMotion[];
  readonly routedScenes: readonly {
    readonly sceneNumber: number;
    readonly cameraMotion: string;
    readonly providerValue: string;
    readonly postMotion: ScenePostMotion;
  }[];
}): unknown {
  return {
    profileVersion: POST_MOTION_PROFILE_VERSION,
    notice:
      'This report states what the deterministic second stage did. It does not assess how the move looks — no measurement of that exists, and an invented one would be the single unverifiable figure in a report a person relies on.',
    permittedFilters: PERMITTED_POST_MOTION_FILTERS,
    structuralGuarantees: [
      'Every window the move reaches is cropped from an oversampled picture, so no frame can expose a border.',
      'No rotation, shake, randomness or per-frame jitter is expressible: the compiled chain is checked against an allow-list of filters.',
      'Easing is a pure function of the output frame index, so two runs of the same plan produce the same bytes.',
    ],
    scenes: input.routedScenes.map((routed) => {
      const applied = input.applied.find(
        (candidate) => candidate.sceneNumber === routed.sceneNumber,
      );
      return {
        sceneNumber: routed.sceneNumber,
        authoredCameraMotion: routed.cameraMotion,
        providerCameraMotionRequested: routed.providerValue,
        treatment: routed.postMotion.treatment,
        magnitudePercent: routed.postMotion.magnitudePercent,
        direction: routed.postMotion.direction ?? null,
        preservedRegion: routed.postMotion.preservedRegion,
        prohibitions: routed.postMotion.prohibitions,
        rationale: routed.postMotion.rationale,
        executed: Boolean(applied),
        ...(applied
          ? {
              headroomScale: applied.compiled.headroomScale,
              oversampled: `${applied.compiled.oversampledWidthPx}x${applied.compiled.oversampledHeightPx}`,
              frameCount: applied.compiled.frameCount,
              magnificationChangesOverTime: applied.compiled.magnificationChangesOverTime,
              narrowestVisibleFraction: applied.compiled.narrowestVisibleFraction,
              preservedRegionCheck: applied.compiled.preservedRegionCheck,
              filterChain: applied.compiled.filterChain,
              inputChecksumSha256: applied.inputChecksumSha256,
              outputChecksumSha256: applied.outputChecksumSha256,
              measuredDurationSeconds: applied.measuredDurationSeconds,
              description: applied.compiled.description,
            }
          : {
              notExecutedReason:
                'this scene declared a routed motion but no clip reached the post-motion stage',
            }),
      };
    }),
  };
}
