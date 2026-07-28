import type { ActualMediaQaReport } from '@combat/media';

/**
 * The 100-point agency benchmark scorecard.
 *
 * The whole design rests on one distinction the rest of this repository already
 * makes and this milestone must not blur: **a machine can measure whether a
 * file meets a delivery contract; it cannot judge whether an advertisement is
 * good.** So the ten dimensions split into two kinds, and the split is
 * structural rather than a convention:
 *
 * - Three dimensions are **verifiable** — they ask whether something is
 *   present, legible and correctly built, and technical QA plus the plan can
 *   answer that. They score.
 * - Seven are **craft judgements** — strategy, tension, story, hook strength,
 *   cinematography, motion design, editing. They carry
 *   `HUMAN_JUDGEMENT_REQUIRED` and no number at all, until a named person
 *   writes one against this specific master.
 *
 * There is no function in this file that produces, suggests, defaults or
 * infers a craft score, and `awardedPoints` for an unassessed dimension is
 * `null` rather than 0 — a zero is a judgement too, and nobody made it.
 *
 * `AGENCY_GRADE` is therefore unreachable from here by construction. Technical
 * QA can only ever clear the gate's *preconditions*; a human scorecard is the
 * only thing that can carry it, and a temporary-audio master is blocked
 * regardless of what anyone scores.
 */

export const AGENCY_SCORECARD_VERSION = 1 as const;

export const SCORECARD_DIMENSIONS = [
  { key: 'STRATEGIC_CLARITY', label: 'Strategic clarity', maxPoints: 15, kind: 'CRAFT' },
  { key: 'HUMAN_CULTURAL_TENSION', label: 'Human/cultural tension', maxPoints: 10, kind: 'CRAFT' },
  { key: 'STORY_PROGRESSION', label: 'Story progression and payoff', maxPoints: 10, kind: 'CRAFT' },
  {
    key: 'PRODUCT_COMPREHENSION',
    label: 'Product comprehension and integration',
    maxPoints: 15,
    kind: 'VERIFIABLE',
  },
  { key: 'HOOK_STRENGTH', label: 'First-frame and hook strength', maxPoints: 10, kind: 'CRAFT' },
  {
    key: 'CINEMATOGRAPHY',
    label: 'Cinematography and production design',
    maxPoints: 10,
    kind: 'CRAFT',
  },
  {
    key: 'GRAPHICS_TYPOGRAPHY_MOTION',
    label: 'Graphics, typography and motion',
    maxPoints: 10,
    kind: 'CRAFT',
  },
  { key: 'EDITING_TIMING', label: 'Editing, timing and transitions', maxPoints: 8, kind: 'CRAFT' },
  { key: 'MUSIC_SOUND_DESIGN', label: 'Music and sound design', maxPoints: 7, kind: 'VERIFIABLE' },
  {
    key: 'ORIGINALITY_PLATFORM_CTA',
    label: 'Originality, platform fit and CTA',
    maxPoints: 5,
    kind: 'VERIFIABLE',
  },
] as const;

export type ScorecardDimensionKey = (typeof SCORECARD_DIMENSIONS)[number]['key'];

/** Points must total exactly 100, or the scorecard is not the one that was agreed. */
export const SCORECARD_TOTAL_POINTS = SCORECARD_DIMENSIONS.reduce(
  (total, dimension) => total + dimension.maxPoints,
  0,
);

export interface ScorecardDimensionResult {
  readonly key: ScorecardDimensionKey;
  readonly label: string;
  readonly maxPoints: number;
  readonly kind: 'CRAFT' | 'VERIFIABLE';
  readonly verdict: 'MEASURED' | 'HUMAN_JUDGEMENT_REQUIRED';
  /** Null for every craft dimension, always. */
  readonly awardedPoints: number | null;
  readonly basis: string;
  readonly evidence: readonly string[];
}

export interface BlockingDefect {
  readonly code: string;
  readonly summary: string;
  readonly blocksAgencyGrade: true;
  readonly remedy: string;
}

export interface AgencyScorecard {
  readonly scorecardVersion: typeof AGENCY_SCORECARD_VERSION;
  readonly campaignId: string;
  readonly masterChecksumSha256: string | null;
  readonly totalPointsAvailable: number;
  readonly pointsUnderHumanJudgement: number;
  readonly pointsMeasured: number;
  readonly measuredPointsAwarded: number;
  readonly dimensions: readonly ScorecardDimensionResult[];
  readonly technicalQaVerdict: string;
  readonly status: 'BLOCKED_FROM_AGENCY_GRADE' | 'AWAITING_HUMAN_CRAFT_REVIEW';
  readonly agencyGradeClaim: 'NOT_ASSESSED';
  readonly blockingDefects: readonly BlockingDefect[];
  readonly requiresHumanApproval: true;
  readonly notice: string;
}

