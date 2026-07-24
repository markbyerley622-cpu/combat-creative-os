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
