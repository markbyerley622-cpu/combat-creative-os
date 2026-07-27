import { z } from 'zod';

/**
 * The vendor-neutral vocabulary for acquiring premium licensed source media.
 *
 * Two separate things are being modelled here, and the whole module exists to
 * keep them apart:
 *
 * - **What a provider says** — `MediaRightsFacts`. Declared licence, declared
 *   dimensions, declared restrictions. None of it is verified by us and none of
 *   it is a permission.
 * - **What we decided** — `MediaRightsDecision`, `MediaQualityDecision` and the
 *   lifecycle. Each carries its own reasons and its own policy version, so a
 *   decision can always be re-read against the rules that produced it.
 *
 * Nothing in this file grants output rights. A candidate becomes usable in an
 * advertisement only by passing through every lifecycle station below, the last
 * two of which require a human approval record and a measurement of the actual
 * downloaded bytes. Reachability is not a licence, and neither is a download.
 *
 * This is a *production* vocabulary. It has no relationship to Creative Memory:
 * a reference advertisement is `ANALYSIS_ONLY` in a different enum, in a
 * different table, in a different repository. Material acquired here may enter
 * an output manifest after approval; material there may never. The two must not
 * be spellable in each other's terms — see `mediaAcquisitionGrantsNoReferenceUse`.
 */

const IsoDateStringSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

/* ------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The candidate lifecycle, in order. **No state may be skipped.**
 *
 * `RIGHTS_REVIEW_REQUIRED` is a mandatory station rather than a branch, and
 * that is deliberate: even a CC0 item passes through it, because the record of
 * "somebody looked at the rights for this specific item" is the artefact, not
 * the outcome. A pipeline where clean licences bypass review is a pipeline
 * where the review station only ever sees the cases somebody already doubted.
 *
 * `DOWNLOADED` and `INSPECTED` are separate for the same reason the renderer
 * separates "the provider returned success" from "the file measures correctly":
 * bytes arriving says nothing about what is in them.
 */
export const MEDIA_CANDIDATE_STATES = [
  'DISCOVERED',
  'METADATA_VERIFIED',
  'RIGHTS_REVIEW_REQUIRED',
  'APPROVED_FOR_DOWNLOAD',
  'DOWNLOADED',
  'INSPECTED',
  'OUTPUT_ELIGIBLE',
] as const;
export const MediaCandidateStateSchema = z.enum(MEDIA_CANDIDATE_STATES);
export type MediaCandidateState = z.infer<typeof MediaCandidateStateSchema>;

/**
 * Terminal refusal. Not a member of the ordered chain — a rejected candidate
 * has left the lifecycle rather than paused inside it, and modelling it as a
 * station would make "advance to the next state" ambiguous.
 */
export const REJECTED_STATE = 'REJECTED' as const;
export type MediaCandidateLifecycleState = MediaCandidateState | typeof REJECTED_STATE;

export class MediaLifecycleError extends Error {
  constructor(
    public readonly from: MediaCandidateLifecycleState,
    public readonly to: MediaCandidateLifecycleState,
    detail: string,
  ) {
    super(`Cannot move a media candidate from ${from} to ${to}: ${detail}`);
    this.name = 'MediaLifecycleError';
  }
}

export function lifecycleRank(state: MediaCandidateState): number {
  return MEDIA_CANDIDATE_STATES.indexOf(state);
}

/**
 * The only legal move is one station forward, or out to `REJECTED`.
 *
 * Written as an assertion rather than a predicate because every caller wants
 * the failure, not the boolean: a pipeline that quietly declined to advance
 * would leave a candidate looking un-processed rather than looking wrong.
 */
export function assertLifecycleTransition(
  from: MediaCandidateLifecycleState,
  to: MediaCandidateLifecycleState,
): void {
  if (from === REJECTED_STATE) {
    throw new MediaLifecycleError(from, to, 'a rejected candidate is terminal');
  }
  if (to === REJECTED_STATE) return;
  if (from === to) {
    throw new MediaLifecycleError(from, to, 'a state never advances to itself');
  }
  const fromRank = lifecycleRank(from);
  const toRank = lifecycleRank(to);
  if (toRank < fromRank) {
    throw new MediaLifecycleError(from, to, 'the lifecycle never runs backwards');
  }
  if (toRank !== fromRank + 1) {
    const skipped = MEDIA_CANDIDATE_STATES.slice(fromRank + 1, toRank).join(', ');
    throw new MediaLifecycleError(
      from,
      to,
      `that would skip ${skipped}. Every station is mandatory — the record that each one happened is the point of having them.`,
    );
  }
}

