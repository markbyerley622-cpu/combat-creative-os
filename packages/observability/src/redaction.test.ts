import { PassThrough } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildRedactPaths, REDACTED_FIELD_NAMES, REDACTION_PLACEHOLDER } from './logger';

/**
 * M14 — proves the redaction configuration actually censors, rather than
 * merely being declared. `createLogger` uses a pino transport (a worker
 * thread) which cannot be captured synchronously, so these tests build a pino
 * instance with the SAME redact config against an in-memory stream. What is
 * under test is the path list and censor, which is the part that can be wrong.
 */

function captureLog(payload: Record<string, unknown>): Record<string, unknown> {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (c: Buffer) => chunks.push(c.toString()));

  const logger = pino(
    {
      redact: { paths: buildRedactPaths(), censor: REDACTION_PLACEHOLDER },
    },
    stream,
  );
  logger.info(payload, 'test');
  stream.end();

  return JSON.parse(chunks.join('')) as Record<string, unknown>;
}

describe('log redaction — credentials never reach a sink', () => {
  it.each([
    'apiKey',
    'ANTHROPIC_API_KEY',
    'secret',
    'secretAccessKey',
    'accessKeyId',
    'password',
    'token',
    'authorization',
    'privateKey',
    'DATABASE_URL',
    'MINIO_SECRET_KEY',
    'POSTGRES_PASSWORD',
  ])('censors a top-level %s', (field) => {
    const output = captureLog({ [field]: 'sk-live-super-secret-value' });

    expect(output[field]).toBe(REDACTION_PLACEHOLDER);
    expect(JSON.stringify(output)).not.toContain('sk-live-super-secret-value');
  });

  it('censors a credential nested one level deep (the `{ config }` shape)', () => {
    const output = captureLog({
      config: { endpoint: 'localhost', secretAccessKey: 'minio-real-secret' },
    });

    const config = output.config as Record<string, unknown>;
    expect(config.secretAccessKey).toBe(REDACTION_PLACEHOLDER);
    // Non-secret config stays readable — redaction must not blind operators.
    expect(config.endpoint).toBe('localhost');
    expect(JSON.stringify(output)).not.toContain('minio-real-secret');
  });

  it('censors a credential nested two levels deep (the `{ err: { config } }` shape)', () => {
    const output = captureLog({
      err: { config: { apiKey: 'sk-nested-secret' }, message: 'provider rejected' },
    });

    expect(JSON.stringify(output)).not.toContain('sk-nested-secret');
    expect(JSON.stringify(output)).toContain('provider rejected');
  });

  it('censors an entire credentials object', () => {
    const output = captureLog({ credentials: { user: 'admin', pass: 'hunter2' } });

    expect(output.credentials).toBe(REDACTION_PLACEHOLDER);
    expect(JSON.stringify(output)).not.toContain('hunter2');
  });
});

describe('log redaction — model payloads', () => {
  it('censors prompts and attachments (confidential creative material)', () => {
    const output = captureLog({
      systemPrompt: 'You are the Campaign Strategist for a confidential brand...',
      promptText: 'a boxer in a gym, brand-confidential treatment',
      attachments: [{ url: 'https://storage.example/signed?sig=abc123' }],
    });

    expect(output.systemPrompt).toBe(REDACTION_PLACEHOLDER);
    expect(output.promptText).toBe(REDACTION_PLACEHOLDER);
    expect(output.attachments).toBe(REDACTION_PLACEHOLDER);
    // No signed URL leaks through the attachment payload.
    expect(JSON.stringify(output)).not.toContain('sig=abc123');
  });
});

describe('log redaction — correlation identifiers stay readable', () => {
  it('never censors the identifiers operators need to trace a run', () => {
    const identifiers = {
      workspaceId: 'ws-1',
      campaignId: 'camp-1',
      workflowRunId: 'run-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      idempotencyKey: 'key-1',
      invocationId: 'inv-1',
      agentName: 'campaign-strategist',
      stage: 'STRATEGY_REVIEW',
    };

    const output = captureLog(identifiers);

    for (const [key, value] of Object.entries(identifiers)) {
      expect(output[key], `${key} must remain readable`).toBe(value);
    }
  });

  it('a mixed record keeps identifiers and censors only the secret', () => {
    const output = captureLog({
      workspaceId: 'ws-1',
      campaignId: 'camp-1',
      apiKey: 'sk-should-vanish',
    });

    expect(output.workspaceId).toBe('ws-1');
    expect(output.campaignId).toBe('camp-1');
    expect(output.apiKey).toBe(REDACTION_PLACEHOLDER);
  });
});

describe('log redaction — path construction', () => {
  it('covers each field at root, one and two levels deep', () => {
    const paths = buildRedactPaths(['apiKey']);

    expect(paths).toEqual(['apiKey', '*.apiKey', '*.*.apiKey']);
  });

  it('includes every declared field name', () => {
    const paths = buildRedactPaths();

    for (const field of REDACTED_FIELD_NAMES) {
      expect(paths).toContain(field);
    }
  });

  it('declares no duplicate field names', () => {
    expect(new Set(REDACTED_FIELD_NAMES).size).toBe(REDACTED_FIELD_NAMES.length);
  });
});
