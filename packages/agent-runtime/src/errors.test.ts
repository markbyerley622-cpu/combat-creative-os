import { describe, expect, it } from 'vitest';
import {
  AgentBudgetExceededError,
  AgentNotImplementedError,
  AgentProviderError,
  AgentSchemaInvalidError,
  AgentTimeoutError,
  toAgentFailure,
} from './errors';

describe('agent execution errors', () => {
  it('marks NOT_IMPLEMENTED as non-retryable', () => {
    const error = new AgentNotImplementedError('asset-manager', 'M6');
    expect(toAgentFailure(error)).toMatchObject({ reason: 'NOT_IMPLEMENTED', retryable: false });
    expect(error.message).toContain('M6');
  });

  it('marks PROVIDER_ERROR and TIMEOUT as retryable', () => {
    expect(toAgentFailure(new AgentProviderError('x', new Error('boom')))).toMatchObject({
      reason: 'PROVIDER_ERROR',
      retryable: true,
    });
    expect(toAgentFailure(new AgentTimeoutError('x', 5000))).toMatchObject({
      reason: 'TIMEOUT',
      retryable: true,
    });
  });

  it('marks SCHEMA_INVALID and BUDGET_EXCEEDED as non-retryable', () => {
    expect(toAgentFailure(new AgentSchemaInvalidError('x', []))).toMatchObject({
      reason: 'SCHEMA_INVALID',
      retryable: false,
    });
    expect(toAgentFailure(new AgentBudgetExceededError('x', {}))).toMatchObject({
      reason: 'BUDGET_EXCEEDED',
      retryable: false,
    });
  });

  it('falls back to a retryable PROVIDER_ERROR for an unknown thrown value', () => {
    expect(toAgentFailure('a bare string throw')).toMatchObject({
      reason: 'PROVIDER_ERROR',
      retryable: true,
      message: 'a bare string throw',
    });
  });
});
