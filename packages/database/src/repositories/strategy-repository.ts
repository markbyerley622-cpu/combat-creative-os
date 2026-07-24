import type { StrategyAudienceProfile } from '@combat/domain';

/** Campaign Strategist's output, persisted as an immutable versioned row (never mutated — a revision is a new row). */
export interface StrategyRecord {
  id: string;
  workspaceId: string;
  campaignId: string;
  version: number;
  positioning: string;
  targetAudienceSummary: string;
  keyMessages: string[];
  toneGuidelines: string[];
  audienceProfile: StrategyAudienceProfile;
  createdAt: Date;
}

export interface StrategyDataSource {
  strategy: {
    create(args: { data: Omit<StrategyRecord, 'id' | 'createdAt'> }): Promise<StrategyRecord>;
    findMany(args: {
      where: { campaignId: string; workspaceId: string };
    }): Promise<StrategyRecord[]>;
  };
}

/**
 * Idempotent create: if a row for `(campaignId, version)` already exists
 * (an Activity retry after a prior attempt persisted it but failed later in
 * the same `runStrategyConceptScriptActivity` call), returns that row
 * instead of attempting a second insert and hitting the unique-constraint
 * error CLAUDE.md's workflow-idempotency rule exists to avoid.
 */
export async function createStrategy(
  db: StrategyDataSource,
  workspaceId: string,
  input: Omit<StrategyRecord, 'id' | 'createdAt' | 'workspaceId'>,
): Promise<StrategyRecord> {
  const existing = await db.strategy.findMany({
    where: { campaignId: input.campaignId, workspaceId },
  });
  const match = existing.find((s) => s.version === input.version);
  if (match) return match;
  return db.strategy.create({ data: { workspaceId, ...input } });
}

export async function listStrategies(
  db: StrategyDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<StrategyRecord[]> {
  return db.strategy.findMany({ where: { campaignId, workspaceId } });
}

export async function getLatestStrategy(
  db: StrategyDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<StrategyRecord | undefined> {
  const strategies = await listStrategies(db, workspaceId, campaignId);
  return [...strategies].sort((a, b) => b.version - a.version)[0];
}
