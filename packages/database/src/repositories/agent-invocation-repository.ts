import type { CampaignStage } from '@combat/domain';

/**
 * Persists every terminal specialist-agent execution outcome (ADR-0004).
 * `(campaignId, idempotencyKey)` is unique — this is the mechanism
 * `execute-specialist-agent-activity.ts` relies on to make an Activity retry
 * a no-op against the reasoning provider: a retried call finds the existing
 * row here and returns it instead of invoking `executeAgent` again.
 */
export interface AgentInvocationRecord {
  id: string;
  workspaceId: string;
  campaignId: string;
  workflowRunId: string;
  stage: CampaignStage;
  agentName: string;
  agentVersion: number;
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
  status: 'SUCCEEDED' | 'FAILED';
  result?: unknown;
  failureReason?: string;
  failureRetryable?: boolean;
  failureMessage?: string;
  failureDetails?: unknown;
  model?: string;
  promptVersion?: number;
  tokensIn?: number;
  tokensOut?: number;
  costCents?: number;
  inputHash: string;
  outputHash?: string;
  attempt: number;
  startedAt: Date;
  completedAt: Date;
  createdAt: Date;
}

export interface AgentInvocationDataSource {
  agentInvocation: {
    findFirst(args: {
      where: { campaignId: string; idempotencyKey: string };
    }): Promise<AgentInvocationRecord | null>;
    create(args: {
      data: Omit<AgentInvocationRecord, 'id' | 'createdAt'>;
    }): Promise<AgentInvocationRecord>;
  };
}

/** Looked up first by the Activity, before any budget check or provider call — see requirement 4/8 (idempotency across retries). */
export async function findAgentInvocationByIdempotencyKey(
  db: AgentInvocationDataSource,
  campaignId: string,
  idempotencyKey: string,
): Promise<AgentInvocationRecord | null> {
  return db.agentInvocation.findFirst({ where: { campaignId, idempotencyKey } });
}

/**
 * Writes exactly one terminal `AgentInvocation` row per (campaignId,
 * idempotencyKey). The database's unique constraint is the backstop against
 * a race between two concurrent Activity attempts both passing the
 * pre-check — the caller is expected to have already checked
 * `findAgentInvocationByIdempotencyKey` and only calls this once per attempt
 * that didn't find an existing row.
 */
export async function recordAgentInvocation(
  db: AgentInvocationDataSource,
  input: Omit<AgentInvocationRecord, 'id' | 'createdAt'>,
): Promise<AgentInvocationRecord> {
  return db.agentInvocation.create({ data: input });
}
