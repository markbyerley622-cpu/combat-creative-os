import { overlapsAny, type ClipAnalysis, type ClipTimeInterval } from '@combat/media';

import type { ResolvedAsset } from '../asset-resolution';
import type { StoryBeat } from '../production-assets';

/**
 * Which part of which clip fills each beat.
 *
 * The limitation this replaces was simple and severe: every video scene began
 * at `inSeconds: 0`. That meant one clip could only ever contribute its own
 * opening, a second beat drawing on the same clip repeated it exactly, and any
 * slate, fade-up or held first frame went straight to the front of the cut.
 *
 * Selection here is over *segments*, not clips. Each beat gets a window
 * `[inSeconds, outSeconds)` chosen from the whole runtime, scored against what
 * the beat needs, and rejected outright if it lands on black, on a freeze, or
 * on a stretch another beat already took.
 *
 * Two properties are non-negotiable, and they are the same two the whole
 * pipeline rests on. **Determinism**: every score is a pure function of the
 * measured analysis and the plan, ties break on a stable key, nothing consults
 * a clock or a random source, and no model or network is involved.
 * **Explainability**: every selection carries the candidates that were
 * considered, the reasons the winner won, and the reasons each rejected
 * alternative lost — so "why does my ad start four seconds into that clip?"
 * has an answer on disk.
 */

/** Handles kept either side of a chosen window so a transition has material to blend. */
export const TRANSITION_HANDLE_SECONDS = 0.35;
/** Candidate in-points are quantised to this grid, so scoring is over a finite, stable set. */
const CANDIDATE_GRID_SECONDS = 0.25;
/** A window must clear a black or frozen region by this much to count as clean. */
const REGION_CLEARANCE_SECONDS = 0.1;

export const SEGMENT_REJECTION_REASONS = [
  'OVERLAPS_BLACK_REGION',
  'OVERLAPS_FROZEN_REGION',
  'OVERLAPS_USED_SEGMENT',
  'INSUFFICIENT_REMAINING_DURATION',
  'NO_TRANSITION_HANDLE',
  'OUTSIDE_CLIP',
] as const;
export type SegmentRejectionReason = (typeof SEGMENT_REJECTION_REASONS)[number];

export interface SegmentCandidate {
  readonly inSeconds: number;
  readonly outSeconds: number;
  readonly score: number;
  readonly reasons: readonly string[];
  /** Set when the candidate is not legal; `score` is then meaningless. */
  readonly rejectedBecause?: SegmentRejectionReason;
  readonly rejectionDetail?: string;
}

export interface SegmentRequest {
  readonly beatId: string;
  readonly beatIndex: number;
  readonly storyBeat: StoryBeat;
  /** How much timeline the beat occupies, before transition overlap. */
  readonly durationSeconds: number;
  /** Whether a transition enters this beat, so a handle is required at the head. */
  readonly hasTransitionIn: boolean;
  /** Whether a transition leaves it, so a handle is required at the tail. */
  readonly hasTransitionOut: boolean;
  /** The author's pinned in-point, if they made the call themselves. */
  readonly pinnedInSeconds?: number;
  /** Whether this beat contributes the clip's own audio to the mix. */
  readonly needsAudio: boolean;
}

export interface SelectedSegment {
  readonly beatId: string;
  readonly beatIndex: number;
  readonly assetId: string;
  readonly inSeconds: number;
  readonly outSeconds: number;
  readonly score: number;
  readonly reasons: readonly string[];
  /** True when the author pinned the in-point and the selector only verified it. */
  readonly pinnedByAuthor: boolean;
  /** True when the window starts on a measured scene boundary. */
  readonly alignedToSceneBoundary: boolean;
  readonly rejectedAlternatives: readonly SegmentCandidate[];
}