/* ------------------------------------------------------------------------- */
/* Providers and media                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Sources this system will talk to. The list is closed on purpose.
 *
 * Every entry is an official, documented API of a platform that publishes
 * licence terms per item. There is no entry for a social network, a broadcaster
 * or a video-sharing site, and there is no generic "HTTP URL" entry — a
 * provider id is the thing that determines which licence vocabulary applies, so
 * an unnamed source could not be evaluated even if it could be fetched.
 *
 * `EXTERNAL_PILOT_PACK` is not a network provider. It is the operator's own
 * previously-collected folder, imported read-only; it reaches this enum because
 * everything downstream keys provenance on a provider id.
 */
export const MEDIA_ACQUISITION_PROVIDERS = [
  'PEXELS',
  'PIXABAY',
  'DVIDS',
  'WIKIMEDIA_COMMONS',
  'OPENVERSE',
  'EXTERNAL_PILOT_PACK',
] as const;
export const MediaAcquisitionProviderIdSchema = z.enum(MEDIA_ACQUISITION_PROVIDERS);
export type MediaAcquisitionProviderId = z.infer<typeof MediaAcquisitionProviderIdSchema>;

export const MEDIA_KINDS = ['VIDEO', 'IMAGE', 'AUDIO'] as const;
export const MediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const MEDIA_ORIENTATIONS = ['PORTRAIT', 'LANDSCAPE', 'SQUARE', 'UNKNOWN'] as const;
export const MediaOrientationSchema = z.enum(MEDIA_ORIENTATIONS);
export type MediaOrientation = z.infer<typeof MediaOrientationSchema>;

export function orientationOf(widthPx?: number, heightPx?: number): MediaOrientation {
  if (!widthPx || !heightPx || widthPx <= 0 || heightPx <= 0) return 'UNKNOWN';
  if (widthPx === heightPx) return 'SQUARE';
  return widthPx > heightPx ? 'LANDSCAPE' : 'PORTRAIT';
}

/**
 * One downloadable form of a candidate.
 *
 * `url` is the provider's own rendition URL and is treated as untrusted: it is
 * re-validated against the provider's documented download hosts before any
 * request, and it is never persisted into a shared artefact (a signed or
 * expiring download URL is a credential in disguise).
 */
export const MediaRenditionSchema = z
  .object({
    /** Provider's own label, e.g. `hd`, `uhd`, `original`, `preview`. */
    label: z.string().min(1).max(60),
    url: z.string().min(1).max(2000),
    widthPx: z.number().int().positive().optional(),
    heightPx: z.number().int().positive().optional(),
    frameRate: z.number().positive().max(1000).optional(),
    fileSizeBytes: z.number().int().nonnegative().optional(),
    /** Container/extension as the provider states it, e.g. `mp4`, `jpg`, `mp3`. */
    fileType: z.string().min(1).max(40).optional(),
  })
  .strict();
export type MediaRendition = z.infer<typeof MediaRenditionSchema>;

/* ------------------------------------------------------------------------- */
/* Rights                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Licence families, normalized across five providers that each spell their
 * terms differently.
 *
 * The refused families are members on purpose, exactly as the production-asset
 * rights enum keeps `ANALYSIS_ONLY`: being told "this is NonCommercial and
 * NonCommercial is refused" is a usable answer, and being told "unrecognised
 * licence" is not.
 */
export const LICENCE_FAMILIES = [
  'CC0',
  'PUBLIC_DOMAIN',
  'PUBLIC_DOMAIN_MARK',
  'US_GOVERNMENT_PUBLIC_DOMAIN',
  'CC_BY',
  'CC_BY_SA',
  'PEXELS_LICENCE',
  'PIXABAY_CONTENT_LICENCE',
  'CC_BY_NC',
  'CC_BY_ND',
  'CC_BY_NC_SA',
  'CC_BY_NC_ND',
  'EDITORIAL_ONLY',
  'PERSONAL_USE_ONLY',
  'STANDARD_YOUTUBE_LICENCE',
  'ALL_RIGHTS_RESERVED',
  'UNKNOWN',
] as const;
export const LicenceFamilySchema = z.enum(LICENCE_FAMILIES);
export type LicenceFamily = z.infer<typeof LicenceFamilySchema>;

