import type { CampaignStrategistResult, CreativeDirectorResult } from '@combat/agents';
import {
  LaunchConceptSchema,
  structuralPositionsOf,
  type CreativeDivergenceRecord,
  type CreativeMemoryContext,
  type LaunchConcept,
  type ProductLaunchBrief,
  type RetrievalPlanInputs,
} from '@combat/domain';
import type { ReasoningProvider } from '@combat/providers';

import { AgentInvocationError, invokeAgent } from '../agent-invocation';
import { formatFactualConstraintsWithIds, type CampaignRequest } from '../campaign-request';
import type { CreativeMemoryInjector } from '../creative-memory/injection';
import { baseRetrievalInputs, type RoleContextRecord } from '../plan-campaign';

/**
 * The concept competition: one strategy, then several genuinely competing
 * concepts, all of them authored by the existing Creative Director agent.
 *
 * What application code contributes here is deliberately narrow. It supplies
 * the brief, the binding facts, the governed Creative Memory context and a
 * *directive* saying which slot this candidate fills and which structural
 * positions the earlier candidates already occupied. It contributes no idea, no
 * hook, no title, no beat and no caption — every one of those comes back from
 * the agent, and a candidate that returns nothing usable is rejected with a
 * reason rather than repaired.
 *
 * The occupied-position list is the only cross-candidate influence, and it is
 * built entirely from values the agent itself emitted on earlier slots. That is
 * what makes this a competition rather than four samples from the same prompt:
 * candidate three is told what one and two took, and is asked for something
 * else.
 */

export class ConceptCompetitionError extends Error {
  constructor(
    public readonly kind: 'AGENT_FAILURE' | 'NO_VALID_CANDIDATES',
    detail: string,
  ) {
    super(detail);
    this.name = 'ConceptCompetitionError';
  }
}

export interface ConceptCandidate {
  readonly conceptId: string;
  readonly candidateIndex: number;
  readonly concept: LaunchConcept;
  /** The full agent result, so the selected concept flows into the existing chain unchanged. */
  readonly director: CreativeDirectorResult;
  readonly agentVersion: string;
  readonly context?: CreativeMemoryContext;
  readonly divergence?: CreativeDivergenceRecord;
}

export interface RejectedCandidate {
  readonly candidateIndex: number;
  readonly reasons: readonly string[];
}

export interface ConceptCompetitionResult {
  readonly strategy: CampaignStrategistResult;
  readonly strategyContext?: CreativeMemoryContext;
  readonly candidates: readonly ConceptCandidate[];
  readonly rejected: readonly RejectedCandidate[];
  readonly agentVersions: readonly string[];
  /** Every agent invocation's Creative Memory record, for provenance and originality. */
  readonly roleContexts: readonly RoleContextRecord[];
}

export interface ConceptCompetitionOptions {
  readonly request: CampaignRequest;
  readonly launchBrief: ProductLaunchBrief;
  readonly reasoningProvider: ReasoningProvider;
  readonly workflowRunId: string;
  readonly injector?: CreativeMemoryInjector;
  readonly newConceptId: () => string;
  readonly onProgress?: (message: string) => void;
}

/**
 * Everything a concept must satisfy before a reviewer is allowed to see it.
 *
 * These are contract checks, not taste: a claim with no supporting fact is an
 * invented claim, and a reference id the agent was never given is a citation of
 * something it cannot have read. Both are defects in the output, and repairing
 * either in application code would mean writing the concept ourselves.
 */
export function validateLaunchConcept(
  result: CreativeDirectorResult,
  options: {
    readonly productFactIds: ReadonlySet<string>;
    readonly permittedReferenceIds: ReadonlySet<string>;
  },
): { readonly concept: LaunchConcept } | { readonly reasons: readonly string[] } {
  if (!result.launchConcept) {
    return {
      reasons: [
        'the agent returned no launchConcept, so there is no structured candidate to review',
      ],
    };
  }

  const parsed = LaunchConceptSchema.safeParse(result.launchConcept);
  if (!parsed.success) {
    return {
      reasons: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
    };
  }
  const concept = parsed.data;
  const reasons: string[] = [];

  for (const claim of concept.factualProductClaims) {
    if (!options.productFactIds.has(claim.factId)) {
      reasons.push(
        `factualProductClaims cites factId "${claim.factId}", which is not one of this campaign's product facts — a claim with no supporting fact is an invented claim`,
      );
    }
  }
  for (const pattern of concept.referencePatternProvenance) {
    if (!options.permittedReferenceIds.has(pattern.referenceId)) {
      reasons.push(
        `referencePatternProvenance cites reference "${pattern.referenceId}", which was not in this invocation's Creative Memory context`,
      );
    }
  }

  return reasons.length > 0 ? { reasons } : { concept };
}

