import { z } from 'zod';

import { canonicalJson } from '@combat/domain';

import { sha256Of, type BenchmarkArmKey } from './experiment';

/**
 * The human creative scorecard.
 *
 * The one thing this file exists to make impossible is a fabricated score.
 * `creative-scorecard.json` — the structural heuristic the generation pipeline
 * already writes — deliberately carries `agencyGradeClaim: NOT_ASSESSED`,
 * because a machine cannot judge whether an advertisement is any good. This is
 * where that judgement is recorded, and it is recorded **only** from a file a
 * named person wrote.
 *
 * So there is no function here that produces a score. `createBlankScorecard`
 * emits a template with an empty `scores` array; `parseHumanScorecard` accepts
 * a submission and refuses one that is unattributed, unevidenced or
 * unexplained. A test asserts the runner never calls anything but the first.
 */

export const HUMAN_SCORECARD_VERSION = 1 as const;

/**
 * The fourteen dimensions, with what each is asking. The prompts matter: a
 * scale with no shared meaning produces numbers that cannot be compared
 * between reviewers, which is the failure mode of most creative scorecards.
 */
export const HUMAN_SCORECARD_DIMENSIONS = [
  {
    key: 'FIRST_SECOND_STOPPING_POWER',
    label: 'First-second stopping power',
    prompt: 'Would the first second stop a thumb mid-scroll, on its own?',
  },
  {
    key: 'PRODUCT_COMPREHENSION',
    label: 'Product comprehension',
    prompt: 'After one viewing, could a stranger say what the product does?',
  },
  {
    key: 'COMBAT_AUTHENTICITY',
    label: 'Combat authenticity',
    prompt: 'Does this read as made by someone who follows the sport?',
  },
  {
    key: 'VISUAL_HIERARCHY',
    label: 'Visual hierarchy',
    prompt: 'Is there one clear thing to look at in every beat?',
  },
  { key: 'PACING', label: 'Pacing', prompt: 'Does the cut rhythm serve the story or fight it?' },
  {
    key: 'SHOT_QUALITY',
    label: 'Shot quality',
    prompt: 'Framing, exposure, motion — would you publish these frames?',
  },
  {
    key: 'MOTION_AND_TRANSITIONS',
    label: 'Motion and transitions',
    prompt: 'Do transitions carry meaning, or are they decoration?',
  },
  {
    key: 'EDIT_COHERENCE',
    label: 'Edit coherence',
    prompt: 'Does one beat lead to the next, or is it a list?',
  },
  {
    key: 'SOUND_IMPACT',
    label: 'Sound impact',
    prompt: 'Does the audio add anything a silent viewer would miss?',
  },
  {
    key: 'BRAND_DISTINCTIVENESS',
    label: 'Brand distinctiveness',
    prompt: 'With the logo removed, is this recognisably Combat Reviews?',
  },
  {
    key: 'CTA_CLARITY',
    label: 'CTA clarity',
    prompt: 'Is the action obvious, and is there time to act on it?',
  },
  {
    key: 'PLATFORM_FIT',
    label: 'Platform fit',
    prompt: 'Does this belong in this feed, or was it made elsewhere and cropped?',
  },
  {
    key: 'ORIGINALITY',
    label: 'Originality',
    prompt: 'Does this resemble a specific existing advertisement you can name?',
  },
  {
    key: 'PUBLISH_READINESS',
    label: 'Publish readiness',
    prompt: 'Would you put paid media behind this as it stands?',
  },
] as const;

export type HumanScorecardDimensionKey = (typeof HUMAN_SCORECARD_DIMENSIONS)[number]['key'];

const DIMENSION_KEYS = HUMAN_SCORECARD_DIMENSIONS.map((dimension) => dimension.key);

/**
 * One reviewer's judgement on one dimension.
 *
 * `note` and `evidence` are required and length-bounded on purpose. A bare
 * number is not a review — it cannot be argued with, and it cannot be acted on.
 * `blocking` is separate from the score because a 4 on originality can still be
 * a blocker if the reviewer recognised the execution.
 */
export const HumanScoreSchema = z
  .object({
    dimension: z.enum(DIMENSION_KEYS as [string, ...string[]]),
    score: z.number().int().min(1).max(5),
    reviewerId: z.string().min(1).max(120),
    note: z.string().min(20).max(2000),
    /** A timestamp in the cut, or a shot index. One or the other is required. */
    evidenceTimestampSeconds: z.number().nonnegative().optional(),
    evidenceShotIndex: z.number().int().nonnegative().optional(),
    blocking: z.boolean(),
    recordedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  })
  .strict()
  .superRefine((score, ctx) => {
    if (score.evidenceTimestampSeconds === undefined && score.evidenceShotIndex === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceTimestampSeconds'],
        message:
          'every score needs evidence: a timestamp in the cut or a shot index. A score with nothing to point at cannot be checked or acted on.',
      });
    }
  });
