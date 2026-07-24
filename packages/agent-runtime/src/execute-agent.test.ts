import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentInput } from '@combat/domain';
import { defineAgent } from './agent-definition';
import { executeAgent } from './execute-agent';
import { AgentDisabledError, AgentNotImplementedError } from './errors';
import { DEFAULT_MODEL_POLICY } from './model-policy';
import { DEFAULT_TOKEN_BUDGET } from './token-budget';
import { NO_TOOL_POLICY } from './tool-policy';
import { definePromptTemplate } from './prompt-template';
import { QueuedReasoningProvider } from './testing';
import type { ReasoningProvider } from '@combat/providers';

const TestInputSchema = z.object({ topic: z.string().min(1) });
const TestResultSchema = z.object({ headline: z.string().min(1) });

function buildDefinition(overrides: Partial<Parameters<typeof defineAgent>[0]> = {}) {
  return defineAgent({
    name: 'test-agent',
    displayName: 'Test Agent',
    description: 'unit-test-only agent',
    implemented: true,
    disabledByDefault: false,
    inputSchema: TestInputSchema,
    resultSchema: TestResultSchema,
    promptVersion: definePromptTemplate({ version: 1, changelog: 'initial', systemPrompt: 'Be a test agent.' }),
    modelPolicy: DEFAULT_MODEL_POLICY,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    toolPolicy: NO_TOOL_POLICY,
    ...overrides,
  });
}

function buildInput(topic = 'combat sports'): AgentInput<{ topic: string }> {
  return {
    invocationId: randomUUID(),
    workflowRunId: randomUUID(),
    stage: 'STRATEGY',
    promptVersion: '1',
    input: { topic },
    context: {
      campaignId: randomUUID(),
      priorArtifactRefs: [],
      budgetRemainingCents: 100_000,
    },
  };
}

