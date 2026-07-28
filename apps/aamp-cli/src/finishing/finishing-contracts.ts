import { createHash } from 'node:crypto';

import { z } from 'zod';

import { EXIT_CODES } from '../run-source-campaign';

/**
 * Creative finishing — the contracts.
 *
 * This milestone exists because the pipeline works and the advertisement does
 * not yet look like one. Everything here is therefore about **directed
 * revision**: a named reviewer says what is visibly wrong, at what timestamp,
 * and what must change; the system produces controlled alternatives along one
 * axis at a time; and a person picks between them.
 *
 * Three properties are load-bearing:
 *
 * - **Vague feedback is refused, not interpreted.** "Make it punchier" cannot
 *   be turned into a render decision, so the schema will not accept it. Every
 *   defect carries a time range, a category, what was observed and what must
 *   change. That is the difference between a revision and a redesign.
 * - **The axes are compared one at a time.** Three hooks times two pacings
 *   times two audios times two CTAs is twenty-four renders and a reviewer who
 *   cannot hold the comparison in their head. Staged elimination is four small
 *   comparisons, each of which a person can actually judge.
 * - **Nothing here scores creative quality on the system's behalf.** Measured
 *   checks are measured from the produced file; craft dimensions carry
 *   `HUMAN_JUDGEMENT_REQUIRED` and no number. A pipeline that graded its own
 *   advertisement would be the failure this whole milestone is trying to fix.
 */

export const CREATIVE_FINISHING_BRIEF_VERSION = 1 as const;

export const FINISHING_EXIT_CODES = {
  ...EXIT_CODES,
  /** The critique could not be accepted — vague, contradictory or off the master. */
  BRIEF_REFUSED: 20,
  /** The reviewer's variation directives were refused. */
  DIRECTIVES_REFUSED: 21,
  /** A stage was proposed or selected out of the fixed elimination order. */
  STAGE_OUT_OF_ORDER: 22,
  /** Something downstream of a stage was attempted with no recorded human selection. */
  HUMAN_SELECTION_REQUIRED: 23,
  /** The named candidate is unknown, or its bytes are not the bytes on disk. */
  CANDIDATE_STALE_OR_UNKNOWN: 24,
  /** A human premium scorecard is required and none has been submitted. */
  SCORECARD_REQUIRED: 25,
  /** Every stage is settled and the finished master still does not clear the bar. */
  NOT_PREMIUM_READY: 26,
} as const;
export type FinishingExitCode = (typeof FINISHING_EXIT_CODES)[keyof typeof FINISHING_EXIT_CODES];

export const FINISHING_RUN_NOTICE =
  'A named reviewer authored the critique and every variation directive in this run. Application code applied them deterministically, enforced one revision axis at a time, and decided nothing creative. No candidate is promoted without a recorded human selection, and no run is PREMIUM_READY without a human scorecard.' as const;

export const FINISHING_MEASUREMENT_NOTICE =
  'Measured checks are measured from the produced file. Craft dimensions are HUMAN_JUDGEMENT_REQUIRED and carry no machine score: nothing here grades creative quality on the system’s behalf.' as const;

export class FinishingContractError extends Error {
  constructor(
    message: string,
    public readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = 'FinishingContractError';
  }
}

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256 digest');

const IsoInstantSchema = z
  .string()
  .datetime({ offset: true })
  .describe('ISO-8601 instant with an offset');

/* -------------------------------------------------------------------------- */
/* Timestamped critique                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What kind of thing is wrong.
 *
 * A closed vocabulary rather than free text, because the category decides
 * which revision axis can even address the defect. "The hook is weak" and
 * "the audio is flat" are not the same class of problem and cannot be fixed by
 * the same comparison.
 */
export const DEFECT_CATEGORIES = [
  'FIRST_FRAME',
  'HOOK',
  'PACING',
  'PRODUCT_COMPREHENSION',
  'FOOTAGE',
  'MOTION_DESIGN',
  'TYPOGRAPHY',
  'TRANSITION',
  'AUDIO',
  'CTA',
  'BRAND',
  'RIGHTS',
  'PLATFORM_READABILITY',
] as const;
export const DefectCategorySchema = z.enum(DEFECT_CATEGORIES);
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];

