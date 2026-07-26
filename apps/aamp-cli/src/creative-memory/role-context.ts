import {
  canonicalJson,
  CREATIVE_MEMORY_NOTICE,
  CREATIVE_MEMORY_USAGE_DIRECTIVE,
  CreativeMemoryContextSchema,
  type BenchmarkGovernanceProfile,
  type CreativeMemoryContext,
  type CreativeMemoryContextItem,
  type CreativeMemoryObservations,
  type CreativeMemoryRetrievalPlan,
  type CreativeReferenceInsight,
  type ReferenceBusinessRole,
} from '@combat/domain';

/**
 * Turning retrieval results into one agent's context.
 *
 * Everything here is a pure function of its arguments — no clock, no database,
 * no network — so a context is reproducible from the same request against the
 * same index state, which is what makes an approved plan reviewable months
 * later. The I/O half lives in `injection.ts`.
 *
 * The order of operations matters and is deliberate: **project, then diversify,
 * then budget, then validate**. Projecting first means the diversity and budget
 * rules act on exactly the bytes the agent will see rather than on the richer
 * search result; budgeting before validation means an over-long context is
 * trimmed rather than rejected, while a *single* item that cannot fit is a real
 * failure and is reported as one.
 */

export interface RetrievedCandidate {
  readonly insight: CreativeReferenceInsight;
  /** Which of the plan's reference roles this candidate matched. */
  readonly contributingRole: ReferenceBusinessRole;
  /** The role's position in the plan's declared order — part of the tie-break. */
  readonly roleOrder: number;
}

/** Reference-level facts read from PostgreSQL, not from the vector store. */
export interface ReferenceFacts {
  readonly annotationId: string;
  readonly annotationVersion: number;
  readonly annotationCreatedAt: Date;
  /** The reference's full ordered scene-duration sequence. */
  readonly sceneDurationsSeconds: readonly number[];
}

export interface EffectiveLimits {
  readonly topK: number;
  readonly maxContextCharacters: number;
  readonly maxItemsPerReference: number;
  readonly minDistinctReferences: number;
  readonly referenceRoles: readonly ReferenceBusinessRole[];
}

/**
 * The stricter of the plan's engineering limits and the profile's governance
 * limits.
 *
 * A profile may only tighten. If governance could raise a top-K it would be a
 * way to buy *more* benchmark influence rather than less, which inverts what
 * the approval is for. `minDistinctReferences` is the one field where "stricter"
 * means larger, so it takes the maximum.
 */
export function effectiveLimitsFor(
  plan: CreativeMemoryRetrievalPlan,
  profile: BenchmarkGovernanceProfile,
): EffectiveLimits {
  const permitted = new Set(profile.requiredReferenceRoles);
  return {
    topK: Math.min(plan.topK, profile.maxTopK),
    maxContextCharacters: Math.min(plan.maxContextCharacters, profile.maxContextCharacters),
    maxItemsPerReference: Math.min(plan.maxItemsPerReference, profile.maxItemsPerReference),
    minDistinctReferences: Math.max(plan.minDistinctReferences, profile.minDistinctReferences),
    referenceRoles: plan.referenceRoles.filter((role) => permitted.has(role)),
  };
}

/**
 * Deterministic candidate order: best rank first, then the plan's own role
 * order, then reference id, then scene id.
 *
 * Rank comes from each per-role search, so two candidates can share a rank.
 * Falling through to the plan's declared role order keeps the primary craft
 * concern ahead of the secondary one, and the two ids make the result total —
 * without them, two runs could legitimately disagree.
 */
export function orderCandidates(
  candidates: readonly RetrievedCandidate[],
): readonly RetrievedCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.insight.explanation.finalRank !== b.insight.explanation.finalRank) {
      return a.insight.explanation.finalRank - b.insight.explanation.finalRank;
    }
    if (a.roleOrder !== b.roleOrder) return a.roleOrder - b.roleOrder;
    if (a.insight.referenceId !== b.insight.referenceId) {
      return a.insight.referenceId.localeCompare(b.insight.referenceId);
    }
    return a.insight.sceneId.localeCompare(b.insight.sceneId);
  });
}

