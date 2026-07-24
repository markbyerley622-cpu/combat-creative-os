import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  findAgentInvocationByIdempotencyKey,
  recordAgentInvocation,
} from './agent-invocation-repository';
import { InMemoryCampaignStore } from './test-helpers/in-memory-campaign-store';

describe('agent invocation repository', () => {
  it('records a terminal invocation and finds it back by (campaignId, idempotencyKey)', async () => {
    const store = new InMemoryCampaignStore();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    const idempotencyKey = randomUUID();

    const created = await recordAgentInvocation(store, {
      workspaceId,
      campaignId,
      workflowRunId: randomUUID(),
      stage: 'PROMPTING',
      agentName: 'test-agent',
      agentVersion: 1,
      idempotencyKey,
      correlationId: randomUUID(),
      status: 'SUCCEEDED',
      result: { headline: 'ok' },
      inputHash: 'a'.repeat(64),
      outputHash: 'b'.repeat(64),
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const found = await findAgentInvocationByIdempotencyKey(store, campaignId, idempotencyKey);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.status).toBe('SUCCEEDED');
  });

  it('returns null when no invocation matches the (campaignId, idempotencyKey) pair', async () => {
    const store = new InMemoryCampaignStore();
    const found = await findAgentInvocationByIdempotencyKey(store, randomUUID(), randomUUID());
    expect(found).toBeNull();
  });

  it('enforces uniqueness on (campaignId, idempotencyKey), matching the Postgres unique constraint', async () => {
    const store = new InMemoryCampaignStore();
    const campaignId = randomUUID();
    const idempotencyKey = randomUUID();
    const base = {
      workspaceId: randomUUID(),
      campaignId,
      workflowRunId: randomUUID(),
      stage: 'PROMPTING' as const,
      agentName: 'test-agent',
      agentVersion: 1,
      idempotencyKey,
      correlationId: randomUUID(),
      status: 'SUCCEEDED' as const,
      inputHash: 'a'.repeat(64),
      attempt: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    };

    await recordAgentInvocation(store, base);
    await expect(recordAgentInvocation(store, base)).rejects.toThrow(/unique constraint/);
  });
});
