import type { ReferenceBusinessRole } from './creative-memory';
import type { NarrativeStage } from './creative-memory-retrieval';
import { MAX_QUERY_CHARACTERS } from './creative-memory-retrieval';
import type {
  CreativeMemoryAgentRole,
  CreativeMemoryObservationField,
} from './creative-memory-injection';

/**
 * Role-specific retrieval plans — what each specialist agent is allowed to ask
 * Creative Memory, and what it is allowed to be told.
 *
 * A single "search the library" call would give four agents the same answer to
 * four different questions. The Strategist needs to know how tension and
 * positioning were established; the Shot-Prompt Engineer needs to know how a
 * camera moved. So each role gets its own plan: its own Creative Memory roles,
 * its own query construction, its own permitted observation fields, its own
 * top-K and context budget.
 *
 * Plans are **versioned data, not behaviour**. Changing a plan changes what an
 * approved campaign was planned against, so a plan is never edited in place —
 * `planVersion` is bumped, and the version travels in every context and every
 * provenance record.
 *
 * Pure: nothing here reads a clock, a filesystem or an environment variable,
 * and query construction is a total function of the plan and its inputs. That
 * is what makes two runs of the same request produce byte-identical queries.
 */

// --- Plan shape --------------------------------------------------------------

/** The named inputs a plan may draw on. Enumerated so a plan declares its dependencies. */
export const RETRIEVAL_QUERY_INPUTS = [
  'CAMPAIGN_PROMPT',
  'FACTUAL_CONSTRAINTS',
  'OBJECTIVE',
  'TARGET_AUDIENCE',
  'BRAND_SYSTEM',
  'PLATFORM',
  'TARGET_DURATION_SECONDS',
  'CALL_TO_ACTION',
  'STRATEGY_OUTPUT',
  'CONCEPT_OUTPUT',
  'SCRIPT_SHOT',
] as const;
export type RetrievalQueryInput = (typeof RETRIEVAL_QUERY_INPUTS)[number];

export interface CreativeMemoryRetrievalPlan {
  readonly planKey: string;
  readonly planVersion: number;
  readonly agentRole: CreativeMemoryAgentRole;
  /** The craft concerns this role is retrieving against. Travels into the context. */
  readonly focusAreas: readonly string[];
  /** Creative Memory business roles queried, in order. One search per role, merged. */
  readonly referenceRoles: readonly ReferenceBusinessRole[];
  readonly queryInputs: readonly RetrievalQueryInput[];
  /** Observation fields that may be populated for this role. Everything else is dropped. */
  readonly permittedObservations: readonly CreativeMemoryObservationField[];
  readonly candidateCount: number;
  readonly topK: number;
  /** Ceiling on the serialised context, in characters. Enforced before the agent sees it. */
  readonly maxContextCharacters: number;
  /** Source-diversity: no reference may contribute more than this many items. */
  readonly maxItemsPerReference: number;
  /**
   * Source-diversity: how many distinct references the context should draw on.
   * Enforced only up to what the eligible pool actually offers — a library with
   * one matching reference is a small library, not a diversity failure.
   */
  readonly minDistinctReferences: number;
  /** Only an approved, active benchmark profile and approved annotations qualify. */
  readonly minimumGovernanceStatus: 'APPROVED_AND_ACTIVE';
  readonly tieBreak: 'RANK_THEN_REFERENCE_ID_THEN_SCENE_ID';
  /**
   * What happens when the plan yields nothing usable. Always
   * `CONTINUE_WITHOUT_CONTEXT` at the plan level; `--creative-memory required`
   * escalates it to a run failure at the CLI level, so the escalation lives in
   * one place instead of being duplicated per plan.
   */
  readonly fallbackBehaviour: 'CONTINUE_WITHOUT_CONTEXT';
  /** System-authored instruction attached to every item this plan produces. */
  readonly intendedApplication: string;
  /** Narrative stage this role reasons about, when it is fixed rather than per-shot. */
  readonly narrativeStage?: NarrativeStage;
}

// --- The four plans ----------------------------------------------------------

