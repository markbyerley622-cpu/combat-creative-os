import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  computeCost,
  defineAgent,
  definePromptTemplate,
  createQueuedReasoningProvider,
  type AgentDefinition,
} from '@combat/agent-runtime';
import type { ExecuteSpecialistAgentInput } from '@combat/domain';
import { z } from 'zod';
import {
  CampaignNotFoundError,
  CampaignStageMismatchError,
  createExecuteSpecialistAgentActivity,
  type ExecuteSpecialistAgentActivityDeps,
} from './execute-specialist-agent-activity';
import { InMemoryAgentExecutionStore } from './test-helpers/in-memory-agent-execution-store';

const TestAgentInputSchema = z.object({ topic: z.string().min(1) });
const TestAgentResultSchema = z.object({ headline: z.string().min(1) });

function buildTestAgentDefinition(
  overrides: Partial<AgentDefinition<{ topic: string }, { headline: string }>> = {},
): AgentDefinition<{ topic: string }, { headline: string }> {
  return defineAgent({
    name: 'test-agent',
    displayName: 'Test Agent',
    description: 'unit-test-only agent',
    implemented: true,
    disabledByDefault: false,
    inputSchema: TestAgentInputSchema,
    resultSchema: TestAgentResultSchema,
    promptVersion: definePromptTemplate({
      version: 3,
      changelog: 'initial',
      systemPrompt: 'Be a test agent.',
    }),
    modelPolicy: DEFAULT_MODEL_POLICY,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    toolPolicy: NO_TOOL_POLICY,
    ...overrides,
  });
}

