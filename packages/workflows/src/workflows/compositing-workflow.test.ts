import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
import {
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
    executeChild: fake.fakeExecuteChild,
  };
});

import { compositingWorkflow } from './compositing-workflow';

type EditFn = (i: activities.RunEditDirectorInput) => Promise<activities.RunEditDirectorOutput>;
type DispatchFn = (
  i: activities.DispatchCompositionRenderInput,
) => Promise<activities.DispatchCompositionRenderOutput>;
type PollFn = (
  i: activities.PollCompositionRenderInput,
) => Promise<activities.PollCompositionRenderOutput>;

const INPUT = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  campaignId: '22222222-2222-2222-2222-222222222222',
  workflowRunId: 'run-1',
  shotSelectionSetId: '33333333-3333-3333-3333-333333333333',
  motionGraphicsProviderId: 'mock-motion-graphics',
  maxAttempts: 3,
  pollIntervalMs: 1,
};

describe('compositingWorkflow', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('runs Edit Director -> dispatch -> poll -> COMPLETED with the rough-edit asset', async () => {
    const runEditDirectorActivity = vi
      .fn<EditFn>()
      .mockResolvedValue({ ok: true, roughEditSpecificationId: 're-1', version: 1 });
    const dispatchCompositionRenderActivity = vi.fn<DispatchFn>().mockResolvedValue({
      ok: true,
      jobId: 'j-1',
      attemptId: 'a-1',
      providerJobId: 'p-1',
      providerId: 'mock-motion-graphics',
    });
    const pollCompositionRenderActivity = vi
      .fn<PollFn>()
      .mockResolvedValue({ terminal: true, status: 'SUCCEEDED', roughEditAssetId: 'asset-1' });

    setFakeActivityImpls({
      runEditDirectorActivity: runEditDirectorActivity as never,
      dispatchCompositionRenderActivity: dispatchCompositionRenderActivity as never,
      pollCompositionRenderActivity: pollCompositionRenderActivity as never,
    });

    const result = await compositingWorkflow(INPUT);
    expect(result.status).toBe('COMPLETED');
    expect(result.roughEditSpecificationId).toBe('re-1');
    expect(result.roughEditAssetId).toBe('asset-1');
    expect(runQuery('getCompositingProgress')).toMatchObject({
      phase: 'DONE',
      attemptStatus: 'SUCCEEDED',
    });
  });

  it('retries a poll-time failure up to maxAttempts, then succeeds', async () => {
    const dispatch = vi.fn<DispatchFn>().mockResolvedValue({
      ok: true,
      jobId: 'j',
      attemptId: 'a',
      providerJobId: 'p',
      providerId: 'mock-motion-graphics',
    });
    const poll = vi
      .fn<PollFn>()
      .mockResolvedValueOnce({
        terminal: true,
        status: 'FAILED',
        failureReason: 'PROVIDER_ERROR',
        failureMessage: 'boom',
      })
      .mockResolvedValueOnce({ terminal: true, status: 'SUCCEEDED', roughEditAssetId: 'asset-2' });

    setFakeActivityImpls({
      runEditDirectorActivity: (async () => ({
        ok: true,
        roughEditSpecificationId: 're-1',
        version: 1,
      })) as never,
      dispatchCompositionRenderActivity: dispatch as never,
      pollCompositionRenderActivity: poll as never,
    });

    const result = await compositingWorkflow(INPUT);
    expect(result.status).toBe('COMPLETED');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('BLOCKS when render attempts are exhausted', async () => {
    const poll = vi.fn<PollFn>().mockResolvedValue({
      terminal: true,
      status: 'FAILED',
      failureReason: 'PROVIDER_ERROR',
      failureMessage: 'boom',
    });
    setFakeActivityImpls({
      runEditDirectorActivity: (async () => ({
        ok: true,
        roughEditSpecificationId: 're-1',
        version: 1,
      })) as never,
      dispatchCompositionRenderActivity: (async () => ({
        ok: true,
        jobId: 'j',
        attemptId: 'a',
        providerJobId: 'p',
        providerId: 'mock-motion-graphics',
      })) as never,
      pollCompositionRenderActivity: poll as never,
    });
    const result = await compositingWorkflow(INPUT);
    expect(result.status).toBe('BLOCKED');
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('BLOCKS without dispatching when the Edit Director / selection revalidation fails', async () => {
    const dispatch = vi.fn<DispatchFn>();
    setFakeActivityImpls({
      runEditDirectorActivity: (async () => ({
        ok: false,
        reason: 'STALE_SELECTION',
        detail: 'stale',
      })) as never,
      dispatchCompositionRenderActivity: dispatch as never,
      pollCompositionRenderActivity: (async () => ({
        terminal: false,
        status: 'POLLING',
      })) as never,
    });
    const result = await compositingWorkflow(INPUT);
    expect(result.status).toBe('BLOCKED');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('BLOCKS on a terminal dispatch failure (budget/capability) with no retry', async () => {
    const dispatch = vi.fn<DispatchFn>().mockResolvedValue({
      ok: false,
      reason: 'BUDGET_EXCEEDED',
      level: 'WORKSPACE',
      detail: 'no budget',
    });
    setFakeActivityImpls({
      runEditDirectorActivity: (async () => ({
        ok: true,
        roughEditSpecificationId: 're-1',
        version: 1,
      })) as never,
      dispatchCompositionRenderActivity: dispatch as never,
      pollCompositionRenderActivity: (async () => ({
        terminal: false,
        status: 'POLLING',
      })) as never,
    });
    const result = await compositingWorkflow(INPUT);
    expect(result.status).toBe('BLOCKED');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
