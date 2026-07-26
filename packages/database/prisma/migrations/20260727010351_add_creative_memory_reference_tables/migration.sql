-- CreateEnum
CREATE TYPE "ReferenceRightsClassification" AS ENUM ('LINK_ONLY', 'ANALYSIS_ONLY', 'LICENSED_FOR_ANALYSIS', 'OWNED_REFERENCE');

-- CreateEnum
CREATE TYPE "SourceAccessBasis" AS ENUM ('PUBLICLY_PUBLISHED_URL', 'OPERATOR_LAWFUL_COPY', 'DIRECT_LICENCE', 'OWN_PAST_WORK', 'SUPPLIED_BY_RIGHTS_HOLDER');

-- CreateEnum
CREATE TYPE "ReferenceBusinessRole" AS ENUM ('CAMPAIGN_STRATEGY', 'CREATIVE_DIRECTION', 'SCRIPT_AND_TIMING', 'REFERENCE_INTELLIGENCE', 'PREVISUALISATION', 'VIDEO_PRODUCTION', 'MOTION_AND_TRANSITIONS', 'SOUND_AND_MUSIC', 'VISUAL_QUALITY_CONTROL', 'CONTINUITY_AND_EDITORIAL', 'COPY_AND_BRAND_CONTROL', 'PLATFORM_OPTIMISATION', 'PERFORMANCE_ANALYSIS');

