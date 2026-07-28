import {
  CAPTION_ENTRANCE_KEYS,
  CTA_ENTRANCE_KEYS,
  DECORATION_TREATMENT_KEYS,
  SCENE_TREATMENT_KEYS,
  TRANSITION_TREATMENT_KEYS,
} from '@combat/media';
import { z } from 'zod';

import {
  FinishingContractError,
  RevisionStageSchema,
  type RevisionAxis,
  type RevisionStage,
} from './finishing-contracts';

/**
 * The reviewer's variation directives — what the alternatives for one stage
 * actually are.
 *
 * This file is the answer to the obvious question about a system that
 * "produces controlled alternatives": produced *from what*? Not from taste
 * this module invented. A directive set is authored by the same named person
 * who wrote the critique, and it states, per candidate, a list of **structural
 * operations** on the approved plan — retime this beat, hold that product
 * longer, put the sweep on the app screen, take two decibels off the bed.
 *
 * Application code's whole job here is discipline, and it is worth being
 * precise about which discipline:
 *
 * - **The operation vocabulary is closed and structural.** There is no
 *   operation that writes a caption, a headline, a hook line or a script beat.
 *   `SET_CAPTION_ENTRANCE` moves how a line arrives; nothing here can change
 *   what it says. A finishing pass re-expresses approved material — the moment
 *   it can author new copy it is a rewrite wearing a revision's clothes.
 * - **Every operation maps to exactly one axis, and every stage permits a
 *   fixed set.** `axisOf` is total over the vocabulary. A candidate in the
 *   HOOK stage that quietly retunes the mix would make the comparison
 *   unreadable: the reviewer would be choosing a hook and getting an audio
 *   decision they never looked at.
 * - **A candidate must move the stage's own axis.** Otherwise it is a
 *   variation of a dependent variable dressed as a competitor, and the stage
 *   settles nothing.
 */

export const FINISHING_DIRECTIVE_VERSION = 1 as const;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256 digest');
const IsoInstantSchema = z.string().datetime({ offset: true });
const BeatIdSchema = z.string().min(1).max(60);

/* -------------------------------------------------------------------------- */
/* The operation vocabulary                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Retiming always names the beat that gives the time back.
 *
 * The plan's timeline has to land exactly on the requested duration, so an
 * operation that lengthened one beat and left the rest alone would produce a
 * plan the schema refuses — after the render directory had been created and
 * the reviewer had been told a candidate exists. Naming the donor makes the
 * arithmetic the reviewer's decision rather than a repair this code performs.
 */
const RetimeBeatSchema = z
  .object({
    kind: z.literal('RETIME_BEAT'),
    beatId: BeatIdSchema,
    durationSeconds: z.number().positive().max(60),
    /** The beat the difference is taken from or given to. */
    compensateWithBeatId: BeatIdSchema,
  })
  .strict();

const SetHookLatencySchema = z
  .object({ kind: z.literal('SET_HOOK_LATENCY'), latencySeconds: z.number().min(0).max(10) })
  .strict();

const SetBeatMotionSchema = z
  .object({
    kind: z.literal('SET_BEAT_MOTION'),
    beatId: BeatIdSchema,
    treatment: z.enum(SCENE_TREATMENT_KEYS),
    intensity: z.number().min(0).max(1),
  })
  .strict();

const SetBeatTransitionSchema = z
  .object({
    kind: z.literal('SET_BEAT_TRANSITION'),
    beatId: BeatIdSchema,
    transitionKind: z.enum(TRANSITION_TREATMENT_KEYS),
    durationSeconds: z
      .number()
      .min(1 / 30)
      .max(2),
    /** A transition overlap changes the timeline, so a donor beat is required. */
    compensateWithBeatId: BeatIdSchema,
  })
  .strict();

const SetCaptionEntranceSchema = z
  .object({
    kind: z.literal('SET_CAPTION_ENTRANCE'),
    beatId: BeatIdSchema,
    entrance: z.enum(CAPTION_ENTRANCE_KEYS),
  })
  .strict();

const SetBeatInPointSchema = z
  .object({
    kind: z.literal('SET_BEAT_IN_POINT'),
    beatId: BeatIdSchema,
    /** Absent hands the choice back to deterministic segment selection. */
    inSeconds: z.number().min(0).max(3600).optional(),
  })
  .strict();

const SetBeatSourceSchema = z
  .object({
    kind: z.literal('SET_BEAT_SOURCE'),
    beatId: BeatIdSchema,
    /** Must be an asset the brief already approved. Checked, not trusted. */
    assetId: z.string().min(1).max(80),
  })
  .strict();

const AddDecorationSchema = z
  .object({
    kind: z.literal('ADD_DECORATION'),
    beatId: BeatIdSchema,
    treatment: z.enum(DECORATION_TREATMENT_KEYS),
    colour: z.enum(['PRIMARY', 'ACCENT']),
    opacity: z.number().min(0).max(1),
    xPx: z.number().int().min(0).max(1080),
    yPx: z.number().int().min(0).max(1920),
    widthPx: z.number().int().positive().max(1080),
    heightPx: z.number().int().positive().max(1920),
    thicknessPx: z.number().int().min(1).max(40),
  })
  .strict();

