import type { CampaignBriefContent } from '@combat/domain';

/**
 * A persisted brief row — versioned and immutable once created (CLAUDE.md:
 * "Brief changes must create immutable versions"). There is no update/delete
 * here, matching human-approval-repository.ts's convention: a revision or a
 * submit-after-draft is always a new row with an incremented `version`.
 */
export interface CampaignBriefRecord extends CampaignBriefContent {
  id: string;
  workspaceId: string;
  campaignId: string;
  version: number;
  /** `Date | null` (not `| undefined`) to match Prisma's nullable-column convention — see transition-facts.ts's `CampaignBriefFactRow`, which this type must stay structurally assignable to. */
  acceptedAt: Date | null;
  createdAt: Date;
}

export interface CampaignBriefDataSource {
  campaignBrief: {
    create(args: {
      data: Omit<CampaignBriefRecord, 'id' | 'createdAt'>;
    }): Promise<CampaignBriefRecord>;
    findMany(args: {
      where: { campaignId: string; workspaceId: string };
    }): Promise<CampaignBriefRecord[]>;
  };
}

function nextVersion(briefs: readonly { version: number }[]): number {
  return briefs.reduce((max, b) => Math.max(max, b.version), 0) + 1;
}

export async function listCampaignBriefs(
  db: CampaignBriefDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<CampaignBriefRecord[]> {
  return db.campaignBrief.findMany({ where: { campaignId, workspaceId } });
}

/** The highest-`version` row regardless of accepted/draft status — what a brief editor resumes from. */
export async function getLatestCampaignBrief(
  db: CampaignBriefDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<CampaignBriefRecord | undefined> {
  const briefs = await listCampaignBriefs(db, workspaceId, campaignId);
  return [...briefs].sort((a, b) => b.version - a.version)[0];
}

/** The highest-`version` row with `acceptedAt` set — what `runStrategyConceptScriptActivity` reads. */
export async function getLatestAcceptedCampaignBrief(
  db: CampaignBriefDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<CampaignBriefRecord | undefined> {
  const briefs = await listCampaignBriefs(db, workspaceId, campaignId);
  return briefs.filter((b) => b.acceptedAt != null).sort((a, b) => b.version - a.version)[0];
}

/** Persists a new draft version (`acceptedAt` left unset). Never mutates a prior version. */
export async function saveDraftCampaignBrief(
  db: CampaignBriefDataSource,
  workspaceId: string,
  input: { campaignId: string; content: CampaignBriefContent },
): Promise<CampaignBriefRecord> {
  const existing = await listCampaignBriefs(db, workspaceId, input.campaignId);
  return db.campaignBrief.create({
    data: {
      workspaceId,
      campaignId: input.campaignId,
      version: nextVersion(existing),
      acceptedAt: null,
      ...input.content,
    },
  });
}

/**
 * Persists a new, immediately-accepted version — the one action that flips
 * `briefAccepted` true and lets `DRAFT -> STRATEGY_REVIEW` auto-forward.
 * Distinct from `saveDraftCampaignBrief` only in that `acceptedAt` is set at
 * creation time; the row is still never mutated afterward.
 */
export async function submitCampaignBrief(
  db: CampaignBriefDataSource,
  workspaceId: string,
  input: { campaignId: string; content: CampaignBriefContent },
): Promise<CampaignBriefRecord> {
  const existing = await listCampaignBriefs(db, workspaceId, input.campaignId);
  return db.campaignBrief.create({
    data: {
      workspaceId,
      campaignId: input.campaignId,
      version: nextVersion(existing),
      ...input.content,
      acceptedAt: new Date(),
    },
  });
}
