import { z } from 'zod';

/**
 * A structured product-launch concept, as a specialist agent produces it.
 *
 * Every field here is **agent-authored**. Application code supplies the brief,
 * the inventory, the constraints and the vocabulary; it never supplies a
 * concept, a hook, a caption, a beat or a timing. That division is the whole
 * point of the milestone, and it is enforced structurally: there is no default,
 * no fallback and no template value anywhere in this file.
 *
 * Seven of the fields are **axes**: a value from a closed structural vocabulary
 * plus the agent's own prose direction for it. The vocabulary exists so
 * distinctness can be compared deterministically rather than by an arbitrary
 * embedding threshold — the same reason `STORY_BEATS` is a closed set rather
 * than free tags. Choosing among the values, and everything said about the
 * choice, remains the agent's work.
 */

function axis<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .object({
      kind: z.enum(values),
      /** The agent's own direction for this axis, in its own words. */
      direction: z.string().min(1).max(1200),
    })
    .strict();
}

// --- Structural axes ---------------------------------------------------------

export const LAUNCH_NARRATIVE_STRUCTURES = [
  'LINEAR_BUILD',
  'PROBLEM_THEN_RESOLUTION',
  'DEMONSTRATION_LED',
  'MONTAGE_ACCUMULATION',
  'CONTRAST_CUT',
  'QUESTION_THEN_ANSWER',
  'SINGLE_CONTINUOUS_MOMENT',
] as const;
export const LaunchNarrativeStructureSchema = z.enum(LAUNCH_NARRATIVE_STRUCTURES);
export type LaunchNarrativeStructure = z.infer<typeof LaunchNarrativeStructureSchema>;

export const LAUNCH_EMOTIONAL_ARCS = [
  'ANTICIPATION_TO_SATISFACTION',
  'TENSION_TO_RELEASE',
  'CURIOSITY_TO_CLARITY',
  'ISOLATION_TO_BELONGING',
  'STEADY_CONFIDENCE',
  'DISORDER_TO_ORDER',
] as const;
export const LaunchEmotionalArcSchema = z.enum(LAUNCH_EMOTIONAL_ARCS);
export type LaunchEmotionalArc = z.infer<typeof LaunchEmotionalArcSchema>;

/** How present the product is, and in what capacity. */
export const LAUNCH_PRODUCT_PRESENCE_STRATEGIES = [
  'PRODUCT_AS_PROTAGONIST',
  'PRODUCT_AS_RESOLUTION',
  'PRODUCT_AS_COMPANION',
  'PRODUCT_AS_LENS',
  'PRODUCT_WITHHELD_UNTIL_END',
] as const;
export const LaunchProductPresenceSchema = z.enum(LAUNCH_PRODUCT_PRESENCE_STRATEGIES);
export type LaunchProductPresence = z.infer<typeof LaunchProductPresenceSchema>;

export const LAUNCH_PACING_TREATMENTS = [
  'ACCELERATING',
  'DECELERATING',
  'SUSTAINED_FAST',
  'SUSTAINED_MEASURED',
  'PUNCTUATED_STILLNESS',
] as const;
export const LaunchPacingTreatmentSchema = z.enum(LAUNCH_PACING_TREATMENTS);
export type LaunchPacingTreatment = z.infer<typeof LaunchPacingTreatmentSchema>;

/** How the real product interface is shown. */
export const LAUNCH_INTERFACE_PRESENTATIONS = [
  'FULL_SCREEN_CAPTURE',
  'INSET_DEVICE_FRAME',
  'MOTION_ISOLATED_DETAIL',
  'INTERFACE_AS_ENVIRONMENT',
  'INTERFACE_AS_PUNCTUATION',
] as const;
export const LaunchInterfacePresentationSchema = z.enum(LAUNCH_INTERFACE_PRESENTATIONS);
export type LaunchInterfacePresentation = z.infer<typeof LaunchInterfacePresentationSchema>;

export const LAUNCH_SOUND_DIRECTIONS = [
  'MUSIC_LED',
  'RHYTHM_LED_DESIGN',
  'AMBIENCE_LED',
  'VOICE_LED',
  'SILENCE_PUNCTUATED',
] as const;
export const LaunchSoundDirectionSchema = z.enum(LAUNCH_SOUND_DIRECTIONS);
export type LaunchSoundDirection = z.infer<typeof LaunchSoundDirectionSchema>;

export const LAUNCH_END_FRAME_STRATEGIES = [
  'BRAND_LOCKUP_HOLD',
  'INTERFACE_WITH_LOCKUP',
  'TYPOGRAPHIC_STATEMENT',
  'MOTION_RESOLVE_TO_MARK',
  'PRODUCT_IN_USE_FREEZE',
] as const;
export const LaunchEndFrameStrategySchema = z.enum(LAUNCH_END_FRAME_STRATEGIES);
export type LaunchEndFrameStrategy = z.infer<typeof LaunchEndFrameStrategySchema>;

/**
 * The production-asset role vocabulary, mirrored for concept requirements.
 *
 * The production register that owns this vocabulary lives above the domain
 * package, so it cannot be imported here. A compile-time equality check on the
 * consuming side keeps the two identical — a duplicated *policy* would be a
 * defect, but a shared *vocabulary* proven equal in both directions is not.
 */
