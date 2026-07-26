import { z } from 'zod';

/**
 * Creative Memory — the reference (inspiration) side of the system.
 *
 * The single most important property of this file is that **nothing here can
 * ever authorise output use**. Reference material is studied; production
 * material is used. They are separate types, separate tables, separate storage
 * namespaces and separate repositories, and the boundary is enforced by
 * construction rather than by convention:
 *
 * - `ReferenceRightsClassification` and `@combat/media`'s `SourceUsageClass`
 *   share no output-permitting value. `LICENSED_FOR_OUTPUT` and
 *   `PRODUCTION_ASSET` are deliberately *absent* from the reference enum, so a
 *   reference literally cannot be spelled in a way the renderer would accept.
 * - `referenceGrantsNoOutputRights()` is a total function returning `true` for
 *   every classification, and a test asserts it stays total as the enum grows.
 * - Public availability is not permission, and ingestion is not a licence.
 *   Both facts are recorded on every record rather than left to documentation.
 */

/**
 * How a reference may lawfully be handled. Every value is analysis-side; none
 * permits output.
 *
 * - `LINK_ONLY` — metadata and a public URL. No bytes were acquired at all.
 * - `ANALYSIS_ONLY` — the operator lawfully possesses a copy for private study.
 * - `LICENSED_FOR_ANALYSIS` — a licence explicitly covering analysis exists.
 * - `OWNED_REFERENCE` — our own past work, kept as a benchmark. Even this does
 *   not authorise output here: to be used in an advertisement it must be
 *   ingested separately through the production-asset system, which performs its
 *   own rights check.
 */
export const REFERENCE_RIGHTS_CLASSIFICATIONS = [
  'LINK_ONLY',
  'ANALYSIS_ONLY',
  'LICENSED_FOR_ANALYSIS',
  'OWNED_REFERENCE',
] as const;
export const ReferenceRightsClassificationSchema = z.enum(REFERENCE_RIGHTS_CLASSIFICATIONS);
export type ReferenceRightsClassification = z.infer<typeof ReferenceRightsClassificationSchema>;

/**
 * Values that must never appear as a reference classification.
 *
 * Listed explicitly, and refused by name, because the failure mode being
 * guarded against is someone reasonably thinking "this footage is licensed, so
 * I'll mark it LICENSED_FOR_OUTPUT here too" — which is exactly how a benchmark
 * advertisement ends up in a render manifest.
 */
export const FORBIDDEN_REFERENCE_CLASSIFICATIONS = [
  'LICENSED_FOR_OUTPUT',
  'PRODUCTION_ASSET',
] as const;

export function isForbiddenReferenceClassification(value: string): boolean {
  return (FORBIDDEN_REFERENCE_CLASSIFICATIONS as readonly string[]).includes(value);
}

/**
 * Total by construction: there is no reference classification that grants
 * output rights, and `creative-memory.test.ts` asserts this stays true for
 * every member of the enum as it grows.
 */
export function referenceGrantsNoOutputRights(
  _classification: ReferenceRightsClassification,
): true {
  return true;
}

/** Only a classification carrying real bytes may be segmented into scenes. */
export function permitsLocalAnalysis(classification: ReferenceRightsClassification): boolean {
  return classification !== 'LINK_ONLY';
}

/** How the operator came to hold this reference. Recorded, never inferred. */
export const SOURCE_ACCESS_BASES = [
  'PUBLICLY_PUBLISHED_URL',
  'OPERATOR_LAWFUL_COPY',
  'DIRECT_LICENCE',
  'OWN_PAST_WORK',
  'SUPPLIED_BY_RIGHTS_HOLDER',
] as const;
export const SourceAccessBasisSchema = z.enum(SOURCE_ACCESS_BASES);
export type SourceAccessBasis = z.infer<typeof SourceAccessBasisSchema>;

/**
 * The AAMP benchmark roles a reference can demonstrate. Mirrors the specialist
 * agent taxonomy so a reference studied for, say, transitions is discoverable
 * by the part of the system that cares about transitions.
 */
