import { describe, expect, it } from 'vitest';
import { MockVideoGenerationProvider } from './video-generation.mock';

describe('MockVideoGenerationProvider', () => {
  it('resubmitting the same idempotencyKey returns the same job, not a new one', async () => {
    const provider = new MockVideoGenerationProvider();
    const input = {
      idempotencyKey: 'key-1',
      shotId: 'shot-1',
      promptText: 'a fighter',
      candidateCount: 2,
    };

    const first = await provider.submit(input);
    const second = await provider.submit(input);

    expect(second.jobId).toBe(first.jobId);
  });

  it('fetchResult returns exactly candidateCount candidates', async () => {
    const provider = new MockVideoGenerationProvider();
    const handle = await provider.submit({
      idempotencyKey: 'key-2',
      shotId: 'shot-2',
      promptText: 'a boxer',
      candidateCount: 3,
    });

    const candidates = await provider.fetchResult(handle);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.candidateIndex)).toEqual([0, 1, 2]);
  });

  it('cancel moves the job to FAILED', async () => {
    const provider = new MockVideoGenerationProvider();
    const handle = await provider.submit({
      idempotencyKey: 'key-3',
      shotId: 'shot-3',
      promptText: 'a grappler',
      candidateCount: 1,
    });

    await provider.cancel(handle);
    await expect(provider.getStatus(handle)).resolves.toBe('FAILED');
  });
});
