-- CreateEnum
CREATE TYPE "RoleName" AS ENUM ('OWNER_ADMIN', 'CREATIVE_DIRECTOR', 'PRODUCTION_OPERATOR', 'REVIEWER', 'ANALYST');

-- CreateEnum
CREATE TYPE "CampaignStage" AS ENUM ('DRAFT', 'STRATEGY_REVIEW', 'CONCEPT_REVIEW', 'SCRIPT_REVIEW', 'ASSET_COLLECTION', 'PROMPTING', 'SHOT_GENERATION', 'VISUAL_QA', 'CONTINUITY_QA', 'HUMAN_SHOT_SELECTION', 'COMPOSITING', 'ROUGH_CUT', 'SOUND_DESIGN', 'FINAL_QA', 'FINAL_APPROVAL', 'VARIANT_GENERATION', 'VARIANT_QA', 'EXPORTING', 'READY_FOR_DISTRIBUTION', 'DISTRIBUTED');

-- CreateEnum
CREATE TYPE "DeliveryPlatform" AS ENUM ('TIKTOK', 'INSTAGRAM_REELS', 'YOUTUBE_SHORTS', 'GENERIC');

-- CreateEnum
CREATE TYPE "BudgetLevel" AS ENUM ('WORKSPACE', 'CAMPAIGN', 'SHOT', 'PROVIDER');

-- CreateEnum
CREATE TYPE "BudgetLedgerEntryType" AS ENUM ('RESERVATION', 'CHARGE', 'RELEASE');

-- CreateEnum
CREATE TYPE "ApprovalGate" AS ENUM ('CONCEPT', 'SHOT_SELECTION', 'FINAL');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('UPLOADED_SOURCE', 'VIDEO_CANDIDATE', 'THUMBNAIL', 'PROXY', 'MOTION_GRAPHICS_RENDER', 'ROUGH_CUT', 'SOUND_STEM', 'FINAL_MASTER', 'VARIANT', 'DESIGN_EXPORT');