const ClearDecorationsSchema = z
  .object({ kind: z.literal('CLEAR_DECORATIONS'), beatId: BeatIdSchema })
  .strict();

const SetMixSchema = z
  .object({
    kind: z.literal('SET_MIX'),
    musicGainDb: z.number().min(-40).max(6).optional(),
    sourceAudioGainDb: z.number().min(-60).max(6).optional(),
    cueDuckingDb: z.number().min(0).max(30).optional(),
    musicCrossfadeSeconds: z.number().min(0).max(3).optional(),
    targetLufs: z.number().min(-30).max(-6).optional(),
  })
  // The "names at least one property" rule lives in the directive set's own
  // refinement rather than here: a `.refine()` produces a ZodEffects, and a
  // discriminated union can only be built from plain objects.
  .strict();

const SetBeatSourceAudioSchema = z
  .object({
    kind: z.literal('SET_BEAT_SOURCE_AUDIO'),
    beatId: BeatIdSchema,
    useSourceAudio: z.boolean(),
  })
  .strict();

const SetCtaTimingSchema = z
  .object({
    kind: z.literal('SET_CTA_TIMING'),
    holdSeconds: z.number().min(0).max(10),
    entrance: z.enum(CTA_ENTRANCE_KEYS).optional(),
  })
  .strict();

export const FinishingOperationSchema = z.discriminatedUnion('kind', [
  RetimeBeatSchema,
  SetHookLatencySchema,
  SetBeatMotionSchema,
  SetBeatTransitionSchema,
  SetCaptionEntranceSchema,
  SetBeatInPointSchema,
  SetBeatSourceSchema,
  AddDecorationSchema,
  ClearDecorationsSchema,
  SetMixSchema,
  SetBeatSourceAudioSchema,
  SetCtaTimingSchema,
]);
export type FinishingOperation = z.infer<typeof FinishingOperationSchema>;
export type FinishingOperationKind = FinishingOperation['kind'];

/**
 * Which revision axis each operation moves. Total over the vocabulary by
 * construction — a new operation cannot be added without deciding, here, which
 * comparison it belongs to.
 */
const AXIS_BY_OPERATION: Readonly<Record<FinishingOperationKind, RevisionAxis>> = {
  SET_HOOK_LATENCY: 'HOOK',
  RETIME_BEAT: 'PACING',
  SET_BEAT_MOTION: 'PACING',
  SET_BEAT_TRANSITION: 'TRANSITION',
  SET_CAPTION_ENTRANCE: 'TYPOGRAPHY',
  SET_BEAT_IN_POINT: 'IN_POINT_CROP',
  SET_BEAT_SOURCE: 'IN_POINT_CROP',
  ADD_DECORATION: 'PRODUCT_HOLD',
  CLEAR_DECORATIONS: 'PRODUCT_HOLD',
  SET_MIX: 'AUDIO',
  SET_BEAT_SOURCE_AUDIO: 'AUDIO',
  SET_CTA_TIMING: 'CTA',
};

export function axisOf(operation: FinishingOperation): RevisionAxis {
  return AXIS_BY_OPERATION[operation.kind];
}

/**
 * What each stage is allowed to move, and what it is *about*.
 *
 * `primaryAxis` is the thing under comparison; `dependentAxes` are the
 * variables a candidate legitimately moves in order to express it — you cannot
 * change a hook without being allowed to change where the clip starts. Nothing
 * outside the pair is permitted, which is what stops a stage from quietly
 * settling a question the reviewer is not looking at yet.
 */
export interface StageAxisPolicy {
  readonly primaryAxis: RevisionAxis;
  readonly dependentAxes: readonly RevisionAxis[];
}

export const STAGE_AXIS_POLICY: Readonly<Record<RevisionStage, StageAxisPolicy>> = {
  HOOK: { primaryAxis: 'HOOK', dependentAxes: ['IN_POINT_CROP', 'TYPOGRAPHY', 'TRANSITION'] },
  PACING: { primaryAxis: 'PACING', dependentAxes: ['TRANSITION', 'PRODUCT_HOLD'] },
  AUDIO: { primaryAxis: 'AUDIO', dependentAxes: [] },
  CTA: { primaryAxis: 'CTA', dependentAxes: ['TYPOGRAPHY', 'PRODUCT_HOLD'] },
};

export function stagePermits(stage: RevisionStage, axis: RevisionAxis): boolean {
  const policy = STAGE_AXIS_POLICY[stage];
  return policy.primaryAxis === axis || policy.dependentAxes.includes(axis);
}

/* -------------------------------------------------------------------------- */
/* The directive set                                                           */
/* -------------------------------------------------------------------------- */

/** The control is the approved plan itself, added by the run, never authored. */
export const CONTROL_CANDIDATE_ID = 'control' as const;

