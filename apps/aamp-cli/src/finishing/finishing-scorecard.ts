import { z } from 'zod';

import {
  FINISHING_MEASUREMENT_NOTICE,
  FinishingContractError,
  type CreativeFinishingBrief,
} from './finishing-contracts';

/**
 * Whether the finished master is premium, and who says so.
 *
 * The split here is the whole point of the file. Measured checks come from the
 * produced file and are the system's to assert. Craft dimensions — is the hook
 * arresting, does the product read, is the cut felt rather than counted — are
 * `HUMAN_JUDGEMENT_REQUIRED` and carry no machine score at all, because there
 * is no reliable measurement of one and a fabricated number would be worse
 * than an absent one: it would be argued with, cited, and eventually believed.
 *
 * So `PREMIUM_READY` is not a verdict this module can reach on its own. It
 * needs a submitted, validated scorecard with a named author, every gated
 * dimension at or above the brief's threshold, every BLOCKING defect recorded
 * as resolved, and the measured checks passing. Any one missing and the answer
 * is `NOT_PREMIUM_READY` with the reasons named.
 */

export const FINISHING_SCORECARD_VERSION = 1 as const;

/**
 * The craft dimensions a person scores.
 *
 * Deliberately about what is on screen rather than about outcomes: nothing
 * here predicts conversion, retention or performance, because a scorecard that
 * did would be a forecast with a number on it and no basis under it.
 */
export const CRAFT_DIMENSIONS = [
  'FIRST_FRAME_STOPPING_POWER',
  'HOOK_CLARITY',
  'PRODUCT_COMPREHENSION',
  'EDIT_RHYTHM',
  'MOTION_AND_FINISH',
  'TYPOGRAPHY_AND_LEGIBILITY',
  'AUDIO_AND_MIX',
  'CTA_CONVICTION',
  'BRAND_COHERENCE',
] as const;
export type CraftDimension = (typeof CRAFT_DIMENSIONS)[number];

/**
 * The dimensions that gate `PREMIUM_READY`.
 *
 * Not all nine: a brief that demanded every dimension clear the same bar would
 * be refused for the one it never cared about, and a gate operators route
 * around is not a gate. These five are the ones a viewer meets in the first
 * two seconds or leaves on.
 */
export const GATED_DIMENSIONS: readonly CraftDimension[] = [
  'FIRST_FRAME_STOPPING_POWER',
  'HOOK_CLARITY',
  'PRODUCT_COMPREHENSION',
  'EDIT_RHYTHM',
  'CTA_CONVICTION',
];

export const CraftScoreSchema = z
  .object({
    dimension: z.enum(CRAFT_DIMENSIONS),
    /** The reviewer's score. There is no function anywhere that produces one. */
    score: z.number().int().min(1).max(10),
    /** Why that score, in the reviewer's words. A bare number is not a judgement. */
    note: z.string().min(15).max(600),
  })
  .strict();

export const PremiumScorecardSchema = z
  .object({
    scorecardVersion: z.literal(FINISHING_SCORECARD_VERSION),
    briefId: z.string().min(1).max(80),
    /** The exact master these scores were given to. */
    masterSha256: z.string().regex(/^[0-9a-f]{64}$/),
    reviewer: z.string().min(2).max(200),
    reviewedAt: z.string().datetime({ offset: true }),
    scores: z.array(CraftScoreSchema).length(CRAFT_DIMENSIONS.length),
    overallScore: z.number().int().min(1).max(10),
    /** Brief defects the reviewer confirms are gone. Confirmed, never inferred. */
    resolvedDefectIds: z.array(z.string().min(1).max(80)).max(64),
    /** Anything the reviewer wants recorded against the decision. */
    remainingConcerns: z.array(z.string().min(10).max(400)).max(32).default([]),
  })
  .strict()
  .superRefine((scorecard, ctx) => {
    const seen = new Set(scorecard.scores.map((entry) => entry.dimension));
    for (const dimension of CRAFT_DIMENSIONS) {
      if (!seen.has(dimension)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scores'],
          message: `no score for ${dimension}. A partial scorecard would let a gated dimension go unlooked-at while the run reported PREMIUM_READY.`,
        });
      }
    }
  });
export type PremiumScorecard = z.infer<typeof PremiumScorecardSchema>;

export function parsePremiumScorecard(value: unknown, sourcePath?: string): PremiumScorecard {
  const result = PremiumScorecardSchema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new FinishingContractError(
    `The premium scorecard${sourcePath ? ` at ${sourcePath}` : ''} was refused:\n  - ${problems.join('\n  - ')}`,
    problems,
  );
}

/**
 * An empty scorecard, for a person to fill in.
 *
 * Emits no scores and no overall — only the dimensions and a `TODO` note each.
 * There is deliberately no function in this repository that suggests, defaults
 * or derives a craft score, and this template is the closest anything comes.
 */
