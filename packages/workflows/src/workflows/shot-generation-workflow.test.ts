import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
import {
  fireSignal,
  resetFakeWorkflowRuntime,
  runQuery,
  setFakeActivityImpls,
} from '../test-helpers/fake-temporal-workflow';

vi.mock('@temporalio/workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@temporalio/workflow')>();
  const fake = await import('../test-helpers/fake-temporal-workflow');
  return {
    ...actual,
    proxyActivities: fake.fakeProxyActivities,
    setHandler: fake.fakeSetHandler,
    condition: fake.fakeCondition,
    sleep: fake.fakeSleep,
  };
});

import { shotGenerationWorkflow } from './shot-generation-workflow';

function succeededDispatch(
  overrides: Partial<activities.DispatchShotGenerationOutput & { ok: true }> = {},
) {
  return {
    ok: true as const,
    attemptId: randomUUID(),
    providerJobId: randomUUID(),
    shotId: randomUUID(),
    providerId: 'mock-video-gen',
    ...overrides,
  };
}

describe('shotGenerationWorkflow (wired via fake @temporalio/workflow runtime)', () => {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();

  beforeEach(() => {
    resetFakeWorkflowRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches, polls to SUCCEEDED, and completes for every shot', async () => {
    const specA = randomUUID();
    const specB = randomUUID();
    const dispatchShotGenerationActivity = vi
      .fn<
        (
          input: activities.DispatchShotGenerationInput,
        ) => Promise<activities.DispatchShotGenerationOutput>
      >()
      .mockResolvedValue(succeededDispatch());
    const pollShotGenerationActivity = vi
      .fn<
        (input: activities.PollShotGenerationInput) => Promise<activities.PollShotGenerationOutput>
      >()
      .mockResolvedValue({
        terminal: true,
        status: 'SUCCEEDED',
        candidateIds: ['c1'],
        assetIds: ['a1'],
      });
    const cancelShotGenerationActivity = vi.fn();

    setFakeActivityImpls({
      dispatchShotGenerationActivity: dispatchShotGenerationActivity as never,
      pollShotGenerationActivity: pollShotGenerationActivity as never,
      cancelShotGenerationActivity: cancelShotGenerationActivity as never,
    });

    const result = await shotGenerationWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      shotSpecificationIds: [specA, specB],
      maxAttempts: 3,
      batchSize: 3,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.shotResults).toHaveLength(2);
    for (const shotResult of result.shotResults) {
      expect(shotResult.status).toBe('SUCCEEDED');
      expect(shotResult.candidateAssetIds).toEqual(['a1']);
    }
    expect(dispatchShotGenerationActivity).toHaveBeenCalledTimes(2);
    expect(cancelShotGenerationActivity).not.toHaveBeenCalled();
  });

  it('polls through non-terminal states before resolving SUCCEEDED', async () => {
    const spec = randomUUID();
    const dispatchShotGenerationActivity = vi
      .fn<
        (
          input: activities.DispatchShotGenerationInput,
        ) => Promise<activities.DispatchShotGenerationOutput>
      >()
      .mockResolvedValue(succeededDispatch());
    const pollShotGenerationActivity = vi
      .fn<
        (input: activities.PollShotGenerationInput) => Promise<activities.PollShotGenerationOutput>
      >()
      .mockResolvedValueOnce({ terminal: false, status: 'SUBMITTED' })
      .mockResolvedValueOnce({ terminal: false, status: 'POLLING' })
      .mockResolvedValueOnce({
        terminal: true,
        status: 'SUCCEEDED',
        candidateIds: ['c1'],
        assetIds: ['a1'],
      });

    setFakeActivityImpls({
      dispatchShotGenerationActivity: dispatchShotGenerationActivity as never,
      pollShotGenerationActivity: pollShotGenerationActivity as never,
      cancelShotGenerationActivity: vi.fn() as never,
    });

    const result = await shotGenerationWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-2',
      shotSpecificationIds: [spec],
      maxAttempts: 3,
      batchSize: 3,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('COMPLETED');
    expect(pollShotGenerationActivity).toHaveBeenCalledTimes(3);
  });

  it('retries a poll-time FAILED attempt up to maxAttempts, then reports RETRY_EXHAUSTED', async () => {
    const spec = randomUUID();
    const dispatchShotGenerationActivity = vi
      .fn<
        (
          input: activities.DispatchShotGenerationInput,
        ) => Promise<activities.DispatchShotGenerationOutput>
      >()
      .mockResolvedValue(succeededDispatch());
    const pollShotGenerationActivity = vi
      .fn<
        (input: activities.PollShotGenerationInput) => Promise<activities.PollShotGenerationOutput>
      >()
      .mockResolvedValue({
        terminal: true,
        status: 'FAILED',
        failureReason: 'PROVIDER_REJECTED',
        failureRetryable: true,
        failureMessage: 'rejected',
      });

    setFakeActivityImpls({
      dispatchShotGenerationActivity: dispatchShotGenerationActivity as never,
      pollShotGenerationActivity: pollShotGenerationActivity as never,
      cancelShotGenerationActivity: vi.fn() as never,
    });

    const result = await shotGenerationWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-3',
      shotSpecificationIds: [spec],
      maxAttempts: 3,
      batchSize: 3,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.shotResults[0]).toMatchObject({
      status: 'RETRY_EXHAUSTED',
      failureReason: 'PROVIDER_REJECTED',
    });
    // Bounded: exactly maxAttempts dispatch attempts, never more.
    expect(dispatchShotGenerationActivity).toHaveBeenCalledTimes(3);
    expect(dispatchShotGenerationActivity).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ attemptNumber: 1 }),
    );
    expect(dispatchShotGenerationActivity).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ attemptNumber: 3 }),
    );
  });

  it('a dispatch-time failure (e.g. UNSUPPORTED_CAPABILITY) is terminal with no retry', async () => {
    const spec = randomUUID();
    const dispatchShotGenerationActivity = vi
      .fn<
        (
          input: activities.DispatchShotGenerationInput,
        ) => Promise<activities.DispatchShotGenerationOutput>
      >()
      .mockResolvedValue({
        ok: false,
        reason: 'UNSUPPORTED_CAPABILITY',
        detail: 'aspectRatio not supported',
        attemptId: randomUUID(),
      });
    const pollShotGenerationActivity = vi.fn();

    setFakeActivityImpls({
      dispatchShotGenerationActivity: dispatchShotGenerationActivity as never,
      pollShotGenerationActivity: pollShotGenerationActivity as never,
      cancelShotGenerationActivity: vi.fn() as never,
    });

    const result = await shotGenerationWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-4',
      shotSpecificationIds: [spec],
      maxAttempts: 3,
      batchSize: 3,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.shotResults[0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'UNSUPPORTED_CAPABILITY',
    });
    expect(dispatchShotGenerationActivity).toHaveBeenCalledTimes(1);
    expect(pollShotGenerationActivity).not.toHaveBeenCalled();
  });

  it('dispatches shots in bounded batches, never exceeding batchSize concurrently in flight', async () => {
    const specs = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatchShotGenerationActivity = vi.fn(
      async (): Promise<activities.DispatchShotGenerationOutput> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return succeededDispatch();
      },
    );
    const pollShotGenerationActivity = vi
      .fn<
        (input: activities.PollShotGenerationInput) => Promise<activities.PollShotGenerationOutput>
      >()
      .mockResolvedValue({ terminal: true, status: 'SUCCEEDED', candidateIds: [], assetIds: [] });

    setFakeActivityImpls({
      dispatchShotGenerationActivity: dispatchShotGenerationActivity as never,
      pollShotGenerationActivity: pollShotGenerationActivity as never,
      cancelShotGenerationActivity: vi.fn() as never,
    });

    const result = await shotGenerationWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-5',
      shotSpecificationIds: specs,
      maxAttempts: 3,
      batchSize: 2,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('COMPLETED');
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(dispatchShotGenerationActivity).toHaveBeenCalledTimes(5);
  });

  it('cancellation mid-poll cancels the in-flight attempt and reports CANCELLED for every shot', async () => {
    const spec = randomUUID();
    const dispatchShotGenerationActivity = vi
      .fn<
        (
          input: activities.DispatchShotGenerationInput,
        ) => Promise<activities.DispatchShotGenerationOutput>
      >()
      .mockResolvedValue(succeededDispatch());
    let pollCount = 0;
    const pollShotGenerationActivity = vi.fn(
      async (): Promise<activities.PollShotGenerationOutput> => {
        pollCount += 1;
        return { terminal: false, status: 'POLLING' };
      },
    );
    const cancelShotGenerationActivity = vi
      .fn<
        (
          input: activities.CancelShotGenerationInput,
        ) => Promise<activities.CancelShotGenerationOutput>
      >()
      .mockResolvedValue({ ok: true, alreadyTerminal: false });

    setFakeActivityImpls({
      dispatchShotGenerationActivity: dispatchShotGenerationActivity as never,
      pollShotGenerationActivity: pollShotGenerationActivity as never,
      cancelShotGenerationActivity: cancelShotGenerationActivity as never,
    });

    const resultPromise = shotGenerationWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-6',
      shotSpecificationIds: [spec],
      maxAttempts: 3,
      batchSize: 3,
      pollIntervalMs: 1,
    });

    await vi.waitFor(() => expect(pollCount).toBeGreaterThan(0));
    fireSignal('cancelShotGenerationSignal', undefined);

    const result = await resultPromise;

    expect(result.status).toBe('CANCELLED');
    expect(result.shotResults[0]!.status).toBe('CANCELLED');
    expect(cancelShotGenerationActivity).toHaveBeenCalledTimes(1);
  });

  it('exposes per-shot progress via the query handler while a shot is still polling', async () => {
    const spec = randomUUID();
    const dispatchShotGenerationActivity = vi
      .fn<
        (
          input: activities.DispatchShotGenerationInput,
        ) => Promise<activities.DispatchShotGenerationOutput>
      >()
      .mockResolvedValue(succeededDispatch());
    let releasePoll: (() => void) | undefined;
    const pollShotGenerationActivity = vi.fn(
      () =>
        new Promise<activities.PollShotGenerationOutput>((resolve) => {
          releasePoll = () =>
            resolve({
              terminal: true,
              status: 'SUCCEEDED',
              candidateIds: ['c1'],
              assetIds: ['a1'],
            });
        }),
    );

    setFakeActivityImpls({
      dispatchShotGenerationActivity: dispatchShotGenerationActivity as never,
      pollShotGenerationActivity: pollShotGenerationActivity as never,
      cancelShotGenerationActivity: vi.fn() as never,
    });

    const resultPromise = shotGenerationWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-7',
      shotSpecificationIds: [spec],
      maxAttempts: 3,
      batchSize: 3,
      pollIntervalMs: 1,
    });

    await vi.waitFor(() => expect(pollShotGenerationActivity).toHaveBeenCalledTimes(1));
    const progress = runQuery<{ shots: { status: string }[] }>('getShotGenerationProgress');
    expect(progress.shots[0]!.status).toBe('POLLING');

    releasePoll!();
    await resultPromise;
  });
});
