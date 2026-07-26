-- CreateEnum
CREATE TYPE "CreativeMemoryProfile" AS ENUM ('STRUCTURAL_BASELINE_V1', 'QWEN3_VL_2B_QUALITY_V1', 'QWEN3_VL_8B_REMOTE_QUALITY_V1');

-- CreateEnum
CREATE TYPE "CreativeMemoryIndexState" AS ENUM ('PENDING', 'INDEXING', 'INDEXED', 'STALE', 'DELETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CreativeMemoryIndexFailureType" AS ENUM ('EMBEDDING_FAILED', 'DIMENSION_MISMATCH', 'INVALID_VECTOR', 'QDRANT_UNAVAILABLE', 'UPSERT_FAILED', 'INELIGIBLE');

-- CreateTable
CREATE TABLE "creative_memory_index_runs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "profile" "CreativeMemoryProfile" NOT NULL,
    "qdrantCollection" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "indexedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "creative_memory_index_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_memory_index_entries" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "referenceSceneId" TEXT NOT NULL,
    "referenceAdvertisementId" TEXT NOT NULL,
    "profile" "CreativeMemoryProfile" NOT NULL,
    "modelRevision" TEXT NOT NULL,
    "vectorDimension" INTEGER NOT NULL,
    "embeddingInputHash" TEXT NOT NULL,
    "vectorChecksum" TEXT NOT NULL,
    "qdrantCollection" TEXT NOT NULL,
    "qdrantPointId" TEXT NOT NULL,
    "state" "CreativeMemoryIndexState" NOT NULL DEFAULT 'PENDING',
    "indexedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "failureType" "CreativeMemoryIndexFailureType",
    "failureDetail" TEXT,
    "indexRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creative_memory_index_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creative_memory_index_runs_workspaceId_idx" ON "creative_memory_index_runs"("workspaceId");

-- CreateIndex
CREATE INDEX "creative_memory_index_entries_workspaceId_idx" ON "creative_memory_index_entries"("workspaceId");

-- CreateIndex
CREATE INDEX "creative_memory_index_entries_workspaceId_state_idx" ON "creative_memory_index_entries"("workspaceId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "creative_memory_index_entries_referenceSceneId_profile_key" ON "creative_memory_index_entries"("referenceSceneId", "profile");

-- AddForeignKey
ALTER TABLE "creative_memory_index_entries" ADD CONSTRAINT "creative_memory_index_entries_referenceSceneId_fkey" FOREIGN KEY ("referenceSceneId") REFERENCES "reference_scenes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_memory_index_entries" ADD CONSTRAINT "creative_memory_index_entries_referenceAdvertisementId_fkey" FOREIGN KEY ("referenceAdvertisementId") REFERENCES "reference_advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_memory_index_entries" ADD CONSTRAINT "creative_memory_index_entries_indexRunId_fkey" FOREIGN KEY ("indexRunId") REFERENCES "creative_memory_index_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
