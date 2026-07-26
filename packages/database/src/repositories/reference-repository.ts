import type { BenchmarkProfileDataSource } from './benchmark-profile-repository';
import type { CreativeMemoryIndexDataSource } from './creative-memory-index-repository';
import type {
  ReferenceBusinessRole,
  ReferenceFailureReason,
  ReferenceProcessingState,
  ReferenceRightsClassification,
  SourceAccessBasis,
} from '@combat/domain';

/**
 * Creative Memory persistence — the reference (inspiration) side.
 *
 * Deliberately a separate repository from `asset-repository.ts`, over separate
 * tables, with a separate rights vocabulary. There is no function here that
 * returns something a render manifest could consume, and no function in the
 * production asset repository that can reach these rows. That separation is
 * the whole safety property: an agency benchmark cannot end up in an
 * advertisement if nothing production-side can even name it.
 *
 * Every function takes `workspaceId` first and folds it into the query, per
 * CLAUDE.md's repository rule — a reference is never looked up by id alone.
 */

export interface ReferenceSourceRecord {
  id: string;
  workspaceId: string;
  officialUrl?: string;
  accessBasis: SourceAccessBasis;
  rightsClassification: ReferenceRightsClassification;
  rightsHolder: string;
  permittedUses: string[];
  prohibitedUses: string[];
  attribution?: string;
  jurisdictionNotes?: string;
  outputUseProhibited: boolean;
  createdAt: Date;
}