export const PERMISSION_STATES = ['PERMITTED', 'PROHIBITED', 'UNKNOWN'] as const;
export const PermissionStateSchema = z.enum(PERMISSION_STATES);
export type PermissionState = z.infer<typeof PermissionStateSchema>;

export const RISK_STATES = ['NONE_APPARENT', 'PRESENT', 'UNKNOWN'] as const;
export const RiskStateSchema = z.enum(RISK_STATES);
export type RiskState = z.infer<typeof RiskStateSchema>;

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RELEASE_STATES = ['ON_FILE', 'NOT_PROVIDED', 'NOT_APPLICABLE', 'UNKNOWN'] as const;
export const ReleaseStateSchema = z.enum(RELEASE_STATES);
export type ReleaseState = z.infer<typeof ReleaseStateSchema>;

/**
 * Everything a provider *declared* about who owns this and what may be done
 * with it. Facts as reported, never as verified.
 *
 * `creator` is required, including when a provider supplies no name — the
 * adapter writes the literal `NOT_STATED` rather than an empty string, because
 * an absent credit is itself a rights fact and a blank field reads like an
 * oversight.
 */
export const MediaRightsFactsSchema = z
  .object({
    /** The provider's own words, e.g. "Pexels License", "CC BY-SA 4.0". */
    declaredLicence: z.string().min(1).max(200),
    licenceFamily: LicenceFamilySchema,
    licenceUrl: z.string().max(2000).optional(),
    creator: z.string().min(1).max(300),
    creatorUrl: z.string().max(2000).optional(),
    /** Ready-to-publish credit line, generated where a licence requires one. */
    attributionText: z.string().max(600).optional(),
    commercialUse: PermissionStateSchema,
    derivativeUse: PermissionStateSchema,
    paidAdvertisingUse: PermissionStateSchema,
    recognizablePersonRisk: RiskStateSchema,
    trademarkOrLogoRisk: RiskStateSchema,
    endorsementRisk: RiskLevelSchema,
    modelReleaseStatus: ReleaseStateSchema,
    propertyReleaseStatus: ReleaseStateSchema,
    /** Verbatim provider restrictions. Never summarised away. */
    sourceRestrictions: z.array(z.string().min(1).max(600)).default([]),
  })
  .strict();
export type MediaRightsFacts = z.infer<typeof MediaRightsFactsSchema>;

/**
 * Usages a human may approve, narrowest first.
 *
 * `INTERNAL_EVALUATION` is not a weaker production grade — it is a different
 * kind of permission, and the system keeps it structurally isolated: material
 * approved only for internal evaluation produces a labelled demonstration
 * output and can never be written into a campaign production manifest.
 */
export const APPROVED_USAGES = ['INTERNAL_EVALUATION', 'ORGANIC_SOCIAL', 'PAID_SOCIAL'] as const;
export const ApprovedUsageSchema = z.enum(APPROVED_USAGES);
export type ApprovedUsage = z.infer<typeof ApprovedUsageSchema>;

export const RIGHTS_OUTCOMES = ['AUTOMATICALLY_ELIGIBLE', 'REVIEW_REQUIRED', 'REJECTED'] as const;
export const RightsOutcomeSchema = z.enum(RIGHTS_OUTCOMES);
export type RightsOutcome = z.infer<typeof RightsOutcomeSchema>;

/**
 * What the rights policy concluded, and why.
 *
 * `AUTOMATICALLY_ELIGIBLE` means "the policy raises no objection", never "this
 * is approved". Approval is a separate, human, attributable record — see
 * `MediaApprovalRecord`. The two are deliberately different types so no code
 * path can mistake one for the other.
 */
