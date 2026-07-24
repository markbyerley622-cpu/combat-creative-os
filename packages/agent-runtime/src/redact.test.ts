import { describe, expect, it } from 'vitest';
import { redact } from './redact';

describe('redact', () => {
  it('masks values behind secret-shaped keys, case-insensitively and nested', () => {
    const result = redact({
      apiKey: 'sk-ant-abc123',
      nested: { Authorization: 'Bearer xyz', token: 't', ok: 'fine' },
    });

    expect(result).toEqual({
      apiKey: '[REDACTED]',
      nested: { Authorization: '[REDACTED]', token: '[REDACTED]', ok: 'fine' },
    });
  });

  it('masks values that look like secrets even under an innocuous key name', () => {
    const result = redact({ notes: 'sk-ant-oat01-abcdefghijklmnop' });
    expect(result).toEqual({ notes: '[REDACTED]' });
  });

  it('leaves ordinary structured data untouched', () => {
    const input = { model: 'claude-opus-4-8', tokensIn: 10, tags: ['a', 'b'], when: new Date('2026-01-01') };
    expect(redact(input)).toEqual(input);
  });

  it('redacts within arrays', () => {
    const result = redact({ items: [{ password: 'hunter2' }, { name: 'ok' }] });
    expect(result).toEqual({ items: [{ password: '[REDACTED]' }, { name: 'ok' }] });
  });
});
