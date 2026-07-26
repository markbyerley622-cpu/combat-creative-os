import { z } from 'zod';

import { ReferenceBusinessRoleSchema } from './creative-memory';
import { CreativeMemoryAgentRoleSchema } from './creative-memory-injection';
import { canonicalJson } from '../canonical-json';

/**
 * Agency benchmark governance — who decided that this library may influence
 * this campaign, for this role, under these limits.
 *
 * Retrieval answers "what is similar". Governance answers "what is permitted",
 * and the two must not be the same decision. A retrieval plan is engineering
 * policy shipped in code; a benchmark profile is an **operational** decision a
 * named human made about a named workspace, and it is the thing that can be
 * withdrawn without a deploy.
 *
 * Three properties are load-bearing:
 *
 * - **Approval is a state, not a flag on a mutable row.** A profile is never
 *   edited once activated; a change is a new version that supersedes the old
 *   one, and `activationProvenance` records who activated what, when, and what
 *   it replaced.
 * - **The stricter limit always wins.** A profile may tighten a retrieval
 *   plan's top-K, context budget and diversity policy. It may never loosen one
 *   — otherwise governance would be a way to buy more context rather than less.
 * - **Nothing here grants output rights.** A benchmark profile authorises
 *   *influence on planning*. It cannot make a reference renderable, and there
 *   is no field in this schema that a render manifest could consume.
 */

