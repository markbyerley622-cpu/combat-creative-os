import { z } from 'zod';

/**
 * Enums shared across multiple entity schemas in this package. Centralized so
 * (for example) `DeliveryPlatform` is defined once rather than re-declared in
 * every schema file that references a platform.
 */

export const DELIVERY_PLATFORMS = [
  'TIKTOK',
  'INSTAGRAM_REELS',
  'YOUTUBE_SHORTS',
  'GENERIC',
] as const;
export const DeliveryPlatformSchema = z.enum(DELIVERY_PLATFORMS);
export type DeliveryPlatform = z.infer<typeof DeliveryPlatformSchema>;

export const BUDGET_LEVELS = ['WORKSPACE', 'CAMPAIGN', 'SHOT', 'PROVIDER'] as const;
export const BudgetLevelSchema = z.enum(BUDGET_LEVELS);
export type BudgetLevel = z.infer<typeof BudgetLevelSchema>;

export const BUDGET_LEDGER_ENTRY_TYPES = ['RESERVATION', 'CHARGE', 'RELEASE'] as const;
export const BudgetLedgerEntryTypeSchema = z.enum(BUDGET_LEDGER_ENTRY_TYPES);
export type BudgetLedgerEntryType = z.infer<typeof BudgetLedgerEntryTypeSchema>;

/**
 * The three architecturally-required gates — concept, shot selection, final
 * master (docs/architecture.md §0/§3.3) — and only these three. STRATEGY_REVIEW
 * and SCRIPT_REVIEW are checkpoint stages, not approval gates: per
 * docs/adr/0002-campaign-lifecycle-alignment.md decision 9, they must not
 * require a HumanApproval record unless a future decision explicitly adds one.
 */
export const APPROVAL_GATES = ['CONCEPT', 'SHOT_SELECTION', 'FINAL'] as const;
export const ApprovalGateSchema = z.enum(APPROVAL_GATES);
export type ApprovalGate = z.infer<typeof ApprovalGateSchema>;

export const APPROVAL_DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'] as const;
export const ApprovalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ASSET_KINDS = [
  /** M5: a file uploaded directly by a user (brand asset, reference footage) — the only AssetKind the ingestion service itself creates; every other kind is agent/render-produced. */
  'UPLOADED_SOURCE',
  'VIDEO_CANDIDATE',
  'THUMBNAIL',
  'PROXY',
  'MOTION_GRAPHICS_RENDER',
  'SOUND_STEM',
  'FINAL_MASTER',
  'VARIANT',
  'DESIGN_EXPORT',
] as const;
export const AssetKindSchema = z.enum(ASSET_KINDS);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/**
 * M5: an uploaded asset's lifecycle after `putObject` succeeds — `PENDING`
 * until `inspectMediaActivity` runs (packages/workflows), then `READY` or
 * `FAILED`. Not every AssetKind necessarily needs inspection (see that
 * activity's doc comment), but the column exists on every Asset row for a
 * single, consistent status field.
 */
export const ASSET_INGESTION_STATUSES = ['PENDING', 'READY', 'FAILED'] as const;
export const AssetIngestionStatusSchema = z.enum(ASSET_INGESTION_STATUSES);
export type AssetIngestionStatus = z.infer<typeof AssetIngestionStatusSchema>;

export const GENERATION_CANDIDATE_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
] as const;
export const GenerationCandidateStatusSchema = z.enum(GENERATION_CANDIDATE_STATUSES);
export type GenerationCandidateStatus = z.infer<typeof GenerationCandidateStatusSchema>;

/**
 * `SHOT_UNUSABLE`, `COMPOSITING_TECHNICAL`, `EDIT_TIMING`, and `AUDIO_TECHNICAL`
 * exist specifically to drive typed revision routing for stages with more than
 * one valid repair target (COMPOSITING, SOUND_DESIGN, FINAL_QA) — see
 * `packages/domain/src/workflow/quality-failure-routing.ts` for the
 * category -> target-stage mapping these four values feed.
 */
export const QUALITY_FAILURE_CATEGORIES = [
  'PROMPT',
  'GENERATION',
  'CONTINUITY',
  'TECHNICAL',
  'SHOT_UNUSABLE',
  'COMPOSITING_TECHNICAL',
  'EDIT_TIMING',
  'AUDIO_TECHNICAL',
] as const;
export const QualityFailureCategorySchema = z.enum(QUALITY_FAILURE_CATEGORIES);
export type QualityFailureCategory = z.infer<typeof QualityFailureCategorySchema>;

