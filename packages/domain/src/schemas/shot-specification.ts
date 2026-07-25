import { z } from 'zod';
import {
  AspectRatioSchema,
  MotionIntensitySchema,
  TextSafeAreaSchema,
  TransitionTypeSchema,
} from './shared-enums';

/**
 * The Shot Prompt Engineer's generation parameters, echoed onto the
 * ShotSpecification for provenance — deliberately a plain structural
 * subset of `@combat/providers`'s `VideoGenerationParams`, not an import of
 * it: `packages/domain` must not depend on `packages/providers`
 * (dependency direction: workflows -> domain only; activities -> providers).
 * The Activity that dispatches generation is responsible for translating
 * this into the provider package's typed shape.
 */
export const ShotGenerationParamsSchema = z.object({
  durationSeconds: z.number().positive(),
  aspectRatio: AspectRatioSchema,
  resolution: z.string().optional(),
  frameRate: z.number().positive().optional(),
  seed: z.number().int().optional(),
  providerOptions: z.record(z.string(), z.unknown()).default({}),
});
export type ShotGenerationParams = z.infer<typeof ShotGenerationParamsSchema>;

export const ShotOutputRequirementsSchema = z.object({
  durationSeconds: z.number().positive(),
  aspectRatio: AspectRatioSchema,
  resolution: z.string().optional(),
  frameRate: z.number().positive().optional(),
  minCandidateCount: z.number().int().positive().default(1),
});
export type ShotOutputRequirements = z.infer<typeof ShotOutputRequirementsSchema>;

/**
 * Canonical, immutable, versioned generation brief for one shot (M6
 * requirement 3). Produced exclusively by the Shot Prompt Engineer agent via
 * `runShotPromptEngineerActivity` — never hand-written, never mutated once
 * created; a revision is a new row with an incremented `version` for the
 * same `shotId`. `promptVersionId` is mandatory, matching the mandatory-FK
 * precedent this schema's predecessor (`GenerationPrompt`) established for
 * "the prompt version used for every generation must be recorded."
 *
 * References (`campaignId`, `creativeConceptId`/`creativeConceptVersion`,
 * `scriptId`/`scriptVersion`, `shotId`, `referenceAssetIds`) are workspace-
 * scoped ids only — resolving them to full records is always done through
 * the repository layer, never inlined here.
 */
export const ShotSpecificationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  creativeConceptId: z.string().uuid(),
  creativeConceptVersion: z.number().int().positive(),
  scriptId: z.string().uuid(),
  scriptVersion: z.number().int().positive(),
  shotId: z.string().uuid(),
  version: z.number().int().positive(),

  shotNumber: z.number().int().nonnegative(),
  sequencePosition: z.number().int().nonnegative(),
  intendedDurationSeconds: z.number().positive(),

  visualObjective: z.string().min(1),
  action: z.string().min(1),
  subject: z.string().min(1),
  environment: z.string().min(1),
  cameraMovement: z.string().min(1),
  lensFraming: z.string().min(1),
  lighting: z.string().min(1),
  colorTreatment: z.string().min(1),
  motionIntensity: MotionIntensitySchema,
  transitionIn: TransitionTypeSchema,
  transitionOut: TransitionTypeSchema,
  textSafeAreas: z.array(TextSafeAreaSchema).default([]),
  appInterfaceRequirements: z.string().optional(),

  referenceAssetIds: z.array(z.string().uuid()).default([]),
  continuityRequirements: z.array(z.string().min(1)).default([]),

  providerId: z.string().min(1),
  promptVersionId: z.string().uuid(),
  generationPrompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  generationParams: ShotGenerationParamsSchema,

  outputRequirements: ShotOutputRequirementsSchema,
  qualityRubric: z.array(z.string().min(1)).default([]),
  licensingConstraints: z.array(z.string().min(1)).default([]),

  createdByAgentInvocationId: z.string().uuid(),
  createdAt: z.date(),
});
export type ShotSpecification = z.infer<typeof ShotSpecificationSchema>;