function directorInput(options: {
  readonly request: CampaignRequest;
  readonly launchBrief: ProductLaunchBrief;
  readonly strategy: CampaignStrategistResult;
  readonly factualConstraints: readonly string[];
  readonly candidateIndex: number;
  readonly candidateCount: number;
  readonly occupiedStructuralPositions: readonly string[];
  readonly occupiedTitles: readonly string[];
  readonly context?: CreativeMemoryContext;
  readonly revisionFeedback?: string;
}): Record<string, unknown> {
  return {
    brandName: options.request.brandName,
    strategy: {
      positioning: options.strategy.strategy.positioning,
      targetAudienceSummary: options.strategy.strategy.targetAudienceSummary,
      keyMessages: options.strategy.strategy.keyMessages,
      toneGuidelines: options.strategy.strategy.toneGuidelines,
    },
    mandatories: options.request.mandatories,
    durationsSeconds: [Math.round(options.request.targetDurationSeconds)],
    priorLearnings: [],
    campaignPrompt: options.request.campaignPrompt,
    factualConstraints: options.factualConstraints,
    productLaunch: options.launchBrief,
    launchDirective: {
      candidateIndex: options.candidateIndex,
      candidateCount: options.candidateCount,
      occupiedStructuralPositions: [...options.occupiedStructuralPositions],
      occupiedTitles: [...options.occupiedTitles],
    },
    ...(options.revisionFeedback ? { revisionFeedback: options.revisionFeedback } : {}),
    ...(options.context ? { creativeMemory: options.context } : {}),
  };
}