export type HumanScore = z.infer<typeof HumanScoreSchema>;

export const HumanCreativeScorecardSchema = z
  .object({
    scorecardVersion: z.literal(HUMAN_SCORECARD_VERSION),
    experimentId: z.string().min(1),
    arm: z.enum(['OFF', 'REQUIRED']),
    reviewerId: z.string().min(1).max(120),
    submittedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
    scores: z.array(HumanScoreSchema),
    overallNote: z.string().min(20).max(4000),
  })
  .strict()
  .superRefine((scorecard, ctx) => {
    const seen = new Set<string>();
    for (const [index, score] of scorecard.scores.entries()) {
      if (seen.has(score.dimension)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scores', index, 'dimension'],
          message: `dimension ${score.dimension} was scored twice`,
        });
      }
      seen.add(score.dimension);
    }
    const missing = DIMENSION_KEYS.filter((key) => !seen.has(key));
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scores'],
        message: `a submitted scorecard must cover every dimension; missing: ${missing.join(', ')}`,
      });
    }
  });
export type HumanCreativeScorecard = z.infer<typeof HumanCreativeScorecardSchema>;

export class HumanScorecardValidationError extends Error {
  constructor(public readonly issues: readonly { path: string; message: string }[]) {
    super(
      `Human scorecard is invalid:\n${issues.map((issue) => `  - ${issue.path || '<root>'}: ${issue.message}`).join('\n')}`,
    );
    this.name = 'HumanScorecardValidationError';
  }
}

export function parseHumanScorecard(value: unknown): HumanCreativeScorecard {
  const result = HumanCreativeScorecardSchema.safeParse(value);
  if (result.success) return result.data;
  throw new HumanScorecardValidationError(
    result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

export interface BlankScorecard {
  readonly scorecardVersion: typeof HUMAN_SCORECARD_VERSION;
  readonly experimentId: string;
  readonly arm: BenchmarkArmKey;
  readonly status: 'AWAITING_HUMAN_REVIEW';
  readonly instructions: string;
  readonly dimensions: readonly {
    readonly key: string;
    readonly label: string;
    readonly prompt: string;
  }[];
  /** Always empty. There is no code path in this repository that fills it. */
  readonly scores: readonly never[];
  readonly reviewerId: null;
  readonly submittedAt: null;
  readonly overallNote: null;
}

/**
 * The template a reviewer fills in.
 *
 * Emits no score and never will. The `scores: []` is not a placeholder to be
 * populated by something clever later — it is the guarantee.
 */
export function createBlankScorecard(experimentId: string, arm: BenchmarkArmKey): BlankScorecard {
  return {
    scorecardVersion: HUMAN_SCORECARD_VERSION,
    experimentId,
    arm,
    status: 'AWAITING_HUMAN_REVIEW',
    instructions:
      'Watch the MP4 for this arm end to end, at least twice, with sound. Score each dimension 1-5, name yourself, write a note of at least 20 characters, and point at a timestamp or shot index. Mark blocking where the issue would stop publication regardless of the score. No automated process may fill this in.',
    dimensions: HUMAN_SCORECARD_DIMENSIONS.map((dimension) => ({ ...dimension })),
    scores: [],
    reviewerId: null,
    submittedAt: null,
    overallNote: null,
  };
}

export interface ScorecardSummary {
  readonly arm: BenchmarkArmKey;
  readonly reviewerId: string;
  readonly averageScore: number;
  readonly lowestDimension: string;
  readonly blockingCount: number;
  readonly blockingDimensions: readonly string[];
  readonly publishReadiness: number;
  readonly checksumSha256: string;
  /** Written on every summary. A human average is not a system verdict. */
  readonly notice: string;
}

export function summariseScorecard(scorecard: HumanCreativeScorecard): ScorecardSummary {
  const total = scorecard.scores.reduce((sum, score) => sum + score.score, 0);
  const lowest = [...scorecard.scores].sort(
    (left, right) => left.score - right.score || left.dimension.localeCompare(right.dimension),
  )[0];
  const blocking = scorecard.scores.filter((score) => score.blocking);
  return {
    arm: scorecard.arm,
    reviewerId: scorecard.reviewerId,
    averageScore: Number((total / scorecard.scores.length).toFixed(2)),
    lowestDimension: lowest?.dimension ?? 'UNKNOWN',
    blockingCount: blocking.length,
    blockingDimensions: blocking.map((score) => score.dimension),
    publishReadiness:
      scorecard.scores.find((score) => score.dimension === 'PUBLISH_READINESS')?.score ?? 0,
    checksumSha256: sha256Of(canonicalJson(scorecard)),
    notice:
      'One reviewer, one viewing. A higher average does not authorise publication; the three human approval gates are unchanged and remain the only approval path.',
  };
}