export const QUALITY_FAILURE_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'BLOCKING'] as const;
export const QualityFailureSeveritySchema = z.enum(QUALITY_FAILURE_SEVERITIES);
export type QualityFailureSeverity = z.infer<typeof QualityFailureSeveritySchema>;

export const ASSESSED_BY_VALUES = ['AGENT', 'HUMAN'] as const;
export const AssessedBySchema = z.enum(ASSESSED_BY_VALUES);
export type AssessedBy = z.infer<typeof AssessedBySchema>;

export const RENDER_JOB_KINDS = ['COMPOSITING', 'EXPORT'] as const;
export const RenderJobKindSchema = z.enum(RENDER_JOB_KINDS);
export type RenderJobKind = z.infer<typeof RenderJobKindSchema>;

export const RENDER_JOB_STATUSES = [
  'QUEUED',
  'SUBMITTED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
] as const;
export const RenderJobStatusSchema = z.enum(RENDER_JOB_STATUSES);
export type RenderJobStatus = z.infer<typeof RenderJobStatusSchema>;

export const SOUND_CUE_TYPES = ['MUSIC', 'SFX', 'VOICEOVER'] as const;
export const SoundCueTypeSchema = z.enum(SOUND_CUE_TYPES);
export type SoundCueType = z.infer<typeof SoundCueTypeSchema>;

export const TRANSITION_TYPES = ['CUT', 'DISSOLVE', 'WIPE', 'FADE_IN', 'FADE_OUT'] as const;
export const TransitionTypeSchema = z.enum(TRANSITION_TYPES);
export type TransitionType = z.infer<typeof TransitionTypeSchema>;

export const SHOT_STATUSES = [
  'PENDING',
  'GENERATING',
  'QC_REVIEW',
  'NEEDS_HUMAN',
  'BUDGET_EXCEEDED',
  'SELECTED',
  'REJECTED',
] as const;
export const ShotStatusSchema = z.enum(SHOT_STATUSES);
export type ShotStatus = z.infer<typeof ShotStatusSchema>;

export const LICENSE_TYPES = [
  'FULL_BUY_OUT',
  'LIMITED_USAGE',
  'ROYALTY_FREE',
  'EXCLUSIVE',
] as const;
export const LicenseTypeSchema = z.enum(LICENSE_TYPES);
export type LicenseType = z.infer<typeof LicenseTypeSchema>;

export const CREATIVE_VARIANT_STATUSES = ['PENDING', 'RENDERING', 'READY', 'FAILED'] as const;
export const CreativeVariantStatusSchema = z.enum(CREATIVE_VARIANT_STATUSES);
export type CreativeVariantStatus = z.infer<typeof CreativeVariantStatusSchema>;

/** Vertical/square/horizontal crop targets a campaign brief can request (M4). */
export const ASPECT_RATIOS = ['9:16', '1:1', '4:5', '16:9'] as const;
export const AspectRatioSchema = z.enum(ASPECT_RATIOS);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/**
 * Script & Timing Director's per-shot narrative-beat classification
 * (packages/agents/src/script-timing-director/schema.ts's `ShotBeatSchema`,
 * mirrored here so `packages/domain`'s `Shot`/database layer can persist it
 * without the domain package depending on `packages/agents`).
 */
export const SHOT_BEATS = ['HOOK', 'PROMISE', 'FEATURE', 'CTA'] as const;
export const ShotBeatSchema = z.enum(SHOT_BEATS);
export type ShotBeat = z.infer<typeof ShotBeatSchema>;

export const TRANSITION_AUDIT_RESULTS = [
  'APPLIED',
  'REJECTED_INVALID_TRANSITION',
  'REJECTED_MISSING_PREREQUISITE',
  'REJECTED_BUDGET_EXCEEDED',
  'REJECTED_CONCURRENT_MODIFICATION',
  'DUPLICATE_IGNORED',
] as const;
export const TransitionAuditResultSchema = z.enum(TRANSITION_AUDIT_RESULTS);
export type TransitionAuditResult = z.infer<typeof TransitionAuditResultSchema>;
