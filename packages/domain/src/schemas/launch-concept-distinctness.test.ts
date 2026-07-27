import { describe, expect, it } from 'vitest';

import {
  assessLaunchConceptDistinctness,
  centralIdeaOverlap,
  LAUNCH_MIN_DIFFERING_AXES,
} from './launch-concept-distinctness';
import { LAUNCH_STRUCTURAL_AXES, type LaunchConcept } from './launch-concept';

/**
 * The distinctness comparison, on its own.
 *
 * Kept pure and tested here rather than through the CLI because this is the
 * rule that decides whether a concept set is a competition, and a rule that can
 * only be exercised by running four agent invocations is a rule nobody will
 * revisit.
 */

type Axis = (typeof LAUNCH_STRUCTURAL_AXES)[number];

/** A concept whose only interesting properties are its axis values and its idea. */
function concept(kinds: Record<Axis, string>, centralIdea: string): LaunchConcept {
  const axis = (name: Axis): { kind: never; direction: string } => ({
    kind: kinds[name] as never,
    direction: `direction for ${name}`,
  });
  return {
    conceptSchemaVersion: 1,
    title: centralIdea.slice(0, 40),
    centralIdea,
    intendedAudienceResponse: 'a response',
    narrativeStructure: axis('narrativeStructure'),
    emotionalArc: axis('emotionalArc'),
    productPresence: axis('productPresence'),
    interfacePresentation: axis('interfacePresentation'),
    pacing: axis('pacing'),
    soundDesign: axis('soundDesign'),
    endFrame: axis('endFrame'),
    combatCultureRelationship: 'a relationship',
    cinematographyDirection: 'a look',
    motionDesignDirection: 'a motion treatment',
    typographyDirection: 'a type treatment',
    assetRoleRequirements: [{ assetRole: 'LOGO', necessity: 'REQUIRED', purpose: 'closing mark' }],
    factualProductClaims: [{ factId: 'fact', claim: 'a claim' }],
    prohibitedImplications: [],
    originalityRationale: 'because it was written for this brief',
    referencePatternProvenance: [],
    feasibility: { confidence: 'HIGH', requiredCaptureIds: [], risks: [], durationFitNote: 'fits' },
  } as LaunchConcept;
}

const BASE: Record<Axis, string> = {
  narrativeStructure: 'LINEAR_BUILD',
  emotionalArc: 'ANTICIPATION_TO_SATISFACTION',
  productPresence: 'PRODUCT_AS_PROTAGONIST',
  interfacePresentation: 'FULL_SCREEN_CAPTURE',
  pacing: 'ACCELERATING',
  soundDesign: 'MUSIC_LED',
  endFrame: 'BRAND_LOCKUP_HOLD',
};

const VARIED: Record<Axis, string> = {
  narrativeStructure: 'CONTRAST_CUT',
  emotionalArc: 'TENSION_TO_RELEASE',
  productPresence: 'PRODUCT_WITHHELD_UNTIL_END',
  interfacePresentation: 'INTERFACE_AS_PUNCTUATION',
  pacing: 'PUNCTUATED_STILLNESS',
  soundDesign: 'SILENCE_PUNCTUATED',
  endFrame: 'TYPOGRAPHIC_STATEMENT',
};

const THIRD: Record<Axis, string> = {
  narrativeStructure: 'DEMONSTRATION_LED',
  emotionalArc: 'CURIOSITY_TO_CLARITY',
  productPresence: 'PRODUCT_AS_COMPANION',
  interfacePresentation: 'MOTION_ISOLATED_DETAIL',
  pacing: 'SUSTAINED_MEASURED',
  soundDesign: 'AMBIENCE_LED',
  endFrame: 'MOTION_RESOLVE_TO_MARK',
};

describe('central-idea overlap', () => {
  it('is 1 for the same words and 0 for none in common', () => {
    expect(centralIdeaOverlap('rhythm carries the reveal', 'reveal carries the rhythm')).toBe(1);
    expect(centralIdeaOverlap('rhythm carries reveal', 'nothing whatsoever similar')).toBe(0);
  });

  it('ignores stop words and punctuation, so formatting is not distinctness', () => {
    expect(centralIdeaOverlap('The rhythm, and the reveal.', 'rhythm reveal')).toBe(1);
  });
});