-- CreateEnum
CREATE TYPE "ReferenceProcessingState" AS ENUM ('REGISTERED', 'VALIDATED', 'INSPECTED', 'SEGMENTED', 'TRANSCRIBED', 'PROJECTED', 'REVIEW_REQUIRED', 'READY_FOR_RETRIEVAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ReferenceFailureReason" AS ENUM ('INVALID_MANIFEST', 'INVALID_RIGHTS', 'UNSAFE_PATH', 'MISSING_MEDIA', 'INSPECTION_FAILED', 'SCENE_DETECTION_FAILED', 'DERIVATION_FAILED', 'TRANSCRIPTION_UNAVAILABLE', 'DUPLICATE_REFERENCE', 'PERSISTENCE_FAILED');

-- CreateEnum
CREATE TYPE "ReferenceFrameKind" AS ENUM ('START', 'MIDPOINT', 'END');

-- CreateEnum
CREATE TYPE "ReferenceDerivedArtifactKind" AS ENUM ('PROXY', 'FRAME', 'SCENE_CLIP', 'TRANSCRIPT');

-- CreateEnum
CREATE TYPE "ReviewerConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "reference_sources" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "officialUrl" TEXT,
    "accessBasis" "SourceAccessBasis" NOT NULL,
    "rightsClassification" "ReferenceRightsClassification" NOT NULL,
    "rightsHolder" TEXT NOT NULL,
    "permittedUses" TEXT[],
    "prohibitedUses" TEXT[],
    "attribution" TEXT,
    "jurisdictionNotes" TEXT,
    "outputUseProhibited" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_advertisements" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "referenceSourceId" TEXT NOT NULL,
    "referenceKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "campaign" TEXT,
    "agency" TEXT,
    "productionCompany" TEXT,
    "director" TEXT,
    "platform" TEXT,
    "publicationYear" INTEGER,
    "declaredDurationSeconds" DOUBLE PRECISION,
    "businessRoles" "ReferenceBusinessRole"[],
    "operatorNotes" TEXT,
    "processingState" "ReferenceProcessingState" NOT NULL DEFAULT 'REGISTERED',
    "failureReason" "ReferenceFailureReason",
    "failureDetail" TEXT,
    "mediaAcquired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_advertisements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_media" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "referenceAdvertisementId" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,
    "frameRate" DOUBLE PRECISION NOT NULL,
    "videoCodec" TEXT NOT NULL,
    "hasAudio" BOOLEAN NOT NULL,
    "audioCodec" TEXT,
    "aspectRatio" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_scenes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "referenceAdvertisementId" TEXT NOT NULL,
    "sceneIndex" INTEGER NOT NULL,
    "startSeconds" DOUBLE PRECISION NOT NULL,
    "endSeconds" DOUBLE PRECISION NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "detectionMethod" TEXT NOT NULL,
    "detectorConfig" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_frames" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "referenceAdvertisementId" TEXT NOT NULL,
    "referenceSceneId" TEXT,
    "kind" "ReferenceFrameKind" NOT NULL,
    "timestampSeconds" DOUBLE PRECISION NOT NULL,
    "localPath" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_frames_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_transcripts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "referenceAdvertisementId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "language" TEXT,
    "segments" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_craft_metrics" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "referenceAdvertisementId" TEXT NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "sceneCount" INTEGER NOT NULL,
    "firstCutSeconds" DOUBLE PRECISION,
    "averageSceneSeconds" DOUBLE PRECISION,
    "medianSceneSeconds" DOUBLE PRECISION,
    "minSceneSeconds" DOUBLE PRECISION,
    "maxSceneSeconds" DOUBLE PRECISION,
    "cutsPerSecond" DOUBLE PRECISION NOT NULL,
    "sceneDurationHistogram" JSONB NOT NULL DEFAULT '{}',
    "aspectRatio" TEXT NOT NULL,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,
    "frameRate" DOUBLE PRECISION NOT NULL,
    "videoCodec" TEXT NOT NULL,
    "hasAudio" BOOLEAN NOT NULL,
    "audioCodec" TEXT,
    "averageBitrateBps" INTEGER,
    "peakBitrateBps" INTEGER,
    "silenceIntervals" JSONB NOT NULL DEFAULT '[]',
    "blackFrameIntervals" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_craft_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_annotations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "referenceAdvertisementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "authorId" TEXT NOT NULL,
    "hookMechanism" TEXT,
    "audienceTension" TEXT,
    "campaignProposition" TEXT,
    "narrativeStructure" TEXT,
    "productRevealSeconds" DOUBLE PRECISION,
    "ctaSeconds" DOUBLE PRECISION,
    "shotType" TEXT,
    "cameraMovement" TEXT,
    "transitionCategory" TEXT,
    "typographyBehaviour" TEXT,
    "soundProgression" TEXT,
    "emotionalMechanism" TEXT,
    "platformNativeCharacteristics" TEXT,
    "transferablePrinciple" TEXT NOT NULL,
    "prohibitedDirectSimilarity" TEXT NOT NULL,
    "reviewerConfidence" "ReviewerConfidence" NOT NULL,
    "reviewerNotes" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_ingestion_runs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "succeededCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "toolVersions" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "reference_ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_derived_artifacts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "referenceAdvertisementId" TEXT NOT NULL,
    "referenceSceneId" TEXT,
    "ingestionRunId" TEXT NOT NULL,
    "kind" "ReferenceDerivedArtifactKind" NOT NULL,
    "localPath" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sourceChecksumSha256" TEXT NOT NULL,
    "extractionCommand" TEXT NOT NULL,
    "toolVersion" TEXT NOT NULL,
    "analysisOnly" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_derived_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reference_sources_workspaceId_idx" ON "reference_sources"("workspaceId");

-- CreateIndex
CREATE INDEX "reference_advertisements_workspaceId_idx" ON "reference_advertisements"("workspaceId");

-- CreateIndex
CREATE INDEX "reference_advertisements_workspaceId_processingState_idx" ON "reference_advertisements"("workspaceId", "processingState");

-- CreateIndex
CREATE UNIQUE INDEX "reference_advertisements_workspaceId_referenceKey_key" ON "reference_advertisements"("workspaceId", "referenceKey");

-- CreateIndex
CREATE UNIQUE INDEX "reference_media_referenceAdvertisementId_key" ON "reference_media"("referenceAdvertisementId");

-- CreateIndex
CREATE INDEX "reference_media_workspaceId_idx" ON "reference_media"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "reference_media_workspaceId_checksumSha256_key" ON "reference_media"("workspaceId", "checksumSha256");

-- CreateIndex
CREATE INDEX "reference_scenes_workspaceId_idx" ON "reference_scenes"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "reference_scenes_referenceAdvertisementId_sceneIndex_key" ON "reference_scenes"("referenceAdvertisementId", "sceneIndex");

-- CreateIndex
CREATE INDEX "reference_frames_workspaceId_idx" ON "reference_frames"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "reference_frames_referenceAdvertisementId_referenceSceneId__key" ON "reference_frames"("referenceAdvertisementId", "referenceSceneId", "kind");

-- CreateIndex
CREATE INDEX "reference_transcripts_workspaceId_idx" ON "reference_transcripts"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "reference_transcripts_referenceAdvertisementId_provider_mod_key" ON "reference_transcripts"("referenceAdvertisementId", "provider", "model");

-- CreateIndex
CREATE UNIQUE INDEX "reference_craft_metrics_referenceAdvertisementId_key" ON "reference_craft_metrics"("referenceAdvertisementId");

-- CreateIndex
CREATE INDEX "reference_craft_metrics_workspaceId_idx" ON "reference_craft_metrics"("workspaceId");

-- CreateIndex
CREATE INDEX "reference_annotations_workspaceId_idx" ON "reference_annotations"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "reference_annotations_referenceAdvertisementId_version_key" ON "reference_annotations"("referenceAdvertisementId", "version");

-- CreateIndex
CREATE INDEX "reference_ingestion_runs_workspaceId_idx" ON "reference_ingestion_runs"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "reference_ingestion_runs_workspaceId_idempotencyKey_key" ON "reference_ingestion_runs"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "reference_derived_artifacts_workspaceId_idx" ON "reference_derived_artifacts"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "reference_derived_artifacts_referenceAdvertisementId_kind_l_key" ON "reference_derived_artifacts"("referenceAdvertisementId", "kind", "localPath");

-- AddForeignKey
ALTER TABLE "reference_sources" ADD CONSTRAINT "reference_sources_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_advertisements" ADD CONSTRAINT "reference_advertisements_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_advertisements" ADD CONSTRAINT "reference_advertisements_referenceSourceId_fkey" FOREIGN KEY ("referenceSourceId") REFERENCES "reference_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_media" ADD CONSTRAINT "reference_media_referenceAdvertisementId_fkey" FOREIGN KEY ("referenceAdvertisementId") REFERENCES "reference_advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_scenes" ADD CONSTRAINT "reference_scenes_referenceAdvertisementId_fkey" FOREIGN KEY ("referenceAdvertisementId") REFERENCES "reference_advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_frames" ADD CONSTRAINT "reference_frames_referenceAdvertisementId_fkey" FOREIGN KEY ("referenceAdvertisementId") REFERENCES "reference_advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_frames" ADD CONSTRAINT "reference_frames_referenceSceneId_fkey" FOREIGN KEY ("referenceSceneId") REFERENCES "reference_scenes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_transcripts" ADD CONSTRAINT "reference_transcripts_referenceAdvertisementId_fkey" FOREIGN KEY ("referenceAdvertisementId") REFERENCES "reference_advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_craft_metrics" ADD CONSTRAINT "reference_craft_metrics_referenceAdvertisementId_fkey" FOREIGN KEY ("referenceAdvertisementId") REFERENCES "reference_advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_annotations" ADD CONSTRAINT "reference_annotations_referenceAdvertisementId_fkey" FOREIGN KEY ("referenceAdvertisementId") REFERENCES "reference_advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_derived_artifacts" ADD CONSTRAINT "reference_derived_artifacts_referenceAdvertisementId_fkey" FOREIGN KEY ("referenceAdvertisementId") REFERENCES "reference_advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_derived_artifacts" ADD CONSTRAINT "reference_derived_artifacts_referenceSceneId_fkey" FOREIGN KEY ("referenceSceneId") REFERENCES "reference_scenes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_derived_artifacts" ADD CONSTRAINT "reference_derived_artifacts_ingestionRunId_fkey" FOREIGN KEY ("ingestionRunId") REFERENCES "reference_ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
