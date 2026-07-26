import { z } from 'zod';

import { ReferenceBusinessRoleSchema } from './creative-memory';
import {
  AGENT_SAFE_FORBIDDEN_KEYS,
  AGENT_SAFE_FORBIDDEN_VALUE_PATTERNS,
  CreativeMemoryProfileSchema,
  PacingProfileSchema,
  RerankingFallbackStatusSchema,
} from './creative-memory-retrieval';

/**
 * What Creative Memory is allowed to say to a specialist agent.
 *
 * Retrieval already produces an `AGENT_SAFE` insight. This file defines the
 * narrower thing an agent actually receives: a **role-scoped, budgeted,
 * governed** envelope carrying craft intelligence and measurements, and nothing
 * expressive. The distinction matters because an insight is a search result —
 * neutral about who reads it — whereas a context is an instruction to a
 * particular agent about how to do its own job.
 *
 * Three properties are load-bearing:
 *
 * - **Transferable, not reproducible.** Every field is either a measured number
 *   or a reviewer's abstraction of a technique. There is no wording to lift, no
 *   shot list to replay, no brand, agency, title, path, URL or byte.
 * - **Role-scoped.** The Strategist and the Shot-Prompt Engineer do not receive
 *   the same context, because they are not doing the same work — the retrieval
 *   plan for each role decides which observations may be populated at all.
 * - **Checked, not assumed.** `assertAgentSafeContext` walks the serialised
 *   envelope before every agent invocation and fails closed. A field added
 *   later that the type happens to permit is caught by the walk, not by
 *   whoever last re-read the type.
 *
 * None of this changes rights. A reference is analysis-only before it is
 * retrieved, while it is in an agent's context, and after the campaign ships.
 */

// --- Roles -------------------------------------------------------------------

/**
 * The four planning agents on the real `aamp:generate` path. Deliberately a
 * separate vocabulary from `AGENT_REGISTRY`'s names: this enum is about which
 * *kind of craft question* is being asked, and only agents that consume
 * Creative Memory appear in it.
 */
export const CREATIVE_MEMORY_AGENT_ROLES = [
  'CAMPAIGN_STRATEGIST',
  'CREATIVE_DIRECTOR',
  'SCRIPT_TIMING_DIRECTOR',
  'SHOT_PROMPT_ENGINEER',
] as const;
export const CreativeMemoryAgentRoleSchema = z.enum(CREATIVE_MEMORY_AGENT_ROLES);
export type CreativeMemoryAgentRole = z.infer<typeof CreativeMemoryAgentRoleSchema>;

/** The registry name each role maps onto, so the mapping is stated once. */
export const CREATIVE_MEMORY_ROLE_AGENT_NAMES: Readonly<Record<CreativeMemoryAgentRole, string>> = {
  CAMPAIGN_STRATEGIST: 'campaign-strategist',
  CREATIVE_DIRECTOR: 'creative-director',
  SCRIPT_TIMING_DIRECTOR: 'script-timing-director',
  SHOT_PROMPT_ENGINEER: 'shot-prompt-engineer',
};

// --- Measurements and observations -------------------------------------------

/**
 * Computed facts about a reference, all of them derived from real measurement
 * during ingestion. Nothing here is a judgement, and nothing here identifies
 * the material — a duration and a cut rate describe craft, not content.
 */
export const CreativeMemoryMeasurementsSchema = z
  .object({
    advertisementDurationSeconds: z.number().positive(),
    sceneDurationSeconds: z.number().positive(),
    sceneCount: z.number().int().nonnegative(),
    cutsPerSecond: z.number().min(0),
    averageSceneSeconds: z.number().positive().optional(),
    firstCutSeconds: z.number().min(0).optional(),
    aspectRatio: z.string().min(1).max(16),
    pacing: PacingProfileSchema,
    productRevealSeconds: z.number().min(0).optional(),
    ctaSeconds: z.number().min(0).optional(),
    /**
     * The reference's full ordered scene-duration sequence.
     *
     * Present so the Script/Timing Director can reason about rhythm — and so
     * the originality evaluator can detect a plan that reproduced that rhythm
     * beat for beat, which is the one structural form of copying a
     * measurements-only context could otherwise enable.
     */
    sceneDurationsSeconds: z.array(z.number().positive()).max(64).default([]),
  })
  .strict();
