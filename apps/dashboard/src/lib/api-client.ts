import type { AspectRatio, CampaignBriefContent, DeliveryPlatform } from '@combat/domain';

/**
 * The only place apps/dashboard talks to a backend — every screen goes
 * through these functions, never a direct fetch call of its own (CLAUDE.md:
 * "apps/dashboard holds no business logic... every command/query goes
 * through apps/api").
 */

const API_BASE_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_BASE_URL) ||
  'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  baseUrl: string = API_BASE_URL,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(response.status, body);
  }
  return body as T;
}

export interface Campaign {
  id: string;
  workspaceId: string;
  name: string;
  currentStage: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignBrief extends CampaignBriefContent {
  id: string;
  workspaceId: string;
  campaignId: string;
  version: number;
  acceptedAt: string | null;
  createdAt: string;
}

export interface Strategy {
  id: string;
  positioning: string;
  targetAudienceSummary: string;
  keyMessages: string[];
  toneGuidelines: string[];
  audienceProfile: {
    name: string;
    painPoints: string[];
    demographics: Record<string, unknown>;
    psychographics: Record<string, unknown>;
    platformBehavior: Record<string, unknown>;
  };
}

export interface CreativeConcept {
  id: string;
  version: number;
  logline: string;
  visualDirection: string;
  narrativeArc: string;
  referenceNotes: string[];
}

export interface Script {
  id: string;
  version: number;
  totalDurationFrames: number;
}

export interface Shot {
  id: string;
  index: number;
  description: string;
  durationFrames: number;
  beat: 'HOOK' | 'PROMISE' | 'FEATURE' | 'CTA';
  status: string;
  dependsOnShotIds: string[];
}

export interface WorkflowSnapshot {
  status: string;
  pendingGate: string | null;
  revisionCounts: { CONCEPT: number };
}

export interface CampaignStatus {
  campaignId: string;
  currentStage: string;
  workflow: WorkflowSnapshot | null;
}

export interface ShotSpecificationView {
  id: string;
  version: number;
  visualObjective: string;
  action: string;
  subject: string;
  environment: string;
  cameraMovement: string;
  lensFraming: string;
  lighting: string;
  colorTreatment: string;
  motionIntensity: string;
  transitionIn: string;
  transitionOut: string;
  textSafeAreas: string[];
  providerId: string;
  generationPrompt: string;
  negativePrompt?: string;
  qualityRubric: string[];
  licensingConstraints: string[];
  referenceAssetIds: string[];
  createdAt: string;
}

export interface ShotGenerationJobView {
  id: string;
  status: string;
  requestedCandidateCount: number;
  maxAttempts: number;
  attemptCount: number;
  updatedAt: string;
}

export interface ShotGenerationAttemptView {
  id: string;
  attemptNumber: number;
  status: string;
  providerId: string;
  providerJobId?: string;
  estimatedCostCents?: number;
  actualCostCents?: number;
  failureReason?: string;
  failureRetryable?: boolean;
  failureMessage?: string;
  startedAt: string;
  completedAt?: string;
}

export interface GenerationCandidateView {
  id: string;
  candidateIndex: number;
  status: string;
  assetId?: string;
  seed?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  /** Always `false` — the mock video-generation provider never produces real media (see apps/api's shot-generation-routes.ts doc comment); render a placeholder, never a video element. */
  hasMedia: false;
}

export interface ShotGenerationShotView {
  shotId: string;
  index: number;
  description: string;
  durationFrames: number;
  beat: string;
  specification: ShotSpecificationView | null;
  generationJob: ShotGenerationJobView | null;
  attempts: ShotGenerationAttemptView[];
  candidates: GenerationCandidateView[];
}

export interface BudgetStatusView {
  level: string;
  scopeId: string;
  limitCents: number;
  spentCents: number;
  remainingCents: number;
}

export interface ShotGenerationView {
  script: { id: string; version: number; totalDurationFrames: number } | null;
  shots: ShotGenerationShotView[];
  budget: { workspace: BudgetStatusView | null; campaign: BudgetStatusView | null };
}

export interface ConceptApprovalState {
  currentStage: string;
  isPending: boolean;
  revisionCount: number;
  latestDecision: {
    id: string;
    decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED';
    decidedByUserId: string;
    comments?: string;
    decidedAt: string;
  } | null;
}

// --- M8 shot review ---

export interface ShotReviewQaDefect {
  category: string;
  severity: string;
  description: string;
  suggestedAction?: string;
}

export interface ShotReviewCandidate {
  id: string;
  candidateIndex: number;
  status: string;
  assetId?: string;
  seed?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  providerId: string;
  /** Always false — the mock provider writes no bytes; render a deterministic placeholder. */
  hasMedia: false;
  eligibility: { eligible: boolean; reasons: string[] };
  visualQa: {
    pass: boolean;
    overallScore: number;
    scores: Record<string, number>;
    defects: ShotReviewQaDefect[];
  } | null;
  continuityQa: { pass: boolean; overallScore: number } | null;
}

export interface ShotReviewSelectionEntry {
  status: string;
  selectedCandidateId: string | null;
  rationale: string | null;
  regenerationFeedback: string | null;
}

export interface ShotReviewShot {
  shotId: string;
  index: number;
  description: string;
  durationFrames: number;
  beat: string;
  specification: { id: string; version: number; providerId: string } | null;
  candidates: ShotReviewCandidate[];
  selection: ShotReviewSelectionEntry | null;
}

export interface ShotSelectionSetView {
  id: string;
  campaignId: string;
  version: number;
  status: string;
  revision: number;
  reviewerUserId: string | null;
  approvedAt: string | null;
}

export interface ShotReviewView {
  campaign: { currentStage: string; isSelectionStage: boolean };
  script: { id: string; version: number } | null;
  shots: ShotReviewShot[];
  selectionSet: ShotSelectionSetView | null;
  budget: { workspace: BudgetStatusView | null; campaign: BudgetStatusView | null };
}

// --- M9 compositing / rough edit ---

export interface RoughEditClipView {
  order: number;
  shotIndex: number;
  sourceAssetId: string;
  durationFrames: number;
  transitionIn: string | null;
}

export interface RoughEditSpecView {
  id: string;
  version: number;
  outputFormat: string;
  aspectRatio: string;
  resolutionWidth: number;
  resolutionHeight: number;
  frameRate: number;
  targetDurationFrames: number;
  shotSelectionSetId: string;
  shotSelectionSetVersion: number;
  clips: RoughEditClipView[];
  overlays: { kind: string; shotIndex?: number; description: string }[];
  pacingNotes: string;
  continuityNotes: string[];
  captionPlaceholder: string;
  musicPlaceholder: string;
  sfxPlaceholder: string;
  editRationale: string;
  qualityRubric: string[];
  platform: string;
}

export interface CompositionAttemptView {
  id: string;
  attemptNumber: number;
  status: string;
  providerId: string;
  estimatedCostCents: number | null;
  actualCostCents: number | null;
  failureReason: string | null;
  failureMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface CompositingView {
  campaign: { currentStage: string; isCompositingStage: boolean };
  roughEditSpecification: RoughEditSpecView | null;
  compositionJob: { id: string; status: string; attemptCount: number; maxAttempts: number } | null;
  attempts: CompositionAttemptView[];
  roughEdit: { assetId: string | null; hasMedia: false };
  budget: { workspace: BudgetStatusView | null; campaign: BudgetStatusView | null };
}

// --- M10 sound design ---

export interface SoundCueView {
  id: string;
  type: string;
  startFrame: number;
  durationFrames: number;
  notes: string | null;
  /** Always false — mock stems carry no real audio; render a placeholder. */
  hasMedia: false;
  assetId: string | null;
}

export interface SoundDesignView {
  campaign: { currentStage: string; isSoundDesignStage: boolean };
  plan: {
    id: string;
    version: number;
    musicBrief: string;
    mixNotes: string;
    brandAudioGuidelines: string[];
    qualityRubric: string[];
    roughEditSpecificationId: string;
  } | null;
  timeline: {
    id: string;
    version: number;
    frameRate: number;
    durationFrames: number;
    entries: { order: number; shotId: string; startFrame: number; durationFrames: number }[];
  } | null;
  cues: SoundCueView[];
  budget: { workspace: BudgetStatusView | null; campaign: BudgetStatusView | null };
}

// --- M11 final QA + final approval ---

export interface FinalQaFindingView {
  id: string;
  category: string;
  severity: string;
  description: string;
  suggestedAction: string | null;
}

export interface FinalQaView {
  campaign: { currentStage: string; isFinalQaStage: boolean; isFinalApprovalStage: boolean };
  /** Advisory only — the approval endpoint re-checks the permission server-side. */
  caller: { role: string; canApprove: boolean };
  master: {
    id: string;
    checksum: string;
    originalFilename: string;
    /** Always false — mock masters carry no real video; render a placeholder. */
    hasMedia: false;
  } | null;
  assessment: {
    id: string;
    pass: boolean;
    overallScore: number;
    scores: Record<string, number>;
    assessedBy: string;
  } | null;
  findings: FinalQaFindingView[];
  deliveryContext: {
    platform: string;
    aspectRatio: string;
    resolutionWidth: number;
    resolutionHeight: number;
    frameRate: number;
    durationFrames: number;
    soundDesignPlanVersion: number | null;
  } | null;
  budget: { workspace: BudgetStatusView | null; campaign: BudgetStatusView | null };
}

/** The three non-gated stages a rejected final master may be sent back to. */
export const FINAL_REPAIR_TARGET_OPTIONS = ['COMPOSITING', 'ROUGH_CUT', 'SOUND_DESIGN'] as const;
export type FinalRepairTarget = (typeof FINAL_REPAIR_TARGET_OPTIONS)[number];

// --- M12 delivery variants ---

export interface VariantCutPointView {
  order: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
  variantStartFrame: number;
}

export interface VariantRetainedClipView {
  order: number;
  shotId: string;
  shotIndex: number;
  beat?: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
}

export interface VariantCaptionView {
  text: string;
  variantStartFrame: number;
  variantEndFrame: number;
  safeArea: string;
}

export interface VariantQaFindingView {
  id: string;
  category: string;
  severity: string;
  description: string;
  suggestedAction: string | null;
}

export interface VariantRowView {
  specification: {
    id: string;
    version: number;
    targetDurationSeconds: number;
    targetDurationFrames: number;
    platform: string;
    aspectRatio: string;
    resolutionWidth: number;
    resolutionHeight: number;
    frameRate: number;
    deliveryProfileKey: string;
    deliveryProfileVersion: number;
    parentMasterAssetId: string;
    cutPoints: VariantCutPointView[];
    retainedClips: VariantRetainedClipView[];
    retainedCues: unknown[];
    retainedCaptions: VariantCaptionView[];
    ctaPlacement: { present: boolean; variantStartFrame?: number; variantEndFrame?: number };
    captionBurnRequired: boolean;
    safeAreas: string[];
    cutRationale: string;
    removedRationale: string[];
    approvedForExport: boolean;
    superseded: boolean;
  };
  variant: {
    id: string;
    status: string;
    assetId: string | null;
    /** Always false — mock renders carry no video; render a placeholder. */
    hasMedia: false;
  } | null;
  qa: {
    id: string;
    pass: boolean;
    overallScore: number;
    scores: Record<string, number>;
    findings: VariantQaFindingView[];
  } | null;
  job: { id: string; status: string; attemptCount: number; maxAttempts: number } | null;
  attempts: {
    attemptNumber: number;
    status: string;
    estimatedCostCents: number | null;
    actualCostCents: number | null;
    failureReason: string | null;
    failureMessage: string | null;
  }[];
}

export interface VariantsView {
  campaign: { currentStage: string; isVariantStage: boolean };
  /** Advisory only — the cancel endpoint re-checks the permission server-side. */
  caller: { role: string; canCancel: boolean };
  variants: VariantRowView[];
  budget: { workspace: BudgetStatusView | null; campaign: BudgetStatusView | null };
}

export interface ApiClientOptions {
  baseUrl?: string;
}

export function createApiClient(
  workspaceId: string,
  userId: string,
  options: ApiClientOptions = {},
) {
  const baseUrl = options.baseUrl ?? API_BASE_URL;

  return {
    listCampaigns: () =>
      request<{ campaigns: Campaign[] }>(
        `/workspaces/${workspaceId}/campaigns?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    createCampaign: (name: string, idempotencyKey?: string) =>
      request<{ campaign: Campaign }>(
        `/workspaces/${workspaceId}/campaigns`,
        { method: 'POST', body: JSON.stringify({ userId, name, idempotencyKey }) },
        baseUrl,
      ),

    getCampaignStatus: (campaignId: string) =>
      request<CampaignStatus>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/status?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    getBrief: (campaignId: string) =>
      request<{ brief: CampaignBrief | null }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/brief?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    saveDraftBrief: (campaignId: string, content: Partial<CampaignBriefContent>) =>
      request<{ brief: CampaignBrief }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/brief/draft`,
        { method: 'POST', body: JSON.stringify({ userId, content }) },
        baseUrl,
      ),

    submitBrief: (campaignId: string, content: CampaignBriefContent) =>
      request<{ brief: CampaignBrief }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/brief/submit`,
        { method: 'POST', body: JSON.stringify({ userId, content }) },
        baseUrl,
      ),

    startWorkflow: (campaignId: string) =>
      request<{ workflowId: string; alreadyRunning: boolean }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/workflow/start`,
        { method: 'POST', body: JSON.stringify({ userId }) },
        baseUrl,
      ),

    getStrategy: (campaignId: string) =>
      request<{ strategy: Strategy | null }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/strategy?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    getConcept: (campaignId: string) =>
      request<{ concept: CreativeConcept | null }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/concept?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    getScript: (campaignId: string) =>
      request<{ script: Script | null; shots: Shot[] }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/script?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    getShotGeneration: (campaignId: string) =>
      request<ShotGenerationView>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-generation?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    getConceptApprovalState: (campaignId: string) =>
      request<ConceptApprovalState>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/approvals/concept/state?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    decideConceptApproval: (
      campaignId: string,
      decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED',
      comments?: string,
    ) =>
      request<{ approvalId: string; replayed: boolean }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/approvals/concept`,
        { method: 'POST', body: JSON.stringify({ userId, decision, comments }) },
        baseUrl,
      ),

    getShotReview: (campaignId: string) =>
      request<ShotReviewView>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-review?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    createShotSelectionDraft: (campaignId: string) =>
      request<{ set: ShotSelectionSetView; selections: ShotReviewSelectionEntry[] }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-review/draft`,
        { method: 'POST', body: JSON.stringify({ userId }) },
        baseUrl,
      ),