export interface BuildAgencyScorecardInput {
  readonly campaignId: string;
  readonly qaReport: ActualMediaQaReport;
  readonly masterChecksumSha256: string | null;
  /** True when the mix rests on synthetic placeholder audio. */
  readonly audioIsTemporary: boolean;
  /** Beats whose source is a real Combat Reviews capture. */
  readonly realProductCaptureBeatIds: readonly string[];
  readonly totalBeatCount: number;
  /** Beats carrying a generated mockup rather than a capture. */
  readonly mockupBeatIds: readonly string[];
  readonly ctaHeadline: string;
  readonly ctaAction: string;
  readonly originalityRiskLevel: string;
  readonly measuredWidthPx: number | null;
  readonly measuredHeightPx: number | null;
  readonly measuredDurationSeconds: number | null;
  readonly outstandingLimitations: readonly string[];
}

/**
 * Builds the scorecard from what was actually measured.
 *
 * Every `VERIFIABLE` dimension states the specific facts it read, so a
 * reviewer can disagree with the score by disagreeing with a fact rather than
 * with a number that arrived from nowhere.
 */
export function buildAgencyScorecard(input: BuildAgencyScorecardInput): AgencyScorecard {
  const qaPassed = input.qaReport.verdict === 'PASS';
  const failedChecks = input.qaReport.measurements
    .filter((measurement) => measurement.verdict === 'FAIL')
    .map((measurement) => measurement.check);

  const dimensions: ScorecardDimensionResult[] = SCORECARD_DIMENSIONS.map((dimension) => {
    if (dimension.kind === 'CRAFT') {
      return {
        key: dimension.key,
        label: dimension.label,
        maxPoints: dimension.maxPoints,
        kind: 'CRAFT' as const,
        verdict: 'HUMAN_JUDGEMENT_REQUIRED' as const,
        awardedPoints: null,
        basis:
          'no reliable machine measurement of this exists. It stays unscored until a named reviewer writes a number against this master.',
        evidence: [],
      };
    }

    switch (dimension.key) {
      case 'PRODUCT_COMPREHENSION': {
        // Real product screens on screen, legibly, is a fact about the file.
        const realBeats = input.realProductCaptureBeatIds.length;
        const share = input.totalBeatCount > 0 ? realBeats / input.totalBeatCount : 0;
        const awarded = Math.round(dimension.maxPoints * Math.min(1, share / 0.375));
        return {
          key: dimension.key,
          label: dimension.label,
          maxPoints: dimension.maxPoints,
          kind: 'VERIFIABLE' as const,
          verdict: 'MEASURED' as const,
          awardedPoints: Math.min(dimension.maxPoints, awarded),
          basis:
            'counts beats carrying a real Combat Reviews capture against the eight-beat plan. It measures product presence, not whether the product was explained well — that is a craft judgement and lives above.',
          evidence: [
            `${realBeats} of ${input.totalBeatCount} beats carry a real product capture: ${input.realProductCaptureBeatIds.join(', ')}`,
            ...(input.mockupBeatIds.length > 0
              ? [
                  `${input.mockupBeatIds.length} beat(s) carry a declared PRODUCT_MOCKUP rather than a capture: ${input.mockupBeatIds.join(', ')}`,
                ]
              : []),
          ],
        };
      }
      case 'MUSIC_SOUND_DESIGN': {
        // Temporary audio scores nothing. Synthetic lavfi tones are not a mix,
        // and awarding partial credit for "an audio stream exists" would make
        // the number mean the opposite of what a reader assumes it means.
        return {
          key: dimension.key,
          label: dimension.label,
          maxPoints: dimension.maxPoints,
          kind: 'VERIFIABLE' as const,
          verdict: 'MEASURED' as const,
          awardedPoints: input.audioIsTemporary ? 0 : null,
          basis: input.audioIsTemporary
            ? 'the mix rests on TEMPORARY synthetic placeholder audio generated from FFmpeg sources. That is not music and not sound design, so this dimension scores zero rather than partially.'
            : 'a real music bed is present; its quality is a craft judgement and is not scored here.',
          evidence: input.audioIsTemporary
            ? ['every audio asset in the library is declared TEMPORARY and synthetic']
            : ['a non-temporary music bed is in the mix'],
        };
      }
      case 'ORIGINALITY_PLATFORM_CTA': {
        const deliveredVertical = input.measuredWidthPx === 1080 && input.measuredHeightPx === 1920;
        const ctaCorrect =
          input.ctaHeadline.toUpperCase().includes('NEVER MISS FIGHT NIGHT') &&
          input.ctaAction.toUpperCase().includes('OPEN COMBAT REVIEWS');
        const originalityClear = input.originalityRiskLevel !== 'HIGH';
        const awarded = [deliveredVertical, ctaCorrect, originalityClear].filter(Boolean).length;
        return {
          key: dimension.key,
          label: dimension.label,
          maxPoints: dimension.maxPoints,
          kind: 'VERIFIABLE' as const,
          verdict: 'MEASURED' as const,
          // Three checkable facts out of five points; the remaining two are
          // whether the idea is *original*, which nothing here can measure.
          awardedPoints: awarded,
          basis:
            'three checkable facts — a 1080×1920 delivery, the corrected truthful CTA, and an originality verdict below HIGH. The remaining two points are whether the idea is genuinely fresh, which no measurement answers.',
          evidence: [
            `delivered ${input.measuredWidthPx ?? '?'}×${input.measuredHeightPx ?? '?'} (vertical: ${deliveredVertical})`,
            `CTA headline "${input.ctaHeadline}" / action "${input.ctaAction}" (corrected: ${ctaCorrect})`,
            `originality risk ${input.originalityRiskLevel} (clear: ${originalityClear})`,
          ],
        };
      }
      default:
        // Unreachable while every VERIFIABLE dimension has a case above. Kept
        // so adding one to the list without scoring it fails loudly rather
        // than silently returning nothing.
        throw new Error('a VERIFIABLE scorecard dimension has no measurement');
    }
  });

  const blockingDefects: BlockingDefect[] = [];
  if (input.audioIsTemporary) {
    blockingDefects.push({
      code: 'TEMPORARY_AUDIO',
      summary:
        'the master carries TEMPORARY synthetic audio. No real music bed or sound-design pass exists in any available pack.',
      blocksAgencyGrade: true,
      remedy:
        'licence or commission a music bed and a sound-design pass, then re-render and re-score.',
    });
  }
  if (!qaPassed) {
    blockingDefects.push({
      code: 'ACTUAL_MEDIA_QA_FAILED',
      summary: `actual-media QA returned ${input.qaReport.verdict}: ${failedChecks.join(', ')}`,
      blocksAgencyGrade: true,
      remedy: 'fix the failing measurements and re-render.',
    });
  }
  if (input.mockupBeatIds.length > 0) {
    blockingDefects.push({
      code: 'MOCKUP_STANDS_IN_FOR_A_CAPTURE',
      summary: `${input.mockupBeatIds.length} beat(s) show a declared PRODUCT_MOCKUP because the live discussion screen is unavailable to the read-only capture path.`,
      blocksAgencyGrade: true,
      remedy:
        'enable the discussion screen for capture, take a real read-only capture, and substitute it.',
    });
  }
  for (const limitation of input.outstandingLimitations) {
    blockingDefects.push({
      code: 'OUTSTANDING_LIMITATION',
      summary: limitation,
      blocksAgencyGrade: true,
      remedy: 'resolve or accept it explicitly in a human review.',
    });
  }

  const measuredDimensions = dimensions.filter((dimension) => dimension.kind === 'VERIFIABLE');
  const pointsMeasured = measuredDimensions.reduce(
    (total, dimension) => total + dimension.maxPoints,
    0,
  );

  return {
    scorecardVersion: AGENCY_SCORECARD_VERSION,
    campaignId: input.campaignId,
    masterChecksumSha256: input.masterChecksumSha256,
    totalPointsAvailable: SCORECARD_TOTAL_POINTS,
    pointsUnderHumanJudgement: SCORECARD_TOTAL_POINTS - pointsMeasured,
    pointsMeasured,
    measuredPointsAwarded: measuredDimensions.reduce(
      (total, dimension) => total + (dimension.awardedPoints ?? 0),
      0,
    ),
    dimensions,
    technicalQaVerdict: input.qaReport.verdict,
    // A blocked master is blocked; an unblocked one is still only awaiting a
    // person. Neither state is `AGENCY_GRADE`, and there is no branch here
    // that produces one.
    status:
      blockingDefects.length > 0 ? 'BLOCKED_FROM_AGENCY_GRADE' : 'AWAITING_HUMAN_CRAFT_REVIEW',
    agencyGradeClaim: 'NOT_ASSESSED',
    blockingDefects,
    requiresHumanApproval: true,
    notice:
      'Technical QA cannot declare AGENCY_GRADE and this scorecard does not attempt to. Seven of the ten dimensions, worth ' +
      `${SCORECARD_TOTAL_POINTS - pointsMeasured} of ${SCORECARD_TOTAL_POINTS} points, are craft judgements carrying HUMAN_JUDGEMENT_REQUIRED and no number. ` +
      'Nothing in this repository produces, suggests or defaults one.',
  };
}
