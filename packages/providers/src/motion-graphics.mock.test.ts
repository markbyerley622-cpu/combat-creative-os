import { describe, expect, it } from 'vitest';
import { MockMotionGraphicsProvider } from './motion-graphics.mock';
import { MotionGraphicsProviderError, type MotionGraphicsTimeline } from './motion-graphics';
import { DEFAULT_MOTION_GRAPHICS_CAPABILITIES } from './motion-graphics-profiles';

function buildTimeline(overrides: Partial<MotionGraphicsTimeline> = {}): MotionGraphicsTimeline {
  return {
    aspectRatio: '9:16',
    outputFormat: 'mp4',
    durationFrames: 300,
    clips: [
      { order: 0, sourceRef: 'candidate-a', inFrame: 0, outFrame: 150, transitionIn: 'CUT' },
      { order: 1, sourceRef: 'candidate-b', inFrame: 0, outFrame: 150, transitionIn: 'DISSOLVE' },
    ],
    overlays: [{ kind: 'LOWER_THIRD', ref: 'overlay-1' }],
    ...overrides,
  };
}

async function submit(
  provider: MockMotionGraphicsProvider,
  key: string,
  timeline: MotionGraphicsTimeline = buildTimeline(),
) {
  const project = await provider.createProject({
    idempotencyKey: `project-${key}`,
    campaignId: 'campaign-1',
    name: 'Rough Edit',
  });
  return provider.submitRender({ idempotencyKey: key, projectId: project.projectId, timeline });
}

describe('MockMotionGraphicsProvider — idempotency', () => {
  it('createProject returns the same project for the same idempotencyKey', async () => {
    const provider = new MockMotionGraphicsProvider();
    const first = await provider.createProject({
      idempotencyKey: 'p-1',
      campaignId: 'c-1',
      name: 'Rough Edit',
    });
    const second = await provider.createProject({
      idempotencyKey: 'p-1',
      campaignId: 'c-1',
      name: 'Rough Edit',
    });
    expect(second.projectId).toBe(first.projectId);
  });

  it('submitRender returns the same render for the same idempotencyKey, not a duplicate', async () => {
    const provider = new MockMotionGraphicsProvider();
    const first = await submit(provider, 'render-1');
    const second = await submit(provider, 'render-1');
    expect(second.jobId).toBe(first.jobId);
  });

  it('two separate provider instances produce the same handles for the same input', async () => {
    const a = new MockMotionGraphicsProvider();
    const b = new MockMotionGraphicsProvider();
    const handleA = await submit(a, 'stable-render');
    const handleB = await submit(b, 'stable-render');
    expect(handleA.jobId).toBe(handleB.jobId);
  });
});

describe('MockMotionGraphicsProvider — capability rejection', () => {
  it('exposes the default capability profile', () => {
    const provider = new MockMotionGraphicsProvider();
    expect(provider.getCapabilities()).toEqual(DEFAULT_MOTION_GRAPHICS_CAPABILITIES);
  });

  it('rejects an unknown output format with UNSUPPORTED_CAPABILITY', async () => {
    const provider = new MockMotionGraphicsProvider();
    await expect(
      submit(provider, 'r', buildTimeline({ outputFormat: 'webm' })),
    ).rejects.toBeInstanceOf(MotionGraphicsProviderError);
  });

  it('rejects an unsupported aspect ratio', async () => {
    const provider = new MockMotionGraphicsProvider();
    await expect(submit(provider, 'r', buildTimeline({ aspectRatio: '2.39:1' }))).rejects.toThrow(
      /aspectRatio/,
    );
  });

  it('rejects more clips than maxClips', async () => {
    const provider = new MockMotionGraphicsProvider({
      capabilities: { ...DEFAULT_MOTION_GRAPHICS_CAPABILITIES, maxClips: 1 },
    });
    await expect(submit(provider, 'r')).rejects.toThrow(/clip count/);
  });

  it('rejects a duration beyond maxDurationFrames', async () => {
    const provider = new MockMotionGraphicsProvider();
    await expect(submit(provider, 'r', buildTimeline({ durationFrames: 999999 }))).rejects.toThrow(
      /durationFrames/,
    );
  });

  it('rejects an unsupported transition', async () => {
    const provider = new MockMotionGraphicsProvider();
    await expect(
      submit(
        provider,
        'r',
        buildTimeline({
          clips: [{ order: 0, sourceRef: 'a', inFrame: 0, outFrame: 10, transitionIn: 'MORPH' }],
        }),
      ),
    ).rejects.toThrow(/transition/);
  });

  it('sets reason UNSUPPORTED_CAPABILITY on the thrown error', async () => {
    const provider = new MockMotionGraphicsProvider();
    await expect(
      submit(provider, 'r', buildTimeline({ outputFormat: 'webm' })),
    ).rejects.toMatchObject({ reason: 'UNSUPPORTED_CAPABILITY' });
  });

  it('records no render state for a rejected request (still rejects the second time)', async () => {
    const provider = new MockMotionGraphicsProvider();
    const bad = buildTimeline({ outputFormat: 'webm' });
    await expect(submit(provider, 'r', bad)).rejects.toThrow();
    await expect(submit(provider, 'r', bad)).rejects.toThrow();
  });
});