const STRATEGIST: CreativeMemoryRetrievalPlan = {
  planKey: 'CAMPAIGN_STRATEGIST_CRAFT_V1',
  planVersion: 1,
  agentRole: 'CAMPAIGN_STRATEGIST',
  focusAreas: [
    'audience tension',
    'positioning',
    'hook strategy',
    'value proposition',
    'campaign objective',
    'CTA strategy',
  ],
  referenceRoles: ['CAMPAIGN_STRATEGY', 'PERFORMANCE_ANALYSIS'],
  queryInputs: [
    'CAMPAIGN_PROMPT',
    'OBJECTIVE',
    'TARGET_AUDIENCE',
    'FACTUAL_CONSTRAINTS',
    'PLATFORM',
    'TARGET_DURATION_SECONDS',
    'CALL_TO_ACTION',
  ],
  permittedObservations: ['hookMechanism', 'narrativeStructure'],
  candidateCount: 24,
  topK: 4,
  maxContextCharacters: 6000,
  maxItemsPerReference: 2,
  minDistinctReferences: 2,
  minimumGovernanceStatus: 'APPROVED_AND_ACTIVE',
  tieBreak: 'RANK_THEN_REFERENCE_ID_THEN_SCENE_ID',
  fallbackBehaviour: 'CONTINUE_WITHOUT_CONTEXT',
  intendedApplication:
    'Use as evidence about which audience tension and hook strategy earn attention on this format. Derive your own positioning and CTA strategy from this campaign’s facts; do not restate the reference.',
  narrativeStage: 'HOOK',
};

const CREATIVE_DIRECTOR: CreativeMemoryRetrievalPlan = {
  planKey: 'CREATIVE_DIRECTOR_CRAFT_V1',
  planVersion: 1,
  agentRole: 'CREATIVE_DIRECTOR',
  focusAreas: [
    'visual concept',
    'narrative arc',
    'attention pattern',
    'visual hierarchy',
    'pacing philosophy',
    'brand treatment',
  ],
  referenceRoles: ['CREATIVE_DIRECTION', 'COPY_AND_BRAND_CONTROL', 'VISUAL_QUALITY_CONTROL'],
  queryInputs: [
    'CAMPAIGN_PROMPT',
    'STRATEGY_OUTPUT',
    'BRAND_SYSTEM',
    'FACTUAL_CONSTRAINTS',
    'PLATFORM',
    'TARGET_DURATION_SECONDS',
  ],
  permittedObservations: [
    'hookMechanism',
    'narrativeStructure',
    'typographyBehaviour',
    'soundProgression',
  ],
  candidateCount: 24,
  topK: 4,
  maxContextCharacters: 8000,
  maxItemsPerReference: 2,
  minDistinctReferences: 2,
  minimumGovernanceStatus: 'APPROVED_AND_ACTIVE',
  tieBreak: 'RANK_THEN_REFERENCE_ID_THEN_SCENE_ID',
  fallbackBehaviour: 'CONTINUE_WITHOUT_CONTEXT',
  intendedApplication:
    'Use as evidence about attention pattern, visual hierarchy and pacing philosophy. Express your concept as your own explicit properties — contrast, framing, rhythm, typography — grounded in this brand’s system.',
};

const SCRIPT_TIMING_DIRECTOR: CreativeMemoryRetrievalPlan = {
  planKey: 'SCRIPT_TIMING_DIRECTOR_CRAFT_V1',
  planVersion: 1,
  agentRole: 'SCRIPT_TIMING_DIRECTOR',
  focusAreas: [
    'opening-hook latency',
    'beat density',
    'information order',
    'transition timing',
    'caption density',
    'CTA timing',
  ],
  referenceRoles: ['SCRIPT_AND_TIMING', 'PLATFORM_OPTIMISATION'],
  queryInputs: [
    'CAMPAIGN_PROMPT',
    'CONCEPT_OUTPUT',
    'TARGET_DURATION_SECONDS',
    'PLATFORM',
    'CALL_TO_ACTION',
    'FACTUAL_CONSTRAINTS',
  ],
  permittedObservations: ['narrativeStructure', 'transitionCategory'],
  candidateCount: 24,
  topK: 5,
  maxContextCharacters: 8000,
  maxItemsPerReference: 3,
  minDistinctReferences: 2,
  minimumGovernanceStatus: 'APPROVED_AND_ACTIVE',
  tieBreak: 'RANK_THEN_REFERENCE_ID_THEN_SCENE_ID',
  fallbackBehaviour: 'CONTINUE_WITHOUT_CONTEXT',
  intendedApplication:
    'Use the measured first-cut latency, cut rate and CTA placement as timing evidence. Derive your own beat lengths and information order from this brief — never reproduce a reference’s ordered beat sequence.',
};

