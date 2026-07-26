import { createHash } from 'node:crypto';

import {
  listReferenceScenes,
  resolveActiveBenchmarkProfile,
  type ReferenceDataSource,
} from '@combat/database';
import {
  assertAgentSafeContext,
  buildRetrievalQuery,
  CREATIVE_MEMORY_RETRIEVAL_PLANS,
  CreativeMemoryQuerySchema,
  CreativeMemorySearchResultSchema,
  UnsafeAgentContextError,
  type BenchmarkGovernanceProfile,
  type BenchmarkProfileRejection,
  type CreativeMemoryAgentRole,
  type CreativeMemoryContext,
  type CreativeMemoryInjectionFailure,
  type CreativeMemoryMode,
  type CreativeMemoryNotUsedReason,
  type CreativeReferenceInsight,
  type ReferenceBusinessRole,
  type RetrievalPlanInputs,
} from '@combat/domain';
import type {
  MultimodalEmbeddingProvider,
  MultimodalRerankerProvider,
  QdrantClient,
} from '@combat/providers';

import { RetrievalError, searchCreativeMemory } from './retrieval-pipeline';
import {
  effectiveLimitsFor,
  fitContextToBudget,
  projectContextItem,
  selectWithDiversity,
  serialiseContext,
  type EffectiveLimits,
  type ReferenceFacts,
  type RetrievedCandidate,
} from './role-context';

/**
 * Role-specific Creative Memory injection — the seam between the reference
 * library and the four specialist agents that actually plan a campaign.
 *
 * The agents never reach this code. An agent is still `(validated input) →
 * (validated output)` plus one reasoning call; this is the orchestrator
 * resolving material *before* the call, the same way an Activity would inside
 * Temporal. Nothing here is reachable from an agent prompt, and no agent can
 * ask for a second search.
 *
 * Two failure classes are treated very differently, and the distinction is the
 * point of the whole module:
 *
 * - **Availability** failures — no approved profile, retrieval down, nothing
 *   eligible, diversity unmet, budget overflow. Under `optional` these degrade
 *   to a recorded `NOT_USED` reason; under `required` they stop the run before
 *   any agent executes.
 * - **Integrity** failures — a result from another workspace, or a context that
 *   fails the agent-safe walk. These always throw, in every mode. Degrading
 *   them would mean continuing after the system did something it must never do.
 */

export interface CreativeMemoryDependencies {
  readonly db: ReferenceDataSource;
  readonly qdrant: QdrantClient;
  readonly embedder: MultimodalEmbeddingProvider;
  readonly reranker?: MultimodalRerankerProvider;
}

export class CreativeMemoryInjectionError extends Error {
  constructor(
    public readonly kind: CreativeMemoryInjectionFailure,
    public readonly agentRole: CreativeMemoryAgentRole,
    detail: string,
  ) {
    super(`Creative Memory injection failed for ${agentRole} (${kind}): ${detail}`);
    this.name = 'CreativeMemoryInjectionError';
  }
}

/** One resolution attempt, recorded whether or not it produced a context. */
export interface RoleRetrievalAudit {
  readonly agentRole: CreativeMemoryAgentRole;
  readonly shotIndex?: number;
  readonly planKey: string;
  readonly planVersion: number;
  readonly benchmarkProfile: {
    readonly id: string;
    readonly name: string;
    readonly version: number;
    readonly reviewerId?: string;
    readonly approvedAt?: string;
    readonly activatedBy: string;
    readonly activatedAt: string;
    readonly governingChecksumSha256: string;
    readonly supersedesProfileId?: string;
  } | null;
  readonly profileRejections: readonly BenchmarkProfileRejection[];
  readonly referenceRolesQueried: readonly ReferenceBusinessRole[];
  readonly queryHash: string | null;
  readonly queryCharacters: number | null;
  readonly missingQueryInputs: readonly string[];
  readonly retrievalProfile: string | null;
  readonly rerankingProfile: string | null;
  readonly fallbackStatus: string | null;
  readonly qdrantCollection: string | null;
  readonly candidatesRetrieved: number;
  readonly effectiveLimits: EffectiveLimits | null;
  readonly distinctReferencesAvailable: number;
  readonly distinctReferencesSelected: number;
  readonly itemsDroppedForBudget: number;
  readonly contextCharacters: number;
  readonly contextHash: string | null;
  readonly items: readonly {
    readonly referenceId: string;
    readonly annotationId: string;
    readonly annotationVersion: number;
    readonly sceneId: string;
    readonly contributingRole: ReferenceBusinessRole;
    readonly retrievalScore: number;
    readonly rerankScore: number;
    readonly finalRank: number;
  }[];
  readonly governanceDecision: 'CONTEXT_INJECTED' | 'NOT_USED';
  readonly notUsedReason?: CreativeMemoryNotUsedReason;
  /**
   * Always false, always written. Retrieval and injection grant no output
   * rights, and the audit record says so explicitly rather than leaving a
   * reader to infer it from an absence.
   */
  readonly anyReferenceOutputEligible: false;
}