export const MediaRightsDecisionSchema = z
  .object({
    outcome: RightsOutcomeSchema,
    policyVersion: z.string().min(1).max(60),
    reasons: z.array(z.string().min(1).max(600)).min(1),
    /** Usages the policy would allow a human to approve. Never an approval itself. */
    candidateUsages: z.array(ApprovedUsageSchema).default([]),
    /** Present when the licence family compels a credit line. */
    requiredAttribution: z.string().max(600).optional(),
  })
  .strict();
export type MediaRightsDecision = z.infer<typeof MediaRightsDecisionSchema>;

/* ------------------------------------------------------------------------- */
/* Quality                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Properties measured from the actual downloaded bytes.
 *
 * Every field here is a measurement or `null`. A declared value never lands in
 * this shape — that is what makes `sourceResolutionVerified` meaningful, and it
 * is why `notMeasured` exists: a property that could not be taken is named,
 * never defaulted to a passing value.
 */
export const MediaQualityMeasurementsSchema = z
  .object({
    fileSizeBytes: z.number().int().nonnegative(),
    /**
     * What the file actually is, decided by the probe rather than by whatever a
     * catalogue row or a filename claimed.
     *
     * This exists because the two disagree in practice: an operator's
     * spreadsheet routinely records a candidate as `video` while the file that
     * was actually downloaded from it is a still. Evaluating a JPEG against the
     * video floor produces a confident, wrong refusal ("the codec mjpeg is not
     * one the renderer accepts"), which is the worst kind of failure — it looks
     * like a measurement.
     */
    detectedMediaKind: MediaKindSchema,
    /** True when the declared kind and the measured kind disagree. Recorded, never silent. */
    declaredMediaKindMismatch: z.boolean().default(false),
    container: z.string().min(1).max(120),
    videoCodec: z.string().max(60).nullable(),
    audioCodec: z.string().max(60).nullable(),
    widthPx: z.number().int().nonnegative(),
    heightPx: z.number().int().nonnegative(),
    durationSeconds: z.number().nonnegative().nullable(),
    frameRate: z.number().nonnegative().nullable(),
    pixelFormat: z.string().max(60).nullable(),
    bitrateBitsPerSecond: z.number().nonnegative().nullable(),
    /** Fraction of the clip measured as black, 0–1. */
    blackRatio: z.number().min(0).max(1).nullable(),
    /** Fraction of the clip measured as frozen, 0–1. */
    freezeRatio: z.number().min(0).max(1).nullable(),
    sceneCount: z.number().int().nonnegative().nullable(),
    /** Detected shot changes per minute — a proxy for cutting density, not for "action". */
    sceneChangesPerMinute: z.number().nonnegative().nullable(),
    /** Longest continuous run with no black, freeze or shot change, in seconds. */
    longestUsableRunSeconds: z.number().nonnegative().nullable(),
    hasAudioStream: z.boolean(),
    audioLoudnessLufs: z.number().nullable(),
    audioClippedSamples: z.number().int().nonnegative().nullable(),
    /** True when a 9:16 crop of the measured frame is at least 1080 px wide. */
    verticalCropFeasible: z.boolean(),
    verticalCropWidthPx: z.number().int().nonnegative(),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Every property the measurement could not establish, named. */
    notMeasured: z.array(z.string().min(1).max(300)).default([]),
  })
  .strict();
export type MediaQualityMeasurements = z.infer<typeof MediaQualityMeasurementsSchema>;

/**
 * Five separate scores rather than one.
 *
 * They answer different questions and a single number would hide which one
 * failed. None of them is a claim about how the footage *looks*: there is no
 * reliable machine measurement of cinematic quality, so this system does not
 * report one. Human creative scoring stays in its own record.
 */
export const MediaQualityScoresSchema = z
  .object({
    /** Resolution, frame rate, codec, bitrate, decode integrity. */
    technicalQualityScore: z.number().int().min(0).max(100),
    /** Usable run length, shot variety, absence of black/freeze — how editable it is. */
    editUtilityScore: z.number().int().min(0).max(100),
    /** How much survives a 9:16 crop. */
    verticalSuitabilityScore: z.number().int().min(0).max(100),
    /** How settled the licence position is. Not a legal opinion. */
    rightsConfidenceScore: z.number().int().min(0).max(100),
    /** Weighted composite of the four above, for ranking only. */
    overallSourceScore: z.number().int().min(0).max(100),
  })
  .strict();
export type MediaQualityScores = z.infer<typeof MediaQualityScoresSchema>;