const SHOT_PROMPT_ENGINEER: CreativeMemoryRetrievalPlan = {
  planKey: 'SHOT_PROMPT_ENGINEER_CRAFT_V1',
  planVersion: 1,
  agentRole: 'SHOT_PROMPT_ENGINEER',
  focusAreas: [
    'composition',
    'camera movement',
    'lighting',
    'motion design',
    'transition mechanics',
    'continuity',
    'reference-control guidance',
  ],
  referenceRoles: ['MOTION_AND_TRANSITIONS', 'PREVISUALISATION', 'CONTINUITY_AND_EDITORIAL'],
  queryInputs: ['CAMPAIGN_PROMPT', 'CONCEPT_OUTPUT', 'SCRIPT_SHOT', 'PLATFORM', 'BRAND_SYSTEM'],
  permittedObservations: ['cameraMovement', 'transitionCategory', 'typographyBehaviour'],
  candidateCount: 24,
  topK: 3,
  maxContextCharacters: 5000,
  maxItemsPerReference: 2,
  minDistinctReferences: 1,
  minimumGovernanceStatus: 'APPROVED_AND_ACTIVE',
  tieBreak: 'RANK_THEN_REFERENCE_ID_THEN_SCENE_ID',
  fallbackBehaviour: 'CONTINUE_WITHOUT_CONTEXT',
  intendedApplication:
    'Use as evidence about camera movement, motion design and transition mechanics for this beat. Specify your own composition, lighting and continuity requirements; do not describe a reference’s frames.',
};

export const CREATIVE_MEMORY_RETRIEVAL_PLANS: Readonly<
  Record<CreativeMemoryAgentRole, CreativeMemoryRetrievalPlan>
> = {
  CAMPAIGN_STRATEGIST: STRATEGIST,
  CREATIVE_DIRECTOR,
  SCRIPT_TIMING_DIRECTOR,
  SHOT_PROMPT_ENGINEER,
};

// --- Query construction ------------------------------------------------------

export interface RetrievalPlanInputs {
  readonly campaignPrompt: string;
  readonly factualConstraints: readonly string[];
  readonly objective: string;
  readonly targetAudience: string;
  readonly brandSystem: string;
  readonly platform: string;
  readonly targetDurationSeconds: number;
  readonly ctaHeadline: string;
  /** Campaign Strategist output, available to every later role. */
  readonly strategy?: {
    readonly positioning: string;
    readonly targetAudienceSummary: string;
    readonly keyMessages: readonly string[];
    readonly toneGuidelines: readonly string[];
  };
  /** Creative Director output. */
  readonly concept?: {
    readonly logline: string;
    readonly visualDirection: string;
    readonly narrativeArc: string;
  };
  /** The specific shot being briefed. Only the Shot-Prompt Engineer plan uses it. */
  readonly shot?: {
    readonly index: number;
    readonly description: string;
    readonly beat: string;
  };
}