    selectShotCandidate: (
      campaignId: string,
      input: {
        setId: string;
        shotId: string;
        candidateId: string;
        expectedRevision: number;
        rationale?: string;
      },
    ) =>
      request<{ set: ShotSelectionSetView }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-review/select`,
        { method: 'POST', body: JSON.stringify({ userId, ...input }) },
        baseUrl,
      ),

    rejectShotCandidate: (
      campaignId: string,
      input: {
        setId: string;
        shotId: string;
        regenerationFeedback: string;
        expectedRevision: number;
      },
    ) =>
      request<{ set: ShotSelectionSetView }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-review/reject-shot`,
        { method: 'POST', body: JSON.stringify({ userId, ...input }) },
        baseUrl,
      ),

    approveShotSelection: (
      campaignId: string,
      input: { setId: string; expectedRevision: number },
    ) =>
      request<{ approvalId: string; replayed: boolean; set: ShotSelectionSetView }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-review/approve`,
        { method: 'POST', body: JSON.stringify({ userId, ...input }) },
        baseUrl,
      ),

    requestShotRegeneration: (campaignId: string, input: { setId: string; comments?: string }) =>
      request<{ approvalId: string; replayed: boolean }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-review/request-regeneration`,
        { method: 'POST', body: JSON.stringify({ userId, ...input }) },
        baseUrl,
      ),

    getCompositing: (campaignId: string) =>
      request<CompositingView>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/compositing?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    cancelCompositing: (campaignId: string) =>
      request<{ cancelRequested: boolean }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/compositing/cancel`,
        { method: 'POST', body: JSON.stringify({ userId }) },
        baseUrl,
      ),

    getSoundDesign: (campaignId: string) =>
      request<SoundDesignView>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/sound-design?userId=${userId}`,
        undefined,
        baseUrl,
      ),
    getFinalQa: (campaignId: string) =>
      request<FinalQaView>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/final-qa?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    /**
     * The FINAL human gate. Dispatched only from apps/api's
     * `POST .../approvals/final`, which re-checks `APPROVE_FINAL_MASTER`
     * server-side — this method is a transport, not an authorization.
     */
    submitFinalApproval: (
      campaignId: string,
      input:
        | { decision: 'APPROVED'; comments?: string }
        | {
            decision: 'REJECTED' | 'CHANGES_REQUESTED';
            repairTarget: FinalRepairTarget;
            comments?: string;
          },
    ) =>
      request<{ approvalId: string; replayed: boolean }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/approvals/final`,
        { method: 'POST', body: JSON.stringify({ userId, ...input }) },
        baseUrl,
      ),
    getVariants: (campaignId: string) =>
      request<VariantsView>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/variants?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    /** Signed, time-limited preview URL — null while the mock renderer produces no bytes. */
    getVariantPreview: (campaignId: string, assetId: string) =>
      request<{ hasMedia: boolean; url: string | null }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/variants/${assetId}/preview?userId=${userId}`,
        undefined,
        baseUrl,
      ),

    cancelVariants: (campaignId: string) =>
      request<{ cancelRequested: boolean }>(
        `/workspaces/${workspaceId}/campaigns/${campaignId}/variants/cancel`,
        { method: 'POST', body: JSON.stringify({ userId }) },
        baseUrl,
      ),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const DELIVERY_PLATFORM_OPTIONS: DeliveryPlatform[] = [
  'TIKTOK',
  'INSTAGRAM_REELS',
  'YOUTUBE_SHORTS',
  'GENERIC',
];

export const ASPECT_RATIO_OPTIONS: AspectRatio[] = ['9:16', '1:1', '4:5', '16:9'];