export const QUALITY_OUTCOMES = ['MEETS_PROFILE', 'REVIEW_REQUIRED', 'BELOW_PROFILE'] as const;
export const QualityOutcomeSchema = z.enum(QUALITY_OUTCOMES);
export type QualityOutcome = z.infer<typeof QualityOutcomeSchema>;

export const MediaQualityDecisionSchema = z
  .object({
    outcome: QualityOutcomeSchema,
    profileVersion: z.string().min(1).max(80),
    scores: MediaQualityScoresSchema,
    /** Why it failed, why it needs a human, or why it passed. Always populated. */
    reasons: z.array(z.string().min(1).max(600)).min(1),
    /** Facts a human must settle — watermarks, burned-in text, logo presence. */
    humanChecksRequired: z.array(z.string().min(1).max(300)).default([]),
  })
  .strict();
export type MediaQualityDecision = z.infer<typeof MediaQualityDecisionSchema>;

/* ------------------------------------------------------------------------- */
/* Candidate                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * One item a provider returned, normalized.
 *
 * `landingPageUrl` is required and `previewUrl` is not: the human-readable page
 * is where a reviewer verifies the licence, and a candidate whose licence
 * cannot be verified by a person is not reviewable. A preview is a convenience.
 */
export const MediaCandidateSchema = z
  .object({
    /** Stable within a run: `<PROVIDER-PREFIX>-<providerAssetId>`. */
    candidateId: z.string().min(1).max(120),
    provider: MediaAcquisitionProviderIdSchema,
    providerAssetId: z.string().min(1).max(200),
    mediaKind: MediaKindSchema,
    title: z.string().min(1).max(300),
    description: z.string().max(2000).default(''),
    landingPageUrl: z.string().min(1).max(2000),
    previewUrl: z.string().max(2000).optional(),
    renditions: z.array(MediaRenditionSchema).default([]),
    durationSeconds: z.number().nonnegative().nullable(),
    widthPx: z.number().int().nonnegative().nullable(),
    heightPx: z.number().int().nonnegative().nullable(),
    frameRate: z.number().positive().max(1000).nullable(),
    orientation: MediaOrientationSchema,
    fileSizeBytes: z.number().int().nonnegative().nullable(),
    rights: MediaRightsFactsSchema,
    /** When the provider was asked. Supplied by the caller's clock, never read here. */
    retrievedAt: IsoDateStringSchema,
    state: MediaCandidateStateSchema,
    rightsDecision: MediaRightsDecisionSchema.optional(),
    qualityDecision: MediaQualityDecisionSchema.optional(),
    measurements: MediaQualityMeasurementsSchema.optional(),
    /** Which campaign slot this could serve. A suggestion, never a binding. */
    suggestedRole: z.string().max(120).optional(),
    /** Free-text operator notes carried through the pipeline. */
    notes: z.string().max(2000).default(''),
  })
  .strict();
export type MediaCandidate = z.infer<typeof MediaCandidateSchema>;

/* ------------------------------------------------------------------------- */
/* Search                                                                     */
/* ------------------------------------------------------------------------- */

export const MediaSearchRequestSchema = z
  .object({
    query: z.string().min(1).max(300),
    kind: MediaKindSchema,
    orientation: MediaOrientationSchema.optional(),
    minWidthPx: z.number().int().positive().optional(),
    minHeightPx: z.number().int().positive().optional(),
    minDurationSeconds: z.number().nonnegative().optional(),
    maxDurationSeconds: z.number().positive().optional(),
    /** 1-based, as every provider here counts. */
    page: z.number().int().positive().default(1),
    perPage: z.number().int().positive().max(80).default(20),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      request.minDurationSeconds !== undefined &&
      request.maxDurationSeconds !== undefined &&
      request.minDurationSeconds > request.maxDurationSeconds
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minDurationSeconds'],
        message: 'minDurationSeconds cannot exceed maxDurationSeconds',
      });
    }
  });
export type MediaSearchRequest = z.infer<typeof MediaSearchRequestSchema>;

export interface MediaSearchPage {
  readonly provider: MediaAcquisitionProviderId;
  readonly candidates: readonly MediaCandidate[];
  readonly page: number;
  readonly perPage: number;
  /** Provider's own total where it supplies one; `null` when it does not. */
  readonly totalResults: number | null;
  readonly hasNextPage: boolean;
}

