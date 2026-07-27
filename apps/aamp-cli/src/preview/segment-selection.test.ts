import type { ClipAnalysis } from '@combat/media';
import { describe, expect, it } from 'vitest';

import type { ResolvedAsset } from '../asset-resolution';
import {
  candidateInPoints,
  describeSegmentSelections,
  evaluateCandidate,
  selectSegments,
  SegmentSelectionError,
  TRANSITION_HANDLE_SECONDS,
  type SegmentRequest,
} from './segment-selection';

/**
 * The behaviour this replaces was "every clip starts at zero", so the tests
 * that matter are the ones proving that is no longer true: a non-zero
 * in-point is chosen, two beats on one clip do not land on the same footage,
 * and a window over black or frozen picture is refused outright rather than
 * scored badly and picked anyway.
 */

function analysis(overrides: Partial<ClipAnalysis> = {}): ClipAnalysis {
  return {
    clipPath: '/library/combat-clips/session.mp4',
    durationSeconds: 20,
    frameRate: 30,
    widthPx: 1920,
    heightPx: 1080,
    videoCodec: 'h264',
    hasAudio: true,
    sceneBoundaries: [0, 5, 7, 12],
    blackRegions: [{ startSeconds: 5, endSeconds: 7 }],
    freezeRegions: [],
    unavailable: [],
    ...overrides,
  };
}

function asset(id: string): ResolvedAsset {
  return {
    asset: {
      id,
      path: `combat-clips/${id}.mp4`,
      kind: 'VIDEO',
      role: 'SOURCE_CLIP',
      description: 'owned footage',
      rights: {
        classification: 'OWNED',
        owner: 'Combat Reviews',
        permittedOutputUse: true,
        restrictions: [],
      },
      beats: [],
      tags: [],
    },
    absolutePath: `/library/combat-clips/${id}.mp4`,
    sizeBytes: 1024,
    checksumSha256: 'a'.repeat(64),
    measuredDurationSeconds: 20,
    discrepancies: [],
  };
}

function request(
  overrides: Partial<SegmentRequest & { asset: ResolvedAsset }> = {},
): SegmentRequest & { asset: ResolvedAsset } {
  return {
    beatId: 'beat',
    beatIndex: 0,
    storyBeat: 'INFORMATION',
    durationSeconds: 3,
    hasTransitionIn: false,
    hasTransitionOut: false,
    needsAudio: false,
    asset: asset('session'),
    ...overrides,
  };
}

describe('candidate in-points', () => {
  it('always includes zero, so a single-shot clip still has somewhere to start', () => {
    expect(candidateInPoints(analysis({ sceneBoundaries: [0] }), 3)[0]).toBe(0);
  });

  it('includes every measured scene boundary that leaves room for the window', () => {
    const points = candidateInPoints(analysis(), 3);
    for (const boundary of [0, 5, 7, 12]) {
      expect(points, `boundary ${boundary} is not a candidate`).toContain(boundary);
    }
  });

  it('never proposes a window that runs off the end of the clip', () => {
    const points = candidateInPoints(analysis({ durationSeconds: 10 }), 4);
    expect(Math.max(...points)).toBeLessThanOrEqual(6 + 1e-9);
  });

  it('proposes nothing when the clip is shorter than the beat', () => {
    expect(candidateInPoints(analysis({ durationSeconds: 2 }), 3)).toEqual([]);
  });
});

describe('candidate evaluation — what is refused', () => {
  it('refuses a window overlapping measured black picture', () => {
    const candidate = evaluateCandidate({
      analysis: analysis(),
      request: request(),
      used: [],
      inSeconds: 4,
    });
    expect(candidate.rejectedBecause).toBe('OVERLAPS_BLACK_REGION');
  });

  it('refuses a window overlapping measured frozen picture', () => {
    const candidate = evaluateCandidate({
      analysis: analysis({
        blackRegions: [],
        freezeRegions: [{ startSeconds: 8, endSeconds: 14 }],
      }),
      request: request(),
      used: [],
      inSeconds: 9,
    });
    expect(candidate.rejectedBecause).toBe('OVERLAPS_FROZEN_REGION');
  });

  it('refuses a window an earlier beat already used', () => {
    const candidate = evaluateCandidate({
      analysis: analysis(),
      request: request(),
      used: [{ startSeconds: 12, endSeconds: 16 }],
      inSeconds: 13,
    });
    expect(candidate.rejectedBecause).toBe('OVERLAPS_USED_SEGMENT');
  });

  it('refuses a window that runs off the end of the clip', () => {
    const candidate = evaluateCandidate({
      analysis: analysis({ durationSeconds: 5 }),
      request: request(),
      used: [],
      inSeconds: 4,
    });
    expect(candidate.rejectedBecause).toBe('OUTSIDE_CLIP');
  });

  it('refuses a window with no handle for the transition entering it', () => {
    const candidate = evaluateCandidate({
      analysis: analysis(),
      request: request({ hasTransitionIn: true }),
      used: [],
      inSeconds: 0,
    });
    expect(candidate.rejectedBecause).toBe('NO_TRANSITION_HANDLE');
  });

  it('refuses a window with no handle for the transition leaving it', () => {
    const candidate = evaluateCandidate({
      analysis: analysis({ durationSeconds: 10, blackRegions: [], sceneBoundaries: [0] }),
      request: request({ hasTransitionOut: true, durationSeconds: 10 }),
      used: [],
      inSeconds: 0,
    });
    expect(candidate.rejectedBecause).toBe('NO_TRANSITION_HANDLE');
  });

  it('accepts a window once the handles fit', () => {
    const candidate = evaluateCandidate({
      analysis: analysis({ blackRegions: [], sceneBoundaries: [0, 12] }),
      request: request({ hasTransitionIn: true, hasTransitionOut: true }),
      used: [],
      inSeconds: TRANSITION_HANDLE_SECONDS + 0.05,
    });
    expect(candidate.rejectedBecause).toBeUndefined();
  });
});