/**
 * Phrases that describe a feeling rather than an observation.
 *
 * A defect a renderer cannot act on is not a defect report, it is a mood. The
 * check is deliberately crude and deliberately loud: it fires on the whole
 * `observed` or `requiredCorrection` string being one of these and nothing
 * else, so a reviewer who writes "punchier — the cut sits on the wide for a
 * beat too long before the tap lands" is never blocked.
 */
const VAGUE_PHRASES: readonly RegExp[] = [
  /^(?:make it |be )?(?:punchier|snappier|better|nicer|cleaner|slicker|cooler)\.?$/i,
  /^(?:needs?|wants?) (?:work|improvement|more (?:energy|impact|punch))\.?$/i,
  /^(?:more|less) (?:premium|professional|agency|polish|energy|impact|punch)\.?$/i,
  /^(?:i )?do(?:n'?t| not) like it\.?$/i,
  /^(?:it'?s )?(?:boring|flat|weak|bad|meh)\.?$/i,
  /^fix (?:it|this|the (?:hook|pacing|audio|cta))\.?$/i,
];

function readsAsVague(text: string): boolean {
  const trimmed = text.trim();
  return VAGUE_PHRASES.some((pattern) => pattern.test(trimmed));
}

export const TimestampedDefectSchema = z
  .object({
    id: z.string().min(1).max(80),
    /** Where in the master the reviewer saw it. */
    startSeconds: z.number().min(0).max(600),
    endSeconds: z.number().min(0).max(600),
    category: DefectCategorySchema,
    /**
     * What is observably wrong. Must describe something visible in the frame
     * or audible in the mix, not how the reviewer felt about it.
     */
    observed: z.string().min(25).max(600),
    /** What must change. The renderer has to be able to act on this. */
    requiredCorrection: z.string().min(20).max(600),
    severity: z.enum(['BLOCKING', 'MAJOR', 'MINOR']),
  })
  .strict()
  .superRefine((defect, ctx) => {
    if (defect.endSeconds <= defect.startSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endSeconds'],
        message: `defect "${defect.id}" ends at ${defect.endSeconds}s, at or before its ${defect.startSeconds}s start — a defect with no duration names no moment`,
      });
    }
    for (const [field, value] of [
      ['observed', defect.observed],
      ['requiredCorrection', defect.requiredCorrection],
    ] as const) {
      if (readsAsVague(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `defect "${defect.id}" ${field} reads as a feeling ("${value.trim()}") rather than something a render decision can act on. Name what is on screen and what must change instead.`,
        });
      }
    }
  });
export type TimestampedDefect = z.infer<typeof TimestampedDefectSchema>;

/**
 * Something the revision must not break.
 *
 * Recorded because directed revision's characteristic failure is fixing the
 * complained-about beat and silently losing the one that was working. A
 * protected strength is the reviewer saying "not this".
 */
export const ProtectedStrengthSchema = z
  .object({
    id: z.string().min(1).max(80),
    startSeconds: z.number().min(0).max(600),
    endSeconds: z.number().min(0).max(600),
    description: z.string().min(20).max(400),
  })
  .strict()
  .refine((strength) => strength.endSeconds > strength.startSeconds, {
    message: 'a protected strength must name a time range',
    path: ['endSeconds'],
  });
export type ProtectedStrength = z.infer<typeof ProtectedStrengthSchema>;

/* -------------------------------------------------------------------------- */
/* Prohibitions                                                                */
/* -------------------------------------------------------------------------- */

export const FinishingProhibitionsSchema = z
  .object({
    /** Asset ids that must not appear, and why. */
    assets: z.array(z.object({ assetId: z.string().min(1), reason: z.string().min(10) }).strict()),
    /** Brands, marks and wordmarks that must not be visible. */
    brands: z.array(z.string().min(1).max(120)).max(64),
    /** Claims that must not be made. */
    claims: z.array(z.string().min(10).max(400)).max(64),
    /** Implications that must not be created. */
    implications: z.array(z.string().min(10).max(400)).max(64),
  })
  .strict();