describe('a set of genuinely different concepts', () => {
  it('is DISTINCT and records the differing axes for every pair', () => {
    const report = assessLaunchConceptDistinctness([
      { conceptId: 'a', concept: concept(BASE, 'crowded scattered listings resolved into order') },
      { conceptId: 'b', concept: concept(VARIED, 'silence broken by one decisive statement') },
      { conceptId: 'c', concept: concept(THIRD, 'somebody demonstrating what the thing does') },
    ]);

    expect(report.verdict).toBe('DISTINCT');
    expect(report.failures).toEqual([]);
    expect(report.pairs).toHaveLength(3);
    for (const pair of report.pairs) {
      expect(pair.differingAxes.length).toBeGreaterThanOrEqual(LAUNCH_MIN_DIFFERING_AXES);
      expect(pair.superficiallyDuplicated).toBe(false);
    }
  });
});

describe('a set that is one idea rewritten', () => {
  it('is refused, and each colliding pair is named', () => {
    const report = assessLaunchConceptDistinctness([
      { conceptId: 'a', concept: concept(BASE, 'crowded scattered listings resolved into order') },
      { conceptId: 'b', concept: concept(BASE, 'scattered crowded listings, resolved into order') },
      {
        conceptId: 'c',
        concept: concept(BASE, 'listings, scattered and crowded, resolved to order'),
      },
    ]);

    expect(report.verdict).toBe('INSUFFICIENTLY_DISTINCT');
    expect(report.pairs.every((pair) => pair.superficiallyDuplicated)).toBe(true);
    expect(report.failures.join(' ')).toContain('differ on only 0 of 8 axes');
  });

  it('refuses a pair that changed two axes and kept everything else', () => {
    const twoChanged: Record<Axis, string> = {
      ...BASE,
      pacing: 'SUSTAINED_FAST',
      soundDesign: 'VOICE_LED',
    };
    const report = assessLaunchConceptDistinctness([
      { conceptId: 'a', concept: concept(BASE, 'crowded scattered listings resolved into order') },
      {
        conceptId: 'b',
        concept: concept(twoChanged, 'crowded scattered listings resolved into order, faster'),
      },
    ]);

    expect(report.verdict).toBe('INSUFFICIENTLY_DISTINCT');
    expect(report.pairs[0]?.differingAxes).toEqual(['pacing', 'soundDesign']);
  });

  it('refuses a set that varies on too few axes even when no single pair collides', () => {
    // Three concepts, each differing from the others on exactly the three axes
    // the pairwise rule demands, and all resting on the same idea. No single
    // pair is a rewrite, and the set is still not a competition.
    const onlyThree = (values: [string, string, string]): Record<Axis, string> => ({
      ...BASE,
      narrativeStructure: values[0],
      emotionalArc: values[1],
      productPresence: values[2],
    });
    const report = assessLaunchConceptDistinctness([
      {
        conceptId: 'a',
        concept: concept(
          onlyThree(['LINEAR_BUILD', 'ANTICIPATION_TO_SATISFACTION', 'PRODUCT_AS_PROTAGONIST']),
          'scattered listings pulled into one ordered place',
        ),
      },
      {
        conceptId: 'b',
        concept: concept(
          onlyThree(['CONTRAST_CUT', 'TENSION_TO_RELEASE', 'PRODUCT_AS_COMPANION']),
          'listings, scattered, pulled into one ordered place',
        ),
      },
      {
        conceptId: 'c',
        concept: concept(
          onlyThree(['MONTAGE_ACCUMULATION', 'STEADY_CONFIDENCE', 'PRODUCT_AS_LENS']),
          'one ordered place, pulled together from scattered listings',
        ),
      },
    ]);

    expect(report.pairs.every((pair) => !pair.superficiallyDuplicated)).toBe(true);
    expect(report.verdict).toBe('INSUFFICIENTLY_DISTINCT');
    expect(report.failures.join(' ')).toContain('the set varies on only');
  });
});