const PLACEHOLDER_AGENT = defineAgent({
  name: 'placeholder-test-agent',
  displayName: 'Placeholder Test Agent',
  description: 'not implemented',
  implemented: false,
  disabledByDefault: true,
  futureMilestone: 'M9',
  inputSchema: TestAgentInputSchema,
  resultSchema: TestAgentResultSchema,
  promptVersion: definePromptTemplate({ version: 1, changelog: 'n/a', systemPrompt: 'n/a' }),
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

const ESTIMATED_CENTS = Math.ceil(
  computeCost(
    DEFAULT_MODEL_POLICY.model,
    DEFAULT_TOKEN_BUDGET.maxInputTokens,
    DEFAULT_TOKEN_BUDGET.maxOutputTokens,
  ).costMicroCents / 1_000_000,
);

function buildInput(
  campaign: ReturnType<InMemoryAgentExecutionStore['seedCampaign']>,
  overrides: Partial<ExecuteSpecialistAgentInput> = {},
): ExecuteSpecialistAgentInput {
  return {
    workspaceId: campaign.workspaceId,
    campaignId: campaign.id,
    workflowRunId: randomUUID(),
    stage: campaign.currentStage,
    agentName: 'test-agent',
    agentVersion: 3,
    idempotencyKey: randomUUID(),
    payload: { topic: 'combat sports' },
    context: { campaignId: campaign.id, priorArtifactRefs: [], budgetRemainingCents: 100_000 },
    correlationId: randomUUID(),
    budgetScope: {},
    ...overrides,
  };
}

function buildDeps(
  store: InMemoryAgentExecutionStore,
  reasoningProvider: ExecuteSpecialistAgentActivityDeps['reasoningProvider'],
  overrides: Partial<ExecuteSpecialistAgentActivityDeps> = {},
): ExecuteSpecialistAgentActivityDeps {
  return {
    agentRegistry: {
      'test-agent': buildTestAgentDefinition() as AgentDefinition<unknown, unknown>,
      'placeholder-test-agent': PLACEHOLDER_AGENT as AgentDefinition<unknown, unknown>,
    },
    reasoningProvider,
    campaignDb: store,
    agentInvocationDb: store,
    budgetDb: store,
    now: () => Date.parse('2026-07-24T00:00:00.000Z'),
    ...overrides,
  };
}

describe('executeSpecialistAgentActivity', () => {
  it('executes a registered agent successfully and persists an AgentInvocation', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    const provider = createQueuedReasoningProvider([
      {
        result: { headline: 'Every fight, one app' },
        modelMeta: { model: 'claude-opus-4-8', tokensIn: 100, tokensOut: 50 },
      },
    ]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));

    const input = buildInput(campaign);
    const output = await activity(input);

    expect(output.status).toBe('SUCCEEDED');
    expect(output.result).toEqual({ headline: 'Every fight, one app' });
    expect(output.replayed).toBe(false);
    expect(store.agentInvocations).toHaveLength(1);
    expect(store.agentInvocations[0]!.status).toBe('SUCCEEDED');
    expect(provider.calls).toHaveLength(1);
    // mock-only: no real reasoning provider / paid credentials involved
    expect(provider.name).toBe('queued-test-reasoning');
  });

  it('rejects a request scoped to the wrong workspace as though the campaign does not exist (workspace isolation)', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    const provider = createQueuedReasoningProvider([{ result: { headline: 'unused' } }]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));

    const input = buildInput(campaign, { workspaceId: randomUUID() });

    await expect(activity(input)).rejects.toBeInstanceOf(CampaignNotFoundError);
    expect(provider.calls).toHaveLength(0);
    expect(store.agentInvocations).toHaveLength(0);
  });

  it('rejects an invocation whose stage does not match the campaign current stage', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign({ currentStage: 'PROMPTING' });
    const provider = createQueuedReasoningProvider([{ result: { headline: 'unused' } }]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));

    const input = buildInput(campaign, { stage: 'SHOT_GENERATION' });

    await expect(activity(input)).rejects.toBeInstanceOf(CampaignStageMismatchError);
    expect(provider.calls).toHaveLength(0);
    expect(store.agentInvocations).toHaveLength(0);
  });

  it('rejects with BUDGET_EXCEEDED before ever calling the reasoning provider', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId: campaign.workspaceId,
      level: 'CAMPAIGN',
      scopeId: campaign.id,
      limitCents: ESTIMATED_CENTS - 1,
    });
    const provider = createQueuedReasoningProvider([{ result: { headline: 'unused' } }]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));

    const output = await activity(buildInput(campaign));

    expect(output.status).toBe('FAILED');
    expect(output.failure).toMatchObject({ reason: 'BUDGET_EXCEEDED', retryable: false });
    expect(provider.calls).toHaveLength(0);
    expect(store.agentInvocations).toHaveLength(1);
    expect(store.budgetLedgerEntries.some((e) => e.entryType === 'CHARGE')).toBe(false);
  });

  it('rejects an unregistered agent name before ever calling the reasoning provider', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    const provider = createQueuedReasoningProvider([{ result: { headline: 'unused' } }]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));

    const output = await activity(buildInput(campaign, { agentName: 'does-not-exist' }));

    expect(output.status).toBe('FAILED');
    expect(output.failure).toMatchObject({ reason: 'AGENT_NOT_FOUND', retryable: false });
    expect(provider.calls).toHaveLength(0);
    expect(store.agentInvocations).toHaveLength(1);
  });

  it('rejects a placeholder (NOT_IMPLEMENTED) agent before ever calling the reasoning provider', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    const provider = createQueuedReasoningProvider([{ result: { headline: 'unused' } }]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));

    const output = await activity(
      buildInput(campaign, { agentName: 'placeholder-test-agent', agentVersion: 1 }),
    );

    expect(output.status).toBe('FAILED');
    expect(output.failure).toMatchObject({ reason: 'NOT_IMPLEMENTED', retryable: false });
    expect(provider.calls).toHaveLength(0);
    expect(store.agentInvocations).toHaveLength(1);
  });

  it('replays a persisted SUCCEEDED result on a retried call with the same idempotency key, without re-invoking the provider', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    const provider = createQueuedReasoningProvider([{ result: { headline: 'Only one shot' } }]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));
    const input = buildInput(campaign);

    const first = await activity(input);
    const second = await activity(input);

    expect(first.status).toBe('SUCCEEDED');
    expect(first.replayed).toBe(false);
    expect(second.status).toBe('SUCCEEDED');
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.invocationId).toBe(first.invocationId);
    expect(provider.calls).toHaveLength(1);
    expect(store.agentInvocations).toHaveLength(1);
  });

  it('replays a persisted FAILED result on a retried call with the same idempotency key, without re-invoking the provider (retry exhaustion)', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    // Two consecutive schema-invalid responses exhaust agent-runtime's one
    // bounded corrective retry, terminating in a persisted FAILED outcome.
    const provider = createQueuedReasoningProvider([
      { result: { headline: '' } as unknown as { headline: string } },
      { result: { headline: '' } as unknown as { headline: string } },
    ]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));
    const input = buildInput(campaign);

    const first = await activity(input);
    const second = await activity(input);

    expect(first.status).toBe('FAILED');
    expect(first.failure).toMatchObject({ reason: 'SCHEMA_INVALID', retryable: false });
    expect(second.status).toBe('FAILED');
    expect(second.replayed).toBe(true);
    expect(second.failure).toEqual(first.failure);
    expect(provider.calls).toHaveLength(2);
    expect(store.agentInvocations).toHaveLength(1);
  });

  it('maps AgentRun fields onto the persisted AgentInvocation and the returned output identically (tokens, cost, hashes)', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    const provider = createQueuedReasoningProvider([
      {
        result: { headline: 'Precision matters' },
        modelMeta: { model: 'claude-sonnet-5', tokensIn: 200, tokensOut: 80, latencyMs: 42 },
      },
    ]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));

    const output = await activity(buildInput(campaign));
    const record = store.agentInvocations[0]!;
    const expectedCents = Math.ceil(
      computeCost('claude-sonnet-5', 200, 80).costMicroCents / 1_000_000,
    );

    expect(output.modelMeta).toMatchObject({
      model: 'claude-sonnet-5',
      tokensIn: 200,
      tokensOut: 80,
    });
    expect(output.costCents).toBe(expectedCents);
    expect(record.tokensIn).toBe(200);
    expect(record.tokensOut).toBe(80);
    expect(record.costCents).toBe(expectedCents);
    expect(record.inputHash).toBe(output.inputHash);
    expect(record.outputHash).toBe(output.outputHash);
    expect(output.inputHash).toHaveLength(64);
    expect(output.outputHash).toHaveLength(64);
  });

  it('persists correlation and causation identifiers unchanged', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    const provider = createQueuedReasoningProvider([{ result: { headline: 'ok' } }]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));
    const correlationId = randomUUID();
    const causationId = randomUUID();

    const output = await activity(buildInput(campaign, { correlationId, causationId }));

    expect(output.correlationId).toBe(correlationId);
    expect(output.causationId).toBe(causationId);
    expect(store.agentInvocations[0]!.correlationId).toBe(correlationId);
    expect(store.agentInvocations[0]!.causationId).toBe(causationId);
  });

  it('redacts sensitive values out of a persisted failure before it ever reaches the database', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    const leakyProvider = {
      name: 'leaky-test-provider',
      invoke: async () => {
        throw {
          message: 'upstream rejected the request',
          apiKey: 'sk-ant-supersecretvalue1234567890',
        };
      },
    };
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, leakyProvider));

    const output = await activity(buildInput(campaign));

    expect(output.status).toBe('FAILED');
    expect(output.failure).toMatchObject({ reason: 'PROVIDER_ERROR', retryable: true });
    const persisted = JSON.stringify(store.agentInvocations[0]!.failureDetails);
    expect(persisted).not.toContain('sk-ant-supersecretvalue1234567890');
    expect(persisted).toContain('[REDACTED]');
  });

  it('never uses a real reasoning provider or requires ANTHROPIC_API_KEY (mock-only execution)', async () => {
    const store = new InMemoryAgentExecutionStore();
    const campaign = store.seedCampaign();
    const provider = createQueuedReasoningProvider([{ result: { headline: 'ok' } }]);
    const activity = createExecuteSpecialistAgentActivity(buildDeps(store, provider));

    expect(process.env.ANTHROPIC_API_KEY).toBeFalsy();
    const output = await activity(buildInput(campaign));
    expect(output.status).toBe('SUCCEEDED');
  });
});