export type FinishingProhibitions = z.infer<typeof FinishingProhibitionsSchema>;

/* -------------------------------------------------------------------------- */
/* The brief                                                                   */
/* -------------------------------------------------------------------------- */

export const TargetThresholdsSchema = z
  .object({
    /** Every gated dimension must reach this to clear PREMIUM_READY. */
    gatedDimensionMinimum: z.number().min(1).max(10),
    /** The reviewer's own overall score must reach this. */
    overallHumanMinimum: z.number().min(1).max(10),
  })
  .strict();

export const CreativeFinishingBriefSchema = z
  .object({
    briefVersion: z.literal(CREATIVE_FINISHING_BRIEF_VERSION),
    briefId: z.string().min(1).max(80),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),

    /** The master being finished, pinned by content. */
    sourceMasterPath: z.string().min(1),
    sourceMasterSha256: Sha256Schema,
    /** The plan that produced it, pinned by content. */
    sourcePlanPath: z.string().min(1),
    sourcePlanSha256: Sha256Schema,

    reviewer: z
      .object({ name: z.string().min(2).max(200), role: z.string().min(2).max(200) })
      .strict(),
    reviewedAt: IsoInstantSchema,

    defects: z.array(TimestampedDefectSchema).min(1).max(64),
    protectedStrengths: z.array(ProtectedStrengthSchema).max(32),

    /** The direction chosen for this round, in the reviewer's words. */
    selectedCreativeDirection: z.string().min(40).max(1200),

    approvedFootageAssetIds: z.array(z.string().min(1).max(80)).min(1).max(64),
    approvedUiAssetIds: z.array(z.string().min(1).max(80)).max(32),
    prohibitions: FinishingProhibitionsSchema,

    platform: z.enum(['TIKTOK', 'INSTAGRAM_REELS', 'YOUTUBE_SHORTS']),
    durationSeconds: z.number().positive().max(120),
    cta: z
      .object({ headline: z.string().min(1).max(80), subline: z.string().min(1).max(120) })
      .strict(),

    thresholds: TargetThresholdsSchema,
  })
  .strict()
  .superRefine((brief, ctx) => {
    for (const [index, defect] of brief.defects.entries()) {
      if (defect.endSeconds > brief.durationSeconds) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defects', index, 'endSeconds'],
          message: `defect "${defect.id}" ends at ${defect.endSeconds}s, past the ${brief.durationSeconds}s master`,
        });
      }
    }
    for (const [index, strength] of brief.protectedStrengths.entries()) {
      if (strength.endSeconds > brief.durationSeconds) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['protectedStrengths', index, 'endSeconds'],
          message: `protected strength "${strength.id}" ends past the ${brief.durationSeconds}s master`,
        });
      }
    }
    const ids = new Set<string>();
    for (const [index, defect] of brief.defects.entries()) {
      if (ids.has(defect.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defects', index, 'id'],
          message: `duplicate defect id "${defect.id}"`,
        });
      }
      ids.add(defect.id);
    }
    // A prohibited asset that is also approved is a brief that contradicts
    // itself, and the render would silently honour whichever check ran last.
    const prohibited = new Set(brief.prohibitions.assets.map((entry) => entry.assetId));
    for (const approved of [...brief.approvedFootageAssetIds, ...brief.approvedUiAssetIds]) {
      if (prohibited.has(approved)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prohibitions', 'assets'],
          message: `asset "${approved}" is both approved and prohibited`,
        });
      }
    }
  });
export type CreativeFinishingBrief = z.infer<typeof CreativeFinishingBriefSchema>;

export function parseCreativeFinishingBrief(
  value: unknown,
  sourcePath?: string,
): CreativeFinishingBrief {
  const result = CreativeFinishingBriefSchema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new FinishingContractError(
    `The creative finishing brief${sourcePath ? ` at ${sourcePath}` : ''} was refused:\n  - ${problems.join('\n  - ')}`,
    problems,
  );
}