export class SegmentSelectionError extends Error {
  constructor(
    public readonly beatId: string,
    public readonly assetId: string,
    public readonly rejected: readonly SegmentCandidate[],
    detail: string,
  ) {
    super(
      `No legal segment of "${assetId}" can fill beat "${beatId}": ${detail}\n${rejected
        .slice(0, 8)
        .map(
          (candidate) =>
            `  - ${candidate.inSeconds.toFixed(2)}s–${candidate.outSeconds.toFixed(2)}s: ${candidate.rejectedBecause} (${candidate.rejectionDetail ?? ''})`,
        )
        .join('\n')}`,
    );
    this.name = 'SegmentSelectionError';
  }
}

/**
 * Every in-point worth considering, in ascending order.
 *
 * Measured scene boundaries come first and are the ones that matter — starting
 * a beat where the picture changed is the difference between landing on a shot
 * and landing in the middle of one. A coarse grid is added underneath so a
 * clip whose detector found nothing still has somewhere to start, and zero is
 * always included so a single-shot clip behaves exactly as it did before.
 */
export function candidateInPoints(
  analysis: ClipAnalysis,
  windowSeconds: number,
): readonly number[] {
  const latest = analysis.durationSeconds - windowSeconds;
  if (latest < 0) return [];

  const points = new Set<number>([0]);
  for (const boundary of analysis.sceneBoundaries) {
    if (boundary >= 0 && boundary <= latest) points.add(Number(boundary.toFixed(3)));
  }
  for (let t = 0; t <= latest; t += CANDIDATE_GRID_SECONDS) {
    points.add(Number(t.toFixed(3)));
  }
  // The very end of the clip is a legal start for the last possible window and
  // is not on the grid unless the arithmetic happens to land there.
  points.add(Number(latest.toFixed(3)));

  return [...points].filter((point) => point >= 0 && point <= latest + 1e-9).sort((a, b) => a - b);
}

function nearBoundary(analysis: ClipAnalysis, timeSeconds: number): boolean {
  return analysis.sceneBoundaries.some(
    (boundary) => Math.abs(boundary - timeSeconds) <= CANDIDATE_GRID_SECONDS / 2,
  );
}

interface EvaluateInput {
  readonly analysis: ClipAnalysis;
  readonly request: SegmentRequest;
  readonly used: readonly ClipTimeInterval[];
  readonly inSeconds: number;
}

/**
 * Judges one candidate window.
 *
 * A rejected candidate is returned rather than dropped: the run's
 * source-selection report lists what was considered and why each loser lost,
 * and a list of winners with no losers is not an explanation.
 */