export function buildScorecardTemplate(
  brief: CreativeFinishingBrief,
  masterSha256: string,
  reviewedAt: string,
): Record<string, unknown> {
  return {
    scorecardVersion: FINISHING_SCORECARD_VERSION,
    briefId: brief.briefId,
    masterSha256,
    reviewer: 'TODO — your name.',
    reviewedAt,
    scores: CRAFT_DIMENSIONS.map((dimension) => ({
      dimension,
      score: 0,
      note: `TODO — what you saw, and why it scores where it does. Gated: ${
        GATED_DIMENSIONS.includes(dimension) ? 'yes' : 'no'
      }.`,
    })),
    overallScore: 0,
    resolvedDefectIds: [],
    remainingConcerns: [],
  };
}

/* -------------------------------------------------------------------------- */
/* The verdict                                                                 */
/* -------------------------------------------------------------------------- */

export interface MeasuredMasterFacts {
  readonly qaVerdict?: string;
  readonly measuredDurationSeconds?: number | null;
  readonly measuredResolution?: string;
  readonly measuredCodecs?: string;
  readonly measuredLoudnessLufs?: number | null;
  readonly outputChecksumSha256?: string;
  readonly qaFailedChecks?: readonly string[];
}

export interface FinishingVerdict {
  readonly verdict: 'PREMIUM_READY' | 'NOT_PREMIUM_READY';
  readonly blockers: readonly string[];
  readonly measured: {
    readonly qaVerdict: string;
    readonly durationSeconds: number | null;
    readonly resolution: string | null;
    readonly codecs: string | null;
    readonly loudnessLufs: number | null;
  };
  readonly human: {
    readonly reviewer: string;
    readonly overallScore: number;
    readonly gated: readonly { readonly dimension: CraftDimension; readonly score: number }[];
    readonly ungatedAssessment: 'HUMAN_JUDGEMENT_REQUIRED';
  };
  readonly notice: string;
  readonly requiresHumanApproval: true;
  readonly agencyGradeClaim: 'NOT_ASSESSED';
}

/**
 * Everything is a blocker until it is not, and each one is named.
 *
 * A verdict that said only "not ready" would send a reviewer back to guess
 * which of six conditions failed, and the usual outcome of that is the
 * condition being removed rather than met.
 */
export function evaluateFinishingVerdict(input: {
  readonly brief: CreativeFinishingBrief;
  readonly scorecard: PremiumScorecard;
  readonly master: MeasuredMasterFacts;
  readonly masterSha256: string;
}): FinishingVerdict {
  const { brief, scorecard, master } = input;
  const blockers: string[] = [];

  if (scorecard.masterSha256 !== input.masterSha256) {
    blockers.push(
      `the scorecard was written against master ${scorecard.masterSha256.slice(0, 16)}… but the finished master hashes to ${input.masterSha256.slice(0, 16)}…. Score the file that exists.`,
    );
  }
  if (scorecard.briefId !== brief.briefId) {
    blockers.push(
      `the scorecard is for brief "${scorecard.briefId}", this run is "${brief.briefId}"`,
    );
  }
  if (master.qaVerdict !== 'PASS') {
    blockers.push(
      `actual-media QA returned ${master.qaVerdict ?? 'no verdict'}${
        master.qaFailedChecks && master.qaFailedChecks.length > 0
          ? `: ${master.qaFailedChecks.join(', ')}`
          : ''
      }`,
    );
  }

  const scoreByDimension = new Map(scorecard.scores.map((entry) => [entry.dimension, entry.score]));
  const gated = GATED_DIMENSIONS.map((dimension) => ({
    dimension,
    score: scoreByDimension.get(dimension) ?? 0,
  }));
  for (const entry of gated) {
    if (entry.score < brief.thresholds.gatedDimensionMinimum) {
      blockers.push(
        `${entry.dimension} scored ${entry.score}, under the brief's ${brief.thresholds.gatedDimensionMinimum} minimum`,
      );
    }
  }
  if (scorecard.overallScore < brief.thresholds.overallHumanMinimum) {
    blockers.push(
      `the reviewer's overall score is ${scorecard.overallScore}, under the brief's ${brief.thresholds.overallHumanMinimum} minimum`,
    );
  }

  const resolved = new Set(scorecard.resolvedDefectIds);
  for (const defect of brief.defects) {
    if (defect.severity === 'BLOCKING' && !resolved.has(defect.id)) {
      blockers.push(
        `BLOCKING defect "${defect.id}" (${defect.category}, ${defect.startSeconds}–${defect.endSeconds}s) is not recorded as resolved`,
      );
    }
  }

  return {
    verdict: blockers.length === 0 ? 'PREMIUM_READY' : 'NOT_PREMIUM_READY',
    blockers,
    measured: {
      qaVerdict: master.qaVerdict ?? 'NOT_MEASURED',
      durationSeconds: master.measuredDurationSeconds ?? null,
      resolution: master.measuredResolution ?? null,
      codecs: master.measuredCodecs ?? null,
      loudnessLufs: master.measuredLoudnessLufs ?? null,
    },
    human: {
      reviewer: scorecard.reviewer,
      overallScore: scorecard.overallScore,
      gated,
      ungatedAssessment: 'HUMAN_JUDGEMENT_REQUIRED',
    },
    notice: FINISHING_MEASUREMENT_NOTICE,
    requiresHumanApproval: true,
    agencyGradeClaim: 'NOT_ASSESSED',
  };
}