export interface DiversitySelection {
  readonly selected: readonly RetrievedCandidate[];
  /** Distinct references the eligible pool actually offered. */
  readonly distinctAvailable: number;
  /** Distinct references the selection drew on. */
  readonly distinctSelected: number;
  /** How many distinct references were genuinely required, given what existed. */
  readonly requiredDistinct: number;
  readonly satisfiesDiversity: boolean;
}

/**
 * Picks the items, capping how many any one reference may contribute.
 *
 * The per-reference cap is **hard whenever the pool offers more than one
 * reference**: a short page is preferable to a page one source dominates,
 * because the whole point of retrieving from a library is that the agent sees
 * more than one way a problem has been solved. Backfilling past the cap would
 * quietly undo that whenever the runner-up happened to be thin.
 *
 * The one exception is a pool with a single distinct reference, where the cap
 * is relaxed — the alternative there is an artificially empty context from a
 * library that simply is small. The diversity *requirement* is scaled the same
 * way: one matching reference is a small library, not a governance failure, and
 * reporting it as one would train operators to ignore the signal.
 */
export function selectWithDiversity(
  candidates: readonly RetrievedCandidate[],
  limits: EffectiveLimits,
): DiversitySelection {
  const ordered = orderCandidates(candidates);
  const distinctAvailable = new Set(ordered.map((entry) => entry.insight.referenceId)).size;
  const perReferenceCap = distinctAvailable <= 1 ? limits.topK : limits.maxItemsPerReference;

  const perReference = new Map<string, number>();
  const selected: RetrievedCandidate[] = [];

  for (const candidate of ordered) {
    if (selected.length >= limits.topK) break;
    const used = perReference.get(candidate.insight.referenceId) ?? 0;
    if (used >= perReferenceCap) continue;
    perReference.set(candidate.insight.referenceId, used + 1);
    selected.push(candidate);
  }

  const distinctSelected = new Set(selected.map((entry) => entry.insight.referenceId)).size;
  const requiredDistinct = Math.min(limits.minDistinctReferences, distinctAvailable);

  return {
    selected,
    distinctAvailable,
    distinctSelected,
    requiredDistinct,
    satisfiesDiversity: selected.length > 0 && distinctSelected >= requiredDistinct,
  };
}

/**
 * Projects one search result into an agent-facing item.
 *
 * Only the observation fields the plan permits survive. That is the mechanism
 * behind role-specific context: the Strategist and the Shot-Prompt Engineer can
 * retrieve the same scene and still be told different things about it, because
 * a camera move is not evidence about positioning.
 */
