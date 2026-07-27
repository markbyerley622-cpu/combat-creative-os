import { z } from 'zod';

import { OriginalityAssessmentSchema } from './creative-memory-originality';
import { LaunchAssetRoleSchema } from './launch-concept';

/**
 * Benchmark assessment of one concept — decision support for the human gate.
 *
 * The hard rule this schema encodes is that **an assessment says what it is**.
 * Every dimension carries a `basis`, and three of the values are honest about
 * being unmeasurable by a machine: strategic clarity, emotional impact and
 * brand distinctiveness are judgements, so they are reported as
 * `HUMAN_JUDGEMENT_REQUIRED` with a `NOT_ASSESSED` verdict rather than given a
 * number that looks like evidence. Nothing here predicts conversion, retention
 * or performance, and nothing here can label a concept agency quality —
 * `agencyGradeClaim` is a literal that only has one value.
 *
 * The dimensions that *are* decided are decided from things that actually
 * exist: the approved asset inventory, the approved capture inventory, the
 * delivery platform, the requested duration, and the deterministic originality
 * evaluator's own output.
 */

export const LAUNCH_ASSESSMENT_DIMENSIONS = [
  'STRATEGIC_CLARITY',
  'PRODUCT_COMPREHENSION',
  'EMOTIONAL_IMPACT',
  'BRAND_DISTINCTIVENESS',
  'NARRATIVE_COHERENCE',
  'VISUAL_FEASIBILITY',
  'ASSET_FEASIBILITY',
  'SOUND_OPPORTUNITY',
  'ORIGINALITY_RISK',
  'PLATFORM_SUITABILITY',
] as const;
export const LaunchAssessmentDimensionSchema = z.enum(LAUNCH_ASSESSMENT_DIMENSIONS);
export type LaunchAssessmentDimension = z.infer<typeof LaunchAssessmentDimensionSchema>;

/**
 * What a dimension's finding actually rests on.
 *
 * `MEASURED_FROM_INVENTORY` means a real count of real approved assets.
 * `DETERMINISTIC_STRUCTURAL_SIGNAL` means a pure function of the concept's own
 * structured fields. `HUMAN_JUDGEMENT_REQUIRED` means this system has nothing
 * to say and is not going to pretend otherwise.
 */
export const LAUNCH_ASSESSMENT_BASES = [
  'MEASURED_FROM_INVENTORY',
  'DETERMINISTIC_STRUCTURAL_SIGNAL',
  'HUMAN_JUDGEMENT_REQUIRED',
] as const;
export const LaunchAssessmentBasisSchema = z.enum(LAUNCH_ASSESSMENT_BASES);
export type LaunchAssessmentBasis = z.infer<typeof LaunchAssessmentBasisSchema>;

export const LAUNCH_ASSESSMENT_VERDICTS = [
  'SUPPORTED',
  'NEEDS_ATTENTION',
  'BLOCKING',
  'NOT_ASSESSED',
] as const;
export const LaunchAssessmentVerdictSchema = z.enum(LAUNCH_ASSESSMENT_VERDICTS);
export type LaunchAssessmentVerdict = z.infer<typeof LaunchAssessmentVerdictSchema>;

export const LaunchDimensionAssessmentSchema = z
  .object({
    dimension: LaunchAssessmentDimensionSchema,
    basis: LaunchAssessmentBasisSchema,
    verdict: LaunchAssessmentVerdictSchema,
    finding: z.string().min(1).max(600),
    /** The concrete facts behind the finding. Empty for a human-judgement dimension. */
    evidence: z.array(z.string().min(1).max(300)).max(12).default([]),
  })
  .strict()
  .superRefine((assessment, ctx) => {
    if (assessment.basis === 'HUMAN_JUDGEMENT_REQUIRED' && assessment.verdict !== 'NOT_ASSESSED') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a dimension that requires human judgement cannot carry a verdict — reporting one would fabricate an assessment nobody made',
        path: ['verdict'],
      });
    }
  });
export type LaunchDimensionAssessment = z.infer<typeof LaunchDimensionAssessmentSchema>;

export const LAUNCH_ASSET_FEASIBILITY_VERDICTS = [
  'FEASIBLE',
  'FEASIBLE_WITH_SUBSTITUTION',
  'INFEASIBLE',
] as const;
export const LaunchAssetFeasibilityVerdictSchema = z.enum(LAUNCH_ASSET_FEASIBILITY_VERDICTS);
export type LaunchAssetFeasibilityVerdict = z.infer<typeof LaunchAssetFeasibilityVerdictSchema>;

export const LaunchAssetFeasibilitySchema = z
  .object({
    verdict: LaunchAssetFeasibilityVerdictSchema,
    /** REQUIRED roles the approved inventory cannot supply at all. */
    missingRequiredRoles: z.array(LaunchAssetRoleSchema).max(8).default([]),
    /** PREFERRED roles the inventory cannot supply. Not blocking. */
    missingPreferredRoles: z.array(LaunchAssetRoleSchema).max(8).default([]),
    /** Capture ids the concept requires that are absent or not output-eligible. */
    missingCaptureIds: z.array(z.string().min(1).max(80)).max(20).default([]),
    satisfiedByAssetIds: z.array(z.string().min(1).max(80)).max(64).default([]),
  })
  .strict();
export type LaunchAssetFeasibility = z.infer<typeof LaunchAssetFeasibilitySchema>;

/** The governing benchmark profile behind one agent role's context. */
export const LaunchGoverningProfileSchema = z
  .object({
    agentRole: z.string().min(1).max(80),
    profileId: z.string().uuid(),
    name: z.string().min(1).max(120),
    version: z.number().int().positive(),
    reviewerId: z.string().min(1).max(200).optional(),
    approvedAt: z.string().min(1).max(40).optional(),
    governingChecksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type LaunchGoverningProfile = z.infer<typeof LaunchGoverningProfileSchema>;

export const LAUNCH_ASSESSMENT_NOTICE =
  'Decision support only. Every dimension is either a measurement of the approved inventory or a deterministic structural signal over the concept’s own fields; none is a prediction of audience response, conversion or campaign performance. Dimensions marked HUMAN_JUDGEMENT_REQUIRED carry no verdict because this system cannot make one. No concept is ever labelled agency quality here — this system is never the source of that claim.' as const;

export const LaunchConceptAssessmentSchema = z
  .object({
    assessmentVersion: z.literal(1),
    conceptId: z.string().min(1).max(80),
    conceptVersion: z.number().int().positive(),
    dimensions: z
      .array(LaunchDimensionAssessmentSchema)
      .length(LAUNCH_ASSESSMENT_DIMENSIONS.length),
    assetFeasibility: LaunchAssetFeasibilitySchema,
    originality: OriginalityAssessmentSchema,
    governingProfiles: z.array(LaunchGoverningProfileSchema).max(8).default([]),
    /**
     * Whether a reviewer may select this concept at all. False only for a
     * concept that cannot be produced or that the originality gate blocked —
     * never for a taste reason, which is not this system's decision.
     */
    selectable: z.boolean(),
    blockingReasons: z.array(z.string().min(1).max(400)).max(12).default([]),
    /** Always this value. A machine has not assessed craft quality and says so. */
    agencyGradeClaim: z.literal('NOT_ASSESSED'),
    requiresHumanApproval: z.literal(true),
    notice: z.literal(LAUNCH_ASSESSMENT_NOTICE),
  })
  .strict();
export type LaunchConceptAssessment = z.infer<typeof LaunchConceptAssessmentSchema>;
