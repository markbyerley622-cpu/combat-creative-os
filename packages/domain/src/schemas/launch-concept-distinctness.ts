import {
  LAUNCH_DISTINCTNESS_AXES,
  LAUNCH_STRUCTURAL_AXES,
  type LaunchConcept,
  type LaunchDistinctnessAxis,
} from './launch-concept';

/**
 * Whether a set of concepts is a genuine competition or the same idea rewritten.
 *
 * The comparison is deliberately **deterministic and structural**. There is no
 * embedding, no model call and no learned threshold, for the reason CLAUDE.md
 * gives about arbitrary semantic boundaries: a number nobody can justify is not
 * a governance rule, and "these two are 0.83 similar" tells a reviewer nothing
 * they can act on. Seven axes are closed-vocabulary values compared by
 * equality; the eighth — the central idea — is prose compared by content-word
 * overlap, which is the same technique the originality evaluator already uses
 * for copied phrasing.
 *
 * The report names every pair, every shared axis and every differing one, so a
 * refusal is explainable to the person whose concepts were refused.
 */

/** A pair must differ on at least this many of the eight axes. */
export const LAUNCH_MIN_DIFFERING_AXES = 3;

/**
 * Central ideas at or above this content-word overlap count as the same axis
 * value. Chosen to match the originality evaluator's tolerance for restatement:
 * below it, two ideas share vocabulary; at it, they are the same sentence with
 * different words around it.
 */
export const LAUNCH_CENTRAL_IDEA_OVERLAP_CEILING = 0.6;

/** At least this many axes must carry more than one value across the whole set. */
export const LAUNCH_MIN_VARIED_AXES = 4;

/**
 * Words carrying no distinguishing content. Deliberately short and explicit —
 * a long list starts deciding which ideas are similar, which is the judgement
 * this function must not make.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'then',
  'this',
  'to',
  'with',
  'you',
  'your',
]);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

/** Jaccard overlap of content words. 1 when identical, 0 when disjoint. */
export function centralIdeaOverlap(left: string, right: string): number {
  const a = contentWords(left);
  const b = contentWords(right);
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}

export interface LaunchConceptCandidate {
  readonly conceptId: string;
  readonly concept: LaunchConcept;
}

export interface LaunchDistinctnessPair {
  readonly leftConceptId: string;
  readonly rightConceptId: string;
  readonly sharedAxes: readonly LaunchDistinctnessAxis[];
  readonly differingAxes: readonly LaunchDistinctnessAxis[];
  readonly centralIdeaOverlap: number;
  /** True when the pair differs on fewer than `LAUNCH_MIN_DIFFERING_AXES` axes. */
  readonly superficiallyDuplicated: boolean;
}

export interface LaunchDistinctnessReport {
  readonly reportVersion: 1;
  readonly conceptCount: number;
  readonly minimumDifferingAxes: number;
  readonly centralIdeaOverlapCeiling: number;
  readonly minimumVariedAxes: number;
  readonly pairs: readonly LaunchDistinctnessPair[];
  /** Distinct values observed per axis across the whole set, in axis order. */
  readonly axisValueCounts: readonly {
    readonly axis: LaunchDistinctnessAxis;
    readonly distinctValues: number;
  }[];
  readonly variedAxes: number;
  readonly verdict: 'DISTINCT' | 'INSUFFICIENTLY_DISTINCT';
  /** Every reason the set was refused, in a stable order. Empty when DISTINCT. */
  readonly failures: readonly string[];
}

/**
 * Compares every unordered pair and the set as a whole.
 *
 * Two failures are possible and they are different problems: a *pair* that is
 * one concept written twice, and a *set* that varies on too few axes even
 * though no individual pair collides. Reporting them separately is what lets an
 * operator tell "candidate 2 is a rewrite of candidate 1" from "all four
 * candidates are the same shape with different words".
 */
export function assessLaunchConceptDistinctness(
  candidates: readonly LaunchConceptCandidate[],
): LaunchDistinctnessReport {
  const pairs: LaunchDistinctnessPair[] = [];
  const failures: string[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i] as LaunchConceptCandidate;
      const right = candidates[j] as LaunchConceptCandidate;

      const shared: LaunchDistinctnessAxis[] = [];
      const differing: LaunchDistinctnessAxis[] = [];
      for (const axis of LAUNCH_STRUCTURAL_AXES) {
        if (left.concept[axis].kind === right.concept[axis].kind) shared.push(axis);
        else differing.push(axis);
      }

      const overlap = centralIdeaOverlap(left.concept.centralIdea, right.concept.centralIdea);
      if (overlap >= LAUNCH_CENTRAL_IDEA_OVERLAP_CEILING) shared.push('centralIdea');
      else differing.push('centralIdea');

      const superficiallyDuplicated = differing.length < LAUNCH_MIN_DIFFERING_AXES;
      pairs.push({
        leftConceptId: left.conceptId,
        rightConceptId: right.conceptId,
        sharedAxes: shared,
        differingAxes: differing,
        centralIdeaOverlap: Number(overlap.toFixed(4)),
        superficiallyDuplicated,
      });

      if (superficiallyDuplicated) {
        failures.push(
          `concepts "${left.conceptId}" and "${right.conceptId}" differ on only ${differing.length} of ${LAUNCH_DISTINCTNESS_AXES.length} axes (${differing.join(', ') || 'none'}); at least ${LAUNCH_MIN_DIFFERING_AXES} are required`,
        );
      }
    }
  }

  const axisValueCounts = LAUNCH_DISTINCTNESS_AXES.map((axis) => {
    if (axis === 'centralIdea') {
      // The prose axis has no enumerable value, so its "distinct values" is the
      // number of concepts that share no pair collision on it — which is what
      // varying on that axis actually means for the set.
      const collided = new Set<string>();
      for (const pair of pairs) {
        if (pair.sharedAxes.includes('centralIdea')) {
          collided.add(pair.leftConceptId);
          collided.add(pair.rightConceptId);
        }
      }
      return { axis, distinctValues: candidates.length === 0 ? 0 : collided.size > 0 ? 1 : 2 };
    }
    return {
      axis,
      distinctValues: new Set(candidates.map((entry) => entry.concept[axis].kind)).size,
    };
  });

  const variedAxes = axisValueCounts.filter((entry) => entry.distinctValues > 1).length;
  if (candidates.length > 1 && variedAxes < LAUNCH_MIN_VARIED_AXES) {
    failures.push(
      `the set varies on only ${variedAxes} of ${LAUNCH_DISTINCTNESS_AXES.length} axes; at least ${LAUNCH_MIN_VARIED_AXES} must carry more than one value`,
    );
  }

  return {
    reportVersion: 1,
    conceptCount: candidates.length,
    minimumDifferingAxes: LAUNCH_MIN_DIFFERING_AXES,
    centralIdeaOverlapCeiling: LAUNCH_CENTRAL_IDEA_OVERLAP_CEILING,
    minimumVariedAxes: LAUNCH_MIN_VARIED_AXES,
    pairs,
    axisValueCounts,
    variedAxes,
    verdict: failures.length === 0 ? 'DISTINCT' : 'INSUFFICIENTLY_DISTINCT',
    failures,
  };
}
