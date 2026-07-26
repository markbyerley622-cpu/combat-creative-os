import { z } from 'zod';
import {
  MotionIntensitySchema,
  QualityFailureCategorySchema,
  QualityFailureSeveritySchema,
  TextSafeAreaSchema,
  TransitionTypeSchema,
} from '@combat/domain';

export const ShotPromptEngineerInputSchema = z.object({
  shot: z.object({
    index: z.number().int().nonnegative(),
    description: z.string().min(1),
    durationFrames: z.number().int().positive(),
  }),
  visualDirection: z.string().min(1),
  providerId: z.string().min(1),
  /** Set only on a regeneration attempt driven by QC/Continuity revision feedback. */
  priorRevisionFeedback: z
    .object({
      category: QualityFailureCategorySchema,
      severity: QualityFailureSeveritySchema,
      description: z.string().min(1),
      suggestedAction: z.string().optional(),
    })
    .optional(),
  /** The requester's brief, verbatim. See `CampaignStrategistInputSchema` for why the summary is not a substitute. */
  campaignPrompt: z.string().min(1).max(8000).optional(),
  /** Binding product/event facts as `PRODUCT — …` / `EVENT — …` lines. */
  factualConstraints: z.array(z.string().min(1)).default([]),
});
export type ShotPromptEngineerInput = z.infer<typeof ShotPromptEngineerInputSchema>;

/**
 * The full structured shot brief the Activity persists as a
 * `ShotSpecification` (`@combat/domain`) — M6 requirement 3's "canonical
 * ShotSpecification" fields, minus the identity/versioning/licensing
 * bookkeeping the Activity itself owns (campaign/concept/script identity,
 * `promptVersionId`, `referenceAssetIds`, `licensingConstraints`): those
 * come from validated upstream inputs and repository lookups the agent
 * never touches directly, not from the model's own judgment.
 */
export const ShotPromptEngineerResultSchema = z.object({
  providerId: z.string().min(1),
  promptText: z.string().min(1),
  negativePrompt: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),

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
  continuityRequirements: z.array(z.string().min(1)).default([]),
  qualityRubric: z.array(z.string().min(1)).default([]),
});
export type ShotPromptEngineerResult = z.infer<typeof ShotPromptEngineerResultSchema>;