-- CreateEnum
CREATE TYPE "GenerationCandidateStatus" AS ENUM ('PENDING', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShotGenerationJobStatus" AS ENUM ('PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'BUDGET_EXCEEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShotGenerationAttemptStatus" AS ENUM ('QUEUED', 'SUBMITTED', 'POLLING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShotGenerationFailureReason" AS ENUM ('UNSUPPORTED_CAPABILITY', 'PROVIDER_TIMEOUT', 'PROVIDER_REJECTED', 'PROVIDER_ERROR', 'BUDGET_EXCEEDED');

-- CreateEnum
CREATE TYPE "MotionIntensity" AS ENUM ('STATIC', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "TextSafeArea" AS ENUM ('TOP', 'BOTTOM', 'LEFT', 'RIGHT', 'CENTER', 'FULL_SAFE');

-- CreateEnum
CREATE TYPE "QualityFailureCategory" AS ENUM ('PROMPT', 'GENERATION', 'CONTINUITY', 'TECHNICAL', 'SHOT_UNUSABLE', 'COMPOSITING_TECHNICAL', 'EDIT_TIMING', 'AUDIO_TECHNICAL');

-- CreateEnum
CREATE TYPE "QualityFailureSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'BLOCKING');

-- CreateEnum
CREATE TYPE "AssessedBy" AS ENUM ('AGENT', 'HUMAN');

-- CreateEnum
CREATE TYPE "RenderJobKind" AS ENUM ('COMPOSITING', 'EXPORT');

-- CreateEnum
CREATE TYPE "RenderJobStatus" AS ENUM ('QUEUED', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SoundCueType" AS ENUM ('MUSIC', 'SFX', 'VOICEOVER');

-- CreateEnum
CREATE TYPE "TransitionType" AS ENUM ('CUT', 'DISSOLVE', 'WIPE', 'FADE_IN', 'FADE_OUT');

-- CreateEnum
CREATE TYPE "ShotStatus" AS ENUM ('PENDING', 'GENERATING', 'QC_REVIEW', 'NEEDS_HUMAN', 'BUDGET_EXCEEDED', 'SELECTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LicenseType" AS ENUM ('FULL_BUY_OUT', 'LIMITED_USAGE', 'ROYALTY_FREE', 'EXCLUSIVE');

-- CreateEnum
CREATE TYPE "CreativeVariantStatus" AS ENUM ('PENDING', 'RENDERING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "VariantGenerationJobStatus" AS ENUM ('PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'BUDGET_EXCEEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VariantGenerationAttemptStatus" AS ENUM ('QUEUED', 'SUBMITTED', 'POLLING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VariantGenerationFailureReason" AS ENUM ('UNSUPPORTED_CAPABILITY', 'PROVIDER_TIMEOUT', 'PROVIDER_REJECTED', 'PROVIDER_ERROR', 'BUDGET_EXCEEDED', 'INVALID_CUT', 'STALE_MASTER');

-- CreateEnum
CREATE TYPE "PerformanceSource" AS ENUM ('FIXTURE', 'MANUAL_ENTRY');

-- CreateEnum
CREATE TYPE "LearningScope" AS ENUM ('STRATEGY', 'CONCEPT', 'PROMPTING');

-- CreateEnum
CREATE TYPE "LearningConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "LearningStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TransitionAuditResult" AS ENUM ('APPLIED', 'REJECTED_INVALID_TRANSITION', 'REJECTED_MISSING_PREREQUISITE', 'REJECTED_BUDGET_EXCEEDED', 'REJECTED_CONCURRENT_MODIFICATION', 'DUPLICATE_IGNORED');

-- CreateEnum
CREATE TYPE "EditTrackType" AS ENUM ('VIDEO', 'AUDIO');

-- CreateEnum
CREATE TYPE "ShotBeat" AS ENUM ('HOOK', 'PROMISE', 'FEATURE', 'CTA');

-- CreateEnum
CREATE TYPE "ShotSelectionSetStatus" AS ENUM ('DRAFT', 'APPROVED');

-- CreateEnum
CREATE TYPE "ShotSelectionEntryStatus" AS ENUM ('PENDING', 'SELECTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AssetIngestionStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "CompositionJobStatus" AS ENUM ('PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'BUDGET_EXCEEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CompositionAttemptStatus" AS ENUM ('QUEUED', 'SUBMITTED', 'POLLING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CompositionFailureReason" AS ENUM ('UNSUPPORTED_CAPABILITY', 'PROVIDER_TIMEOUT', 'PROVIDER_REJECTED', 'PROVIDER_ERROR', 'BUDGET_EXCEEDED');

-- CreateEnum
CREATE TYPE "AgentInvocationStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RoleName" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "currentStage" "CampaignStage" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_briefs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "campaignName" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productDescription" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "targetAudience" TEXT NOT NULL,
    "customerProblem" TEXT NOT NULL,
    "valueProposition" TEXT NOT NULL,
    "productFeatures" TEXT[],
    "targetPlatforms" "DeliveryPlatform"[],
    "aspectRatios" TEXT[],
    "durationsSeconds" INTEGER[],
    "brandVoice" TEXT NOT NULL,
    "visualDirection" TEXT NOT NULL,
    "requiredMessaging" TEXT[],
    "callToAction" TEXT NOT NULL,
    "references" TEXT[],
    "assetReferences" TEXT[],
    "prohibitedClaims" TEXT[],
    "budgetCents" INTEGER NOT NULL,
    "deadline" TIMESTAMP(3),
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "notes" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategies" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "positioning" TEXT NOT NULL,
    "targetAudienceSummary" TEXT NOT NULL,
    "keyMessages" TEXT[],
    "toneGuidelines" TEXT[],
    "audienceProfile" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audience_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignBriefId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "demographics" JSONB NOT NULL DEFAULT '{}',
    "psychographics" JSONB NOT NULL DEFAULT '{}',
    "painPoints" TEXT[],
    "platformBehavior" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audience_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_concepts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "logline" TEXT NOT NULL,
    "visualDirection" TEXT NOT NULL,
    "narrativeArc" TEXT NOT NULL,
    "referenceNotes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creative_concepts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visual_languages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "creativeConceptId" TEXT NOT NULL,
    "colorPalette" TEXT[],
    "typography" JSONB NOT NULL DEFAULT '{}',
    "motionPrinciples" TEXT[],
    "brandAssetRefs" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visual_languages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scripts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creativeConceptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "totalDurationFrames" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shots" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "durationFrames" INTEGER NOT NULL,
    "beat" "ShotBeat" NOT NULL,
    "status" "ShotStatus" NOT NULL DEFAULT 'PENDING',
    "dependsOnShotIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transition_specifications" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "TransitionType" NOT NULL,
    "durationFrames" INTEGER NOT NULL,
    "easing" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transition_specifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timelines" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "frameRate" INTEGER NOT NULL DEFAULT 30,
    "durationFrames" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timeline_entries" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "timelineId" TEXT NOT NULL,
    "shotId" TEXT NOT NULL,
    "transitionSpecificationId" TEXT,
    "order" INTEGER NOT NULL,
    "startFrame" INTEGER NOT NULL,
    "durationFrames" INTEGER NOT NULL,

    CONSTRAINT "timeline_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shot_specifications" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creativeConceptId" TEXT NOT NULL,
    "creativeConceptVersion" INTEGER NOT NULL,
    "scriptId" TEXT NOT NULL,
    "scriptVersion" INTEGER NOT NULL,
    "shotId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "shotNumber" INTEGER NOT NULL,
    "sequencePosition" INTEGER NOT NULL,
    "intendedDurationSeconds" DOUBLE PRECISION NOT NULL,
    "visualObjective" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "cameraMovement" TEXT NOT NULL,
    "lensFraming" TEXT NOT NULL,
    "lighting" TEXT NOT NULL,
    "colorTreatment" TEXT NOT NULL,
    "motionIntensity" "MotionIntensity" NOT NULL,
    "transitionIn" "TransitionType" NOT NULL,
    "transitionOut" "TransitionType" NOT NULL,
    "textSafeAreas" "TextSafeArea"[],
    "appInterfaceRequirements" TEXT,
    "referenceAssetIds" TEXT[],
    "continuityRequirements" TEXT[],
    "providerId" TEXT NOT NULL,
    "promptVersionId" TEXT NOT NULL,
    "generationPrompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "generationParams" JSONB NOT NULL DEFAULT '{}',
    "outputRequirements" JSONB NOT NULL DEFAULT '{}',
    "qualityRubric" TEXT[],
    "licensingConstraints" TEXT[],
    "createdByAgentInvocationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shot_specifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shot_generation_jobs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "shotSpecificationId" TEXT NOT NULL,
    "status" "ShotGenerationJobStatus" NOT NULL DEFAULT 'PENDING',
    "requestedCandidateCount" INTEGER NOT NULL,
    "maxAttempts" INTEGER NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shot_generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shot_generation_attempts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shotGenerationJobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerJobId" TEXT,
    "status" "ShotGenerationAttemptStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedCandidateCount" INTEGER NOT NULL,
    "seed" INTEGER,
    "generationParams" JSONB NOT NULL DEFAULT '{}',
    "budgetReservationId" TEXT,
    "estimatedCostCents" INTEGER,
    "actualCostCents" INTEGER,
    "failureReason" "ShotGenerationFailureReason",
    "failureRetryable" BOOLEAN,
    "failureMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shot_generation_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_candidates" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shotSpecificationId" TEXT NOT NULL,
    "shotGenerationAttemptId" TEXT NOT NULL,
    "candidateIndex" INTEGER NOT NULL,
    "assetId" TEXT,
    "providerCandidateRef" TEXT,
    "seed" INTEGER,
    "durationSeconds" DOUBLE PRECISION,
    "aspectRatio" TEXT,
    "status" "GenerationCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_assessments" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "generationCandidateId" TEXT,
    "assetId" TEXT,
    "subjectStage" "CampaignStage",
    "pass" BOOLEAN NOT NULL,
    "scores" JSONB NOT NULL DEFAULT '{}',
    "overallScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "assessedBy" "AssessedBy" NOT NULL,
    "createdByAgentInvocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_failures" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "qualityAssessmentId" TEXT NOT NULL,
    "category" "QualityFailureCategory" NOT NULL,
    "severity" "QualityFailureSeverity" NOT NULL,
    "description" TEXT NOT NULL,
    "suggestedAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shot_selection_sets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "scriptVersion" INTEGER NOT NULL,
    "creativeConceptId" TEXT NOT NULL,
    "creativeConceptVersion" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ShotSelectionSetStatus" NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" TEXT NOT NULL,
    "reviewerUserId" TEXT,
    "rationale" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shot_selection_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shot_selections" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shotSelectionSetId" TEXT NOT NULL,
    "shotId" TEXT NOT NULL,
    "sequencePosition" INTEGER NOT NULL,
    "shotSpecificationId" TEXT NOT NULL,
    "shotSpecificationVersion" INTEGER NOT NULL,
    "status" "ShotSelectionEntryStatus" NOT NULL DEFAULT 'PENDING',
    "selectedCandidateId" TEXT,
    "visualQaAssessmentId" TEXT,
    "continuityQaAssessmentId" TEXT,
    "rationale" TEXT,
    "regenerationFeedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shot_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shot_selection_replacements" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shotSelectionSetId" TEXT NOT NULL,
    "shotId" TEXT NOT NULL,
    "previousCandidateId" TEXT,
    "newCandidateId" TEXT,
    "replacedByUserId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shot_selection_replacements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_approvals" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "gate" "ApprovalGate" NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "stageAtDecision" "CampaignStage" NOT NULL,
    "decidedByUserId" TEXT NOT NULL,
    "comments" TEXT,
    "repairTarget" "CampaignStage",
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "human_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "s3Key" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "ingestionStatus" "AssetIngestionStatus" NOT NULL DEFAULT 'PENDING',
    "mediaMetadata" JSONB,
    "inspectionFailureDetails" TEXT,
    "createdByAgentInvocationId" TEXT,
    "uploadedByUserId" TEXT,
    "generatedByActivity" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_provenance_records" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "derivedFromAssetIds" TEXT[],
    "producedByInvocationId" TEXT,
    "providerJobRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_provenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_records" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "licenseType" "LicenseType" NOT NULL,
    "rightsHolder" TEXT NOT NULL,
    "restrictions" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "license_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "render_jobs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "RenderJobKind" NOT NULL,
    "status" "RenderJobStatus" NOT NULL DEFAULT 'QUEUED',
    "inputAssetIds" TEXT[],
    "outputAssetId" TEXT,
    "providerJobRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "render_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rough_edit_specifications" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creativeConceptId" TEXT NOT NULL,
    "creativeConceptVersion" INTEGER NOT NULL,
    "scriptId" TEXT NOT NULL,
    "scriptVersion" INTEGER NOT NULL,
    "shotSelectionSetId" TEXT NOT NULL,
    "shotSelectionSetVersion" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "outputFormat" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolutionWidth" INTEGER NOT NULL,
    "resolutionHeight" INTEGER NOT NULL,
    "frameRate" INTEGER NOT NULL,
    "targetDurationFrames" INTEGER NOT NULL,
    "tracks" JSONB NOT NULL,
    "overlays" JSONB NOT NULL DEFAULT '[]',
    "pacingNotes" TEXT NOT NULL,
    "beatStructure" JSONB NOT NULL DEFAULT '[]',
    "continuityNotes" TEXT[],
    "textSafeAreas" "TextSafeArea"[],
    "brandTokens" TEXT[],
    "captionPlaceholder" TEXT NOT NULL,
    "musicPlaceholder" TEXT NOT NULL,
    "sfxPlaceholder" TEXT NOT NULL,
    "platform" "DeliveryPlatform" NOT NULL,
    "platformDeliveryNotes" TEXT NOT NULL,
    "editRationale" TEXT NOT NULL,
    "qualityRubric" TEXT[],
    "promptVersionId" TEXT NOT NULL,
    "createdByAgentInvocationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rough_edit_specifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "composition_jobs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "roughEditSpecificationId" TEXT NOT NULL,
    "status" "CompositionJobStatus" NOT NULL DEFAULT 'PENDING',
    "maxAttempts" INTEGER NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "composition_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "composition_attempts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "compositionJobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerProjectId" TEXT,
    "providerJobId" TEXT,
    "status" "CompositionAttemptStatus" NOT NULL DEFAULT 'QUEUED',
    "budgetReservationId" TEXT,
    "estimatedCostCents" INTEGER,
    "actualCostCents" INTEGER,
    "outputAssetId" TEXT,
    "failureReason" "CompositionFailureReason",
    "failureRetryable" BOOLEAN,
    "failureMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "composition_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sound_cues" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "timelineId" TEXT NOT NULL,
    "type" "SoundCueType" NOT NULL,
    "startFrame" INTEGER NOT NULL,
    "durationFrames" INTEGER NOT NULL,
    "assetId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sound_cues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sound_design_plans" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "timelineId" TEXT NOT NULL,
    "roughEditSpecificationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "musicBrief" TEXT NOT NULL,
    "mixNotes" TEXT NOT NULL,
    "brandAudioGuidelines" TEXT[],
    "qualityRubric" TEXT[],
    "promptVersionId" TEXT NOT NULL,
    "createdByAgentInvocationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sound_design_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edit_decision_lists" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edit_decision_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edit_decision_entries" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "editDecisionListId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "sourceInFrame" INTEGER NOT NULL,
    "sourceOutFrame" INTEGER NOT NULL,
    "timelinePosition" INTEGER NOT NULL,
    "trackType" "EditTrackType" NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "edit_decision_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_specifications" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "platform" "DeliveryPlatform" NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "safeArea" JSONB,
    "captionBurnRequired" BOOLEAN NOT NULL DEFAULT false,
    "format" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_specifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_variants" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "deliverySpecificationId" TEXT NOT NULL,
    "variantSpecificationId" TEXT,
    "durationSeconds" INTEGER NOT NULL,
    "assetId" TEXT,
    "status" "CreativeVariantStatus" NOT NULL DEFAULT 'PENDING',
    "qualityAssessmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creative_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "platforms" "DeliveryPlatform"[],
    "aspectRatio" TEXT NOT NULL,
    "resolutionWidth" INTEGER NOT NULL,
    "resolutionHeight" INTEGER NOT NULL,
    "frameRate" INTEGER NOT NULL,
    "durationsSeconds" INTEGER[],
    "captionBurnRequired" BOOLEAN NOT NULL,
    "safeAreas" "TextSafeArea"[],
    "ctaTailSeconds" INTEGER,
    "ctaMinimumDurationSeconds" INTEGER,
    "durationToleranceFrames" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_specifications" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "parentMasterAssetId" TEXT NOT NULL,
    "parentFinalQaAssessmentId" TEXT NOT NULL,
    "timelineId" TEXT NOT NULL,
    "timelineVersion" INTEGER NOT NULL,
    "creativeConceptId" TEXT NOT NULL,
    "creativeConceptVersion" INTEGER NOT NULL,
    "scriptId" TEXT NOT NULL,
    "scriptVersion" INTEGER NOT NULL,
    "shotSelectionSetId" TEXT NOT NULL,
    "shotSelectionSetVersion" INTEGER NOT NULL,
    "roughEditSpecificationId" TEXT NOT NULL,
    "roughEditSpecificationVersion" INTEGER NOT NULL,
    "soundDesignPlanId" TEXT NOT NULL,
    "soundDesignPlanVersion" INTEGER NOT NULL,
    "deliveryProfileId" TEXT NOT NULL,
    "deliveryProfileKey" TEXT NOT NULL,
    "deliveryProfileVersion" INTEGER NOT NULL,
    "deliverySpecificationId" TEXT NOT NULL,
    "platform" "DeliveryPlatform" NOT NULL,
    "targetDurationSeconds" INTEGER NOT NULL,
    "targetDurationFrames" INTEGER NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolutionWidth" INTEGER NOT NULL,
    "resolutionHeight" INTEGER NOT NULL,
    "frameRate" INTEGER NOT NULL,
    "cutPoints" JSONB NOT NULL,
    "retainedClips" JSONB NOT NULL,
    "retainedCues" JSONB NOT NULL DEFAULT '[]',
    "retainedCaptions" JSONB NOT NULL DEFAULT '[]',
    "ctaPlacement" JSONB NOT NULL,
    "captionBurnRequired" BOOLEAN NOT NULL,
    "safeAreas" "TextSafeArea"[],
    "cutRationale" TEXT NOT NULL,
    "removedRationale" TEXT[],
    "qualityRubric" TEXT[],
    "promptVersionId" TEXT NOT NULL,
    "createdByAgentInvocationId" TEXT NOT NULL,
    "approvedForExportAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_specifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_generation_jobs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "variantSpecificationId" TEXT NOT NULL,
    "status" "VariantGenerationJobStatus" NOT NULL DEFAULT 'PENDING',
    "maxAttempts" INTEGER NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_generation_attempts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "variantGenerationJobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerProjectId" TEXT,
    "providerJobId" TEXT,
    "status" "VariantGenerationAttemptStatus" NOT NULL DEFAULT 'QUEUED',
    "budgetReservationId" TEXT,
    "estimatedCostCents" INTEGER,
    "actualCostCents" INTEGER,
    "outputAssetId" TEXT,
    "failureReason" "VariantGenerationFailureReason",
    "failureRetryable" BOOLEAN,
    "failureMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_generation_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_metrics" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "creativeVariantId" TEXT NOT NULL,
    "platform" "DeliveryPlatform" NOT NULL,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "conversions" INTEGER NOT NULL,
    "spendCents" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_observations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "platform" "DeliveryPlatform" NOT NULL,
    "externalPostId" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "creativeVariantId" TEXT,
    "variantAssetId" TEXT,
    "durationSeconds" INTEGER,
    "source" "PerformanceSource" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL,
    "normalized" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "ingestedByUserId" TEXT,
    "fixtureRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_records" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "learningKey" TEXT NOT NULL,
    "insight" TEXT NOT NULL,
    "scope" "LearningScope" NOT NULL,
    "applicability" JSONB NOT NULL,
    "confidence" "LearningConfidence" NOT NULL,
    "evidence" JSONB NOT NULL,
    "totalImpressions" INTEGER NOT NULL,
    "status" "LearningStatus" NOT NULL DEFAULT 'PROPOSED',
    "sourceCampaignId" TEXT NOT NULL,
    "createdByAgentInvocationId" TEXT NOT NULL,
    "promptVersionId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "promptTemplateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_policies" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "level" "BudgetLevel" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "limitCents" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_ledger_entries" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "budgetPolicyId" TEXT NOT NULL,
    "entryType" "BudgetLedgerEntryType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "campaignId" TEXT,
    "shotId" TEXT,
    "generationJobRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_transition_audits" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "fromStage" "CampaignStage" NOT NULL,
    "toStage" "CampaignStage" NOT NULL,
    "result" "TransitionAuditResult" NOT NULL,
    "reason" TEXT,
    "approvalId" TEXT,
    "requestedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_transition_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_invocations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "stage" "CampaignStage" NOT NULL,
    "agentName" TEXT NOT NULL,
    "agentVersion" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "status" "AgentInvocationStatus" NOT NULL,
    "result" JSONB,
    "failureReason" TEXT,
    "failureRetryable" BOOLEAN,
    "failureMessage" TEXT,
    "failureDetails" JSONB,
    "model" TEXT,
    "promptVersion" INTEGER,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costCents" INTEGER,
    "inputHash" TEXT NOT NULL,
    "outputHash" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_workspaceId_idx" ON "memberships"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_workspaceId_userId_key" ON "memberships"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "campaigns_workspaceId_idx" ON "campaigns"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_workspaceId_idempotencyKey_key" ON "campaigns"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "campaign_briefs_workspaceId_idx" ON "campaign_briefs"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_briefs_campaignId_version_key" ON "campaign_briefs"("campaignId", "version");

-- CreateIndex
CREATE INDEX "strategies_workspaceId_idx" ON "strategies"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "strategies_campaignId_version_key" ON "strategies"("campaignId", "version");

-- CreateIndex
CREATE INDEX "audience_profiles_workspaceId_idx" ON "audience_profiles"("workspaceId");

-- CreateIndex
CREATE INDEX "audience_profiles_campaignBriefId_idx" ON "audience_profiles"("campaignBriefId");

-- CreateIndex
CREATE INDEX "creative_concepts_workspaceId_idx" ON "creative_concepts"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "creative_concepts_campaignId_version_key" ON "creative_concepts"("campaignId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "visual_languages_creativeConceptId_key" ON "visual_languages"("creativeConceptId");

-- CreateIndex
CREATE INDEX "visual_languages_workspaceId_idx" ON "visual_languages"("workspaceId");

-- CreateIndex
CREATE INDEX "scripts_workspaceId_idx" ON "scripts"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "scripts_campaignId_version_key" ON "scripts"("campaignId", "version");

-- CreateIndex
CREATE INDEX "shots_workspaceId_idx" ON "shots"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "shots_scriptId_index_key" ON "shots"("scriptId", "index");

-- CreateIndex
CREATE INDEX "transition_specifications_workspaceId_idx" ON "transition_specifications"("workspaceId");

-- CreateIndex
CREATE INDEX "timelines_workspaceId_idx" ON "timelines"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "timelines_campaignId_version_key" ON "timelines"("campaignId", "version");

-- CreateIndex
CREATE INDEX "timeline_entries_workspaceId_idx" ON "timeline_entries"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "timeline_entries_timelineId_order_key" ON "timeline_entries"("timelineId", "order");

-- CreateIndex
CREATE INDEX "shot_specifications_workspaceId_idx" ON "shot_specifications"("workspaceId");

-- CreateIndex
CREATE INDEX "shot_specifications_shotId_idx" ON "shot_specifications"("shotId");

-- CreateIndex
CREATE INDEX "shot_specifications_campaignId_idx" ON "shot_specifications"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "shot_specifications_shotId_version_key" ON "shot_specifications"("shotId", "version");

-- CreateIndex
CREATE INDEX "shot_generation_jobs_workspaceId_idx" ON "shot_generation_jobs"("workspaceId");

-- CreateIndex
CREATE INDEX "shot_generation_jobs_campaignId_idx" ON "shot_generation_jobs"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "shot_generation_jobs_shotSpecificationId_key" ON "shot_generation_jobs"("shotSpecificationId");

-- CreateIndex
CREATE INDEX "shot_generation_attempts_workspaceId_idx" ON "shot_generation_attempts"("workspaceId");

-- CreateIndex
CREATE INDEX "shot_generation_attempts_shotGenerationJobId_idx" ON "shot_generation_attempts"("shotGenerationJobId");

-- CreateIndex
CREATE UNIQUE INDEX "shot_generation_attempts_shotGenerationJobId_idempotencyKey_key" ON "shot_generation_attempts"("shotGenerationJobId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "generation_candidates_workspaceId_idx" ON "generation_candidates"("workspaceId");

-- CreateIndex
CREATE INDEX "generation_candidates_shotSpecificationId_idx" ON "generation_candidates"("shotSpecificationId");

-- CreateIndex
CREATE INDEX "generation_candidates_shotGenerationAttemptId_idx" ON "generation_candidates"("shotGenerationAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_candidates_shotGenerationAttemptId_candidateInde_key" ON "generation_candidates"("shotGenerationAttemptId", "candidateIndex");

-- CreateIndex
CREATE INDEX "quality_assessments_workspaceId_idx" ON "quality_assessments"("workspaceId");

-- CreateIndex
CREATE INDEX "quality_assessments_campaignId_idx" ON "quality_assessments"("campaignId");

-- CreateIndex
CREATE INDEX "quality_assessments_generationCandidateId_idx" ON "quality_assessments"("generationCandidateId");

-- CreateIndex
CREATE INDEX "quality_assessments_assetId_idx" ON "quality_assessments"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "quality_assessments_generationCandidateId_subjectStage_key" ON "quality_assessments"("generationCandidateId", "subjectStage");

-- CreateIndex
CREATE INDEX "quality_failures_workspaceId_idx" ON "quality_failures"("workspaceId");

-- CreateIndex
CREATE INDEX "quality_failures_qualityAssessmentId_idx" ON "quality_failures"("qualityAssessmentId");

-- CreateIndex
CREATE INDEX "shot_selection_sets_workspaceId_idx" ON "shot_selection_sets"("workspaceId");

-- CreateIndex
CREATE INDEX "shot_selection_sets_campaignId_idx" ON "shot_selection_sets"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "shot_selection_sets_campaignId_version_key" ON "shot_selection_sets"("campaignId", "version");

-- CreateIndex
CREATE INDEX "shot_selections_workspaceId_idx" ON "shot_selections"("workspaceId");

-- CreateIndex
CREATE INDEX "shot_selections_shotSelectionSetId_idx" ON "shot_selections"("shotSelectionSetId");

-- CreateIndex
CREATE UNIQUE INDEX "shot_selections_shotSelectionSetId_shotId_key" ON "shot_selections"("shotSelectionSetId", "shotId");

-- CreateIndex
CREATE INDEX "shot_selection_replacements_workspaceId_idx" ON "shot_selection_replacements"("workspaceId");

-- CreateIndex
CREATE INDEX "shot_selection_replacements_shotSelectionSetId_idx" ON "shot_selection_replacements"("shotSelectionSetId");

-- CreateIndex
CREATE INDEX "human_approvals_workspaceId_idx" ON "human_approvals"("workspaceId");

-- CreateIndex
CREATE INDEX "human_approvals_campaignId_gate_idx" ON "human_approvals"("campaignId", "gate");

-- CreateIndex
CREATE UNIQUE INDEX "assets_s3Key_key" ON "assets"("s3Key");

-- CreateIndex
CREATE INDEX "assets_workspaceId_idx" ON "assets"("workspaceId");

-- CreateIndex
CREATE INDEX "assets_campaignId_idx" ON "assets"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "assets_workspaceId_checksum_kind_key" ON "assets"("workspaceId", "checksum", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "asset_provenance_records_assetId_key" ON "asset_provenance_records"("assetId");

-- CreateIndex
CREATE INDEX "asset_provenance_records_workspaceId_idx" ON "asset_provenance_records"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "license_records_assetId_key" ON "license_records"("assetId");

-- CreateIndex
CREATE INDEX "license_records_workspaceId_idx" ON "license_records"("workspaceId");

-- CreateIndex
CREATE INDEX "render_jobs_workspaceId_idx" ON "render_jobs"("workspaceId");

-- CreateIndex
CREATE INDEX "render_jobs_campaignId_idx" ON "render_jobs"("campaignId");

-- CreateIndex
CREATE INDEX "rough_edit_specifications_workspaceId_idx" ON "rough_edit_specifications"("workspaceId");

-- CreateIndex
CREATE INDEX "rough_edit_specifications_campaignId_idx" ON "rough_edit_specifications"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "rough_edit_specifications_campaignId_version_key" ON "rough_edit_specifications"("campaignId", "version");

-- CreateIndex
CREATE INDEX "composition_jobs_workspaceId_idx" ON "composition_jobs"("workspaceId");

-- CreateIndex
CREATE INDEX "composition_jobs_campaignId_idx" ON "composition_jobs"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "composition_jobs_roughEditSpecificationId_key" ON "composition_jobs"("roughEditSpecificationId");

-- CreateIndex
CREATE INDEX "composition_attempts_workspaceId_idx" ON "composition_attempts"("workspaceId");

-- CreateIndex
CREATE INDEX "composition_attempts_compositionJobId_idx" ON "composition_attempts"("compositionJobId");

-- CreateIndex
CREATE UNIQUE INDEX "composition_attempts_compositionJobId_idempotencyKey_key" ON "composition_attempts"("compositionJobId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "sound_cues_workspaceId_idx" ON "sound_cues"("workspaceId");

-- CreateIndex
CREATE INDEX "sound_cues_timelineId_idx" ON "sound_cues"("timelineId");

-- CreateIndex
CREATE INDEX "sound_design_plans_workspaceId_idx" ON "sound_design_plans"("workspaceId");

-- CreateIndex
CREATE INDEX "sound_design_plans_campaignId_idx" ON "sound_design_plans"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "sound_design_plans_campaignId_version_key" ON "sound_design_plans"("campaignId", "version");

-- CreateIndex
CREATE INDEX "edit_decision_lists_workspaceId_idx" ON "edit_decision_lists"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "edit_decision_lists_campaignId_version_key" ON "edit_decision_lists"("campaignId", "version");

-- CreateIndex
CREATE INDEX "edit_decision_entries_workspaceId_idx" ON "edit_decision_entries"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "edit_decision_entries_editDecisionListId_order_key" ON "edit_decision_entries"("editDecisionListId", "order");

-- CreateIndex
CREATE INDEX "delivery_specifications_workspaceId_idx" ON "delivery_specifications"("workspaceId");

-- CreateIndex
CREATE INDEX "creative_variants_workspaceId_idx" ON "creative_variants"("workspaceId");

-- CreateIndex
CREATE INDEX "creative_variants_variantSpecificationId_idx" ON "creative_variants"("variantSpecificationId");

-- CreateIndex
CREATE INDEX "delivery_profiles_workspaceId_idx" ON "delivery_profiles"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_profiles_workspaceId_key_version_key" ON "delivery_profiles"("workspaceId", "key", "version");

-- CreateIndex
CREATE INDEX "variant_specifications_workspaceId_idx" ON "variant_specifications"("workspaceId");

-- CreateIndex
CREATE INDEX "variant_specifications_campaignId_idx" ON "variant_specifications"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "variant_specifications_campaignId_parentMasterAssetId_targe_key" ON "variant_specifications"("campaignId", "parentMasterAssetId", "targetDurationSeconds", "version");

-- CreateIndex
CREATE INDEX "variant_generation_jobs_workspaceId_idx" ON "variant_generation_jobs"("workspaceId");

-- CreateIndex
CREATE INDEX "variant_generation_jobs_campaignId_idx" ON "variant_generation_jobs"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "variant_generation_jobs_variantSpecificationId_key" ON "variant_generation_jobs"("variantSpecificationId");

-- CreateIndex
CREATE INDEX "variant_generation_attempts_workspaceId_idx" ON "variant_generation_attempts"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "variant_generation_attempts_variantGenerationJobId_idempote_key" ON "variant_generation_attempts"("variantGenerationJobId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "performance_metrics_workspaceId_idx" ON "performance_metrics"("workspaceId");

-- CreateIndex
CREATE INDEX "performance_metrics_creativeVariantId_idx" ON "performance_metrics"("creativeVariantId");

-- CreateIndex
CREATE INDEX "performance_observations_workspaceId_idx" ON "performance_observations"("workspaceId");

-- CreateIndex
CREATE INDEX "performance_observations_campaignId_idx" ON "performance_observations"("campaignId");

-- CreateIndex
CREATE INDEX "performance_observations_creativeVariantId_idx" ON "performance_observations"("creativeVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "performance_observations_workspaceId_idempotencyKey_key" ON "performance_observations"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "learning_records_workspaceId_idx" ON "learning_records"("workspaceId");

-- CreateIndex
CREATE INDEX "learning_records_sourceCampaignId_idx" ON "learning_records"("sourceCampaignId");

-- CreateIndex
CREATE UNIQUE INDEX "learning_records_workspaceId_learningKey_version_key" ON "learning_records"("workspaceId", "learningKey", "version");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_workspaceId_agentKey_name_key" ON "prompt_templates"("workspaceId", "agentKey", "name");

-- CreateIndex
CREATE INDEX "prompt_versions_workspaceId_idx" ON "prompt_versions"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_promptTemplateId_version_key" ON "prompt_versions"("promptTemplateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "budget_policies_workspaceId_level_scopeId_key" ON "budget_policies"("workspaceId", "level", "scopeId");

-- CreateIndex
CREATE INDEX "budget_ledger_entries_workspaceId_idx" ON "budget_ledger_entries"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "budget_ledger_entries_budgetPolicyId_idempotencyKey_key" ON "budget_ledger_entries"("budgetPolicyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "campaign_transition_audits_workspaceId_idx" ON "campaign_transition_audits"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_transition_audits_campaignId_idempotencyKey_key" ON "campaign_transition_audits"("campaignId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "agent_invocations_workspaceId_idx" ON "agent_invocations"("workspaceId");

-- CreateIndex
CREATE INDEX "agent_invocations_workflowRunId_idx" ON "agent_invocations"("workflowRunId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_invocations_campaignId_idempotencyKey_key" ON "agent_invocations"("campaignId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_briefs" ADD CONSTRAINT "campaign_briefs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_profiles" ADD CONSTRAINT "audience_profiles_campaignBriefId_fkey" FOREIGN KEY ("campaignBriefId") REFERENCES "campaign_briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_concepts" ADD CONSTRAINT "creative_concepts_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_languages" ADD CONSTRAINT "visual_languages_creativeConceptId_fkey" FOREIGN KEY ("creativeConceptId") REFERENCES "creative_concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_creativeConceptId_fkey" FOREIGN KEY ("creativeConceptId") REFERENCES "creative_concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "scripts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_timelineId_fkey" FOREIGN KEY ("timelineId") REFERENCES "timelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "shots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_transitionSpecificationId_fkey" FOREIGN KEY ("transitionSpecificationId") REFERENCES "transition_specifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_specifications" ADD CONSTRAINT "shot_specifications_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "shots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_specifications" ADD CONSTRAINT "shot_specifications_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "prompt_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_generation_jobs" ADD CONSTRAINT "shot_generation_jobs_shotSpecificationId_fkey" FOREIGN KEY ("shotSpecificationId") REFERENCES "shot_specifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_generation_attempts" ADD CONSTRAINT "shot_generation_attempts_shotGenerationJobId_fkey" FOREIGN KEY ("shotGenerationJobId") REFERENCES "shot_generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_candidates" ADD CONSTRAINT "generation_candidates_shotSpecificationId_fkey" FOREIGN KEY ("shotSpecificationId") REFERENCES "shot_specifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_candidates" ADD CONSTRAINT "generation_candidates_shotGenerationAttemptId_fkey" FOREIGN KEY ("shotGenerationAttemptId") REFERENCES "shot_generation_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_candidates" ADD CONSTRAINT "generation_candidates_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_assessments" ADD CONSTRAINT "quality_assessments_generationCandidateId_fkey" FOREIGN KEY ("generationCandidateId") REFERENCES "generation_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_assessments" ADD CONSTRAINT "quality_assessments_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_failures" ADD CONSTRAINT "quality_failures_qualityAssessmentId_fkey" FOREIGN KEY ("qualityAssessmentId") REFERENCES "quality_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_selections" ADD CONSTRAINT "shot_selections_shotSelectionSetId_fkey" FOREIGN KEY ("shotSelectionSetId") REFERENCES "shot_selection_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_selection_replacements" ADD CONSTRAINT "shot_selection_replacements_shotSelectionSetId_fkey" FOREIGN KEY ("shotSelectionSetId") REFERENCES "shot_selection_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_approvals" ADD CONSTRAINT "human_approvals_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_provenance_records" ADD CONSTRAINT "asset_provenance_records_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_records" ADD CONSTRAINT "license_records_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_outputAssetId_fkey" FOREIGN KEY ("outputAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "composition_jobs" ADD CONSTRAINT "composition_jobs_roughEditSpecificationId_fkey" FOREIGN KEY ("roughEditSpecificationId") REFERENCES "rough_edit_specifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "composition_attempts" ADD CONSTRAINT "composition_attempts_compositionJobId_fkey" FOREIGN KEY ("compositionJobId") REFERENCES "composition_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sound_cues" ADD CONSTRAINT "sound_cues_timelineId_fkey" FOREIGN KEY ("timelineId") REFERENCES "timelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sound_cues" ADD CONSTRAINT "sound_cues_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edit_decision_lists" ADD CONSTRAINT "edit_decision_lists_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edit_decision_entries" ADD CONSTRAINT "edit_decision_entries_editDecisionListId_fkey" FOREIGN KEY ("editDecisionListId") REFERENCES "edit_decision_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edit_decision_entries" ADD CONSTRAINT "edit_decision_entries_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_specifications" ADD CONSTRAINT "delivery_specifications_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_deliverySpecificationId_fkey" FOREIGN KEY ("deliverySpecificationId") REFERENCES "delivery_specifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_variantSpecificationId_fkey" FOREIGN KEY ("variantSpecificationId") REFERENCES "variant_specifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_profiles" ADD CONSTRAINT "delivery_profiles_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_specifications" ADD CONSTRAINT "variant_specifications_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_specifications" ADD CONSTRAINT "variant_specifications_deliveryProfileId_fkey" FOREIGN KEY ("deliveryProfileId") REFERENCES "delivery_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_specifications" ADD CONSTRAINT "variant_specifications_parentMasterAssetId_fkey" FOREIGN KEY ("parentMasterAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_generation_jobs" ADD CONSTRAINT "variant_generation_jobs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_generation_jobs" ADD CONSTRAINT "variant_generation_jobs_variantSpecificationId_fkey" FOREIGN KEY ("variantSpecificationId") REFERENCES "variant_specifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_generation_attempts" ADD CONSTRAINT "variant_generation_attempts_variantGenerationJobId_fkey" FOREIGN KEY ("variantGenerationJobId") REFERENCES "variant_generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_metrics" ADD CONSTRAINT "performance_metrics_creativeVariantId_fkey" FOREIGN KEY ("creativeVariantId") REFERENCES "creative_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_observations" ADD CONSTRAINT "performance_observations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_observations" ADD CONSTRAINT "performance_observations_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_observations" ADD CONSTRAINT "performance_observations_creativeVariantId_fkey" FOREIGN KEY ("creativeVariantId") REFERENCES "creative_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_records" ADD CONSTRAINT "learning_records_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_records" ADD CONSTRAINT "learning_records_sourceCampaignId_fkey" FOREIGN KEY ("sourceCampaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "prompt_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_ledger_entries" ADD CONSTRAINT "budget_ledger_entries_budgetPolicyId_fkey" FOREIGN KEY ("budgetPolicyId") REFERENCES "budget_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_transition_audits" ADD CONSTRAINT "campaign_transition_audits_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_transition_audits" ADD CONSTRAINT "campaign_transition_audits_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_invocations" ADD CONSTRAINT "agent_invocations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_invocations" ADD CONSTRAINT "agent_invocations_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