/** Which narrative stage a scripted beat corresponds to. Structural, not a judgement. */
export function narrativeStageForBeat(beat: string): NarrativeStage {
  switch (beat) {
    case 'HOOK':
      return 'HOOK';
    case 'PROMISE':
      return 'SETUP';
    case 'CTA':
      return 'CALL_TO_ACTION';
    default:
      return 'DEMONSTRATION';
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface BuiltRetrievalQuery {
  readonly text: string;
  /** Inputs the plan asked for that were not supplied. Recorded, never silently ignored. */
  readonly missingInputs: readonly RetrievalQueryInput[];
  readonly narrativeStage?: NarrativeStage;
}

/**
 * Builds the query text for a plan.
 *
 * Sections are emitted in the plan's declared `queryInputs` order and joined
 * with a newline, so two runs of the same request produce the same string and
 * two different briefs produce different ones. The whole thing is truncated to
 * the query ceiling by a plain slice rather than by dropping sections, because
 * a deterministic truncation is auditable and a "smart" one is not.
 *
 * Platform is written into the query rather than applied as a hard filter. A
 * hard platform filter on a small library silently empties the context, and the
 * craft this system retrieves — hook latency, cut density, transition mechanics
 * — transfers across vertical short-form platforms. Relevance scoring still
 * rewards a platform match.
 */
export function buildRetrievalQuery(
  plan: CreativeMemoryRetrievalPlan,
  inputs: RetrievalPlanInputs,
): BuiltRetrievalQuery {
  const sections: string[] = [`FOCUS: ${plan.focusAreas.join(', ')}`];
  const missing: RetrievalQueryInput[] = [];

  for (const input of plan.queryInputs) {
    switch (input) {
      case 'CAMPAIGN_PROMPT':
        sections.push(`BRIEF: ${collapse(inputs.campaignPrompt)}`);
        break;
      case 'FACTUAL_CONSTRAINTS':
        if (inputs.factualConstraints.length === 0) missing.push(input);
        else sections.push(`FACTS: ${inputs.factualConstraints.map(collapse).join('; ')}`);
        break;
      case 'OBJECTIVE':
        sections.push(`OBJECTIVE: ${collapse(inputs.objective)}`);
        break;
      case 'TARGET_AUDIENCE':
        sections.push(`AUDIENCE: ${collapse(inputs.targetAudience)}`);
        break;
      case 'BRAND_SYSTEM':
        sections.push(`BRAND SYSTEM: ${collapse(inputs.brandSystem)}`);
        break;
      case 'PLATFORM':
        sections.push(`PLATFORM: ${inputs.platform}`);
        break;
      case 'TARGET_DURATION_SECONDS':
        sections.push(`DURATION: ${inputs.targetDurationSeconds}s`);
        break;
      case 'CALL_TO_ACTION':
        sections.push(`CTA: ${collapse(inputs.ctaHeadline)}`);
        break;
      case 'STRATEGY_OUTPUT':
        if (!inputs.strategy) missing.push(input);
        else {
          sections.push(
            `STRATEGY: ${collapse(inputs.strategy.positioning)} | ${collapse(
              inputs.strategy.targetAudienceSummary,
            )} | ${inputs.strategy.keyMessages.map(collapse).join('; ')} | ${inputs.strategy.toneGuidelines
              .map(collapse)
              .join('; ')}`,
          );
        }
        break;
      case 'CONCEPT_OUTPUT':
        if (!inputs.concept) missing.push(input);
        else {
          sections.push(
            `CONCEPT: ${collapse(inputs.concept.logline)} | ${collapse(
              inputs.concept.visualDirection,
            )} | ${collapse(inputs.concept.narrativeArc)}`,
          );
        }
        break;
      case 'SCRIPT_SHOT':
        if (!inputs.shot) missing.push(input);
        else {
          sections.push(
            `SHOT ${inputs.shot.index} (${inputs.shot.beat}): ${collapse(inputs.shot.description)}`,
          );
        }
        break;
      default: {
        // Exhaustiveness: a new query input must be handled here.
        const unreachable: never = input;
        throw new Error(`unhandled retrieval query input ${String(unreachable)}`);
      }
    }
  }

  const narrativeStage = inputs.shot
    ? narrativeStageForBeat(inputs.shot.beat)
    : plan.narrativeStage;

  return {
    text: sections.join('\n').slice(0, MAX_QUERY_CHARACTERS),
    missingInputs: missing,
    ...(narrativeStage ? { narrativeStage } : {}),
  };
}