export function projectContextItem(
  candidate: RetrievedCandidate,
  facts: ReferenceFacts,
  plan: CreativeMemoryRetrievalPlan,
  rank: number,
): CreativeMemoryContextItem {
  const { insight } = candidate;
  const permitted = new Set<string>(plan.permittedObservations);
  const observation = (
    field: keyof CreativeMemoryObservations,
    value: string | undefined,
  ): Partial<CreativeMemoryObservations> =>
    permitted.has(field) && value ? { [field]: value } : {};

  return {
    referenceId: insight.referenceId,
    annotationId: facts.annotationId,
    annotationVersion: facts.annotationVersion,
    sceneId: insight.sceneId,
    contributingRole: candidate.contributingRole,
    retrievalScore: insight.explanation.vectorRecallScore,
    rerankScore: insight.explanation.rerankScore,
    finalRank: rank,
    measurements: {
      advertisementDurationSeconds: insight.craft.advertisementDurationSeconds,
      sceneDurationSeconds: insight.craft.sceneDurationSeconds,
      sceneCount: insight.craft.sceneCount,
      cutsPerSecond: insight.craft.cutsPerSecond,
      ...(insight.craft.averageSceneSeconds !== undefined
        ? { averageSceneSeconds: insight.craft.averageSceneSeconds }
        : {}),
      ...(insight.craft.firstCutSeconds !== undefined
        ? { firstCutSeconds: insight.craft.firstCutSeconds }
        : {}),
      aspectRatio: insight.craft.aspectRatio,
      pacing: insight.craft.pacing,
      ...(insight.productRevealSeconds !== undefined
        ? { productRevealSeconds: insight.productRevealSeconds }
        : {}),
      ...(insight.ctaSeconds !== undefined ? { ctaSeconds: insight.ctaSeconds } : {}),
      sceneDurationsSeconds: [...facts.sceneDurationsSeconds],
    },
    observations: {
      ...observation('hookMechanism', insight.hookMechanism),
      ...observation('narrativeStructure', insight.narrativeStructure),
      ...observation('cameraMovement', insight.cameraMovement),
      ...observation('transitionCategory', insight.transitionCategory),
      ...observation('typographyBehaviour', insight.typographyBehaviour),
      ...observation('soundProgression', insight.soundProgression),
    },
    craftPrinciple: insight.transferablePrinciple,
    intendedApplication: plan.intendedApplication,
    riskWarning: insight.prohibitedDirectSimilarity,
  };
}

export interface ContextEnvelopeInput {
  readonly plan: CreativeMemoryRetrievalPlan;
  readonly profile: BenchmarkGovernanceProfile;
  readonly retrievalProfile: CreativeMemoryContext['retrievalProfile'];
  readonly rerankingProfile: string;
  readonly fallbackStatus: CreativeMemoryContext['fallbackStatus'];
  readonly queryHash: string;
  readonly items: readonly CreativeMemoryContextItem[];
}

export function buildContextEnvelope(input: ContextEnvelopeInput): CreativeMemoryContext {
  return CreativeMemoryContextSchema.parse({
    contextVersion: 1,
    agentRole: input.plan.agentRole,
    planKey: input.plan.planKey,
    planVersion: input.plan.planVersion,
    benchmarkProfileName: input.profile.name,
    benchmarkProfileVersion: input.profile.version,
    retrievalProfile: input.retrievalProfile,
    rerankingProfile: input.rerankingProfile,
    fallbackStatus: input.fallbackStatus,
    queryHash: input.queryHash,
    focusAreas: [...input.plan.focusAreas],
    items: input.items.map((item, index) => ({ ...item, finalRank: index + 1 })),
    usageDirective: CREATIVE_MEMORY_USAGE_DIRECTIVE,
    notice: CREATIVE_MEMORY_NOTICE,
  });
}

/** The exact string the budget is measured against, and what the context hash covers. */
export function serialiseContext(context: CreativeMemoryContext): string {
  return canonicalJson(context);
}

export interface BudgetFitResult {
  readonly context?: CreativeMemoryContext;
  readonly droppedItems: number;
  readonly characters: number;
  readonly overflowed: boolean;
}

/**
 * Trims the context until it fits the effective character budget.
 *
 * Lowest-ranked items go first, because they are the ones the retriever was
 * least confident about. Truncating a craft principle mid-sentence would keep
 * the item count up at the cost of saying something the reviewer never wrote,
 * so items are dropped whole. When even the single best item does not fit, that
 * is reported as an overflow rather than papered over — a budget too small for
 * one item is a configuration error, not a retrieval outcome.
 */
export function fitContextToBudget(
  input: ContextEnvelopeInput,
  limits: EffectiveLimits,
): BudgetFitResult {
  let items = [...input.items];
  let dropped = 0;

  while (items.length > 0) {
    const context = buildContextEnvelope({ ...input, items });
    const characters = serialiseContext(context).length;
    if (characters <= limits.maxContextCharacters) {
      return { context, droppedItems: dropped, characters, overflowed: false };
    }
    items = items.slice(0, -1);
    dropped += 1;
  }

  return { droppedItems: dropped, characters: 0, overflowed: true };
}