export const REFERENCE_BUSINESS_ROLES = [
  'CAMPAIGN_STRATEGY',
  'CREATIVE_DIRECTION',
  'SCRIPT_AND_TIMING',
  'REFERENCE_INTELLIGENCE',
  'PREVISUALISATION',
  'VIDEO_PRODUCTION',
  'MOTION_AND_TRANSITIONS',
  'SOUND_AND_MUSIC',
  'VISUAL_QUALITY_CONTROL',
  'CONTINUITY_AND_EDITORIAL',
  'COPY_AND_BRAND_CONTROL',
  'PLATFORM_OPTIMISATION',
  'PERFORMANCE_ANALYSIS',
] as const;
export const ReferenceBusinessRoleSchema = z.enum(REFERENCE_BUSINESS_ROLES);
export type ReferenceBusinessRole = z.infer<typeof ReferenceBusinessRoleSchema>;

/**
 * The ingestion state machine.
 *
 * `READY_FOR_RETRIEVAL` is the most dangerous label in this file, so it is
 * worth being explicit: it means *the analysis pipeline finished and a human
 * approved the annotations*. It says nothing whatever about output rights —
 * `referenceGrantsNoOutputRights` is still true, and a test asserts that a
 * `READY_FOR_RETRIEVAL` reference is still refused by production selection.
 */
export const REFERENCE_PROCESSING_STATES = [
  'REGISTERED',
  'VALIDATED',
  'INSPECTED',
  'SEGMENTED',
  'TRANSCRIBED',
  'PROJECTED',
  'REVIEW_REQUIRED',
  'READY_FOR_RETRIEVAL',
  'FAILED',
] as const;
export const ReferenceProcessingStateSchema = z.enum(REFERENCE_PROCESSING_STATES);
export type ReferenceProcessingState = z.infer<typeof ReferenceProcessingStateSchema>;

/** States from which a reference may still advance. */
export const TERMINAL_REFERENCE_STATES: readonly ReferenceProcessingState[] = [
  'READY_FOR_RETRIEVAL',
  'FAILED',
];

/** Why a reference could not be ingested. Typed so a CLI can map it to an exit code. */
export const REFERENCE_FAILURE_REASONS = [
  'INVALID_MANIFEST',
  'INVALID_RIGHTS',
  'UNSAFE_PATH',
  'MISSING_MEDIA',
  'INSPECTION_FAILED',
  'SCENE_DETECTION_FAILED',
  'DERIVATION_FAILED',
  'TRANSCRIPTION_UNAVAILABLE',
  'DUPLICATE_REFERENCE',
  'PERSISTENCE_FAILED',
] as const;
export const ReferenceFailureReasonSchema = z.enum(REFERENCE_FAILURE_REASONS);
export type ReferenceFailureReason = z.infer<typeof ReferenceFailureReasonSchema>;

// --- Entities ---------------------------------------------------------------

/** Where a reference came from, and on what basis we hold it. */
export const ReferenceSourceSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  /** Official/public URL. Always recorded, even when a local copy exists. */
  officialUrl: z.string().url().optional(),
  accessBasis: SourceAccessBasisSchema,
  rightsClassification: ReferenceRightsClassificationSchema,
  rightsHolder: z.string().min(1).max(200),
  permittedUses: z.array(z.string().min(1)).min(1),
  prohibitedUses: z.array(z.string().min(1)).min(1),
  attribution: z.string().min(1).max(300).optional(),
  jurisdictionNotes: z.string().max(2000).optional(),
  /** Always true. Persisted rather than derived so the record is self-describing in a database dump. */
  outputUseProhibited: z.literal(true),
  createdAt: z.date(),
});
export type ReferenceSource = z.infer<typeof ReferenceSourceSchema>;

export const ReferenceAdvertisementSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  referenceSourceId: z.string().uuid(),
  /** Operator-supplied stable key, unique per workspace. */
  referenceKey: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  brand: z.string().min(1).max(200),
  campaign: z.string().max(300).optional(),
  agency: z.string().max(200).optional(),
  productionCompany: z.string().max(200).optional(),
  director: z.string().max(200).optional(),
  platform: z.string().max(80).optional(),
  publicationYear: z.number().int().min(1900).max(2200).optional(),
  declaredDurationSeconds: z.number().positive().optional(),
  businessRoles: z.array(ReferenceBusinessRoleSchema).min(1),
  operatorNotes: z.string().max(4000).optional(),
  processingState: ReferenceProcessingStateSchema,
  failureReason: ReferenceFailureReasonSchema.optional(),
  failureDetail: z.string().max(2000).optional(),
  /** False for LINK_ONLY: no bytes were ever acquired. */
  mediaAcquired: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ReferenceAdvertisement = z.infer<typeof ReferenceAdvertisementSchema>;