/* ------------------------------------------------------------------------- */
/* Approval and selection                                                     */
/* ------------------------------------------------------------------------- */

/**
 * A human's decision, attributable and bounded.
 *
 * `approvedBy` has no default and never will. The entire value of this record
 * is that a named person accepted the licence position for a specific item, for
 * specific usages, on specific platforms, until a specific date. A generated
 * approval would be a forgery of exactly the thing that makes acquisition
 * lawful.
 */
export const MediaApprovalRecordSchema = z
  .object({
    candidateId: z.string().min(1).max(120),
    approvedBy: z.string().min(1).max(200),
    approvedUsages: z.array(ApprovedUsageSchema).min(1),
    /** Where it may run, e.g. "instagram-reels". Free-form: platforms outlive enums. */
    approvedPlatforms: z.array(z.string().min(1).max(80)).min(1),
    effectiveDate: IsoDateStringSchema,
    /** Absent means the operator asserts no expiry. Present and past refuses use. */
    expiresAt: IsoDateStringSchema.optional(),
    /**
     * Paths, relative to the approval file, of the licence evidence a reviewer
     * relied on. Recorded, never copied into the repository.
     */
    evidenceReferences: z.array(z.string().min(1).max(500)).default([]),
    /** The reviewer's own reasoning. Required — an unexplained approval is a rubber stamp. */
    notes: z.string().min(1).max(2000),
    approvedAt: IsoDateStringSchema,
  })
  .strict();
export type MediaApprovalRecord = z.infer<typeof MediaApprovalRecordSchema>;

/**
 * The approval file an operator submits to `aamp:media approve`.
 *
 * `runId` binds a set of approvals to the run whose evidence they were made
 * against. An approval written while looking at one run's gallery must not
 * silently apply to a different run's candidates with the same ids.
 */
export const MediaApprovalSubmissionSchema = z
  .object({
    submissionVersion: z.literal(1),
    runId: z.string().min(1).max(120),
    approvals: z.array(MediaApprovalRecordSchema).min(1),
  })
  .strict()
  .superRefine((submission, ctx) => {
    const seen = new Set<string>();
    submission.approvals.forEach((approval, index) => {
      if (seen.has(approval.candidateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approvals', index, 'candidateId'],
          message: `duplicate approval for "${approval.candidateId}" — one candidate, one decision`,
        });
      }
      seen.add(approval.candidateId);
    });
  });
export type MediaApprovalSubmission = z.infer<typeof MediaApprovalSubmissionSchema>;

/**
 * One approved candidate, paired with the decisions that let it be approved.
 *
 * Carrying the decisions alongside the approval is what makes the acquisition
 * step self-checking: it re-reads the rights outcome rather than trusting that
 * whoever wrote the approval file looked at it.
 */
export const MediaAcquisitionSelectionSchema = z
  .object({
    candidateId: z.string().min(1).max(120),
    provider: MediaAcquisitionProviderIdSchema,
    providerAssetId: z.string().min(1).max(200),
    /** Which rendition to fetch. Chosen by policy, recorded here. */
    renditionLabel: z.string().min(1).max(60),
    approval: MediaApprovalRecordSchema,
    rightsDecision: MediaRightsDecisionSchema,
  })
  .strict();
export type MediaAcquisitionSelection = z.infer<typeof MediaAcquisitionSelectionSchema>;

/* ------------------------------------------------------------------------- */
/* Run                                                                        */
/* ------------------------------------------------------------------------- */

export const MEDIA_RUN_ORIGINS = ['PROVIDER_SEARCH', 'EXTERNAL_PACK_IMPORT'] as const;
export const MediaRunOriginSchema = z.enum(MEDIA_RUN_ORIGINS);
export type MediaRunOrigin = z.infer<typeof MediaRunOriginSchema>;

/**
 * One acquisition run: a search or an import, its candidates, and everything
 * decided about them.
 *
 * `workspaceId` is here for the same reason every other workspace-owned record
 * carries one — a run belongs to a tenant, and a candidate approved in one
 * workspace is not approved in another.
 */
