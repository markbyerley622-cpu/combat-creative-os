import { z } from 'zod';

/**
 * The product-launch campaign mode, and the brief that distinguishes it.
 *
 * Before this milestone the system had no campaign-type discriminator at all:
 * a `CampaignRequest` described "an advertisement", and every path treated
 * every request identically. This adds the smallest one that does real work.
 *
 * `CAMPAIGN_MODES` deliberately has exactly one member. Event promotion,
 * paid direct response, creator distribution and UGC are **not** listed,
 * because listing a mode nothing implements is how a discriminator becomes
 * decoration — a caller would pass `EVENT_PROMOTION`, every check would accept
 * it, and nothing would behave differently. A later milestone adds its mode
 * together with the behaviour that makes it mean something.
 *
 * Nothing in this file is creative content. It is the *constraint* half of the
 * contract: what the campaign is for, who may approve it, what may never be
 * claimed, and what the brand sounds like. The concepts themselves come from
 * the agents (`LaunchConceptSchema`), never from application code.
 */

export const CAMPAIGN_MODES = ['PRODUCT_LAUNCH'] as const;
export const CampaignModeSchema = z.enum(CAMPAIGN_MODES);
export type CampaignMode = z.infer<typeof CampaignModeSchema>;

/**
 * The verbal half of the brand system.
 *
 * `BrandKit` (in the CLI's campaign request) already carries the visual
 * constants a renderer needs — colours, type family, safe areas. Those say
 * nothing about how the brand *sounds*, which is exactly what a concept has to
 * get right, so it is stated separately rather than smuggled into a colour
 * block.
 */
export const BrandIdentitySchema = z
  .object({
    voice: z.string().min(1).max(600),
    personalityAttributes: z.array(z.string().min(1).max(80)).min(1).max(12),
    /** Registers the brand must never adopt. Binding, like a prohibited claim. */
    prohibitedTone: z.array(z.string().min(1).max(120)).max(12).default([]),
  })
  .strict();
export type BrandIdentity = z.infer<typeof BrandIdentitySchema>;

/**
 * A cutdown the launch must eventually support.
 *
 * Recorded as a constraint the concepts are judged against, not as a render
 * target: this milestone renders the master only, and a concept that cannot
 * survive the shortest required variant is a feasibility finding a reviewer
 * should see before selecting it.
 */
export const LaunchVariantRequirementSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    durationSeconds: z.number().positive().max(120),
    purpose: z.string().min(1).max(300),
  })
  .strict();
export type LaunchVariantRequirement = z.infer<typeof LaunchVariantRequirementSchema>;

/** Concept-set bounds. Fewer than three is not a competition; more than five is not a review. */
export const LAUNCH_MIN_CONCEPT_CANDIDATES = 3;
export const LAUNCH_MAX_CONCEPT_CANDIDATES = 5;

export const ProductLaunchBriefSchema = z
  .object({
    campaignMode: z.literal('PRODUCT_LAUNCH'),

    /** What the product is positioned as. The strategist's starting point, not its output. */
    positioning: z.string().min(1).max(1000),
    /** What the audience should believe afterwards. Distinct from the objective, which is what they should do. */
    desiredAudiencePerception: z.string().min(1).max(1000),

    /**
     * Claims that may never be made, in any wording, by any agent.
     *
     * Carried verbatim into every planning agent's input rather than summarised:
     * a prohibition that survives paraphrase into "be careful about X" is not a
     * prohibition.
     */
    prohibitedClaims: z.array(z.string().min(1).max(300)).max(30).default([]),
    /** Non-negotiable creative direction from the requester (format, structure, legal supers). */
    creativeConstraints: z.array(z.string().min(1).max(300)).max(30).default([]),

    brandIdentity: BrandIdentitySchema,
    requiredVariants: z.array(LaunchVariantRequirementSchema).max(8).default([]),

    /**
     * How many concepts the agents are asked to produce. Bounded by the schema,
     * which is also what bounds this command's worst-case model spend.
     */
    conceptCandidateCount: z
      .number()
      .int()
      .min(LAUNCH_MIN_CONCEPT_CANDIDATES)
      .max(LAUNCH_MAX_CONCEPT_CANDIDATES)
      .default(4),

    /**
     * The approved benchmark profile that must govern this campaign's Creative
     * Memory. Optional here because the CLI takes it as a required flag; when
     * both are present they must agree, because two different answers to "which
     * governance applies" is worse than none.
     */
    benchmarkProfileName: z.string().min(1).max(120).optional(),

    /**
     * The people permitted to decide this concept gate. A selection recorded
     * against anyone else is refused — an approval nobody is accountable for is
     * not an approval.
     */
    approvedReviewerIds: z.array(z.string().min(1).max(200)).min(1).max(20),

    /** The ceiling this run's estimated maximum model spend must fit inside. */
    budgetCeilingCents: z.number().int().nonnegative(),

    /**
     * Product captures every concept may rely on, by capture asset id. A
     * concept may require a subset; it may never require one that is not here,
     * and none of these may be an inspection-only capture.
     */
    requiredCaptureIds: z.array(z.string().min(1).max(80)).max(20).default([]),
  })
  .strict();
export type ProductLaunchBrief = z.infer<typeof ProductLaunchBriefSchema>;

/**
 * The instruction that makes one concept slot different from another.
 *
 * This is orchestration, not creative direction: it says "you are candidate 3
 * of 4, and these structural positions are already taken", using values the
 * agents themselves emitted on the earlier slots. Application code never states
 * what a concept should be — only that this one must not repeat the last one.
 */
export const LaunchConceptDirectiveSchema = z
  .object({
    candidateIndex: z.number().int().min(1).max(LAUNCH_MAX_CONCEPT_CANDIDATES),
    candidateCount: z
      .number()
      .int()
      .min(LAUNCH_MIN_CONCEPT_CANDIDATES)
      .max(LAUNCH_MAX_CONCEPT_CANDIDATES),
    /**
     * Structural positions already occupied by earlier candidates in this same
     * run, as `axis=value` pairs drawn from those candidates' own output.
     */
    occupiedStructuralPositions: z.array(z.string().min(1).max(120)).max(64).default([]),
    /** Titles already used, so a rewrite of the same idea is visibly disallowed. */
    occupiedTitles: z.array(z.string().min(1).max(120)).max(8).default([]),
  })
  .strict();
export type LaunchConceptDirective = z.infer<typeof LaunchConceptDirectiveSchema>;