describe('segment selection', () => {
  const analyses = new Map<string, ClipAnalysis>([['session', analysis()]]);

  it('chooses a non-zero in-point when a later boundary scores higher', () => {
    const [selection] = selectSegments({
      requests: [request({ beatId: 'later-beat', storyBeat: 'DISCUSSION' })],
      analyses,
    });
    // A non-hook beat is scored away from the front, and 12 is a measured
    // boundary — so this is exactly the case the old `inSeconds: 0` behaviour
    // could not express.
    expect(selection?.inSeconds).toBe(12);
    expect(selection?.alignedToSceneBoundary).toBe(true);
  });

  it('keeps a hook near the front of the clip', () => {
    const [selection] = selectSegments({
      requests: [request({ beatId: 'hook', storyBeat: 'HOOK' })],
      analyses,
    });
    expect(selection?.inSeconds).toBe(0);
  });

  it('gives two beats on the same clip different, non-overlapping footage', () => {
    const selections = selectSegments({
      requests: [
        request({ beatId: 'first', beatIndex: 0, storyBeat: 'HOOK' }),
        request({ beatId: 'second', beatIndex: 1, storyBeat: 'DISCUSSION' }),
        request({ beatId: 'third', beatIndex: 2, storyBeat: 'INFORMATION' }),
      ],
      analyses,
    });

    expect(selections).toHaveLength(3);
    for (let i = 0; i < selections.length; i += 1) {
      for (let j = i + 1; j < selections.length; j += 1) {
        const a = selections[i]!;
        const b = selections[j]!;
        const overlaps = a.inSeconds < b.outSeconds && a.outSeconds > b.inSeconds;
        expect(overlaps, `${a.beatId} and ${b.beatId} share footage`).toBe(false);
      }
    }
  });

  it('is deterministic: identical inputs give identical windows', () => {
    const build = () =>
      selectSegments({
        requests: [
          request({ beatId: 'first', beatIndex: 0, storyBeat: 'HOOK' }),
          request({ beatId: 'second', beatIndex: 1, storyBeat: 'DISCUSSION' }),
        ],
        analyses,
      });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('never lands a window on the black region the clip actually contains', () => {
    const selections = selectSegments({
      requests: [
        request({ beatId: 'first', beatIndex: 0, storyBeat: 'HOOK' }),
        request({ beatId: 'second', beatIndex: 1, storyBeat: 'DISCUSSION' }),
      ],
      analyses,
    });
    for (const selection of selections) {
      expect(
        selection.inSeconds < 7 && selection.outSeconds > 5,
        `${selection.beatId} overlaps the 5s–7s black region`,
      ).toBe(false);
    }
  });

  it('verifies an author-pinned in-point rather than overriding it', () => {
    const [selection] = selectSegments({
      requests: [request({ beatId: 'pinned', pinnedInSeconds: 14 })],
      analyses,
    });
    expect(selection?.inSeconds).toBe(14);
    expect(selection?.pinnedByAuthor).toBe(true);
  });

  it('refuses an author-pinned in-point that is not legal, and says so', () => {
    expect(() =>
      selectSegments({
        requests: [request({ beatId: 'pinned', pinnedInSeconds: 5.5 })],
        analyses,
      }),
    ).toThrow(/pinned in-point 5.5s, and it is not legal/);
  });

  it('refuses a beat whose clip was never analysed', () => {
    expect(() =>
      selectSegments({ requests: [request({ asset: asset('unanalysed') })], analyses }),
    ).toThrow(SegmentSelectionError);
  });

  it('refuses when the clip has no legal window at all, listing what it tried', () => {
    const allBlack = new Map<string, ClipAnalysis>([
      ['session', analysis({ blackRegions: [{ startSeconds: 0, endSeconds: 20 }] })],
    ]);
    try {
      selectSegments({ requests: [request()], analyses: allBlack });
      throw new Error('expected the selection to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SegmentSelectionError);
      expect((error as SegmentSelectionError).rejected.length).toBeGreaterThan(0);
    }
  });

  it('records the alternatives it rejected, so a choice can be explained', () => {
    const [selection] = selectSegments({ requests: [request()], analyses });
    expect(selection?.rejectedAlternatives.length).toBeGreaterThan(0);
    const rows = describeSegmentSelections(selection ? [selection] : []);
    const row = rows[0] as Record<string, unknown>;
    expect(row.reasons).toBeDefined();
    expect(Array.isArray(row.rejectedAlternatives)).toBe(true);
    expect(row.startsAtNonZeroInPoint).toBe((selection?.inSeconds ?? 0) > 0);
  });

  it('penalises a clip with no audio when the beat wants source audio', () => {
    const silent = new Map<string, ClipAnalysis>([
      ['session', analysis({ hasAudio: false, blackRegions: [] })],
    ]);
    const withAudio = selectSegments({
      requests: [request({ needsAudio: false })],
      analyses: new Map([['session', analysis({ hasAudio: true, blackRegions: [] })]]),
    });
    const withoutAudio = selectSegments({
      requests: [request({ needsAudio: true })],
      analyses: silent,
    });
    expect(withoutAudio[0]!.score).toBeLessThan(withAudio[0]!.score);
    expect(withoutAudio[0]!.reasons.join(' ')).toContain('the clip has none');
  });
});