export function evaluateCandidate(input: EvaluateInput): SegmentCandidate {
  const { analysis, request, used, inSeconds } = input;
  const outSeconds = Number((inSeconds + request.durationSeconds).toFixed(6));

  const headHandle = request.hasTransitionIn ? TRANSITION_HANDLE_SECONDS : 0;
  const tailHandle = request.hasTransitionOut ? TRANSITION_HANDLE_SECONDS : 0;

  const reject = (
    rejectedBecause: SegmentRejectionReason,
    rejectionDetail: string,
  ): SegmentCandidate => ({
    inSeconds,
    outSeconds,
    score: Number.NEGATIVE_INFINITY,
    reasons: [],
    rejectedBecause,
    rejectionDetail,
  });

  if (outSeconds > analysis.durationSeconds + 1e-6) {
    return reject(
      'OUTSIDE_CLIP',
      `needs ${outSeconds.toFixed(2)}s of a ${analysis.durationSeconds.toFixed(2)}s clip`,
    );
  }

  // The handles are material *outside* the window that a transition blends
  // into. Without them an xfade at the head reaches for frames before the
  // in-point and finds nothing.
  if (inSeconds - headHandle < -1e-6) {
    return reject(
      'NO_TRANSITION_HANDLE',
      `a transition enters here but there is no ${TRANSITION_HANDLE_SECONDS}s handle before ${inSeconds.toFixed(2)}s`,
    );
  }
  if (outSeconds + tailHandle > analysis.durationSeconds + 1e-6) {
    return reject(
      'NO_TRANSITION_HANDLE',
      `a transition leaves here but there is no ${TRANSITION_HANDLE_SECONDS}s handle after ${outSeconds.toFixed(2)}s`,
    );
  }

  const guardedIn = inSeconds - REGION_CLEARANCE_SECONDS;
  const guardedOut = outSeconds + REGION_CLEARANCE_SECONDS;

  if (overlapsAny(analysis.blackRegions, guardedIn, guardedOut)) {
    return reject('OVERLAPS_BLACK_REGION', 'the window touches measured black picture');
  }
  if (overlapsAny(analysis.freezeRegions, guardedIn, guardedOut)) {
    return reject('OVERLAPS_FROZEN_REGION', 'the window touches measured frozen picture');
  }
  if (overlapsAny(used, inSeconds, outSeconds)) {
    return reject('OVERLAPS_USED_SEGMENT', 'an earlier beat already used this stretch of the clip');
  }

  // ---- scoring -------------------------------------------------------------
  let score = 0;
  const reasons: string[] = [];

  if (nearBoundary(analysis, inSeconds)) {
    score += 100;
    reasons.push('starts on a measured scene boundary');
  } else {
    score += 10;
    reasons.push('starts mid-shot; no boundary was measured near this point');
  }

  // How far the window sits from anything unusable. More clearance is a safer
  // cut, and it breaks ties toward the middle of clean stretches.
  const clearance = Math.min(
    distanceToNearestRegion(analysis.blackRegions, inSeconds, outSeconds),
    distanceToNearestRegion(analysis.freezeRegions, inSeconds, outSeconds),
  );
  if (Number.isFinite(clearance)) {
    const bounded = Math.min(20, Math.round(clearance * 4));
    score += bounded;
    reasons.push(`sits ${clearance.toFixed(2)}s clear of the nearest black or frozen region`);
  } else {
    score += 20;
    reasons.push('the clip has no measured black or frozen region');
  }

  // A hook wants the opening energy; later beats are better served further in,
  // where a clip has usually settled.
  if (request.storyBeat === 'HOOK') {
    const earliness = Math.max(0, 12 - inSeconds);
    score += Math.round(earliness);
    reasons.push('a hook is scored toward the front of the clip');
  } else {
    score += Math.min(12, Math.round(inSeconds));
    reasons.push('a later beat is scored away from material a hook would use');
  }

  if (request.needsAudio && !analysis.hasAudio) {
    score -= 40;
    reasons.push('this beat wants source audio but the clip has none');
  }

  return { inSeconds, outSeconds, score, reasons };
}

/** Seconds between a window and the nearest region; `Infinity` when there are none. */
function distanceToNearestRegion(
  regions: readonly ClipTimeInterval[],
  startSeconds: number,
  endSeconds: number,
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const region of regions) {
    const gap =
      region.startSeconds >= endSeconds
        ? region.startSeconds - endSeconds
        : region.endSeconds <= startSeconds
          ? startSeconds - region.endSeconds
          : 0;
    nearest = Math.min(nearest, gap);
  }
  return nearest;
}

export interface SelectSegmentsOptions {
  /** One request per beat that draws on a video source, in timeline order. */
  readonly requests: readonly (SegmentRequest & { readonly asset: ResolvedAsset })[];
  /** Measured analysis per asset id. A beat whose clip is unanalysed is refused. */
  readonly analyses: ReadonlyMap<string, ClipAnalysis>;
  /** How many rejected alternatives to record per beat, so a report stays readable. */
  readonly rejectedSampleSize?: number;
}

const DEFAULT_REJECTED_SAMPLE_SIZE = 6;

/**
 * Chooses a segment for every beat, in timeline order.
 *
 * Order matters and is deliberate: an earlier beat's window is added to the
 * used set before a later beat is considered, so two beats drawing on the same
 * clip cannot land on the same footage. That is the rule that turns "one clip,
 * four beats" from four copies of the same three seconds into four different
 * parts of it.
 */
