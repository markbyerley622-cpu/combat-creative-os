import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createBlankScorecard,
  HUMAN_SCORECARD_DIMENSIONS,
  HUMAN_SCORECARD_VERSION,
  HumanScorecardValidationError,
  parseHumanScorecard,
  summariseScorecard,
} from './human-scorecard';

/**
 * The property under test throughout: **a score exists only because a person
 * wrote it down**. Everything else here is in service of that — the template is
 * empty, the schema refuses an unattributed or unevidenced submission, and a
 * source-level check holds that nothing in the benchmark code produces one.
 */

const AT = '2026-07-27T00:00:00.000Z';

function completeScorecard(overrides: Record<string, unknown> = {}) {
  return {
    scorecardVersion: HUMAN_SCORECARD_VERSION,
    experimentId: 'bench-1',
    arm: 'REQUIRED',
    reviewerId: 'creative-director-1',
    submittedAt: AT,
    overallNote:
      'Watched both arms twice with sound. The REQUIRED arm opens harder but loses the product screen.',
    scores: HUMAN_SCORECARD_DIMENSIONS.map((dimension, index) => ({
      dimension: dimension.key,
      score: ((index % 5) + 1) as number,
      reviewerId: 'creative-director-1',
      note: `A specific observation about ${dimension.label.toLowerCase()} worth writing down.`,
      evidenceTimestampSeconds: index * 0.5,
      blocking: index === 0,
      recordedAt: AT,
    })),
    ...overrides,
  };
}

describe('the blank template', () => {
  it('contains no score, and every dimension with its question', () => {
    const blank = createBlankScorecard('bench-1', 'OFF');
    expect(blank.scores).toEqual([]);
    expect(blank.reviewerId).toBeNull();
    expect(blank.submittedAt).toBeNull();
    expect(blank.status).toBe('AWAITING_HUMAN_REVIEW');
    expect(blank.dimensions).toHaveLength(14);
    for (const dimension of blank.dimensions) {
      expect(dimension.prompt.length).toBeGreaterThan(10);
    }
  });

  it('covers exactly the fourteen dimensions the milestone specifies', () => {
    expect(HUMAN_SCORECARD_DIMENSIONS.map((dimension) => dimension.key).sort()).toEqual(
      [
        'BRAND_DISTINCTIVENESS',
        'COMBAT_AUTHENTICITY',
        'CTA_CLARITY',
        'EDIT_COHERENCE',
        'FIRST_SECOND_STOPPING_POWER',
        'MOTION_AND_TRANSITIONS',
        'ORIGINALITY',
        'PACING',
        'PLATFORM_FIT',
        'PRODUCT_COMPREHENSION',
        'PUBLISH_READINESS',
        'SHOT_QUALITY',
        'SOUND_IMPACT',
        'VISUAL_HIERARCHY',
      ].sort(),
    );
  });

  it('tells the reviewer that no automated process may fill it in', () => {
    expect(createBlankScorecard('bench-1', 'OFF').instructions).toMatch(
      /No automated process may fill this in/i,
    );
  });
});

describe('a submitted scorecard must be attributable, evidenced and explained', () => {
  it('accepts a complete submission', () => {
    const parsed = parseHumanScorecard(completeScorecard());
    expect(parsed.scores).toHaveLength(14);
    expect(parsed.reviewerId).toBe('creative-director-1');
  });

  it('refuses a submission that does not cover every dimension', () => {
    const partial = completeScorecard();
    partial.scores = partial.scores.slice(0, 5);
    expect(() => parseHumanScorecard(partial)).toThrow(/missing: /);
  });

  it('refuses a duplicated dimension', () => {
    const doubled = completeScorecard();
    doubled.scores = [...doubled.scores, doubled.scores[0] as never];
    expect(() => parseHumanScorecard(doubled)).toThrow(/scored twice/);
  });

  it('refuses a score with no evidence to point at', () => {
    const unevidenced = completeScorecard();
    (unevidenced.scores[0] as Record<string, unknown>).evidenceTimestampSeconds = undefined;
    expect(() => parseHumanScorecard(unevidenced)).toThrow(/evidence/);
  });

  it('refuses an unattributed score', () => {
    const anonymous = completeScorecard();
    (anonymous.scores[0] as Record<string, unknown>).reviewerId = '';
    expect(() => parseHumanScorecard(anonymous)).toThrow(HumanScorecardValidationError);
  });

  it('refuses a bare number with no note', () => {
    const terse = completeScorecard();
    (terse.scores[0] as Record<string, unknown>).note = 'good';
    expect(() => parseHumanScorecard(terse)).toThrow(HumanScorecardValidationError);
  });

  it('refuses a score outside 1-5, and a non-integer', () => {
    for (const bad of [0, 6, 3.5]) {
      const invalid = completeScorecard();
      (invalid.scores[0] as Record<string, unknown>).score = bad;
      expect(() => parseHumanScorecard(invalid), `score ${bad} was accepted`).toThrow(
        HumanScorecardValidationError,
      );
    }
  });

  it('refuses an unknown field rather than silently ignoring it', () => {
    expect(() => parseHumanScorecard(completeScorecard({ agencyGrade: 'A+' }))).toThrow(
      HumanScorecardValidationError,
    );
  });
});

describe('the summary is a summary, not a verdict', () => {
  it('reports the average, the weakest dimension and the blockers', () => {
    const summary = summariseScorecard(parseHumanScorecard(completeScorecard()));
    expect(summary.averageScore).toBeGreaterThan(0);
    expect(summary.blockingCount).toBe(1);
    expect(summary.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('says explicitly that it does not authorise publication', () => {
    const summary = summariseScorecard(parseHumanScorecard(completeScorecard()));
    expect(summary.notice).toMatch(/does not authorise publication/i);
    expect(summary.notice).toMatch(/three human approval gates/i);
  });
});

describe('nothing in the benchmark can fabricate a human score', () => {
  it('has no code path that writes a score, a reviewer or a note', async () => {
    // The runner may only ever call `createBlankScorecard`. If a future change
    // adds a "suggested score" it fails here first.
    for (const file of ['run-benchmark.ts', 'comparison.ts', 'report-markdown.ts']) {
      // eslint-disable-next-line no-await-in-loop -- read in declared order for a stable failure
      const source = await readFile(join(__dirname, file), 'utf8');
      expect(source, `${file} constructs a scorecard submission`).not.toMatch(
        /parseHumanScorecard|summariseScorecard|reviewerId\s*:/,
      );
    }
    const runner = await readFile(join(__dirname, 'run-benchmark.ts'), 'utf8');
    expect(runner).toContain('createBlankScorecard');
  });

  it('has no path from the benchmark to a human approval signal', async () => {
    for (const file of [
      'benchmark-cli.ts',
      'comparison.ts',
      'experiment.ts',
      'human-scorecard.ts',
      'paid-providers.ts',
      'report-markdown.ts',
      'run-benchmark.ts',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- read in declared order
      const source = await readFile(join(__dirname, file), 'utf8');
      expect(source, `${file} references an approval signal`).not.toMatch(
        /approveConcept|selectShots|approveFinal/,
      );
    }
  });
});
