import { describe, expect, it } from 'vitest';
import { initObservability } from './tracing';

describe('initObservability', () => {
  it('is a no-op when no OTLP endpoint is configured', async () => {
    const handle = initObservability({ serviceName: 'test-service' });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