export const LAUNCH_ASSET_ROLES = [
  'SOURCE_CLIP',
  'APP_SCREENSHOT',
  'BRAND_CARD',
  'LOGO',
  'MUSIC',
] as const;
export const LaunchAssetRoleSchema = z.enum(LAUNCH_ASSET_ROLES);
export type LaunchAssetRole = z.infer<typeof LaunchAssetRoleSchema>;

export const LaunchAssetRequirementSchema = z
  .object({
    assetRole: LaunchAssetRoleSchema,
    necessity: z.enum(['REQUIRED', 'PREFERRED']),
    purpose: z.string().min(1).max(400),
  })
  .strict();
export type LaunchAssetRequirement = z.infer<typeof LaunchAssetRequirementSchema>;

/**
 * A claim the advertisement will make, tied to the product fact that makes it
 * true.
 *
 * `factId` is validated against the request's own `productFacts` by the caller.
 * That is what "no product feature or claim may be invented" means in code: a
 * concept that asserts something no supplied fact supports fails validation
 * rather than reaching a reviewer looking plausible.
 */
export const LaunchFactualClaimSchema = z
  .object({
    factId: z.string().min(1).max(80),
    claim: z.string().min(1).max(400),
  })
  .strict();
export type LaunchFactualClaim = z.infer<typeof LaunchFactualClaimSchema>;

/**
 * Where a craft pattern in this concept came from.
 *
 * `referenceId` may only name a reference that appeared in this agent's own
 * Creative Memory context, and naming one grants nothing: the reference stays
 * analysis-only, and no field here can reach a render manifest.
 */
export const LaunchReferencePatternSchema = z
  .object({
    referenceId: z.string().uuid(),
    patternSummary: z.string().min(1).max(400),
    appliedAs: z.string().min(1).max(400),
  })
  .strict();
export type LaunchReferencePattern = z.infer<typeof LaunchReferencePatternSchema>;

export const LaunchFeasibilitySchema = z
  .object({
    confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    /** Capture asset ids this concept cannot be produced without. */
    requiredCaptureIds: z.array(z.string().min(1).max(80)).max(20).default([]),
    risks: z.array(z.string().min(1).max(300)).max(12).default([]),
    /** How the concept survives the shortest required variant, in the agent's words. */
    durationFitNote: z.string().min(1).max(600),
  })
  .strict();
export type LaunchFeasibility = z.infer<typeof LaunchFeasibilitySchema>;

// --- The concept -------------------------------------------------------------

export const LaunchConceptSchema = z
  .object({
    conceptSchemaVersion: z.literal(1),
    title: z.string().min(1).max(120),
    centralIdea: z.string().min(1).max(1200),
    intendedAudienceResponse: z.string().min(1).max(800),

    narrativeStructure: axis(LAUNCH_NARRATIVE_STRUCTURES),
    emotionalArc: axis(LAUNCH_EMOTIONAL_ARCS),
    productPresence: axis(LAUNCH_PRODUCT_PRESENCE_STRATEGIES),
    interfacePresentation: axis(LAUNCH_INTERFACE_PRESENTATIONS),
    pacing: axis(LAUNCH_PACING_TREATMENTS),
    soundDesign: axis(LAUNCH_SOUND_DIRECTIONS),
    endFrame: axis(LAUNCH_END_FRAME_STRATEGIES),

    /** How combat culture and the product relate in this concept, rather than merely coexist. */
    combatCultureRelationship: z.string().min(1).max(1200),
    cinematographyDirection: z.string().min(1).max(1200),
    motionDesignDirection: z.string().min(1).max(1200),
    typographyDirection: z.string().min(1).max(1200),

    assetRoleRequirements: z.array(LaunchAssetRequirementSchema).min(1).max(12),
    factualProductClaims: z.array(LaunchFactualClaimSchema).min(1).max(12),
    /** What this concept must never be read as implying. The agent's own guardrails. */
    prohibitedImplications: z.array(z.string().min(1).max(300)).max(12).default([]),

    originalityRationale: z.string().min(1).max(1500),
    referencePatternProvenance: z.array(LaunchReferencePatternSchema).max(12).default([]),
    feasibility: LaunchFeasibilitySchema,
  })
  .strict();
export type LaunchConcept = z.infer<typeof LaunchConceptSchema>;

/**
 * The eight axes distinctness is compared across, named once.
 *
 * Seven read a closed vocabulary value; the eighth is the central idea, which
 * is prose and is compared by content-word overlap. Stated as data so the
 * comparison, the report and the agent's own directive all use the same list.
 */
export const LAUNCH_STRUCTURAL_AXES = [
  'narrativeStructure',
  'emotionalArc',
  'productPresence',
  'interfacePresentation',
  'pacing',
  'soundDesign',
  'endFrame',
] as const;
export type LaunchStructuralAxis = (typeof LAUNCH_STRUCTURAL_AXES)[number];

export const LAUNCH_DISTINCTNESS_AXES = [...LAUNCH_STRUCTURAL_AXES, 'centralIdea'] as const;
export type LaunchDistinctnessAxis = (typeof LAUNCH_DISTINCTNESS_AXES)[number];

/** `axis=value` pairs, used to tell a later candidate what is already taken. */
export function structuralPositionsOf(concept: LaunchConcept): readonly string[] {
  return LAUNCH_STRUCTURAL_AXES.map((axisName) => `${axisName}=${concept[axisName].kind}`);
}