/** The measured facts about a locally-held reference file. Absent for LINK_ONLY. */
export const ReferenceMediaSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  referenceAdvertisementId: z.string().uuid(),
  /** Absolute path inside a configured reference root. Never a production path. */
  localPath: z.string().min(1),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  frameRate: z.number().positive(),
  videoCodec: z.string().min(1),
  hasAudio: z.boolean(),
  audioCodec: z.string().min(1).optional(),
  aspectRatio: z.string().min(1),
  createdAt: z.date(),
});
export type ReferenceMedia = z.infer<typeof ReferenceMediaSchema>;

export const ReferenceSceneSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  referenceAdvertisementId: z.string().uuid(),
  sceneIndex: z.number().int().nonnegative(),
  startSeconds: z.number().min(0),
  endSeconds: z.number().positive(),
  durationSeconds: z.number().positive(),
  detectionMethod: z.string().min(1),
  detectorConfig: z.record(z.string(), z.unknown()).default({}),
  /** Detector-reported score for the cut that opened this scene, when available. */
  confidence: z.number().optional(),
  createdAt: z.date(),
});
export type ReferenceScene = z.infer<typeof ReferenceSceneSchema>;

export const REFERENCE_FRAME_KINDS = ['START', 'MIDPOINT', 'END'] as const;
export const ReferenceFrameKindSchema = z.enum(REFERENCE_FRAME_KINDS);

export const ReferenceFrameSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  referenceAdvertisementId: z.string().uuid(),
  referenceSceneId: z.string().uuid().optional(),
  kind: ReferenceFrameKindSchema,
  timestampSeconds: z.number().min(0),
  localPath: z.string().min(1),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  createdAt: z.date(),
});
export type ReferenceFrame = z.infer<typeof ReferenceFrameSchema>;

export const TranscriptSegmentSchema = z
  .object({
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    text: z.string().min(1).max(2000),
  })
  .strict();

export const ReferenceTranscriptSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  referenceAdvertisementId: z.string().uuid(),
  provider: z.string().min(1),
  model: z.string().min(1),
  language: z.string().min(1).optional(),
  segments: z.array(TranscriptSegmentSchema),
  createdAt: z.date(),
});
export type ReferenceTranscript = z.infer<typeof ReferenceTranscriptSchema>;

/**
 * Deterministic, measured craft statistics. **No subjective judgement.**
 *
 * Everything here is computed from the file or from detected scene boundaries.
 * Words like "powerful", "premium" or "engaging" belong in
 * `ReferenceAnnotation`, authored by a named human, never in this record —
 * a measurement and an opinion are different kinds of claim and mixing them is
 * how a system starts asserting taste as fact.
 */
export const ReferenceCraftMetricsSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  referenceAdvertisementId: z.string().uuid(),
  durationSeconds: z.number().positive(),
  sceneCount: z.number().int().nonnegative(),
  firstCutSeconds: z.number().min(0).optional(),
  averageSceneSeconds: z.number().positive().optional(),
  medianSceneSeconds: z.number().positive().optional(),
  minSceneSeconds: z.number().positive().optional(),
  maxSceneSeconds: z.number().positive().optional(),
  cutsPerSecond: z.number().min(0),
  /** Histogram of scene durations, as `{ bucketSeconds: count }`. */
  sceneDurationHistogram: z.record(z.string(), z.number().int().nonnegative()).default({}),
  aspectRatio: z.string().min(1),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  frameRate: z.number().positive(),
  videoCodec: z.string().min(1),
  hasAudio: z.boolean(),
  audioCodec: z.string().min(1).optional(),
  averageBitrateBps: z.number().int().positive().optional(),
  peakBitrateBps: z.number().int().positive().optional(),
  silenceIntervals: z
    .array(
      z.object({ startSeconds: z.number().min(0), endSeconds: z.number().positive() }).strict(),
    )
    .default([]),
  blackFrameIntervals: z
    .array(
      z.object({ startSeconds: z.number().min(0), endSeconds: z.number().positive() }).strict(),
    )
    .default([]),
  createdAt: z.date(),
});
export type ReferenceCraftMetrics = z.infer<typeof ReferenceCraftMetricsSchema>;

