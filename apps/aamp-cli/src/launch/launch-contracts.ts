import { createHash } from 'node:crypto';

import { canonicalJson } from '@combat/domain';
import { z } from 'zod';

import { EXIT_CODES } from '../run-source-campaign';

/**
 * The artefacts a product-launch run leaves behind, and the exit codes it uses.
 *
 * A launch run is longer-lived than a generate run: it spans four separate
 * commands and at least one human decision, so the run directory *is* the
 * state. Everything a later command needs is written as a validated document
 * rather than held in memory, and every document that records a decision is
 * written once and never edited — a revised concept is a new version file, a
 * changed mind is a new decision file.
 */

/**
 * Exit codes. The generate path's codes are reused unchanged where the failure
 * class is the same, so a script that already branches on 3, 4, 5 or 9 keeps
 * working; the new codes name failures that only exist once concepts compete
 * and a human decides between them.
 */
export const LAUNCH_EXIT_CODES = {
  ...EXIT_CODES,
  /** Fewer than three valid concepts survived. A competition needs competitors. */
  INSUFFICIENT_CONCEPTS: 13,
  /** The concepts were superficial rewrites of each other. */
  CONCEPTS_NOT_DISTINCT: 14,
  /** Rendering was attempted with no recorded human selection. */
  HUMAN_SELECTION_REQUIRED: 15,
  /** The named concept version was superseded, or was authored against another brief. */
  CONCEPT_STALE_OR_SUPERSEDED: 16,
  /** A required artefact is missing or does not match its recorded checksum. */
  PROVENANCE_INCOMPLETE: 17,
  /**
   * The gate refused this decision — wrong workspace, wrong campaign, an
   * unapproved reviewer, an unselectable concept, or a run that already has a
   * recorded decision.
   */
  SELECTION_REFUSED: 18,
} as const;
export type LaunchExitCode = (typeof LAUNCH_EXIT_CODES)[keyof typeof LAUNCH_EXIT_CODES];

export const LAUNCH_RUN_NOTICE =
  'The specialist agents authored every concept in this run. Application code supplied the brief, the approved inventory, the constraints and the governance, and decided nothing creative. A named human selects one concept; nothing downstream runs until they do.' as const;

export const LAUNCH_REFERENCE_NOTICE =
  'Reference material is analysis-only. Retrieval, injection and benchmark-profile approval grant no output rights, and no reference contributed a byte to any rendered advertisement.' as const;

/** Canonical sha256 over a value, so a checksum is a fact about content, not formatting. */
export function checksumOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

// --- run manifest ------------------------------------------------------------

export const LaunchCaptureVerificationSchema = z
  .object({
    /** Path to the capture session that was read. Never its bytes. */
    captureSessionPath: z.string().min(1),
    sessionRightsMode: z.enum(['DECLARED', 'INSPECTION_ONLY']),
    outputEligibleCaptureIds: z.array(z.string().min(1)).max(64).default([]),
    /**
     * Captures the session recorded as REVIEW_REQUIRED. Listed so a reviewer can
     * see they exist and were refused, rather than silently filtered.
     */
    reviewRequiredCaptureIds: z.array(z.string().min(1)).max(64).default([]),
    requiredCaptureIds: z.array(z.string().min(1)).max(64).default([]),
    /** Required captures the session could not supply as output-eligible. */
    missingRequiredCaptureIds: z.array(z.string().min(1)).max(64).default([]),
    mergedAssetIds: z.array(z.string().min(1)).max(64).default([]),
  })
  .strict();
export type LaunchCaptureVerification = z.infer<typeof LaunchCaptureVerificationSchema>;

export const LaunchCostBasisSchema = z
  .object({
    budgetCeilingCents: z.number().int().nonnegative(),
    /** Null when no price was declared, which is itself a refusal for a paid run. */
    estimatedMaximumCostCents: z.number().int().nonnegative().nullable(),
    plannedAgentInvocations: z.number().int().nonnegative(),
    /** Whether this run could have spent money at all. */
    paidProviderCallsPossible: z.boolean(),
    note: z.string().min(1).max(600),
  })
  .strict();
export type LaunchCostBasis = z.infer<typeof LaunchCostBasisSchema>;