/* -------------------------------------------------------------------------- */
/* Revision axes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The four axes compared in sequence, in the order they are compared.
 *
 * The order is not arbitrary. The hook decides whether anything after it is
 * seen, so it is settled first; pacing is judged against a fixed opening;
 * audio is judged against a fixed cut; and the CTA is judged last because it
 * is the only axis whose best answer genuinely depends on everything before
 * it. Reordering these would mean comparing a variable against a variable.
 */
export const REVISION_STAGES = ['HOOK', 'PACING', 'AUDIO', 'CTA'] as const;
export const RevisionStageSchema = z.enum(REVISION_STAGES);
export type RevisionStage = (typeof REVISION_STAGES)[number];

export function nextStage(stage: RevisionStage): RevisionStage | 'FINAL' {
  const index = REVISION_STAGES.indexOf(stage);
  return index === REVISION_STAGES.length - 1
    ? 'FINAL'
    : (REVISION_STAGES[index + 1] as RevisionStage);
}

/**
 * The axes a candidate may vary *within* a stage.
 *
 * `PRODUCT_HOLD`, `IN_POINT_CROP`, `TYPOGRAPHY` and `TRANSITION` are not
 * stages of their own: they are dependent variables that a hook or pacing
 * variant moves as part of expressing itself. Promoting them to stages would
 * add four more comparisons that a reviewer cannot judge in isolation — you
 * cannot look at a transition without looking at the two shots it joins.
 */
export const REVISION_AXES = [
  'HOOK',
  'PACING',
  'AUDIO',
  'CTA',
  'PRODUCT_HOLD',
  'IN_POINT_CROP',
  'TYPOGRAPHY',
  'TRANSITION',
] as const;
export const RevisionAxisSchema = z.enum(REVISION_AXES);
export type RevisionAxis = (typeof REVISION_AXES)[number];

export const CandidateChangeSchema = z
  .object({
    axis: RevisionAxisSchema,
    field: z.string().min(1).max(160),
    from: z.string().min(1).max(300),
    to: z.string().min(1).max(300),
    /** Which brief defect this change is answering, when it is answering one. */
    addressesDefectId: z.string().min(1).max(80).optional(),
  })
  .strict();
export type CandidateChange = z.infer<typeof CandidateChangeSchema>;

export const FinishingCandidateSchema = z
  .object({
    candidateId: z.string().min(1).max(80),
    stage: RevisionStageSchema,
    label: z.string().min(1).max(120),
    /** One sentence a reviewer reads in the gallery before watching. */
    rationale: z.string().min(20).max(600),
    /** The plan this candidate was derived from, pinned by content. */
    basePlanSha256: Sha256Schema,
    /** This candidate's own plan, pinned by content. */
    planSha256: Sha256Schema,
    changesFromBase: z.array(CandidateChangeSchema).min(1).max(64),
    createdAt: IsoInstantSchema,
  })
  .strict();
export type FinishingCandidate = z.infer<typeof FinishingCandidateSchema>;

export const FinishingSelectionSchema = z
  .object({
    stage: RevisionStageSchema,
    selectedCandidateId: z.string().min(1).max(80),
    /** Pins the exact bytes that were approved. */
    selectedPlanSha256: Sha256Schema,
    reviewer: z.string().min(2).max(200),
    selectedAt: IsoInstantSchema,
    /** Why this one, in the reviewer's words. Never generated. */
    reason: z.string().min(20).max(1000),
    /** Timestamped notes carried into the next stage. */
    feedback: z.array(TimestampedDefectSchema).max(32),
  })
  .strict();
export type FinishingSelection = z.infer<typeof FinishingSelectionSchema>;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Canonical JSON, so a checksum is a fact about content rather than about key
 * order or indentation. The same discipline the run-provenance record uses.
 */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.keys(node as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((node as Record<string, unknown>)[key])]),
      );
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

export function sha256OfJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