async function runDirector(
  input: Record<string, unknown>,
  options: ConceptCompetitionOptions,
  stage: string,
): Promise<{ result: CreativeDirectorResult; agentVersion: string }> {
  try {
    const invocation = await invokeAgent<Record<string, unknown>, CreativeDirectorResult>(
      'creative-director',
      input,
      {
        reasoningProvider: options.reasoningProvider,
        workflowRunId: options.workflowRunId,
        campaignId: options.request.campaignId,
        stage,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    );
    return { result: invocation.result, agentVersion: invocation.agentVersion };
  } catch (error) {
    if (error instanceof AgentInvocationError) {
      throw new ConceptCompetitionError('AGENT_FAILURE', error.message);
    }
    throw error;
  }
}

export async function runConceptCompetition(
  options: ConceptCompetitionOptions,
): Promise<ConceptCompetitionResult> {
  const { request, launchBrief, injector } = options;
  const factualConstraints = formatFactualConstraintsWithIds(request);
  const productFactIds = new Set(request.productFacts.map((fact) => fact.id));
  const agentVersions: string[] = [];
  const roleContexts: RoleContextRecord[] = [];

  let retrievalInputs: RetrievalPlanInputs = baseRetrievalInputs(request);

  // --- strategy -------------------------------------------------------------
  const strategyContext = await injector?.contextFor('CAMPAIGN_STRATEGIST', retrievalInputs);
  let strategy: CampaignStrategistResult;
  try {
    const invocation = await invokeAgent<Record<string, unknown>, CampaignStrategistResult>(
      'campaign-strategist',
      {
        brandName: request.brandName,
        objective: request.objective,
        targetPlatforms: [request.platform],
        durationsSeconds: [Math.round(request.targetDurationSeconds)],
        budgetCents: 0,
        keyMessages: request.keyMessages,
        mandatories: request.mandatories,
        priorLearnings: [],
        campaignPrompt: request.campaignPrompt,
        factualConstraints,
        productLaunch: launchBrief,
        ...(strategyContext ? { creativeMemory: strategyContext } : {}),
      },
      {
        reasoningProvider: options.reasoningProvider,
        workflowRunId: options.workflowRunId,
        campaignId: request.campaignId,
        stage: 'LAUNCH_STRATEGY',
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    );
    strategy = invocation.result;
    agentVersions.push(invocation.agentVersion);
  } catch (error) {
    if (error instanceof AgentInvocationError) {
      throw new ConceptCompetitionError('AGENT_FAILURE', error.message);
    }
    throw error;
  }
  roleContexts.push({
    agentRole: 'CAMPAIGN_STRATEGIST',
    ...(strategyContext ? { context: strategyContext } : {}),
    ...(strategy.creativeMemoryDivergence ? { divergence: strategy.creativeMemoryDivergence } : {}),
  });

  retrievalInputs = {
    ...retrievalInputs,
    strategy: {
      positioning: strategy.strategy.positioning,
      targetAudienceSummary: strategy.strategy.targetAudienceSummary,
      keyMessages: strategy.strategy.keyMessages,
      toneGuidelines: strategy.strategy.toneGuidelines,
    },
  };

  // --- competing concepts ---------------------------------------------------
  const candidates: ConceptCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const occupiedStructuralPositions: string[] = [];
  const occupiedTitles: string[] = [];

  for (
    let candidateIndex = 1;
    candidateIndex <= launchBrief.conceptCandidateCount;
    candidateIndex += 1
  ) {
    options.onProgress?.(
      `concept candidate ${candidateIndex} of ${launchBrief.conceptCandidateCount}`,
    );
    // Retrieved per candidate, and checked agent-safe per candidate: each
    // invocation is its own agent call, and a context is validated immediately
    // before the call it belongs to, never once for a batch.
    // eslint-disable-next-line no-await-in-loop -- candidates are produced in slot order so directives stay truthful
    const context = await injector?.contextFor('CREATIVE_DIRECTOR', retrievalInputs);

    // eslint-disable-next-line no-await-in-loop -- same ordering rationale
    const { result, agentVersion } = await runDirector(
      directorInput({
        request,
        launchBrief,
        strategy,
        factualConstraints,
        candidateIndex,
        candidateCount: launchBrief.conceptCandidateCount,
        occupiedStructuralPositions,
        occupiedTitles,
        ...(context ? { context } : {}),
      }),
      options,
      'LAUNCH_CONCEPT',
    );
    agentVersions.push(agentVersion);

    const validation = validateLaunchConcept(result, {
      productFactIds,
      permittedReferenceIds: new Set(context?.items.map((item) => item.referenceId) ?? []),
    });
    if ('reasons' in validation) {
      rejected.push({ candidateIndex, reasons: validation.reasons });
      options.onProgress?.(
        `candidate ${candidateIndex} rejected: ${validation.reasons.join('; ').slice(0, 200)}`,
      );
      continue;
    }

    const conceptId = options.newConceptId();
    candidates.push({
      conceptId,
      candidateIndex,
      concept: validation.concept,
      director: result,
      agentVersion,
      ...(context ? { context } : {}),
      ...(result.creativeMemoryDivergence ? { divergence: result.creativeMemoryDivergence } : {}),
    });
    roleContexts.push({
      agentRole: 'CREATIVE_DIRECTOR',
      ...(context ? { context } : {}),
      ...(result.creativeMemoryDivergence ? { divergence: result.creativeMemoryDivergence } : {}),
    });
    occupiedStructuralPositions.push(...structuralPositionsOf(validation.concept));
    occupiedTitles.push(validation.concept.title);
  }

  return {
    strategy,
    ...(strategyContext ? { strategyContext } : {}),
    candidates,
    rejected,
    agentVersions,
    roleContexts,
  };
}

export interface ConceptRevisionOptions extends ConceptCompetitionOptions {
  readonly strategy: CampaignStrategistResult;
  readonly priorConcept: LaunchConcept;
  readonly priorConceptId: string;
  readonly feedback: string;
  /** The structural positions the *other* concepts in the run occupy. */
  readonly occupiedStructuralPositions: readonly string[];
  readonly occupiedTitles: readonly string[];
  readonly candidateIndex: number;
  readonly candidateCount: number;
}

/**
 * A revision, produced by the same agent through the same execution path.
 *
 * The reviewer's feedback travels in the Creative Director's existing
 * `revisionFeedback` field — the one its prompt has described as binding since
 * v1 — and the prior concept's structural positions are excluded from the
 * "already occupied" list, because the agent is being asked to reconsider that
 * concept, not to avoid it. Nothing here edits concept JSON: the output is
 * whatever the agent returns, validated the same way a first-round candidate is.
 */
export async function reviseConcept(
  options: ConceptRevisionOptions,
): Promise<{ readonly candidate: ConceptCandidate } | { readonly reasons: readonly string[] }> {
  const factualConstraints = formatFactualConstraintsWithIds(options.request);
  const context = await options.injector?.contextFor('CREATIVE_DIRECTOR', {
    ...baseRetrievalInputs(options.request),
    strategy: {
      positioning: options.strategy.strategy.positioning,
      targetAudienceSummary: options.strategy.strategy.targetAudienceSummary,
      keyMessages: options.strategy.strategy.keyMessages,
      toneGuidelines: options.strategy.strategy.toneGuidelines,
    },
  });

  const { result, agentVersion } = await runDirector(
    directorInput({
      request: options.request,
      launchBrief: options.launchBrief,
      strategy: options.strategy,
      factualConstraints,
      candidateIndex: options.candidateIndex,
      candidateCount: options.candidateCount,
      occupiedStructuralPositions: options.occupiedStructuralPositions,
      occupiedTitles: options.occupiedTitles,
      revisionFeedback: options.feedback,
      ...(context ? { context } : {}),
    }),
    options,
    'LAUNCH_CONCEPT_REVISION',
  );

  const validation = validateLaunchConcept(result, {
    productFactIds: new Set(options.request.productFacts.map((fact) => fact.id)),
    permittedReferenceIds: new Set(context?.items.map((item) => item.referenceId) ?? []),
  });
  if ('reasons' in validation) return { reasons: validation.reasons };

  return {
    candidate: {
      conceptId: options.priorConceptId,
      candidateIndex: options.candidateIndex,
      concept: validation.concept,
      director: result,
      agentVersion,
      ...(context ? { context } : {}),
      ...(result.creativeMemoryDivergence ? { divergence: result.creativeMemoryDivergence } : {}),
    },
  };
}