/**
 * The human half. Every field is an interpretation, attributed to a named
 * author and versioned, so a later reader can tell whose judgement it was and
 * when it was made.
 */
export const ReferenceAnnotationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  referenceAdvertisementId: z.string().uuid(),
  version: z.number().int().positive(),
  authorId: z.string().min(1).max(200),
  hookMechanism: z.string().max(1000).optional(),
  audienceTension: z.string().max(1000).optional(),
  campaignProposition: z.string().max(1000).optional(),
  narrativeStructure: z.string().max(1000).optional(),
  productRevealSeconds: z.number().min(0).optional(),
  ctaSeconds: z.number().min(0).optional(),
  shotType: z.string().max(200).optional(),
  cameraMovement: z.string().max(200).optional(),
  transitionCategory: z.string().max(200).optional(),
  typographyBehaviour: z.string().max(1000).optional(),
  soundProgression: z.string().max(1000).optional(),
  emotionalMechanism: z.string().max(1000).optional(),
  platformNativeCharacteristics: z.string().max(1000).optional(),
  /**
   * What may be learned and reapplied. This is the entire point of Creative
   * Memory: a transferable principle, never a reusable asset.
   */
  transferablePrinciple: z.string().min(1).max(2000),
  /**
   * What must NOT be copied. Recorded alongside the principle so the two
   * always travel together — a lesson without its boundary invites imitation.
   */
  prohibitedDirectSimilarity: z.string().min(1).max(2000),
  reviewerConfidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  reviewerNotes: z.string().max(4000).optional(),
  approved: z.boolean(),
  createdAt: z.date(),
});
export type ReferenceAnnotation = z.infer<typeof ReferenceAnnotationSchema>;

export const ReferenceIngestionRunSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  /** Derived from the manifest so a re-run is idempotent. */
  idempotencyKey: z.string().min(1).max(200),
  startedAt: z.date(),
  completedAt: z.date().optional(),
  succeededCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  toolVersions: z.record(z.string(), z.string()).default({}),
});
export type ReferenceIngestionRun = z.infer<typeof ReferenceIngestionRunSchema>;

export const DERIVED_ARTIFACT_KINDS = ['PROXY', 'FRAME', 'SCENE_CLIP', 'TRANSCRIPT'] as const;
export const DerivedArtifactKindSchema = z.enum(DERIVED_ARTIFACT_KINDS);

/**
 * Provenance for every byte this system derived from a reference.
 *
 * `sourceChecksumSha256` and `extractionCommand` are what make a derived file
 * explicable months later: which original it came from, and exactly how. Both
 * are required — a derived artefact whose origin cannot be named is
 * indistinguishable from an asset of unknown rights.
 */
export const ReferenceDerivedArtifactSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  referenceAdvertisementId: z.string().uuid(),
  referenceSceneId: z.string().uuid().optional(),
  ingestionRunId: z.string().uuid(),
  kind: DerivedArtifactKindSchema,
  localPath: z.string().min(1),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  sourceChecksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  extractionCommand: z.string().min(1).max(4000),
  toolVersion: z.string().min(1).max(200),
  /** Always true. Derived analysis media is analysis media. */
  analysisOnly: z.literal(true),
  createdAt: z.date(),
});
export type ReferenceDerivedArtifact = z.infer<typeof ReferenceDerivedArtifactSchema>;

// --- Ingestion manifest ------------------------------------------------------