export const BENCHMARK_PROFILE_REVIEW_STATUSES = [
  'DRAFT',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export const BenchmarkProfileReviewStatusSchema = z.enum(BENCHMARK_PROFILE_REVIEW_STATUSES);
export type BenchmarkProfileReviewStatus = z.infer<typeof BenchmarkProfileReviewStatusSchema>;

/**
 * Why a profile may not influence a campaign. Every value is a distinct
 * operator response — "nobody approved this" and "this was withdrawn" are not
 * the same problem.
 */
export const BENCHMARK_PROFILE_REJECTIONS = [
  'NOT_APPROVED',
  'NOT_ACTIVE',
  'WRONG_AGENT_ROLE',
  'PLATFORM_NOT_APPLICABLE',
  'CAMPAIGN_NOT_APPLICABLE',
  'WRONG_WORKSPACE',
  'STALE_ACTIVATION',
  /** The stored governing fields no longer hash to the activation checksum. */
  'CHECKSUM_MISMATCH',
] as const;
export const BenchmarkProfileRejectionSchema = z.enum(BENCHMARK_PROFILE_REJECTIONS);
export type BenchmarkProfileRejection = z.infer<typeof BenchmarkProfileRejectionSchema>;

/**
 * Immutable record of an activation. Written once; a later change writes a new
 * profile version carrying `supersedesProfileId`, so the chain is auditable
 * without reading a mutation log that does not exist.
 */
export const BenchmarkActivationProvenanceSchema = z
  .object({
    activatedBy: z.string().min(1).max(200),
    activatedAt: z.coerce.date(),
    supersedesProfileId: z.string().uuid().optional(),
    /** sha256 of the profile's governing fields, so a tampered row is detectable. */
    governingChecksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type BenchmarkActivationProvenance = z.infer<typeof BenchmarkActivationProvenanceSchema>;

export const BenchmarkGovernanceProfileSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    name: z.string().min(1).max(120),
    version: z.number().int().positive(),
    agentRole: CreativeMemoryAgentRoleSchema,

    /** Empty means "every platform". Non-empty is an allowlist. */
    applicablePlatforms: z.array(z.string().min(1).max(80)).max(20).default([]),
    /** Empty means "every campaign in the workspace". Non-empty is an allowlist. */
    applicableCampaignIds: z.array(z.string().uuid()).max(50).default([]),

    active: z.boolean(),
    reviewStatus: BenchmarkProfileReviewStatusSchema,

    /** Reference business roles this profile permits the plan to query. */
    requiredReferenceRoles: z.array(ReferenceBusinessRoleSchema).min(1),
    /** Qdrant collections this profile permits. Empty means "whatever the configured profile uses". */
    allowedCollections: z.array(z.string().min(1).max(200)).max(10).default([]),

    /** Ceilings. Applied as the stricter of these and the retrieval plan's own. */
    maxTopK: z.number().int().min(1).max(20),
    maxContextCharacters: z.number().int().min(200).max(40_000),
    maxItemsPerReference: z.number().int().min(1).max(10),
    minDistinctReferences: z.number().int().min(1).max(10),

    /** Governance requirements, carried into provenance and enforced downstream. */
    requireOriginalTransformation: z.boolean().default(true),
    prohibitedSimilarityRules: z.array(z.string().min(1).max(400)).min(1),
    /**
     * Days after activation at which this profile must be re-reviewed. Absent
     * means it never goes stale on its own. Evaluated against a caller-supplied
     * instant — nothing here reads a clock.
     */
    activationValidForDays: z.number().int().min(1).max(3650).optional(),
    /** Days after which an approved annotation is too old to influence a campaign. */
    annotationValidForDays: z.number().int().min(1).max(3650).optional(),

    reviewerId: z.string().min(1).max(200).optional(),
    approvedAt: z.coerce.date().optional(),
    activationProvenance: BenchmarkActivationProvenanceSchema,

    notes: z.string().max(2000).optional(),
    createdAt: z.coerce.date(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.reviewStatus === 'APPROVED' && (!profile.reviewerId || !profile.approvedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'an APPROVED profile must name its reviewer and its approval instant — an unattributed approval is not an approval',
        path: ['reviewerId'],
      });
    }
    if (profile.active && profile.reviewStatus !== 'APPROVED') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a profile cannot be active while its review status is ${profile.reviewStatus}`,
        path: ['active'],
      });
    }
  });
export type BenchmarkGovernanceProfile = z.infer<typeof BenchmarkGovernanceProfileSchema>;

/**
 * The fields the activation checksum covers.
 *
 * Deliberately the *governing* fields only: notes, reviewer identity and
 * timestamps describe the decision, while these describe what the decision
 * permits. A checksum over everything would change when someone fixed a typo in
 * a note, which would make it useless as a tamper signal.
 */
export function benchmarkProfileGoverningFields(
  profile: Omit<BenchmarkGovernanceProfile, 'activationProvenance' | 'createdAt' | 'id'> & {
    readonly id?: string;
  },
): Record<string, unknown> {
  return {
    workspaceId: profile.workspaceId,
    name: profile.name,
    version: profile.version,
    agentRole: profile.agentRole,
    applicablePlatforms: [...profile.applicablePlatforms].sort(),
    applicableCampaignIds: [...profile.applicableCampaignIds].sort(),
    requiredReferenceRoles: [...profile.requiredReferenceRoles].sort(),
    allowedCollections: [...profile.allowedCollections].sort(),
    maxTopK: profile.maxTopK,
    maxContextCharacters: profile.maxContextCharacters,
    maxItemsPerReference: profile.maxItemsPerReference,
    minDistinctReferences: profile.minDistinctReferences,
    requireOriginalTransformation: profile.requireOriginalTransformation,
    prohibitedSimilarityRules: [...profile.prohibitedSimilarityRules],
    activationValidForDays: profile.activationValidForDays ?? null,
    annotationValidForDays: profile.annotationValidForDays ?? null,
  };
}

/** The exact string the activation checksum is taken over. Hashing happens in Node-side callers. */
export function benchmarkProfileChecksumInput(
  profile: Parameters<typeof benchmarkProfileGoverningFields>[0],
): string {
  return canonicalJson(benchmarkProfileGoverningFields(profile));
}

export interface BenchmarkProfileApplicability {
  readonly workspaceId: string;
  readonly agentRole: BenchmarkGovernanceProfile['agentRole'];
  readonly platform: string;
  readonly campaignId: string;
  /** Caller-supplied instant. Staleness is never evaluated against a clock read here. */
  readonly now: Date;
}

/**
 * Whether a profile may influence this campaign, and if not, exactly why.
 *
 * Returns `null` when the profile is usable. Ordered from cheapest and most
 * fundamental (workspace) outward, so the reported reason is the first real
 * problem rather than an incidental one.
 */
export function benchmarkProfileRejection(
  profile: BenchmarkGovernanceProfile,
  applicability: BenchmarkProfileApplicability,
): BenchmarkProfileRejection | null {
  if (profile.workspaceId !== applicability.workspaceId) return 'WRONG_WORKSPACE';
  if (profile.agentRole !== applicability.agentRole) return 'WRONG_AGENT_ROLE';
  if (profile.reviewStatus !== 'APPROVED') return 'NOT_APPROVED';
  if (!profile.active) return 'NOT_ACTIVE';
  if (
    profile.applicablePlatforms.length > 0 &&
    !profile.applicablePlatforms.includes(applicability.platform)
  ) {
    return 'PLATFORM_NOT_APPLICABLE';
  }
  if (
    profile.applicableCampaignIds.length > 0 &&
    !profile.applicableCampaignIds.includes(applicability.campaignId)
  ) {
    return 'CAMPAIGN_NOT_APPLICABLE';
  }
  if (profile.activationValidForDays !== undefined) {
    const expiresAt =
      profile.activationProvenance.activatedAt.getTime() +
      profile.activationValidForDays * 86_400_000;
    if (applicability.now.getTime() > expiresAt) return 'STALE_ACTIVATION';
  }
  return null;
}

/** Whether an approved annotation is still fresh enough for this profile. */
export function annotationIsStale(
  profile: BenchmarkGovernanceProfile,
  annotationCreatedAt: Date,
  now: Date,
): boolean {
  if (profile.annotationValidForDays === undefined) return false;
  return (
    now.getTime() > annotationCreatedAt.getTime() + profile.annotationValidForDays * 86_400_000
  );
}

// --- Typed injection failures ------------------------------------------------

/**
 * Every way role-specific injection can fail, as a closed vocabulary.
 *
 * A caller branches on these rather than on prose, and `--creative-memory
 * required` maps all of them onto one distinct exit code — which is the whole
 * point: a required-mode run that cannot get governed context must stop, not
 * quietly produce an ungoverned campaign that looks identical.
 */
export const CREATIVE_MEMORY_INJECTION_FAILURES = [
  'MISSING_APPROVED_PROFILE',
  'RETRIEVAL_UNAVAILABLE',
  'NO_ELIGIBLE_REFERENCES',
  'CROSS_WORKSPACE_RESULT',
  'UNSAFE_AGENT_CONTEXT',
  'CONTEXT_BUDGET_OVERFLOW',
  'SOURCE_DIVERSITY_FAILURE',
  'ORIGINALITY_RISK_BLOCKED',
  'STALE_PROFILE_OR_ANNOTATION',
  'MALFORMED_RETRIEVAL_RESPONSE',
] as const;
export const CreativeMemoryInjectionFailureSchema = z.enum(CREATIVE_MEMORY_INJECTION_FAILURES);
export type CreativeMemoryInjectionFailure = z.infer<typeof CreativeMemoryInjectionFailureSchema>;