describe('MockMotionGraphicsProvider — lifecycle, latency, failure injection', () => {
  it('reports non-terminal states over the configured poll budget before SUCCEEDED', async () => {
    const provider = new MockMotionGraphicsProvider({ pollsUntilTerminal: 2 });
    const handle = await submit(provider, 'r');
    expect(await provider.getStatus(handle)).toBe('SUBMITTED');
    expect(await provider.getStatus(handle)).toBe('POLLING');
    expect(await provider.getStatus(handle)).toBe('SUCCEEDED');
  });

  it('resolves on the first poll by default', async () => {
    const provider = new MockMotionGraphicsProvider();
    const handle = await submit(provider, 'r');
    expect(await provider.getStatus(handle)).toBe('SUCCEEDED');
    expect(await provider.getFailure(handle)).toBeNull();
  });

  it('forces a FAILED outcome for a specific idempotencyKey with a non-null failure', async () => {
    const provider = new MockMotionGraphicsProvider({
      forcedFailures: {
        'bad-render': { reason: 'PROVIDER_ERROR', message: 'aerender crashed' },
      },
    });
    const handle = await submit(provider, 'bad-render');
    expect(await provider.getStatus(handle)).toBe('FAILED');
    expect(await provider.getFailure(handle)).toEqual({
      reason: 'PROVIDER_ERROR',
      message: 'aerender crashed',
    });
  });

  it('forces a TIMED_OUT outcome distinctly from FAILED', async () => {
    const provider = new MockMotionGraphicsProvider({
      forcedFailures: {
        'slow-render': { reason: 'PROVIDER_TIMEOUT', message: 'worker did not respond' },
      },
    });
    const handle = await submit(provider, 'slow-render');
    expect(await provider.getStatus(handle)).toBe('TIMED_OUT');
    expect(await provider.getFailure(handle)).toMatchObject({ reason: 'PROVIDER_TIMEOUT' });
  });

  it('test-only forceTerminalStatus drives a submitted job to a terminal state', async () => {
    const provider = new MockMotionGraphicsProvider({ pollsUntilTerminal: 5 });
    const handle = await submit(provider, 'r');
    provider.forceTerminalStatus(handle, 'FAILED');
    expect(await provider.getStatus(handle)).toBe('FAILED');
    expect(await provider.getFailure(handle)).toMatchObject({ reason: 'PROVIDER_ERROR' });
  });

  it('cancel moves the render to CANCELLED, distinct from FAILED', async () => {
    const provider = new MockMotionGraphicsProvider();
    const handle = await submit(provider, 'r');
    await provider.cancel(handle);
    expect(await provider.getStatus(handle)).toBe('CANCELLED');
    expect((await provider.getUsage(handle)).costCents).toBe(0);
  });

  it('getStatus/getFailure/fetchRenderOutput throw for an unknown handle', async () => {
    const provider = new MockMotionGraphicsProvider();
    const bogus = { jobId: 'nope' };
    await expect(provider.getStatus(bogus)).rejects.toThrow();
    await expect(provider.getFailure(bogus)).rejects.toThrow();
    await expect(provider.fetchRenderOutput(bogus)).rejects.toThrow();
  });
});

describe('MockMotionGraphicsProvider — usage and output metadata', () => {
  it('reports deterministic cost as a pure function of durationFrames', async () => {
    const provider = new MockMotionGraphicsProvider({ costCentsPerFrame: 2 });
    const handle = await submit(provider, 'r', buildTimeline({ durationFrames: 300 }));
    const usage = await provider.getUsage(handle);
    expect(usage).toEqual({ costCents: 600, currency: 'USD', computeUnits: 300 });
  });

  it('charges nothing for a forced-failed render', async () => {
    const provider = new MockMotionGraphicsProvider({
      forcedFailures: { r: { reason: 'PROVIDER_ERROR', message: 'boom' } },
    });
    const handle = await submit(provider, 'r');
    expect((await provider.getUsage(handle)).costCents).toBe(0);
  });

  it('fetchRenderOutput returns metadata only — no binary payload, stable across calls', async () => {
    const provider = new MockMotionGraphicsProvider();
    const handle = await submit(provider, 'r', buildTimeline({ durationFrames: 300 }));
    const first = await provider.fetchRenderOutput(handle);
    const second = await provider.fetchRenderOutput(handle);
    expect(first).toEqual(second);
    expect(first.s3Key).toBe(`mock/rough-edit/${handle.jobId}.mp4`);
    expect(first.durationFrames).toBe(300);
    expect(first.format).toBe('mp4');
    expect(typeof first.checksum).toBe('string');
    expect(first).not.toHaveProperty('body');
    expect(first).not.toHaveProperty('bytes');
  });
});