export interface CreativeMemoryInjectorOptions {
  readonly mode: Exclude<CreativeMemoryMode, 'off'>;
  readonly dependencies: CreativeMemoryDependencies;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly platform: string;
  /** Caller-supplied instant. Staleness never reads a clock inside this module. */
  readonly now: Date;
  readonly onProgress?: (message: string) => void;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class CreativeMemoryInjector {
  private readonly profiles = new Map<
    CreativeMemoryAgentRole,
    { profile?: BenchmarkGovernanceProfile; rejections: readonly BenchmarkProfileRejection[] }
  >();

  private referenceFacts?: Map<string, ReferenceFacts>;

  readonly audits: RoleRetrievalAudit[] = [];

  constructor(private readonly options: CreativeMemoryInjectorOptions) {}

  get mode(): Exclude<CreativeMemoryMode, 'off'> {
    return this.options.mode;
  }

  /**
   * Resolves the governed, agent-safe context for one agent invocation.
   *
   * Returns `undefined` when the mode is `optional` and no usable context
   * exists — the reason is on the audit record, never swallowed.
   */
  async contextFor(
    agentRole: CreativeMemoryAgentRole,
    inputs: RetrievalPlanInputs,
    options: { readonly shotIndex?: number } = {},
  ): Promise<CreativeMemoryContext | undefined> {
    const plan = CREATIVE_MEMORY_RETRIEVAL_PLANS[agentRole];
    const base = {
      agentRole,
      ...(options.shotIndex === undefined ? {} : { shotIndex: options.shotIndex }),
      planKey: plan.planKey,
      planVersion: plan.planVersion,
      anyReferenceOutputEligible: false as const,
    };

    const notUsed = (
      reason: CreativeMemoryNotUsedReason,
      partial: Partial<RoleRetrievalAudit>,
    ): undefined => {
      this.audits.push({
        ...base,
        benchmarkProfile: null,
        profileRejections: [],
        referenceRolesQueried: [],
        queryHash: null,
        queryCharacters: null,
        missingQueryInputs: [],
        retrievalProfile: null,
        rerankingProfile: null,
        fallbackStatus: null,
        qdrantCollection: null,
        candidatesRetrieved: 0,
        effectiveLimits: null,
        distinctReferencesAvailable: 0,
        distinctReferencesSelected: 0,
        itemsDroppedForBudget: 0,
        contextCharacters: 0,
        contextHash: null,
        items: [],
        ...partial,
        governanceDecision: 'NOT_USED',
        notUsedReason: reason,
      });
      if (this.options.mode === 'required') {
        throw new CreativeMemoryInjectionError(
          REQUIRED_MODE_FAILURE[reason],
          agentRole,
          `mode is "required" but no governed context could be produced (${reason})`,
        );
      }
      this.options.onProgress?.(`creative memory: ${agentRole} ran without context (${reason})`);
      return undefined;
    };

    // --- governance ---------------------------------------------------------
    const resolution = await this.profileFor(agentRole);
    if (!resolution.profile) {
      return notUsed('NO_APPROVED_PROFILE', { profileRejections: resolution.rejections });
    }
    const profile = resolution.profile;
    const profileAudit = {
      id: profile.id,
      name: profile.name,
      version: profile.version,
      ...(profile.reviewerId ? { reviewerId: profile.reviewerId } : {}),
      ...(profile.approvedAt ? { approvedAt: profile.approvedAt.toISOString() } : {}),
      activatedBy: profile.activationProvenance.activatedBy,
      activatedAt: profile.activationProvenance.activatedAt.toISOString(),
      governingChecksumSha256: profile.activationProvenance.governingChecksumSha256,
      ...(profile.activationProvenance.supersedesProfileId
        ? { supersedesProfileId: profile.activationProvenance.supersedesProfileId }
        : {}),
    };

    const limits = effectiveLimitsFor(plan, profile);
    if (limits.referenceRoles.length === 0) {
      return notUsed('NO_ROLE_MATCHED_REFERENCES', {
        benchmarkProfile: profileAudit,
        effectiveLimits: limits,
      });
    }

    // --- query --------------------------------------------------------------
    const query = buildRetrievalQuery(plan, inputs);
    const queryHash = sha256(query.text);
    const queryAudit = {
      benchmarkProfile: profileAudit,
      effectiveLimits: limits,
      referenceRolesQueried: limits.referenceRoles,
      queryHash,
      queryCharacters: query.text.length,
      missingQueryInputs: [...query.missingInputs],
    };

    // --- retrieval ----------------------------------------------------------
    const candidates: RetrievedCandidate[] = [];
    const seenScenes = new Set<string>();
    let candidatesRetrieved = 0;
    let retrievalProfile: string | null = null;
    let rerankingProfile: string | null = null;
    let fallbackStatus: string | null = null;
    let collection: string | null = null;

    for (const [roleOrder, referenceRole] of limits.referenceRoles.entries()) {
      const parsedQuery = CreativeMemoryQuerySchema.safeParse({
        queryVersion: 1,
        workspaceId: this.options.workspaceId,
        query: query.text,
        intendedAudience: inputs.targetAudience.slice(0, 500),
        campaignObjective: inputs.objective.slice(0, 500),
        filter: {
          businessRole: referenceRole,
          targetDurationSeconds: inputs.targetDurationSeconds,
          ...(query.narrativeStage ? { narrativeStage: query.narrativeStage } : {}),
          requireApprovedAnnotation: true,
        },
        candidateCount: plan.candidateCount,
        resultCount: Math.min(plan.candidateCount, limits.topK * 2),
        maxScenesPerReference: limits.maxItemsPerReference,
        mode: 'AGENT_SAFE',
      });
      if (!parsedQuery.success) {
        return notUsed('MALFORMED_RETRIEVAL_RESPONSE', {
          ...queryAudit,
          candidatesRetrieved,
        });
      }

      let raw;
      try {
        // eslint-disable-next-line no-await-in-loop -- one search per reference role, merged in declared order
        raw = await searchCreativeMemory({
          db: this.options.dependencies.db,
          query: parsedQuery.data,
          embedder: this.options.dependencies.embedder,
          qdrant: this.options.dependencies.qdrant,
          ...(this.options.dependencies.reranker
            ? { reranker: this.options.dependencies.reranker }
            : {}),
        });
      } catch (error) {
        if (error instanceof RetrievalError) {
          return notUsed(
            error.kind === 'NO_ELIGIBLE_REFERENCES'
              ? 'NO_ELIGIBLE_REFERENCES'
              : 'RETRIEVAL_UNAVAILABLE',
            { ...queryAudit, candidatesRetrieved },
          );
        }
        throw error;
      }

      // The pipeline's own contract, re-validated at this boundary: a shape
      // this code does not expect is a typed failure here, not an undefined
      // read three frames later.
      const parsedResult = CreativeMemorySearchResultSchema.safeParse(raw);
      if (!parsedResult.success || !parsedResult.data.insights) {
        return notUsed('MALFORMED_RETRIEVAL_RESPONSE', { ...queryAudit, candidatesRetrieved });
      }
      const result = parsedResult.data;

      if (
        profile.allowedCollections.length > 0 &&
        !profile.allowedCollections.includes(result.qdrantCollection)
      ) {
        return notUsed('COLLECTION_NOT_PERMITTED', { ...queryAudit, candidatesRetrieved });
      }

      retrievalProfile = result.profile;
      rerankingProfile = result.rerankingProfile;
      fallbackStatus = result.fallbackStatus;
      collection = result.qdrantCollection;
      candidatesRetrieved += result.candidatesRetrieved;

      for (const insight of result.insights as readonly CreativeReferenceInsight[]) {
        if (seenScenes.has(insight.sceneId)) continue;
        seenScenes.add(insight.sceneId);
        candidates.push({ insight, contributingRole: referenceRole, roleOrder });
      }
    }

    const retrievalAudit = {
      ...queryAudit,
      candidatesRetrieved,
      retrievalProfile,
      rerankingProfile,
      fallbackStatus,
      qdrantCollection: collection,
    };

    if (candidates.length === 0) {
      return notUsed('NO_ROLE_MATCHED_REFERENCES', retrievalAudit);
    }

    // --- workspace isolation, re-checked against PostgreSQL -----------------
    const facts = await this.factsFor();
    const foreign = candidates.find((entry) => !facts.has(entry.insight.referenceId));
    if (foreign) {
      throw new CreativeMemoryInjectionError(
        'CROSS_WORKSPACE_RESULT',
        agentRole,
        `reference ${foreign.insight.referenceId} is not an eligible reference in workspace ${this.options.workspaceId}`,
      );
    }

    // --- staleness ----------------------------------------------------------
    const fresh = candidates.filter((entry) => {
      const reference = facts.get(entry.insight.referenceId) as ReferenceFacts;
      if (profile.annotationValidForDays === undefined) return true;
      return (
        this.options.now.getTime() <=
        reference.annotationCreatedAt.getTime() + profile.annotationValidForDays * 86_400_000
      );
    });
    if (fresh.length === 0) {
      return notUsed('STALE_PROFILE_OR_ANNOTATION', retrievalAudit);
    }

    // --- diversity ----------------------------------------------------------
    const selection = selectWithDiversity(fresh, limits);
    if (!selection.satisfiesDiversity) {
      return notUsed('SOURCE_DIVERSITY_FAILURE', {
        ...retrievalAudit,
        distinctReferencesAvailable: selection.distinctAvailable,
        distinctReferencesSelected: selection.distinctSelected,
      });
    }

    // --- projection and budget ----------------------------------------------
    const items = selection.selected.map((candidate, index) =>
      projectContextItem(
        candidate,
        facts.get(candidate.insight.referenceId) as ReferenceFacts,
        plan,
        index + 1,
      ),
    );
    const envelopeInput = {
      plan,
      profile,
      retrievalProfile: retrievalProfile as CreativeMemoryContext['retrievalProfile'],
      rerankingProfile: rerankingProfile as string,
      fallbackStatus: fallbackStatus as CreativeMemoryContext['fallbackStatus'],
      queryHash,
      items,
    };
    const fitted = fitContextToBudget(envelopeInput, limits);
    if (!fitted.context) {
      return notUsed('CONTEXT_BUDGET_OVERFLOW', {
        ...retrievalAudit,
        distinctReferencesAvailable: selection.distinctAvailable,
        distinctReferencesSelected: selection.distinctSelected,
        itemsDroppedForBudget: fitted.droppedItems,
      });
    }
    const context = fitted.context;

    // Dropping for budget can collapse the context onto one reference. The
    // diversity rule is re-checked here rather than only before the trim,
    // because the context the agent sees is the only one that matters.
    const distinctAfterTrim = new Set(context.items.map((item) => item.referenceId)).size;
    if (distinctAfterTrim < selection.requiredDistinct) {
      return notUsed('SOURCE_DIVERSITY_FAILURE', {
        ...retrievalAudit,
        distinctReferencesAvailable: selection.distinctAvailable,
        distinctReferencesSelected: distinctAfterTrim,
        itemsDroppedForBudget: fitted.droppedItems,
      });
    }

    // --- the boundary -------------------------------------------------------
    try {
      assertAgentSafeContext(context, `${agentRole} Creative Memory context`);
    } catch (error) {
      if (error instanceof UnsafeAgentContextError) {
        throw new CreativeMemoryInjectionError('UNSAFE_AGENT_CONTEXT', agentRole, error.message);
      }
      throw error;
    }

    const serialised = serialiseContext(context);
    this.audits.push({
      ...base,
      profileRejections: [],
      ...retrievalAudit,
      distinctReferencesAvailable: selection.distinctAvailable,
      distinctReferencesSelected: distinctAfterTrim,
      itemsDroppedForBudget: fitted.droppedItems,
      contextCharacters: serialised.length,
      contextHash: sha256(serialised),
      items: context.items.map((item) => ({
        referenceId: item.referenceId,
        annotationId: item.annotationId,
        annotationVersion: item.annotationVersion,
        sceneId: item.sceneId,
        contributingRole: item.contributingRole,
        retrievalScore: item.retrievalScore,
        rerankScore: item.rerankScore,
        finalRank: item.finalRank,
      })),
      governanceDecision: 'CONTEXT_INJECTED',
    });
    this.options.onProgress?.(
      `creative memory: ${agentRole} received ${context.items.length} item(s) from ${distinctAfterTrim} reference(s)`,
    );

    return context;
  }

  private async profileFor(agentRole: CreativeMemoryAgentRole): Promise<{
    profile?: BenchmarkGovernanceProfile;
    rejections: readonly BenchmarkProfileRejection[];
  }> {
    const cached = this.profiles.get(agentRole);
    if (cached) return cached;

    const resolution = await resolveActiveBenchmarkProfile(this.options.dependencies.db, {
      workspaceId: this.options.workspaceId,
      agentRole,
      platform: this.options.platform,
      campaignId: this.options.campaignId,
      now: this.options.now,
    });
    const entry =
      resolution.kind === 'RESOLVED'
        ? { profile: resolution.profile, rejections: [] }
        : { rejections: resolution.rejections };
    this.profiles.set(agentRole, entry);
    return entry;
  }

  /**
   * Reference-level facts, read from PostgreSQL once per run.
   *
   * The annotation id, its version and the reference's scene sequence are not
   * in the vector payload and must not be — Qdrant holds vectors and filterable
   * payload, never provenance. Reading them here also gives the cross-workspace
   * check something authoritative to compare against.
   */
  private async factsFor(): Promise<Map<string, ReferenceFacts>> {
    if (this.referenceFacts) return this.referenceFacts;
    const { db } = this.options.dependencies;
    const workspaceId = this.options.workspaceId;

    const references = await db.referenceAdvertisement.findMany({
      where: { workspaceId, processingState: 'READY_FOR_RETRIEVAL' },
      orderBy: { createdAt: 'asc' },
    });

    const facts = new Map<string, ReferenceFacts>();
    for (const reference of references) {
      // eslint-disable-next-line no-await-in-loop -- read in stable reference order
      const annotations = await db.referenceAnnotation.findMany({
        where: { workspaceId, referenceAdvertisementId: reference.id },
        orderBy: { version: 'desc' },
      });
      const approved = annotations.find((annotation) => annotation.approved);
      if (!approved) continue;

      // eslint-disable-next-line no-await-in-loop -- same ordering rationale
      const scenes = await listReferenceScenes(db, workspaceId, reference.id);
      facts.set(reference.id, {
        annotationId: approved.id,
        annotationVersion: approved.version,
        annotationCreatedAt: approved.createdAt,
        sceneDurationsSeconds: scenes.map((scene) => scene.durationSeconds),
      });
    }

    this.referenceFacts = facts;
    return facts;
  }
}

/**
 * How each "no context" reason is reported when the mode is `required`.
 *
 * Stated as a total map rather than a chain of conditionals so a new reason
 * cannot be added without deciding what it means for a required run — the case
 * where getting this wrong would silently let an ungoverned campaign through.
 */
const REQUIRED_MODE_FAILURE: Readonly<
  Record<CreativeMemoryNotUsedReason, CreativeMemoryInjectionFailure>
> = {
  MODE_OFF: 'MISSING_APPROVED_PROFILE',
  NO_APPROVED_PROFILE: 'MISSING_APPROVED_PROFILE',
  RETRIEVAL_UNAVAILABLE: 'RETRIEVAL_UNAVAILABLE',
  NO_ELIGIBLE_REFERENCES: 'NO_ELIGIBLE_REFERENCES',
  NO_ROLE_MATCHED_REFERENCES: 'NO_ELIGIBLE_REFERENCES',
  COLLECTION_NOT_PERMITTED: 'MISSING_APPROVED_PROFILE',
  CONTEXT_BUDGET_OVERFLOW: 'CONTEXT_BUDGET_OVERFLOW',
  SOURCE_DIVERSITY_FAILURE: 'SOURCE_DIVERSITY_FAILURE',
  STALE_PROFILE_OR_ANNOTATION: 'STALE_PROFILE_OR_ANNOTATION',
  MALFORMED_RETRIEVAL_RESPONSE: 'MALFORMED_RETRIEVAL_RESPONSE',
};
