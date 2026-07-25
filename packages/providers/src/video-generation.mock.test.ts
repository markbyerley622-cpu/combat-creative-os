import { describe, expect, it } from 'vitest';
import { MockVideoGenerationProvider } from './video-generation.mock';
import { VideoGenerationError, type VideoGenerationSubmitInput } from './video-generation';

function buildInput(
  overrides: Partial<VideoGenerationSubmitInput> = {},
): VideoGenerationSubmitInput {
  return {
    idempotencyKey: 'key-1',
    shotId: 'shot-1',
    mode: 'TEXT_TO_VIDEO',
    promptText: 'a fighter throws a jab in slow motion',
    candidateCount: 2,
    params: { durationSeconds: 5, aspectRatio: '9:16' },
    ...overrides,
  };
}

describe('MockVideoGenerationProvider — deterministic behavior', () => {
  it('resubmitting the same idempotencyKey returns the same job, not a new one', async () => {
    const provider = new MockVideoGenerationProvider();
    const input = buildInput();

    const first = await provider.submit(input);
    const second = await provider.submit(input);

    expect(second.jobId).toBe(first.jobId);
  });

  it('fetchResult is byte-identical across repeated calls for the same job', async () => {
    const provider = new MockVideoGenerationProvider();
    const handle = await provider.submit(buildInput({ candidateCount: 3 }));

    const first = await provider.fetchResult(handle);
    const second = await provider.fetchResult(handle);

    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(first.map((c) => c.candidateIndex)).toEqual([0, 1, 2]);
  });

  it('two separate provider instances produce the same job id and candidate refs for the same input', async () => {
    const a = new MockVideoGenerationProvider();
    const b = new MockVideoGenerationProvider();
    const input = buildInput({ idempotencyKey: 'stable-key' });

    const handleA = await a.submit(input);
    const handleB = await b.submit(input);
    expect(handleA.jobId).toBe(handleB.jobId);

    const resultA = await a.fetchResult(handleA);
    const resultB = await b.fetchResult(handleB);
    expect(resultA).toEqual(resultB);
  });

  it('reports deterministic cost as a pure function of duration and candidateCount', async () => {
    const provider = new MockVideoGenerationProvider({ costCentsPerSecond: 50 });
    const handle = await provider.submit(
      buildInput({ candidateCount: 2, params: { durationSeconds: 5, aspectRatio: '9:16' } }),
    );

    const usage = await provider.getUsage(handle);
    expect(usage).toEqual({ costCents: 500, currency: 'USD', computeUnits: 2 });
  });

  it('never returns anything resembling a real binary payload — only metadata refs', async () => {
    const provider = new MockVideoGenerationProvider();
    const handle = await provider.submit(buildInput());
    const candidates = await provider.fetchResult(handle);
    for (const candidate of candidates) {
      expect(typeof candidate.s3Key).toBe('string');
      expect(candidate).not.toHaveProperty('body');
      expect(candidate).not.toHaveProperty('bytes');
    }
  });
});

describe('MockVideoGenerationProvider — text-to-video and image-to-video', () => {
  it('accepts a TEXT_TO_VIDEO request', async () => {
    const provider = new MockVideoGenerationProvider();
    const handle = await provider.submit(buildInput({ mode: 'TEXT_TO_VIDEO' }));
    await expect(provider.getStatus(handle)).resolves.toBe('SUCCEEDED');
  });

  it('accepts an IMAGE_TO_VIDEO request with reference images', async () => {
    const provider = new MockVideoGenerationProvider();
    const handle = await provider.submit(
      buildInput({
        mode: 'IMAGE_TO_VIDEO',
        referenceImages: [{ assetId: 'asset-1' }],
      }),
    );
    await expect(provider.getStatus(handle)).resolves.toBe('SUCCEEDED');
  });

  it('accepts reference-video metadata without any binary payload', async () => {
    const provider = new MockVideoGenerationProvider();
    const handle = await provider.submit(
      buildInput({
        referenceVideo: {
          description: 'fast cuts, high contrast',
          styleNotes: 'gritty documentary feel',
        },
      }),
    );
    await expect(provider.getStatus(handle)).resolves.toBe('SUCCEEDED');
  });
});

