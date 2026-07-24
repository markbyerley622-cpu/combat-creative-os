import { describe, expect, it } from 'vitest';
import { toAgentOutput } from './agent-output';
import type { AgentRun } from './agent-run';

function buildRun(overrides: Partial<AgentRun<{ ok: boolean }>> = {}): AgentRun<{ ok: boolean }> {
  return {
    invocationId: 'inv-1',
    agentName: 'test-agent',
    status: 'SUCCEEDED',
    result: { ok: true },
    reasoning: { facts: [], decisions: [], assumptions: [], recommendations: ['check X'] },
    evaluation: null,
    modelMeta: { model: 'claude-opus-4-8', promptVersion: 1, tokensIn: 10, tokensOut: 5, latencyMs: 20 },
    cost: { model: 'claude-opus-4-8', tokensIn: 10, tokensOut: 5, costMicroCents: 100, pricingKnown: true },
    failure: null,
    inputHash: 'a'.repeat(64),
    outputHash: 'b'.repeat(64),
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    ...overrides,
  };
}

describe('toAgentOutput', () => {
  it('maps a SUCCEEDED run to validationStatus VALID with the result as output', () => {
    const output = toAgentOutput(buildRun());
    expect(output).toMatchObject({
      invocationId: 'inv-1',
      output: { ok: true },
      rationale: 'check X',
      validationStatus: 'VALID',
    });
  });

  it('maps a SCHEMA_INVALID failure straight through, with a null output', () => {
    const output = toAgentOutput(
      buildRun({
        status: 'FAILED',
        result: null,
        reasoning: null,
        failure: { reason: 'SCHEMA_INVALID', retryable: false, message: 'bad shape' },
      }),
    );
    expect(output.validationStatus).toBe('SCHEMA_INVALID');
    expect(output.output).toBeNull();
  });

  it('maps any other failure reason to NEEDS_HUMAN_REVIEW', () => {
    const output = toAgentOutput(
      buildRun({
        status: 'FAILED',
        result: null,
        reasoning: null,
        failure: { reason: 'PROVIDER_ERROR', retryable: true, message: 'upstream 500' },
      }),
    );
    expect(output.validationStatus).toBe('NEEDS_HUMAN_REVIEW');
  });
});
