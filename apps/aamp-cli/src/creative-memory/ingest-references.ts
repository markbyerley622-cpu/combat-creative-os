import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  assertReferenceClassification,
  clearDerivedAnalysis,
  createReferenceAdvertisement,
  createReferenceAnnotation,
  createReferenceSource,
  findReferenceMediaByChecksum,
  getReferenceByKey,
  setReferenceState,
  type ReferenceDataSource,
} from '@combat/database';
import type {
  ReferenceFailureReason,
  ReferenceIngestionManifest,
  ReferenceManifestEntry,
} from '@combat/domain';
import {
  aspectRatioOf,
  computeSceneStatistics,
  measureBitrate,
  measureBlackFrameIntervals,
  measureSilenceIntervals,
  NodeCommandRunner,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';
import {
  SceneDetectionError,
  UnavailableTranscriptionProvider,
  type SceneDetectionProvider,
  type TranscriptionProvider,
} from '@combat/providers';

import { deriveAnalysisMedia, DerivationError } from './derive-analysis-media';
import { ReferenceValidationError, validateReferenceMedia } from './reference-validation';

/**
 * Ingests a reference manifest: register, validate, inspect, segment, derive,
 * measure, annotate.
 *
 * Each reference advances through the processing states one step at a time and
 * the state is persisted after each, so a run interrupted halfway leaves a
 * database that says exactly how far it got. Failures are per-reference: one
 * unreadable file does not abandon the rest of a library, and the reason is
 * recorded on the row rather than only printed.
 *
 * Nothing here can produce an output-eligible asset. It writes only to
 * `reference_*` tables through the reference repository, and derived media
 * goes to the analysis directory, never a production storage namespace.
 */

export interface IngestOptions {
  readonly manifest: ReferenceIngestionManifest;
  readonly manifestDir: string;
  readonly db: ReferenceDataSource;
  readonly sceneDetector: SceneDetectionProvider;
  readonly transcriber?: TranscriptionProvider;
  readonly binaries: FfmpegBinaries;
  /** Roots a reference file may live inside. */
  readonly referenceRoots: readonly string[];
  /** Root of the analysis output tree. Never a production namespace. */
  readonly analysisDirectory: string;
  readonly runner?: CommandRunner;
  /** Re-derive even when this checksum was ingested before. */
  readonly force?: boolean;
  readonly extractSceneClips?: boolean;
  readonly onProgress?: (message: string) => void;
  readonly signal?: AbortSignal;
}

export interface ReferenceOutcome {
  readonly referenceId: string;
  readonly status: 'INGESTED' | 'REGISTERED_LINK_ONLY' | 'SKIPPED_DUPLICATE' | 'FAILED';
  readonly referenceAdvertisementId?: string;
  readonly sceneCount?: number;
  readonly frameCount?: number;
  readonly transcriptAvailable?: boolean;
  readonly failureReason?: ReferenceFailureReason;
  readonly detail?: string;
}

export interface IngestResult {
  readonly ingestionRunId: string;
  readonly outcomes: readonly ReferenceOutcome[];
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
}

/** Maps a validation failure onto the persisted, CLI-mappable reason. */
function validationReason(kind: string): ReferenceFailureReason {
  switch (kind) {
    case 'UNSAFE_PATH':
      return 'UNSAFE_PATH';
    case 'CHECKSUM_MISMATCH':
    case 'UNSUPPORTED_MEDIA':
    case 'TOO_LARGE':
    case 'TOO_LONG':
      return 'INSPECTION_FAILED';
    default:
      return 'MISSING_MEDIA';
  }
}

export async function ingestReferences(options: IngestOptions): Promise<IngestResult> {
  const { manifest, db, onProgress } = options;
  const workspaceId = manifest.workspaceId;
  const runner = options.runner ?? new NodeCommandRunner();
  const transcriber = options.transcriber ?? new UnavailableTranscriptionProvider();

  // Derived from the manifest content, so re-running the same manifest resumes
  // the same run rather than opening a second one.
  const idempotencyKey = createHash('sha256')
    .update(
      JSON.stringify({
        library: manifest.library,
        ids: manifest.references.map((r) => r.referenceId),
      }),
    )
    .digest('hex')
    .slice(0, 40);

  const existingRun = await db.referenceIngestionRun.findFirst({
    where: { workspaceId, idempotencyKey },
  });
  const run =
    existingRun ??
    (await db.referenceIngestionRun.create({
      data: {
        workspaceId,
        idempotencyKey,
        succeededCount: 0,
        failedCount: 0,
        skippedCount: 0,
        toolVersions: { sceneDetector: options.sceneDetector.name, transcriber: transcriber.name },
      },
    }));

  const outcomes: ReferenceOutcome[] = [];

  for (const entry of manifest.references) {
    onProgress?.(`reference ${entry.referenceId}`);
    try {
      // eslint-disable-next-line no-await-in-loop -- references are ingested in manifest order so outcomes are reportable in order
      outcomes.push(
        await ingestOne(entry, { ...options, runner, transcriber }, run.id, workspaceId),
      );
    } catch (error) {
      outcomes.push({
        referenceId: entry.referenceId,
        status: 'FAILED',
        failureReason: 'PERSISTENCE_FAILED',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const succeededCount = outcomes.filter(
    (outcome) => outcome.status === 'INGESTED' || outcome.status === 'REGISTERED_LINK_ONLY',
  ).length;
  const failedCount = outcomes.filter((outcome) => outcome.status === 'FAILED').length;
  const skippedCount = outcomes.filter((outcome) => outcome.status === 'SKIPPED_DUPLICATE').length;

  await db.referenceIngestionRun.update({
    where: { id: run.id },
    data: { completedAt: new Date(), succeededCount, failedCount, skippedCount },
  });

  return { ingestionRunId: run.id, outcomes, succeededCount, failedCount, skippedCount };
}

async function ingestOne(
  entry: ReferenceManifestEntry,
  options: IngestOptions & { runner: CommandRunner; transcriber: TranscriptionProvider },
  ingestionRunId: string,
  workspaceId: string,
): Promise<ReferenceOutcome> {
  const { db } = options;

  // Belt and braces: the manifest schema and the Prisma enum both already
  // exclude an output classification.
  assertReferenceClassification(entry.rightsClassification);

  const existing = await getReferenceByKey(db, workspaceId, entry.referenceId);
  const source = await createReferenceSource(db, workspaceId, {
    ...(entry.officialUrl ? { officialUrl: entry.officialUrl } : {}),
    accessBasis: entry.accessBasis,
    rightsClassification: entry.rightsClassification,
    rightsHolder: entry.rightsHolder,
    permittedUses: [...entry.permittedUses],
    prohibitedUses: [...entry.prohibitedUses],
    ...(entry.attribution ? { attribution: entry.attribution } : {}),
    ...(entry.jurisdictionNotes ? { jurisdictionNotes: entry.jurisdictionNotes } : {}),
  });

  const advertisement =
    existing ??
    (await createReferenceAdvertisement(db, workspaceId, {
      referenceSourceId: source.id,
      referenceKey: entry.referenceId,
      title: entry.title,
      brand: entry.brand,
      ...(entry.campaign ? { campaign: entry.campaign } : {}),
      ...(entry.agency ? { agency: entry.agency } : {}),
      ...(entry.productionCompany ? { productionCompany: entry.productionCompany } : {}),
      ...(entry.director ? { director: entry.director } : {}),
      ...(entry.platform ? { platform: entry.platform } : {}),
      ...(entry.publicationYear ? { publicationYear: entry.publicationYear } : {}),
      ...(entry.declaredDurationSeconds
        ? { declaredDurationSeconds: entry.declaredDurationSeconds }
        : {}),
      businessRoles: [...entry.businessRoles],
      ...(entry.operatorNotes ? { operatorNotes: entry.operatorNotes } : {}),
      mediaAcquired: entry.rightsClassification !== 'LINK_ONLY',
    }));

  if (entry.annotation) {
    const { authorId, ...rest } = entry.annotation;
    await createReferenceAnnotation(db, workspaceId, advertisement.id, {
      authorId,
      ...rest,
      transferablePrinciple: entry.annotation.transferablePrinciple,
      prohibitedDirectSimilarity: entry.annotation.prohibitedDirectSimilarity,
      reviewerConfidence: entry.annotation.reviewerConfidence,
    });
  }

  // --- link-only stops here, by design --------------------------------------
  if (entry.rightsClassification === 'LINK_ONLY') {
    // No bytes were acquired, so there is nothing to inspect. Fabricating a
    // duration or a scene count here would be inventing evidence.
    await setReferenceState(db, workspaceId, advertisement.id, 'REGISTERED');
    return {
      referenceId: entry.referenceId,
      status: 'REGISTERED_LINK_ONLY',
      referenceAdvertisementId: advertisement.id,
    };
  }

  const fail = async (
    reason: ReferenceFailureReason,
    detail: string,
  ): Promise<ReferenceOutcome> => {
    await setReferenceState(db, workspaceId, advertisement.id, 'FAILED', { reason, detail });
    return {
      referenceId: entry.referenceId,
      status: 'FAILED',
      referenceAdvertisementId: advertisement.id,
      failureReason: reason,
      detail,
    };
  };

  // --- validate --------------------------------------------------------------
  let media;
  try {
    media = await validateReferenceMedia({
      entry,
      manifestDir: options.manifestDir,
      referenceRoots: options.referenceRoots,
      binaries: options.binaries,
      runner: options.runner,
    });
  } catch (error) {
    if (error instanceof ReferenceValidationError) {
      return fail(validationReason(error.kind), error.message);
    }
    throw error;
  }
  await setReferenceState(db, workspaceId, advertisement.id, 'VALIDATED');

  // --- duplicate detection ----------------------------------------------------
  const duplicate = await findReferenceMediaByChecksum(db, workspaceId, media.checksumSha256);
  if (duplicate && duplicate.referenceAdvertisementId !== advertisement.id && !options.force) {
    return {
      referenceId: entry.referenceId,
      status: 'SKIPPED_DUPLICATE',
      referenceAdvertisementId: advertisement.id,
      detail: `checksum ${media.checksumSha256} was already ingested as reference ${duplicate.referenceAdvertisementId}`,
    };
  }

  // Re-ingesting the same reference replaces its derived analysis wholesale;
  // a partial merge would leave scenes from a previous segmentation stranded.
  await clearDerivedAnalysis(db, workspaceId, advertisement.id);
  if (!duplicate) {
    await db.referenceMedia.create({
      data: {
        workspaceId,
        referenceAdvertisementId: advertisement.id,
        localPath: media.absolutePath,
        checksumSha256: media.checksumSha256,
        sizeBytes: BigInt(media.sizeBytes),
        durationSeconds: media.durationSeconds,
        widthPx: media.widthPx,
        heightPx: media.heightPx,
        frameRate: media.frameRate,
        videoCodec: media.videoCodec,
        hasAudio: media.hasAudio,
        ...(media.audioCodec ? { audioCodec: media.audioCodec } : {}),
        aspectRatio: aspectRatioOf(media.widthPx, media.heightPx),
      },
    });
  }
  await setReferenceState(db, workspaceId, advertisement.id, 'INSPECTED');

  // --- segment ----------------------------------------------------------------
  let detection;
  try {
    detection = await options.sceneDetector.detectScenes({
      filePath: media.absolutePath,
      durationSeconds: media.durationSeconds,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return fail(
      'SCENE_DETECTION_FAILED',
      error instanceof SceneDetectionError
        ? `${error.kind}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  const sceneIdByIndex = new Map<number, string>();
  for (const scene of detection.scenes) {
    // eslint-disable-next-line no-await-in-loop -- scenes are written in index order
    const row = await db.referenceScene.create({
      data: {
        workspaceId,
        referenceAdvertisementId: advertisement.id,
        sceneIndex: scene.sceneIndex,
        startSeconds: scene.startSeconds,
        endSeconds: scene.endSeconds,
        durationSeconds: scene.durationSeconds,
        detectionMethod: detection.method,
        detectorConfig: detection.detectorConfig,
        ...(scene.confidence === undefined ? {} : { confidence: scene.confidence }),
      },
    });
    sceneIdByIndex.set(scene.sceneIndex, row.id);
  }
  await setReferenceState(db, workspaceId, advertisement.id, 'SEGMENTED');

  // --- derive analysis media ---------------------------------------------------
  const analysisDirectory = join(options.analysisDirectory, entry.referenceId);
  let artifacts;
  try {
    artifacts = await deriveAnalysisMedia({
      sourcePath: media.absolutePath,
      sourceChecksumSha256: media.checksumSha256,
      durationSeconds: media.durationSeconds,
      scenes: detection.scenes,
      outputDirectory: analysisDirectory,
      binaries: options.binaries,
      toolVersion: detection.toolVersion,
      ...(options.extractSceneClips ? { extractSceneClips: true } : {}),
      runner: options.runner,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return fail(
      'DERIVATION_FAILED',
      error instanceof DerivationError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  let frameCount = 0;
  for (const artifact of artifacts) {
    const sceneId =
      artifact.sceneIndex === undefined ? undefined : sceneIdByIndex.get(artifact.sceneIndex);
    // eslint-disable-next-line no-await-in-loop -- artefacts are written in extraction order
    await db.referenceDerivedArtifact.create({
      data: {
        workspaceId,
        referenceAdvertisementId: advertisement.id,
        ...(sceneId ? { referenceSceneId: sceneId } : {}),
        ingestionRunId,
        kind: artifact.kind,
        localPath: artifact.localPath,
        checksumSha256: artifact.checksumSha256,
        sizeBytes: BigInt(artifact.sizeBytes),
        // Provenance back to the original, on every derived byte.
        sourceChecksumSha256: media.checksumSha256,
        extractionCommand: artifact.extractionCommand,
        toolVersion: artifact.toolVersion,
        analysisOnly: true,
      },
    });

    if (artifact.kind === 'FRAME' && artifact.frameKind) {
      frameCount += 1;
      // eslint-disable-next-line no-await-in-loop -- same ordering rationale
      await db.referenceFrame.create({
        data: {
          workspaceId,
          referenceAdvertisementId: advertisement.id,
          ...(sceneId ? { referenceSceneId: sceneId } : {}),
          kind: artifact.frameKind,
          timestampSeconds: artifact.timestampSeconds ?? 0,
          localPath: artifact.localPath,
          checksumSha256: artifact.checksumSha256,
          widthPx: media.widthPx,
          heightPx: media.heightPx,
        },
      });
    }
  }

  // --- measure -----------------------------------------------------------------
  const statistics = computeSceneStatistics(detection.scenes, media.durationSeconds);
  const probeQuery = {
    runner: options.runner,
    binaries: options.binaries,
    filePath: media.absolutePath,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const [silenceIntervals, blackFrameIntervals, bitrate] = await Promise.all([
    media.hasAudio ? measureSilenceIntervals(probeQuery) : Promise.resolve([]),
    measureBlackFrameIntervals(probeQuery),
    measureBitrate(probeQuery),
  ]);

  await db.referenceCraftMetrics.create({
    data: {
      workspaceId,
      referenceAdvertisementId: advertisement.id,
      durationSeconds: media.durationSeconds,
      ...statistics,
      aspectRatio: aspectRatioOf(media.widthPx, media.heightPx),
      widthPx: media.widthPx,
      heightPx: media.heightPx,
      frameRate: media.frameRate,
      videoCodec: media.videoCodec,
      hasAudio: media.hasAudio,
      ...(media.audioCodec ? { audioCodec: media.audioCodec } : {}),
      ...bitrate,
      silenceIntervals,
      blackFrameIntervals,
    },
  });

  // --- optional transcript -------------------------------------------------------
  const transcription = await options.transcriber.transcribe({ filePath: media.absolutePath });
  if (transcription.available) {
    await db.referenceTranscript.create({
      data: {
        workspaceId,
        referenceAdvertisementId: advertisement.id,
        provider: transcription.provider,
        model: transcription.model,
        ...(transcription.language ? { language: transcription.language } : {}),
        segments: transcription.segments,
      },
    });
    await setReferenceState(db, workspaceId, advertisement.id, 'TRANSCRIBED');
  }

  // A human still has to read the annotations before this becomes retrievable.
  await setReferenceState(db, workspaceId, advertisement.id, 'REVIEW_REQUIRED');

  return {
    referenceId: entry.referenceId,
    status: 'INGESTED',
    referenceAdvertisementId: advertisement.id,
    sceneCount: detection.scenes.length,
    frameCount,
    transcriptAvailable: transcription.available,
  };
}