export const LaunchRunManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    launchRunId: z.string().min(1).max(120),
    campaignMode: z.literal('PRODUCT_LAUNCH'),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    campaignName: z.string().min(1),
    campaignPromptSha256: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().min(1).max(40),

    executionMode: z.string().min(1).max(60),
    isRealCampaignRun: z.boolean(),
    demonstrationOnly: z.boolean(),
    runMode: z.string().min(1).max(40),
    reasoningProvider: z.string().min(1).max(80),
    reasoningModel: z.string().min(1).max(120),
    caveat: z.string().min(1).max(1200),

    creativeMemoryMode: z.enum(['required', 'optional', 'off']),
    benchmarkProfileName: z.string().min(1).max(120),
    conceptCandidateCount: z.number().int().min(3).max(5),
    approvedReviewerIds: z.array(z.string().min(1)).min(1),
    costBasis: LaunchCostBasisSchema,

    requestPath: z.string().min(1),
    productionAssetManifestPath: z.string().min(1),
    /** The manifest actually used downstream — captures merged over the library. */
    mergedAssetManifestPath: z.string().min(1),
    captureVerification: LaunchCaptureVerificationSchema,

    requiresHumanApproval: z.literal(true),
    notice: z.literal(LAUNCH_RUN_NOTICE),
    referenceNotice: z.literal(LAUNCH_REFERENCE_NOTICE),
  })
  .strict();
export type LaunchRunManifest = z.infer<typeof LaunchRunManifestSchema>;

// --- concept ledger ----------------------------------------------------------

export const LaunchLedgerEntrySchema = z
  .object({
    conceptId: z.string().min(1).max(80),
    version: z.number().int().positive(),
    origin: z.enum(['INITIAL_COMPETITION', 'REVISION']),
    supersedesVersion: z.number().int().positive().optional(),
    /** Run-directory-relative, forward-slashed. */
    versionFile: z.string().min(1),
    assessmentFile: z.string().min(1),
    conceptChecksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().min(1).max(40),
    authoredByAgent: z.string().min(1).max(120),
  })
  .strict();
export type LaunchLedgerEntry = z.infer<typeof LaunchLedgerEntrySchema>;

export const LaunchConceptLedgerSchema = z
  .object({
    ledgerVersion: z.literal(1),
    launchRunId: z.string().min(1).max(120),
    entries: z.array(LaunchLedgerEntrySchema).max(64),
  })
  .strict();
export type LaunchConceptLedger = z.infer<typeof LaunchConceptLedgerSchema>;

// --- the candidate set -------------------------------------------------------

export const LaunchConceptSetSchema = z
  .object({
    setVersion: z.literal(1),
    launchRunId: z.string().min(1).max(120),
    generatedAt: z.string().min(1).max(40),
    /** Concept ids in the order the agent produced them. */
    conceptIds: z.array(z.string().min(1).max(80)).min(3).max(5),
    /** Candidates the agent produced that failed validation, with the reason. */
    rejectedCandidates: z
      .array(
        z
          .object({
            candidateIndex: z.number().int().positive(),
            reasons: z.array(z.string().min(1).max(600)).min(1),
          })
          .strict(),
      )
      .max(16)
      .default([]),
    agentVersions: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type LaunchConceptSet = z.infer<typeof LaunchConceptSetSchema>;

// --- handoff -----------------------------------------------------------------

export const LaunchHandoffSchema = z
  .object({
    handoffVersion: z.literal(1),
    launchRunId: z.string().min(1).max(120),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    campaignPromptSha256: z.string().regex(/^[0-9a-f]{64}$/),
    conceptId: z.string().min(1).max(80),
    conceptVersion: z.number().int().positive(),
    conceptChecksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    conceptTitle: z.string().min(1).max(120),
    authoredByAgent: z.string().min(1).max(120),
    reviewerId: z.string().min(1).max(200),
    selectedAt: z.string().min(1).max(40),
    benchmarkProfileName: z.string().min(1).max(120),
    benchmarkProfileVersions: z.array(z.string().min(1).max(200)).max(16).default([]),
    /** Retrieval audit hashes for the roles that produced this concept. */
    creativeMemoryRetrievalIds: z.array(z.string().min(1).max(200)).max(64).default([]),
    approvedAssetIds: z.array(z.string().min(1).max(80)).min(1),
    productCaptureIds: z.array(z.string().min(1).max(80)).max(64).default([]),
    factualConstraints: z.array(z.string().min(1)).min(1),
    prohibitedClaims: z.array(z.string().min(1)).max(30).default([]),
    anyReferenceOutputEligible: z.literal(false),
    requiresHumanApproval: z.literal(true),
    notice: z.literal(LAUNCH_REFERENCE_NOTICE),
  })
  .strict();
export type LaunchHandoff = z.infer<typeof LaunchHandoffSchema>;

export class LaunchArtefactError extends Error {
  constructor(
    public readonly kind:
      'MISSING' | 'INVALID' | 'CHECKSUM_MISMATCH' | 'IMMUTABLE_RECORD_EXISTS' | 'LEDGER_TAMPERED',
    detail: string,
  ) {
    super(`${kind}: ${detail}`);
    this.name = 'LaunchArtefactError';
  }
}