describe('MockVideoGenerationProvider — capability rejection', () => {
  it('rejects an unsupported mode', async () => {
    const provider = new MockVideoGenerationProvider({
      capabilities: {
        supportedModes: ['TEXT_TO_VIDEO'],
        supportsReferenceImages: false,
        maxReferenceImages: 0,
        supportsReferenceVideo: false,
        supportedAspectRatios: ['9:16'],
        supportedResolutions: [],
        minDurationSeconds: 1,
        maxDurationSeconds: 10,
        supportedFrameRates: [24],
        supportsSeed: false,
        supportsNegativePrompt: false,
        maxCandidateCount: 4,
      },
    });

    await expect(provider.submit(buildInput({ mode: 'IMAGE_TO_VIDEO' }))).rejects.toThrow(
      VideoGenerationError,
    );
  });

  it('rejects an unsupported aspect ratio', async () => {
    const provider = new MockVideoGenerationProvider();
    await expect(
      provider.submit(buildInput({ params: { durationSeconds: 5, aspectRatio: '2.39:1' } })),
    ).rejects.toThrow(/aspectRatio/);
  });

  it('rejects a duration outside the supported range', async () => {
    const provider = new MockVideoGenerationProvider();
    await expect(
      provider.submit(buildInput({ params: { durationSeconds: 999, aspectRatio: '9:16' } })),
    ).rejects.toThrow(/durationSeconds/);
  });

  it('rejects a candidateCount above the provider maximum', async () => {
    const provider = new MockVideoGenerationProvider();
    await expect(provider.submit(buildInput({ candidateCount: 999 }))).rejects.toThrow(
      /candidateCount/,
    );
  });

  it('rejects too many reference images', async () => {
    const provider = new MockVideoGenerationProvider();
    await expect(
      provider.submit(
        buildInput({
          referenceImages: [{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }, { assetId: 'd' }],
        }),
      ),
    ).rejects.toThrow(/reference images/);
  });

  it('never creates a job for a rejected request (rejection happens before any state is recorded)', async () => {
    const provider = new MockVideoGenerationProvider();
    const input = buildInput({ params: { durationSeconds: 999, aspectRatio: '9:16' } });
    await expect(provider.submit(input)).rejects.toThrow();
    await expect(provider.submit(input)).rejects.toThrow(); // still rejected, not silently accepted the second time
  });
});

describe('MockVideoGenerationProvider — job lifecycle, latency, and retry testing', () => {
  it('simulates QUEUED/PROCESSING states over configured polls before a terminal state', async () => {
    const provider = new MockVideoGenerationProvider({ pollsUntilTerminal: 2 });
    const handle = await provider.submit(buildInput());

    expect(await provider.getStatus(handle)).toBe('SUBMITTED');
    expect(await provider.getStatus(handle)).toBe('POLLING');
    expect(await provider.getStatus(handle)).toBe('SUCCEEDED');
  });

  it('simulates a forced FAILED outcome for a specific idempotencyKey (failure-mode injection)', async () => {
    const provider = new MockVideoGenerationProvider({
      forcedFailures: {
        'failing-key': {
          reason: 'PROVIDER_REJECTED',
          retryable: true,
          message: 'moderation flagged',
        },
      },
    });
    const handle = await provider.submit(buildInput({ idempotencyKey: 'failing-key' }));

    expect(await provider.getStatus(handle)).toBe('FAILED');
    const failure = await provider.getFailure(handle);
    expect(failure).toEqual({
      reason: 'PROVIDER_REJECTED',
      retryable: true,
      message: 'moderation flagged',
    });
    expect(await provider.fetchResult(handle)).toEqual([]);
  });

  it('simulates a forced TIMED_OUT outcome distinctly from FAILED', async () => {
    const provider = new MockVideoGenerationProvider({
      forcedFailures: {
        'timeout-key': {
          reason: 'PROVIDER_TIMEOUT',
          retryable: true,
          message: 'provider did not respond',
        },
      },
    });
    const handle = await provider.submit(buildInput({ idempotencyKey: 'timeout-key' }));

    expect(await provider.getStatus(handle)).toBe('TIMED_OUT');
  });

  it('a retried submission (new idempotencyKey) after a forced failure succeeds independently', async () => {
    const provider = new MockVideoGenerationProvider({
      forcedFailures: {
        'attempt-1': { reason: 'PROVIDER_REJECTED', retryable: true, message: 'transient' },
      },
    });
    const failedHandle = await provider.submit(buildInput({ idempotencyKey: 'attempt-1' }));
    expect(await provider.getStatus(failedHandle)).toBe('FAILED');

    const retryHandle = await provider.submit(buildInput({ idempotencyKey: 'attempt-2' }));
    expect(await provider.getStatus(retryHandle)).toBe('SUCCEEDED');
  });

  it('cancel moves the job to CANCELLED, distinct from FAILED', async () => {
    const provider = new MockVideoGenerationProvider();
    const handle = await provider.submit(buildInput({ candidateCount: 1 }));

    await provider.cancel(handle);

    expect(await provider.getStatus(handle)).toBe('CANCELLED');
    expect(await provider.fetchResult(handle)).toEqual([]);
    expect((await provider.getUsage(handle)).costCents).toBe(0);
  });

  it('getStatus/getFailure/fetchResult all throw for an unknown job handle', async () => {
    const provider = new MockVideoGenerationProvider();
    const bogusHandle = { jobId: 'does-not-exist', shotId: 'shot-x' };
    await expect(provider.getStatus(bogusHandle)).rejects.toThrow();
    await expect(provider.getFailure(bogusHandle)).rejects.toThrow();
    await expect(provider.fetchResult(bogusHandle)).rejects.toThrow();
  });
});