export const MediaAcquisitionRunSchema = z
  .object({
    runVersion: z.literal(1),
    runId: z.string().min(1).max(120),
    workspaceId: z.string().min(1).max(120),
    origin: MediaRunOriginSchema,
    startedAt: IsoDateStringSchema,
    /** The search that produced this run, absent for an import. */
    request: MediaSearchRequestSchema.optional(),
    /** The external folder an import read, absent for a search. Private provenance only. */
    externalPackPath: z.string().max(1000).optional(),
    providersQueried: z.array(MediaAcquisitionProviderIdSchema).default([]),
    candidates: z.array(MediaCandidateSchema).default([]),
    /** Providers that could not be reached or were not configured, named. */
    providerProblems: z
      .array(
        z
          .object({
            provider: MediaAcquisitionProviderIdSchema,
            kind: z.string().min(1).max(80),
            detail: z.string().min(1).max(600),
          })
          .strict(),
      )
      .default([]),
    /** Always false. No acquisition run has ever spent money; the field says so explicitly. */
    paidProviderCalls: z.literal(0).default(0),
  })
  .strict();
export type MediaAcquisitionRun = z.infer<typeof MediaAcquisitionRunSchema>;

/* ------------------------------------------------------------------------- */
/* Acquired asset                                                             */
/* ------------------------------------------------------------------------- */

/**
 * A downloaded, measured, approved file — the only shape from which a
 * production asset manifest entry may be built.
 *
 * The provenance block is the whole point: from a finished MP4 an auditor can
 * reach the manifest, the manifest entry, this record, the candidate, the
 * provider, the landing page, the creator, the licence and the named human who
 * approved it. Every one of those links is required, so none of them can be
 * dropped by an omission.
 */
export const AcquiredProductionAssetSchema = z
  .object({
    assetId: z.string().min(1).max(80),
    candidateId: z.string().min(1).max(120),
    provider: MediaAcquisitionProviderIdSchema,
    providerAssetId: z.string().min(1).max(200),
    mediaKind: MediaKindSchema,
    /** Relative to the acquisition output directory. Never absolute in an artefact. */
    relativePath: z.string().min(1).max(500),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    fileSizeBytes: z.number().int().positive(),
    measurements: MediaQualityMeasurementsSchema,
    qualityDecision: MediaQualityDecisionSchema,
    rights: MediaRightsFactsSchema,
    rightsDecision: MediaRightsDecisionSchema,
    approval: MediaApprovalRecordSchema,
    landingPageUrl: z.string().min(1).max(2000),
    /**
     * Host the bytes came from. The full download URL is deliberately absent:
     * a provider's direct URL is frequently signed or expiring, which makes it
     * a credential, and a credential does not belong in a committed artefact.
     */
    downloadHost: z.string().min(1).max(300),
    downloadedAt: IsoDateStringSchema,
    state: MediaCandidateStateSchema,
  })
  .strict();
export type AcquiredProductionAsset = z.infer<typeof AcquiredProductionAssetSchema>;

/* ------------------------------------------------------------------------- */
/* The separation guarantee                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Total over the provider enum, and always false.
 *
 * Production acquisition and Creative Memory are two systems with two rights
 * vocabularies, and this function exists so the boundary is stated in code
 * rather than in a comment: **no** media acquired here may be indexed as a
 * Creative Memory reference. Pexels footage is not a benchmark advertisement;
 * indexing it would put production material into an analysis-only store and
 * make the one enum that guarantees "references never reach output" carry
 * entries that are allowed to.
 *
 * The `never` assignment makes a new provider a compile error rather than an
 * accidental exemption.
 */
export function mediaAcquisitionGrantsNoReferenceUse(
  provider: MediaAcquisitionProviderId,
): boolean {
  switch (provider) {
    case 'PEXELS':
    case 'PIXABAY':
    case 'DVIDS':
    case 'WIKIMEDIA_COMMONS':
    case 'OPENVERSE':
    case 'EXTERNAL_PILOT_PACK':
      return true;
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

export const MEDIA_ACQUISITION_NOTICE =
  'Acquisition grants no output rights on its own. A candidate becomes usable in an advertisement only through a named human approval recorded against the specific item, and never because it was reachable, downloaded or measured. Material acquired here is production material and is never indexed as a Creative Memory reference.';