export interface ReferenceAdvertisementRecord {
  id: string;
  workspaceId: string;
  referenceSourceId: string;
  referenceKey: string;
  title: string;
  brand: string;
  campaign?: string;
  agency?: string;
  productionCompany?: string;
  director?: string;
  platform?: string;
  publicationYear?: number;
  declaredDurationSeconds?: number;
  businessRoles: ReferenceBusinessRole[];
  operatorNotes?: string;
  processingState: ReferenceProcessingState;
  failureReason?: ReferenceFailureReason;
  failureDetail?: string;
  mediaAcquired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReferenceMediaRecord {
  id: string;
  workspaceId: string;
  referenceAdvertisementId: string;
  localPath: string;
  checksumSha256: string;
  sizeBytes: bigint;
  durationSeconds: number;
  widthPx: number;
  heightPx: number;
  frameRate: number;
  videoCodec: string;
  hasAudio: boolean;
  audioCodec?: string;
  aspectRatio: string;
  createdAt: Date;
}

export interface ReferenceSceneRecord {
  id: string;
  workspaceId: string;
  referenceAdvertisementId: string;
  sceneIndex: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  detectionMethod: string;
  detectorConfig: unknown;
  confidence?: number;
  createdAt: Date;
}

export interface ReferenceFrameRecord {
  id: string;
  workspaceId: string;
  referenceAdvertisementId: string;
  referenceSceneId?: string;
  kind: 'START' | 'MIDPOINT' | 'END';
  timestampSeconds: number;
  localPath: string;
  checksumSha256: string;
  widthPx: number;
  heightPx: number;
  createdAt: Date;
}

export interface ReferenceCraftMetricsRecord {
  id: string;
  workspaceId: string;
  referenceAdvertisementId: string;
  durationSeconds: number;
  sceneCount: number;
  cutsPerSecond: number;
  aspectRatio: string;
  widthPx: number;
  heightPx: number;
  frameRate: number;
  videoCodec: string;
  hasAudio: boolean;
  createdAt: Date;
  [key: string]: unknown;
}

export interface ReferenceAnnotationRecord {
  id: string;
  workspaceId: string;
  referenceAdvertisementId: string;
  version: number;
  authorId: string;
  transferablePrinciple: string;
  prohibitedDirectSimilarity: string;
  reviewerConfidence: 'LOW' | 'MEDIUM' | 'HIGH';
  approved: boolean;
  createdAt: Date;
  [key: string]: unknown;
}

export interface ReferenceIngestionRunRecord {
  id: string;
  workspaceId: string;
  idempotencyKey: string;
  startedAt: Date;
  completedAt?: Date;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  toolVersions: unknown;
}

export interface ReferenceDerivedArtifactRecord {
  id: string;
  workspaceId: string;
  referenceAdvertisementId: string;
  referenceSceneId?: string;
  ingestionRunId: string;
  kind: 'PROXY' | 'FRAME' | 'SCENE_CLIP' | 'TRANSCRIPT';
  localPath: string;
  checksumSha256: string;
  sizeBytes: bigint;
  sourceChecksumSha256: string;
  extractionCommand: string;
  toolVersion: string;
  analysisOnly: boolean;
  createdAt: Date;
}

/**
 * The Prisma-shaped surface this repository needs. Mirrors the other
 * repositories' style.
 *
 * It extends `BenchmarkProfileDataSource` because governance profiles are part
 * of the same reference-side world and always travel with the same database
 * handle — a caller that can read references is exactly the caller that needs
 * to know which of them a human approved for use.
 */
export interface ReferenceDataSource
  extends BenchmarkProfileDataSource, CreativeMemoryIndexDataSource {
  referenceSource: {
    create(args: { data: Record<string, unknown> }): Promise<ReferenceSourceRecord>;
    findFirst(args: { where: Record<string, unknown> }): Promise<ReferenceSourceRecord | null>;
  };
  referenceAdvertisement: {
    create(args: { data: Record<string, unknown> }): Promise<ReferenceAdvertisementRecord>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<ReferenceAdvertisementRecord>;
    findFirst(args: {
      where: Record<string, unknown>;
    }): Promise<ReferenceAdvertisementRecord | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<ReferenceAdvertisementRecord[]>;
  };
  referenceMedia: {
    create(args: { data: Record<string, unknown> }): Promise<ReferenceMediaRecord>;
    findFirst(args: { where: Record<string, unknown> }): Promise<ReferenceMediaRecord | null>;
  };
  referenceScene: {
    create(args: { data: Record<string, unknown> }): Promise<ReferenceSceneRecord>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<ReferenceSceneRecord[]>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  referenceFrame: {
    create(args: { data: Record<string, unknown> }): Promise<ReferenceFrameRecord>;
    findMany(args: { where: Record<string, unknown> }): Promise<ReferenceFrameRecord[]>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  referenceTranscript: {
    create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
    findMany(args: { where: Record<string, unknown> }): Promise<Record<string, unknown>[]>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  referenceCraftMetrics: {
    create(args: { data: Record<string, unknown> }): Promise<ReferenceCraftMetricsRecord>;
    findFirst(args: {
      where: Record<string, unknown>;
    }): Promise<ReferenceCraftMetricsRecord | null>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  referenceAnnotation: {
    create(args: { data: Record<string, unknown> }): Promise<ReferenceAnnotationRecord>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<ReferenceAnnotationRecord>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<ReferenceAnnotationRecord[]>;
  };
  referenceIngestionRun: {
    create(args: { data: Record<string, unknown> }): Promise<ReferenceIngestionRunRecord>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<ReferenceIngestionRunRecord>;
    findFirst(args: {
      where: Record<string, unknown>;
    }): Promise<ReferenceIngestionRunRecord | null>;
  };
  referenceDerivedArtifact: {
    create(args: { data: Record<string, unknown> }): Promise<ReferenceDerivedArtifactRecord>;
    findMany(args: { where: Record<string, unknown> }): Promise<ReferenceDerivedArtifactRecord[]>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

export class ReferenceRightsViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceRightsViolationError';
  }
}

/**
 * The last line of defence before a reference reaches the database.
 *
 * The manifest schema already refuses an output-permitting classification, and
 * the Prisma enum cannot express one. This check exists anyway because it is
 * cheap, and because the cost of the failure it guards against — an agency
 * advertisement acquiring output rights — is not symmetric with the cost of
 * one redundant comparison.
 */
export function assertReferenceClassification(classification: string): void {
  if (classification === 'LICENSED_FOR_OUTPUT' || classification === 'PRODUCTION_ASSET') {
    throw new ReferenceRightsViolationError(
      `"${classification}" is not a reference rights classification — reference material is never output-eligible. Ingest output material through the production-asset system instead.`,
    );
  }
}

export async function createReferenceSource(
  db: ReferenceDataSource,
  workspaceId: string,
  input: Omit<ReferenceSourceRecord, 'id' | 'workspaceId' | 'createdAt' | 'outputUseProhibited'>,
): Promise<ReferenceSourceRecord> {
  assertReferenceClassification(input.rightsClassification);
  return db.referenceSource.create({
    data: {
      workspaceId,
      officialUrl: input.officialUrl,
      accessBasis: input.accessBasis,
      rightsClassification: input.rightsClassification,
      rightsHolder: input.rightsHolder,
      permittedUses: input.permittedUses,
      prohibitedUses: input.prohibitedUses,
      attribution: input.attribution,
      jurisdictionNotes: input.jurisdictionNotes,
      // Never caller-supplied: it is the one invariant of this table.
      outputUseProhibited: true,
    },
  });
}

export async function getReferenceByKey(
  db: ReferenceDataSource,
  workspaceId: string,
  referenceKey: string,
): Promise<ReferenceAdvertisementRecord | null> {
  return db.referenceAdvertisement.findFirst({ where: { workspaceId, referenceKey } });
}

/** Checksum lookup — how duplicate ingestion is detected before any work is done. */
export async function findReferenceMediaByChecksum(
  db: ReferenceDataSource,
  workspaceId: string,
  checksumSha256: string,
): Promise<ReferenceMediaRecord | null> {
  return db.referenceMedia.findFirst({ where: { workspaceId, checksumSha256 } });
}

export async function createReferenceAdvertisement(
  db: ReferenceDataSource,
  workspaceId: string,
  input: {
    referenceSourceId: string;
    referenceKey: string;
    title: string;
    brand: string;
    campaign?: string;
    agency?: string;
    productionCompany?: string;
    director?: string;
    platform?: string;
    publicationYear?: number;
    declaredDurationSeconds?: number;
    businessRoles: ReferenceBusinessRole[];
    operatorNotes?: string;
    processingState?: ReferenceProcessingState;
    mediaAcquired: boolean;
  },
): Promise<ReferenceAdvertisementRecord> {
  return db.referenceAdvertisement.create({
    data: { workspaceId, ...input, processingState: input.processingState ?? 'REGISTERED' },
  });
}

/**
 * Refreshes the metadata an operator *declared* in the manifest.
 *
 * Only declared fields. `processingState`, `failureReason` and `mediaAcquired`
 * are outcomes of the analysis pipeline, not manifest values, and rewriting
 * them here would let an edited manifest reset a reference's state without any
 * analysis having happened.
 *
 * This exists because re-ingesting an existing reference previously reused the
 * stored row untouched: an operator who corrected `businessRoles` and re-ran
 * with `--force` got a fresh analysis attached to the *old* declared metadata,
 * with nothing to indicate the edit had been ignored.
 */
export async function updateReferenceDeclaredMetadata(
  db: ReferenceDataSource,
  workspaceId: string,
  referenceAdvertisementId: string,
  input: {
    referenceSourceId: string;
    title: string;
    brand: string;
    campaign?: string;
    agency?: string;
    productionCompany?: string;
    director?: string;
    platform?: string;
    publicationYear?: number;
    declaredDurationSeconds?: number;
    businessRoles: ReferenceBusinessRole[];
    operatorNotes?: string;
  },
): Promise<ReferenceAdvertisementRecord> {
  const existing = await db.referenceAdvertisement.findFirst({
    where: { workspaceId, id: referenceAdvertisementId },
  });
  if (!existing) {
    throw new Error(`Reference ${referenceAdvertisementId} not found in workspace ${workspaceId}`);
  }
  return db.referenceAdvertisement.update({
    where: { id: referenceAdvertisementId },
    data: {
      referenceSourceId: input.referenceSourceId,
      title: input.title,
      brand: input.brand,
      campaign: input.campaign ?? null,
      agency: input.agency ?? null,
      productionCompany: input.productionCompany ?? null,
      director: input.director ?? null,
      platform: input.platform ?? null,
      publicationYear: input.publicationYear ?? null,
      declaredDurationSeconds: input.declaredDurationSeconds ?? null,
      businessRoles: input.businessRoles,
      operatorNotes: input.operatorNotes ?? null,
    },
  });
}

export async function setReferenceState(
  db: ReferenceDataSource,
  workspaceId: string,
  referenceAdvertisementId: string,
  state: ReferenceProcessingState,
  failure?: { reason: ReferenceFailureReason; detail: string },
): Promise<ReferenceAdvertisementRecord> {
  const existing = await db.referenceAdvertisement.findFirst({
    where: { workspaceId, id: referenceAdvertisementId },
  });
  if (!existing) {
    throw new Error(`Reference ${referenceAdvertisementId} not found in workspace ${workspaceId}`);
  }
  return db.referenceAdvertisement.update({
    where: { id: referenceAdvertisementId },
    data: {
      processingState: state,
      failureReason: failure?.reason ?? null,
      failureDetail: failure?.detail ?? null,
    },
  });
}

export async function listReferences(
  db: ReferenceDataSource,
  workspaceId: string,
  filter: { processingState?: ReferenceProcessingState; businessRole?: ReferenceBusinessRole } = {},
): Promise<ReferenceAdvertisementRecord[]> {
  return db.referenceAdvertisement.findMany({
    where: {
      workspaceId,
      ...(filter.processingState ? { processingState: filter.processingState } : {}),
      ...(filter.businessRole ? { businessRoles: { has: filter.businessRole } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function listReferenceScenes(
  db: ReferenceDataSource,
  workspaceId: string,
  referenceAdvertisementId: string,
): Promise<ReferenceSceneRecord[]> {
  return db.referenceScene.findMany({
    where: { workspaceId, referenceAdvertisementId },
    orderBy: { sceneIndex: 'asc' },
  });
}

/**
 * Replaces a reference's derived analysis rows.
 *
 * Re-ingestion must be idempotent, and the honest way to achieve that for
 * derived data is to delete and rewrite rather than to attempt a merge: scene
 * indices shift when a detector or threshold changes, so a partial update
 * would leave orphaned scenes from a previous segmentation silently in place.
 */
export async function clearDerivedAnalysis(
  db: ReferenceDataSource,
  workspaceId: string,
  referenceAdvertisementId: string,
): Promise<void> {
  const where = { workspaceId, referenceAdvertisementId };
  await db.referenceDerivedArtifact.deleteMany({ where });
  await db.referenceFrame.deleteMany({ where });
  await db.referenceCraftMetrics.deleteMany({ where });
  await db.referenceScene.deleteMany({ where });
}

export async function createReferenceAnnotation(
  db: ReferenceDataSource,
  workspaceId: string,
  referenceAdvertisementId: string,
  input: Record<string, unknown> & {
    authorId: string;
    transferablePrinciple: string;
    prohibitedDirectSimilarity: string;
    reviewerConfidence: 'LOW' | 'MEDIUM' | 'HIGH';
  },
): Promise<ReferenceAnnotationRecord> {
  const existing = await db.referenceAnnotation.findMany({
    where: { workspaceId, referenceAdvertisementId },
    orderBy: { version: 'desc' },
  });
  // Annotations are versioned, never edited in place: a later reader must be
  // able to see what an earlier reviewer actually thought.
  const version = (existing[0]?.version ?? 0) + 1;
  return db.referenceAnnotation.create({
    data: { workspaceId, referenceAdvertisementId, version, approved: false, ...input },
  });
}

export async function approveReferenceAnnotation(
  db: ReferenceDataSource,
  workspaceId: string,
  annotationId: string,
): Promise<ReferenceAnnotationRecord> {
  const [annotation] = await db.referenceAnnotation.findMany({
    where: { workspaceId, id: annotationId },
  });
  if (!annotation) {
    throw new Error(`Annotation ${annotationId} not found in workspace ${workspaceId}`);
  }
  return db.referenceAnnotation.update({
    where: { id: annotationId },
    data: { approved: true },
  });
}