export function selectSegments(options: SelectSegmentsOptions): readonly SelectedSegment[] {
  const sampleSize = options.rejectedSampleSize ?? DEFAULT_REJECTED_SAMPLE_SIZE;
  const usedByAsset = new Map<string, ClipTimeInterval[]>();
  const selections: SelectedSegment[] = [];

  for (const request of options.requests) {
    const assetId = request.asset.asset.id;
    const analysis = options.analyses.get(assetId);
    if (!analysis) {
      throw new SegmentSelectionError(
        request.beatId,
        assetId,
        [],
        'the clip was never analysed, so no in-point can be shown to be legal',
      );
    }

    const used = usedByAsset.get(assetId) ?? [];
    const inPoints = request.pinnedInSeconds
      ? [request.pinnedInSeconds]
      : candidateInPoints(analysis, request.durationSeconds);

    const evaluated = inPoints.map((inSeconds) =>
      evaluateCandidate({ analysis, request, used, inSeconds }),
    );
    const legal = evaluated.filter((candidate) => candidate.rejectedBecause === undefined);
    const rejected = evaluated.filter((candidate) => candidate.rejectedBecause !== undefined);

    if (legal.length === 0) {
      throw new SegmentSelectionError(
        request.beatId,
        assetId,
        rejected,
        request.pinnedInSeconds !== undefined
          ? `the author pinned in-point ${request.pinnedInSeconds}s, and it is not legal`
          : `none of ${evaluated.length} candidate windows is legal`,
      );
    }

    // Descending score, then ascending in-point. The in-point tie-break is what
    // makes two runs of the same plan byte-identical.
    const ordered = [...legal].sort((a, b) =>
      b.score === a.score ? a.inSeconds - b.inSeconds : b.score - a.score,
    );
    const winner = ordered[0] as SegmentCandidate;

    used.push({ startSeconds: winner.inSeconds, endSeconds: winner.outSeconds });
    usedByAsset.set(assetId, used);

    selections.push({
      beatId: request.beatId,
      beatIndex: request.beatIndex,
      assetId,
      inSeconds: winner.inSeconds,
      outSeconds: winner.outSeconds,
      score: winner.score,
      reasons: winner.reasons,
      pinnedByAuthor: request.pinnedInSeconds !== undefined,
      alignedToSceneBoundary: nearBoundary(analysis, winner.inSeconds),
      // The near-misses are the useful ones: a reader wants to know what the
      // selector *nearly* chose and why it did not.
      rejectedAlternatives: [...rejected, ...ordered.slice(1)].slice(0, sampleSize),
    });
  }

  return selections;
}

/** The rows `source-selection-report.json` is built from. */
export function describeSegmentSelections(
  selections: readonly SelectedSegment[],
): readonly Record<string, unknown>[] {
  return selections.map((selection) => ({
    beatId: selection.beatId,
    beatIndex: selection.beatIndex,
    assetId: selection.assetId,
    inSeconds: selection.inSeconds,
    outSeconds: selection.outSeconds,
    durationSeconds: Number((selection.outSeconds - selection.inSeconds).toFixed(6)),
    startsAtNonZeroInPoint: selection.inSeconds > 0,
    alignedToSceneBoundary: selection.alignedToSceneBoundary,
    pinnedByAuthor: selection.pinnedByAuthor,
    score: selection.score,
    reasons: selection.reasons,
    rejectedAlternatives: selection.rejectedAlternatives.map((candidate) => ({
      inSeconds: candidate.inSeconds,
      outSeconds: candidate.outSeconds,
      ...(candidate.rejectedBecause
        ? { rejectedBecause: candidate.rejectedBecause, detail: candidate.rejectionDetail }
        : { score: candidate.score, lostBecause: 'a higher-scoring window was available' }),
    })),
  }));
}
