-- CreateEnum
CREATE TYPE "CreativeMemoryAgentRole" AS ENUM ('CAMPAIGN_STRATEGIST', 'CREATIVE_DIRECTOR', 'SCRIPT_TIMING_DIRECTOR', 'SHOT_PROMPT_ENGINEER');

-- CreateEnum
CREATE TYPE "BenchmarkProfileReviewStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "benchmark_governance_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "agentRole" "CreativeMemoryAgentRole" NOT NULL,
    "applicablePlatforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "applicableCampaignIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT false,
    "reviewStatus" "BenchmarkProfileReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "requiredReferenceRoles" "ReferenceBusinessRole"[],
    "allowedCollections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxTopK" INTEGER NOT NULL,
    "maxContextCharacters" INTEGER NOT NULL,
    "maxItemsPerReference" INTEGER NOT NULL,
    "minDistinctReferences" INTEGER NOT NULL,
    "requireOriginalTransformation" BOOLEAN NOT NULL DEFAULT true,
    "prohibitedSimilarityRules" TEXT[],
    "activationValidForDays" INTEGER,
    "annotationValidForDays" INTEGER,
    "reviewerId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "activatedBy" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "supersedesProfileId" TEXT,
    "governingChecksumSha256" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benchmark_governance_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "benchmark_governance_profiles_workspaceId_idx" ON "benchmark_governance_profiles"("workspaceId");

-- CreateIndex
CREATE INDEX "benchmark_governance_profiles_workspaceId_agentRole_active_idx" ON "benchmark_governance_profiles"("workspaceId", "agentRole", "active");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_governance_profiles_workspaceId_name_agentRole_ve_key" ON "benchmark_governance_profiles"("workspaceId", "name", "agentRole", "version");

-- AddForeignKey
ALTER TABLE "benchmark_governance_profiles" ADD CONSTRAINT "benchmark_governance_profiles_supersedesProfileId_fkey" FOREIGN KEY ("supersedesProfileId") REFERENCES "benchmark_governance_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