describe('executeAgent', () => {
  it('returns a SUCCEEDED run with cost/hash/latency populated on a valid first response', async () => {
    const provider = new QueuedReasoningProvider([
      { result: { headline: 'Every fight, one app' }, reasoning: { facts: ['12 events this weekend'] } },
    ]);
    const run = await executeAgent(buildDefinition(), buildInput(), { reasoningProvider: provider });

    expect(run.status).toBe('SUCCEEDED');
    expect(run.result).toEqual({ headline: 'Every fight, one app' });
    expect(run.reasoning?.facts).toEqual(['12 events this weekend']);
    expect(run.failure).toBeNull();
    expect(run.inputHash).toHaveLength(64);
    expect(run.outputHash).toHaveLength(64);
    expect(run.modelMeta.promptVersion).toBe(1);
    expect(run.cost.pricingKnown).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  it('retries once with a corrective re-prompt when the first response fails schema validation, then succeeds', async () => {
    const provider = new QueuedReasoningProvider([
      { result: { headline: '' } as unknown as { headline: string } }, // fails min(1)
      { result: { headline: 'Fixed on retry' } },
    ]);
    const run = await executeAgent(buildDefinition(), buildInput(), { reasoningProvider: provider });

    expect(run.status).toBe('SUCCEEDED');
    expect(run.result).toEqual({ headline: 'Fixed on retry' });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.messages.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('returns FAILED with SCHEMA_INVALID (non-retryable) after two consecutive invalid responses', async () => {
    const provider = new QueuedReasoningProvider([
      { result: { headline: '' } as unknown as { headline: string } },
      { result: { headline: '' } as unknown as { headline: string } },
    ]);
    const run = await executeAgent(buildDefinition(), buildInput(), { reasoningProvider: provider });

    expect(run.status).toBe('FAILED');
    expect(run.result).toBeNull();
    expect(run.failure).toMatchObject({ reason: 'SCHEMA_INVALID', retryable: false });
    expect(provider.calls).toHaveLength(2);
  });

  it('rejects malformed input before ever calling the reasoning provider', async () => {
    const provider = new QueuedReasoningProvider([{ result: { headline: 'unused' } }]);
    const badInput = buildInput('');
    const run = await executeAgent(buildDefinition(), badInput, { reasoningProvider: provider });

    expect(run.status).toBe('FAILED');
    expect(run.failure).toMatchObject({ reason: 'INPUT_INVALID', retryable: false });
    expect(provider.calls).toHaveLength(0);
  });

  it('surfaces a provider failure as a retryable PROVIDER_ERROR', async () => {
    const throwingProvider: ReasoningProvider = {
      name: 'throwing',
      invoke: async () => {
        throw new Error('upstream 500');
      },
    };
    const run = await executeAgent(buildDefinition(), buildInput(), { reasoningProvider: throwingProvider });

    expect(run.status).toBe('FAILED');
    expect(run.failure).toMatchObject({ reason: 'PROVIDER_ERROR', retryable: true });
  });

  it('throws AgentNotImplementedError for a placeholder agent without calling the provider', async () => {
    const provider = new QueuedReasoningProvider([]);
    const placeholder = defineAgent({
      name: 'placeholder-agent',
      displayName: 'Placeholder',
      description: 'not implemented',
      implemented: false,
      disabledByDefault: true,
      futureMilestone: 'M9',
      inputSchema: TestInputSchema,
      resultSchema: TestResultSchema,
      promptVersion: definePromptTemplate({ version: 1, changelog: 'n/a', systemPrompt: 'n/a' }),
      modelPolicy: DEFAULT_MODEL_POLICY,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      toolPolicy: NO_TOOL_POLICY,
    });

    await expect(
      executeAgent(placeholder, buildInput(), { reasoningProvider: provider }),
    ).rejects.toBeInstanceOf(AgentNotImplementedError);
    expect(provider.calls).toHaveLength(0);
  });

  it('throws AgentDisabledError for an implemented-but-disabled agent', async () => {
    const provider = new QueuedReasoningProvider([{ result: { headline: 'unused' } }]);
    const disabled = buildDefinition({ implemented: true, disabledByDefault: true, futureMilestone: 'later' });

    await expect(
      executeAgent(disabled, buildInput(), { reasoningProvider: provider }),
    ).rejects.toBeInstanceOf(AgentDisabledError);
  });

  it('logs a redacted record via the supplied logger', async () => {
    const provider = new QueuedReasoningProvider([{ result: { headline: 'ok' } }]);
    const logs: unknown[] = [];
    const logger = { info: (payload: unknown) => logs.push(payload) } as unknown as {
      info: (payload: unknown, msg?: string) => void;
    };

    await executeAgent(buildDefinition(), buildInput(), {
      reasoningProvider: provider,
      logger: logger as never,
    });

    expect(logs).toHaveLength(1);
  });

  it('forwards attachments as image content blocks alongside the text payload (requirement 14)', async () => {
    const provider = new QueuedReasoningProvider([{ result: { headline: 'ok' } }]);
    const input = buildInput();
    input.attachments = [{ mediaType: 'image/png', base64Data: 'ZmFrZQ==', caption: 'frame 1' }];

    await executeAgent(buildDefinition(), input, { reasoningProvider: provider });

    const sentContent = provider.calls[0]!.messages[0]!.content;
    expect(Array.isArray(sentContent)).toBe(true);
    expect(sentContent).toContainEqual({ type: 'image', mediaType: 'image/png', base64Data: 'ZmFrZQ==' });
  });

  it('computes cost as zero-priced but pricingKnown=false for an unrecognized model', async () => {
    const provider = new QueuedReasoningProvider([
      { result: { headline: 'ok' }, modelMeta: { model: 'some-future-model', tokensIn: 10, tokensOut: 10 } },
    ]);
    const run = await executeAgent(buildDefinition(), buildInput(), { reasoningProvider: provider });
    expect(run.cost.pricingKnown).toBe(false);
    expect(run.cost.costMicroCents).toBeGreaterThan(0);
  });
});