export const DirectiveCandidateSchema = z
  .object({
    candidateId: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'candidate ids are lowercase, kebab-case and path-safe'),
    label: z.string().min(3).max(120),
    /** What the reviewer is trying with this one. Read in the gallery. */
    rationale: z.string().min(20).max(600),
    operations: z.array(FinishingOperationSchema).min(1).max(24),
    /** Which brief defect this candidate is answering, when it answers one. */
    addressesDefectIds: z.array(z.string().min(1).max(80)).max(16).default([]),
  })
  .strict();
export type DirectiveCandidate = z.infer<typeof DirectiveCandidateSchema>;

export const StageDirectiveSetSchema = z
  .object({
    directiveVersion: z.literal(FINISHING_DIRECTIVE_VERSION),
    stage: RevisionStageSchema,
    authoredBy: z.string().min(2).max(200),
    authoredAt: IsoInstantSchema,
    /**
     * The plan these were written against. Checked against the run's current
     * base, so directives authored before an earlier stage was settled are
     * refused rather than applied to a plan their author never saw.
     */
    basePlanSha256: Sha256Schema,
    candidates: z.array(DirectiveCandidateSchema).min(1).max(6),
  })
  .strict()
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    const policy = STAGE_AXIS_POLICY[set.stage];
    for (const [index, candidate] of set.candidates.entries()) {
      if (candidate.candidateId === CONTROL_CANDIDATE_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['candidates', index, 'candidateId'],
          message: `"${CONTROL_CANDIDATE_ID}" is reserved: the run always adds the unchanged plan as the control, so the reviewer is never asked to choose without one.`,
        });
      }
      if (seen.has(candidate.candidateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['candidates', index, 'candidateId'],
          message: `duplicate candidate id "${candidate.candidateId}"`,
        });
      }
      seen.add(candidate.candidateId);

      for (const [operationIndex, operation] of candidate.operations.entries()) {
        if (operation.kind === 'SET_MIX' && Object.keys(operation).length === 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['candidates', index, 'operations', operationIndex],
            message:
              'SET_MIX names no mix property, so it changes nothing while making the candidate look like it varies the mix.',
          });
        }
      }

      const axes = candidate.operations.map(axisOf);
      for (const [operationIndex, axis] of axes.entries()) {
        if (!stagePermits(set.stage, axis)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['candidates', index, 'operations', operationIndex],
            message: `the ${set.stage} stage compares ${policy.primaryAxis}${
              policy.dependentAxes.length > 0
                ? ` (and may move ${policy.dependentAxes.join(', ')} to express it)`
                : ''
            }, but this operation moves ${axis}. Settle one axis at a time, or the reviewer is choosing a ${policy.primaryAxis} and silently getting a ${axis} decision too.`,
          });
        }
      }
      if (!axes.includes(policy.primaryAxis)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['candidates', index, 'operations'],
          message: `candidate "${candidate.candidateId}" never moves ${policy.primaryAxis}, so it is not an alternative for the ${set.stage} stage — it is a variation of a dependent variable.`,
        });
      }
    }
  });
export type StageDirectiveSet = z.infer<typeof StageDirectiveSetSchema>;

export function parseStageDirectiveSet(value: unknown, sourcePath?: string): StageDirectiveSet {
  const result = StageDirectiveSetSchema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new FinishingContractError(
    `The stage directives${sourcePath ? ` at ${sourcePath}` : ''} were refused:\n  - ${problems.join('\n  - ')}`,
    problems,
  );
}

/**
 * A skeleton directive set, emitted by `aamp:finish directives`.
 *
 * A template that rendered as-is would make the mode's claim — that a person
 * decided what the alternatives are — untrue on first use, so every prose
 * field says `TODO` and the operation list is deliberately empty of values a
 * reviewer has not chosen.
 */
export function buildDirectiveTemplate(
  stage: RevisionStage,
  basePlanSha256: string,
  authoredAt: string,
): Record<string, unknown> {
  const policy = STAGE_AXIS_POLICY[stage];
  return {
    directiveVersion: FINISHING_DIRECTIVE_VERSION,
    stage,
    authoredBy: 'TODO — your name. This run claims a person chose these alternatives.',
    authoredAt,
    basePlanSha256,
    _guidance: [
      `This stage compares ${policy.primaryAxis}.`,
      policy.dependentAxes.length > 0
        ? `A candidate may also move ${policy.dependentAxes.join(', ')} to express it. Nothing else.`
        : 'No other axis may move.',
      'Every candidate must contain at least one operation on the primary axis.',
      'The unchanged plan is added automatically as the control — do not author one.',
      'Remove this _guidance key before submitting; the schema is strict and will refuse it.',
    ],
    candidates: [
      {
        candidateId: 'todo-candidate-a',
        label: 'TODO — what a reviewer calls this one in the gallery.',
        rationale: 'TODO — what you are trying with this alternative, and why.',
        addressesDefectIds: [],
        operations: [],
      },
    ],
  };
}
