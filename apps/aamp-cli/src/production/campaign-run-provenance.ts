import { relative } from 'node:path';

import { canonicalJson } from '@combat/domain';

import type { CampaignRequest } from '../campaign-request';
import type { RoleRetrievalAudit } from '../creative-memory/injection';
import type { SourceCampaignResult } from '../run-source-campaign';
import type { AampDependencies } from './dependency-factory';
import {
  RUN_PROVENANCE_VERSION,
  sealRunProvenance,
  sha256Of,
  type AampRunProvenance,
  type RetrievalEvidenceRecord,
} from './run-provenance';

/**
 * Assembles the durable run record from what the run actually produced.
 *
 * Kept separate from `run-provenance.ts` so the contract and its safety guard
 * stay independent of every type this composition happens to touch — the guard
 * is the thing that must not acquire a reason to be relaxed.
 */

/**
 * The campaign request, minus the two fields that are machine-local.
 *
 * `requestPath` and `sourceAssetManifestPath` are absolute paths on whoever ran
 * the command. Hashing them would make the request hash differ between two
 * machines running the same brief, which is the opposite of what the hash is
 * for; persisting them would put a local path into an artefact that has no use
 * for one.
 */
export function portableRequest(request: CampaignRequest): Record<string, unknown> {
  const { requestPath: _requestPath, sourceAssetManifestPath: _manifestPath, ...rest } = request;
  return rest as unknown as Record<string, unknown>;
}

export function hashCampaignRequest(request: CampaignRequest): string {
  return sha256Of(canonicalJson(portableRequest(request)));
}

/**
 * The retrieval audits, projected onto what may be persisted.
 *
 * Reference ids, annotation ids, scene ids and scores stay — they are the
 * evidence that makes a governed run auditable, and they are already canonical
 * rows in PostgreSQL. Everything the audit carries about *content* does not
 * appear here at all, because the audit never held any: the agent-safe
 * boundary already removed it upstream.
 */
export function projectRetrievalEvidence(
  audits: readonly RoleRetrievalAudit[],
): readonly RetrievalEvidenceRecord[] {
  return audits.map((audit) => ({
    agentRole: audit.agentRole,
    ...(audit.shotIndex === undefined ? {} : { shotIndex: audit.shotIndex }),
    planKey: audit.planKey,
    planVersion: audit.planVersion,
    benchmarkProfileId: audit.benchmarkProfile?.id ?? null,
    benchmarkProfileName: audit.benchmarkProfile?.name ?? null,
    benchmarkProfileVersion: audit.benchmarkProfile?.version ?? null,
    governingChecksumSha256: audit.benchmarkProfile?.governingChecksumSha256 ?? null,
    queryHash: audit.queryHash,
    contextHash: audit.contextHash,
    retrievalProfile: audit.retrievalProfile,
    rerankingProfile: audit.rerankingProfile,
    fallbackStatus: audit.fallbackStatus,
    qdrantCollection: audit.qdrantCollection,
    governanceDecision: audit.governanceDecision,
    ...(audit.notUsedReason ? { notUsedReason: audit.notUsedReason } : {}),
    items: audit.items.map((item) => ({
      referenceId: item.referenceId,
      annotationId: item.annotationId,
      annotationVersion: item.annotationVersion,
      sceneId: item.sceneId,
      retrievalScore: item.retrievalScore,
      rerankScore: item.rerankScore,
      finalRank: item.finalRank,
    })),
    anyReferenceOutputEligible: false as const,
  }));
}

export interface BuildRunProvenanceOptions {
  readonly request: CampaignRequest;
  readonly dependencies: AampDependencies;
  readonly creativeMemoryMode: string;
  readonly audits: readonly RoleRetrievalAudit[];
  readonly workflowRunId: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly result?: SourceCampaignResult;
  readonly failureReason: string | null;
  readonly fallbackReason: string | null;
}

export function buildRunProvenance(options: BuildRunProvenanceOptions): AampRunProvenance {
  const { request, dependencies, result } = options;
  const requestHash = hashCampaignRequest(request);
  const generation = dependencies.providers.find(
    (provider) => provider.role === 'video-generation',
  );
  const render = dependencies.providers.find((provider) => provider.role === 'motion-graphics');

  return sealRunProvenance({
    provenanceVersion: RUN_PROVENANCE_VERSION,
    workspaceId: request.workspaceId,
    campaignId: request.campaignId,
    campaignName: request.name,
    workflowRunId: options.workflowRunId,
    correlationId: options.workflowRunId,
    // Two runs of the same brief, under the same governance mode, in the same
    // workspace are the same unit of work. Deriving the key rather than
    // generating one is what would let a retry be recognised as a retry.
    idempotencyKey: sha256Of(
      `${request.workspaceId}:${request.campaignId}:${requestHash}:${options.creativeMemoryMode}`,
    ),
    requestHashSha256: requestHash,
    promptSha256: request.promptSha256,

    requestedExecutionMode: dependencies.requestedExecutionMode ?? null,
    executionMode: dependencies.executionMode,
    evidence: dependencies.evidence,
    label: dependencies.label,
    providers: dependencies.providers,

    creativeMemoryMode: options.creativeMemoryMode,
    retrievals: projectRetrievalEvidence(options.audits),

    agents: result?.agentVersions ?? [],
    reasoningProvider: dependencies.reasoningPolicy.providerName,
    reasoningModel: dependencies.reasoningPolicy.reasoningModel,
    generationProvider: generation?.identity ?? null,
    generationProfile: generation?.version ?? null,
    renderProvider: render?.identity ?? 'none',
    renderProviderVersion: render?.version ?? 'UNKNOWN',

    outputChecksumSha256: result?.outputChecksumSha256 ?? null,
    // Relative to the run directory, so the record stays portable and carries
    // no absolute path off this machine.
    outputRelativePath:
      result?.outputPath && result.runDirectory
        ? relative(result.runDirectory, result.outputPath).split('\\').join('/')
        : null,
    qaVerdict: result?.qaVerdict ?? null,
    qaFailedChecks: result?.qaFailedChecks ?? [],
    originality: result?.originality
      ? {
          riskLevel: result.originality.riskLevel,
          blocked: result.originality.blocked,
          requiresHumanReview: result.originality.requiresHumanReview,
        }
      : null,

    // The CLI reserves no budget and writes no ledger row — that machinery
    // belongs to the Activity path, and duplicating it here would produce
    // reservations no workflow ever saw. Recorded as zero with the basis
    // named, rather than left absent as if it were unknown.
    costEstimateCents: 0,
    costActualCents: 0,
    costBasis:
      'NOT_METERED_BY_CLI — this command reserves no budget and writes no BudgetLedger row; provider spend is metered in the Activity path.',

    failureReason: options.failureReason,
    fallbackReason: options.fallbackReason,
    requiresHumanApproval: true,
    startedAt: options.startedAt.toISOString(),
    completedAt: options.completedAt.toISOString(),
  });
}