export const ReferenceManifestEntrySchema = z
  .object({
    referenceId: z.string().min(1).max(120),
    title: z.string().min(1).max(300),
    brand: z.string().min(1).max(200),
    campaign: z.string().max(300).optional(),
    agency: z.string().max(200).optional(),
    productionCompany: z.string().max(200).optional(),
    director: z.string().max(200).optional(),
    officialUrl: z.string().url().optional(),
    /** Relative to the manifest, or absolute. Containment enforced at resolution. */
    localAnalysisPath: z.string().min(1).optional(),
    accessBasis: SourceAccessBasisSchema,
    rightsClassification: ReferenceRightsClassificationSchema,
    rightsHolder: z.string().min(1).max(200),
    permittedUses: z.array(z.string().min(1)).min(1),
    prohibitedUses: z.array(z.string().min(1)).min(1),
    attribution: z.string().min(1).max(300).optional(),
    jurisdictionNotes: z.string().max(2000).optional(),
    platform: z.string().max(80).optional(),
    publicationYear: z.number().int().min(1900).max(2200).optional(),
    declaredDurationSeconds: z.number().positive().optional(),
    businessRoles: z.array(ReferenceBusinessRoleSchema).min(1),
    operatorNotes: z.string().max(4000).optional(),
    expectedChecksumSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'expectedChecksumSha256 must be a lowercase hex sha256')
      .optional(),
    annotation: ReferenceAnnotationSchema.pick({
      hookMechanism: true,
      audienceTension: true,
      campaignProposition: true,
      narrativeStructure: true,
      productRevealSeconds: true,
      ctaSeconds: true,
      shotType: true,
      cameraMovement: true,
      transitionCategory: true,
      typographyBehaviour: true,
      soundProgression: true,
      emotionalMechanism: true,
      platformNativeCharacteristics: true,
      transferablePrinciple: true,
      prohibitedDirectSimilarity: true,
      reviewerConfidence: true,
      reviewerNotes: true,
    })
      .extend({ authorId: z.string().min(1).max(200) })
      .optional(),
  })
  .strict();
export type ReferenceManifestEntry = z.infer<typeof ReferenceManifestEntrySchema>;

const ReferenceManifestObjectSchema = z
  .object({
    manifestVersion: z.literal(1),
    library: z.string().min(1).max(200),
    workspaceId: z.string().uuid(),
    references: z.array(ReferenceManifestEntrySchema).min(1),
  })
  .strict();

export const ReferenceIngestionManifestV1Schema = ReferenceManifestObjectSchema.superRefine(
  (manifest, ctx) => {
    const addIssue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };

    const ids = new Set<string>();
    manifest.references.forEach((entry, index) => {
      if (ids.has(entry.referenceId)) {
        addIssue(`duplicate referenceId "${entry.referenceId}"`, [
          'references',
          index,
          'referenceId',
        ]);
      }
      ids.add(entry.referenceId);

      // LINK_ONLY means exactly that: no bytes. A local path alongside it is a
      // contradiction, and silently honouring either half would misrepresent
      // what the operator actually holds.
      if (entry.rightsClassification === 'LINK_ONLY') {
        if (entry.localAnalysisPath) {
          addIssue(
            `"${entry.referenceId}" is LINK_ONLY but supplies localAnalysisPath — a link-only reference must acquire no media`,
            ['references', index, 'localAnalysisPath'],
          );
        }
        if (!entry.officialUrl) {
          addIssue(`"${entry.referenceId}" is LINK_ONLY and must supply officialUrl`, [
            'references',
            index,
            'officialUrl',
          ]);
        }
        if (entry.expectedChecksumSha256) {
          addIssue(
            `"${entry.referenceId}" is LINK_ONLY but supplies a checksum — there are no bytes to hash`,
            ['references', index, 'expectedChecksumSha256'],
          );
        }
      } else if (!entry.localAnalysisPath) {
        addIssue(
          `"${entry.referenceId}" is ${entry.rightsClassification} and must supply localAnalysisPath, or be registered as LINK_ONLY`,
          ['references', index, 'localAnalysisPath'],
        );
      }

      // Every record must say, in its own words, that it may not be used in
      // output. Enforced rather than assumed.
      const prohibits = entry.prohibitedUses.some((use) =>
        /output|advertis|broadcast|publish/i.test(use),
      );
      if (!prohibits) {
        addIssue(
          `"${entry.referenceId}" must explicitly prohibit output use in prohibitedUses (e.g. "no use in any produced advertisement")`,
          ['references', index, 'prohibitedUses'],
        );
      }
      const permitsOutput = entry.permittedUses.some((use) =>
        /output|advertis|broadcast|publish/i.test(use),
      );
      if (permitsOutput) {
        addIssue(
          `"${entry.referenceId}" lists an output-like permitted use — reference material is never output-eligible; ingest it through the production-asset system instead`,
          ['references', index, 'permittedUses'],
        );
      }
    });
  },
);
export type ReferenceIngestionManifest = z.infer<typeof ReferenceIngestionManifestV1Schema>;