export type CreativeMemoryMeasurements = z.infer<typeof CreativeMemoryMeasurementsSchema>;

/**
 * The reviewer's abstractions of technique. Each is populated only when the
 * role's retrieval plan permits that field — see `permittedObservations` on
 * `CreativeMemoryRetrievalPlan`.
 */
export const CreativeMemoryObservationsSchema = z
  .object({
    hookMechanism: z.string().min(1).max(1000).optional(),
    narrativeStructure: z.string().min(1).max(1000).optional(),
    cameraMovement: z.string().min(1).max(200).optional(),
    transitionCategory: z.string().min(1).max(200).optional(),
    typographyBehaviour: z.string().min(1).max(1000).optional(),
    soundProgression: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type CreativeMemoryObservations = z.infer<typeof CreativeMemoryObservationsSchema>;

/** The observation field names, as a value, so a plan can name them by key. */
export const CREATIVE_MEMORY_OBSERVATION_FIELDS = [
  'hookMechanism',
  'narrativeStructure',
  'cameraMovement',
  'transitionCategory',
  'typographyBehaviour',
  'soundProgression',
] as const;
export type CreativeMemoryObservationField = (typeof CREATIVE_MEMORY_OBSERVATION_FIELDS)[number];

// --- Context -----------------------------------------------------------------

export const CreativeMemoryContextItemSchema = z
  .object({
    referenceId: z.string().uuid(),
    /** The approved annotation this item's craft reading came from. */
    annotationId: z.string().uuid(),
    annotationVersion: z.number().int().positive(),
    sceneId: z.string().uuid(),
    /** Which of the plan's Creative Memory roles matched this reference. */
    contributingRole: ReferenceBusinessRoleSchema,
    retrievalScore: z.number(),
    rerankScore: z.number(),
    finalRank: z.number().int().positive(),
    measurements: CreativeMemoryMeasurementsSchema,
    observations: CreativeMemoryObservationsSchema,
    /** The reviewer's transferable principle, verbatim from the approved annotation. */
    craftPrinciple: z.string().min(1).max(2000),
    /** Role-specific, system-authored instruction for how this may be applied. */
    intendedApplication: z.string().min(1).max(600),
    /** The reviewer's `prohibitedDirectSimilarity`, carried so it travels with the principle. */
    riskWarning: z.string().min(1).max(2000),
  })
  .strict();
export type CreativeMemoryContextItem = z.infer<typeof CreativeMemoryContextItemSchema>;

export const CREATIVE_MEMORY_USAGE_DIRECTIVE =
  'These are craft principles and measurements only. Do not reproduce any reference’s wording, shot order, beat lengths, music, logos or branded assets, and do not name or imitate any agency, studio or existing campaign. Transform each principle into an original application specific to this campaign, and record that transformation in creativeMemoryDivergence.';

export const CREATIVE_MEMORY_NOTICE =
  'Reference material is analysis-only. Retrieval grants no output rights.' as const;

export const CreativeMemoryContextSchema = z
  .object({
    contextVersion: z.literal(1),
    agentRole: CreativeMemoryAgentRoleSchema,
    /** Retrieval plan identity — versioned, so a context records how it was built. */
    planKey: z.string().min(1).max(80),
    planVersion: z.number().int().positive(),
    /** The approved, active benchmark profile that authorised this context. */
    benchmarkProfileName: z.string().min(1).max(120),
    benchmarkProfileVersion: z.number().int().positive(),
    retrievalProfile: CreativeMemoryProfileSchema,
    rerankingProfile: z.string().min(1).max(120),
    fallbackStatus: RerankingFallbackStatusSchema,
    /** sha256 of the canonical query. The query text itself is audit material, not agent material. */
    queryHash: z.string().regex(/^[0-9a-f]{64}$/),
    focusAreas: z.array(z.string().min(1).max(120)).min(1).max(12),
    items: z.array(CreativeMemoryContextItemSchema).min(1).max(20),
    usageDirective: z.literal(CREATIVE_MEMORY_USAGE_DIRECTIVE),
    notice: z.literal(CREATIVE_MEMORY_NOTICE),
  })
  .strict();
export type CreativeMemoryContext = z.infer<typeof CreativeMemoryContextSchema>;

// --- The boundary check ------------------------------------------------------

/**
 * Phrases that would turn a craft principle into an instruction to imitate.
 *
 * Used in two directions: nothing matching may enter a context, and nothing
 * matching may appear in an agent's output. Deliberately a small, explicit list
 * rather than a general classifier — a governance signal that can be read and
 * argued with beats one that cannot.
 */
export const AGENCY_IMITATION_PATTERNS: readonly RegExp[] = [
  /\bin the style of\b/i,
  /\bstyled after\b/i,
  /\bimitat(?:e|es|ed|ing|ion)\b/i,
  /\bmimic(?:k?ing|s)?\b/i,
  /\bre-?create (?:the|their|its)\b/i,
  /\bcopy (?:the|their|its) (?:campaign|advertisement|ad|execution|edit)\b/i,
  /\b(?:advertising|ad|creative) agency\b/i,
  /\bproduction studio\b/i,
];

export interface AgentSafetyViolation {
  /** Dotted path into the serialised envelope, e.g. `items.0.craftPrinciple`. */
  readonly path: string;
  readonly reason: 'FORBIDDEN_KEY' | 'FORBIDDEN_VALUE_PATTERN' | 'AGENCY_IMITATION_INSTRUCTION';
  readonly detail: string;
}

export class UnsafeAgentContextError extends Error {
  constructor(
    public readonly label: string,
    public readonly violations: readonly AgentSafetyViolation[],
  ) {
    super(
      `${label} is not agent-safe:\n${violations
        .map((violation) => `  - ${violation.path}: ${violation.reason} (${violation.detail})`)
        .join('\n')}`,
    );
    this.name = 'UnsafeAgentContextError';
  }
}

/**
 * Fields whose whole purpose is to forbid something.
 *
 * A prohibition necessarily names the thing it prohibits — the standing usage
 * directive says "do not … imitate any agency", and a reviewer's
 * `prohibitedDirectSimilarity` may well say "do not copy their edit". Running
 * the imitation check over those would fail closed on the very text that exists
 * to keep the system safe. They are still walked for forbidden keys and for
 * paths, URLs and media filenames; only the imitation-phrase check is skipped.
 */
function isProhibitionField(path: string): boolean {
  return path === 'usageDirective' || path === 'notice' || path.endsWith('riskWarning');
}

/**
 * Walks the serialised value looking for anything an agent must never receive.
 *
 * Deliberately structural rather than type-driven: the failure mode being
 * guarded against is a field somebody adds later which the type permits and
 * nobody re-reads. A walk over the actual JSON catches that; a type does not.
 */
export function findAgentSafetyViolations(value: unknown, path = ''): AgentSafetyViolation[] {
  const violations: AgentSafetyViolation[] = [];

  if (typeof value === 'string') {
    for (const pattern of AGENT_SAFE_FORBIDDEN_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        violations.push({
          path: path || '<root>',
          reason: 'FORBIDDEN_VALUE_PATTERN',
          detail: `matches ${pattern.source}`,
        });
      }
    }
    if (!isProhibitionField(path)) {
      for (const pattern of AGENCY_IMITATION_PATTERNS) {
        if (pattern.test(value)) {
          violations.push({
            path: path || '<root>',
            reason: 'AGENCY_IMITATION_INSTRUCTION',
            detail: `matches ${pattern.source}`,
          });
        }
      }
    }
    return violations;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      violations.push(...findAgentSafetyViolations(entry, `${path}${path ? '.' : ''}${index}`));
    });
    return violations;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}${path ? '.' : ''}${key}`;
      if ((AGENT_SAFE_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
        violations.push({
          path: childPath,
          reason: 'FORBIDDEN_KEY',
          detail: `"${key}" may never appear in agent-facing material`,
        });
      }
      violations.push(...findAgentSafetyViolations(member, childPath));
    }
  }

  return violations;
}

/** Fails closed. Called immediately before every agent invocation that carries a context. */
export function assertAgentSafeContext(value: unknown, label: string): void {
  const violations = findAgentSafetyViolations(value);
  if (violations.length > 0) throw new UnsafeAgentContextError(label, violations);
}

// --- Divergence --------------------------------------------------------------

export const ORIGINALITY_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const OriginalityRiskLevelSchema = z.enum(ORIGINALITY_RISK_LEVELS);
export type OriginalityRiskLevel = z.infer<typeof OriginalityRiskLevelSchema>;

/**
 * What an agent must return when it was given Creative Memory context.
 *
 * The point is not the prose — it is that the agent has to *name* what it took,
 * what it changed and what it avoided. An agent that cannot articulate the
 * transformation probably did not make one, and the deterministic evaluator in
 * `creative-memory-originality.ts` reads these fields as evidence rather than
 * taking the self-assessed `originalityRiskLevel` at face value.
 */
export const CreativeDivergenceRecordSchema = z
  .object({
    agentRole: CreativeMemoryAgentRoleSchema,
    principlesUsed: z
      .array(
        z
          .object({
            referenceId: z.string().uuid(),
            principleSummary: z.string().min(1).max(400),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    campaignSpecificTransformation: z.string().min(1).max(2000),
    elementsDeliberatelyChanged: z.array(z.string().min(1).max(400)).max(20).default([]),
    prohibitedElementsAvoided: z.array(z.string().min(1).max(400)).max(20).default([]),
    /** The agent's own reading. Advisory: the evaluator may raise it, never lower it. */
    originalityRiskLevel: OriginalityRiskLevelSchema,
    rationale: z.string().min(1).max(1000),
  })
  .strict();
export type CreativeDivergenceRecord = z.infer<typeof CreativeDivergenceRecordSchema>;

// --- Modes -------------------------------------------------------------------

/**
 * `off` preserves the pre-milestone baseline exactly. `optional` uses Creative
 * Memory when a governed, eligible context exists and records why when it does
 * not. `required` treats every one of those as a hard failure before any agent
 * runs — the mode to use when a campaign is only meaningful with benchmark
 * intelligence behind it.
 */
export const CREATIVE_MEMORY_MODES = ['required', 'optional', 'off'] as const;
export const CreativeMemoryModeSchema = z.enum(CREATIVE_MEMORY_MODES);
export type CreativeMemoryMode = z.infer<typeof CreativeMemoryModeSchema>;

/** Why a role ran without context. Recorded in provenance; never silently omitted. */
export const CREATIVE_MEMORY_NOT_USED_REASONS = [
  'MODE_OFF',
  'NO_APPROVED_PROFILE',
  'RETRIEVAL_UNAVAILABLE',
  'NO_ELIGIBLE_REFERENCES',
  'NO_ROLE_MATCHED_REFERENCES',
  'COLLECTION_NOT_PERMITTED',
  'CONTEXT_BUDGET_OVERFLOW',
  'SOURCE_DIVERSITY_FAILURE',
  'STALE_PROFILE_OR_ANNOTATION',
  'MALFORMED_RETRIEVAL_RESPONSE',
] as const;
export const CreativeMemoryNotUsedReasonSchema = z.enum(CREATIVE_MEMORY_NOT_USED_REASONS);
export type CreativeMemoryNotUsedReason = z.infer<typeof CreativeMemoryNotUsedReasonSchema>;
