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
    executeChild: fake.fakeExecuteChild,
  };
});

import { variantWorkflow } from './variant-workflow';

type GeneratorFn = (
  i: activities.RunVariantGeneratorInput,
) => Promise<activities.RunVariantGeneratorOutput>;
type DispatchFn = (
  i: activities.DispatchVariantRenderInput,
) => Promise<activities.DispatchVariantRenderOutput>;
type PollFn = (i: activities.PollVariantRenderInput) => Promise<activities.PollVariantRenderOutput>;
type QaFn = (i: activities.RunVariantFinalQaInput) => Promise<activities.RunVariantFinalQaOutput>;

const workspaceId = randomUUID();
const campaignId = randomUUID();

const SPEC_15 = randomUUID();
const SPEC_10 = randomUUID();
const SPEC_6 = randomUUID();

function run(runId: string, overrides: Partial<Parameters<typeof variantWorkflow>[0]> = {}) {
  return variantWorkflow({
    workspaceId,
    campaignId,
    workflowRunId: runId,
    deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
    revisionAttempt: 1,
    motionGraphicsProviderId: 'mock-motion-graphics',
    maxAttempts: 3,
    pollIntervalMs: 1,
    ...overrides,
  });
}

function generatedThree(): activities.RunVariantGeneratorOutput {
  return {
    ok: true,
    parentMasterAssetId: 'master-1',
    deliveryProfileId: 'profile-1',
    specifications: [
      {
        variantSpecificationId: SPEC_15,
        targetDurationSeconds: 15,
        deliverySpecificationId: 'ds-1',
        version: 1,
      },
      {
        variantSpecificationId: SPEC_10,
        targetDurationSeconds: 10,
        deliverySpecificationId: 'ds-1',
        version: 1,
      },
      {
        variantSpecificationId: SPEC_6,
        targetDurationSeconds: 6,
        deliverySpecificationId: 'ds-1',
        version: 1,
      },
    ],
  };
}

/** Just the 15s specification — for the single-variant failure/retry cases. */
function generatedOne(): activities.RunVariantGeneratorOutput {
  return {
    ok: true,
    parentMasterAssetId: 'master-1',
    deliveryProfileId: 'profile-1',
    specifications: [
      {
        variantSpecificationId: SPEC_15,
        targetDurationSeconds: 15,
        deliverySpecificationId: 'ds-1',
        version: 1,
      },
    ],
  };
}

function okDispatch(attemptId: string): activities.DispatchVariantRenderOutput {
  return {
    ok: true,
    jobId: 'job-1',
    attemptId,
    providerJobId: 'provider-1',
    providerId: 'mock-motion-graphics',
  };
}

function succeededPoll(specId: string): activities.PollVariantRenderOutput {
  return {
    terminal: true,
    status: 'SUCCEEDED',
    variantAssetId: `asset-${specId}`,
    creativeVariantId: `cv-${specId}`,
  };
}

function passingQa(): activities.RunVariantFinalQaOutput {
  return {
    ok: true,
    pass: true,
    assessmentId: 'qa-1',
    creativeVariantId: 'cv-1',
    overallScore: 1,
    blockingFindingCount: 0,
  };
}

describe('variantWorkflow — happy path', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('cuts, renders and QA-passes all three durations, then reports COMPLETED', async () => {
    const generator = vi.fn<GeneratorFn>().mockResolvedValue(generatedThree());
    const dispatch = vi.fn<DispatchFn>(async (i) =>
      okDispatch(`attempt-${i.variantSpecificationId}`),
    );
    const poll = vi.fn<PollFn>(async (i) => succeededPoll(i.attemptId.replace('attempt-', '')));
    const qa = vi.fn<QaFn>().mockResolvedValue(passingQa());

    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
      pollVariantRenderActivity: poll as never,
      runVariantFinalQaActivity: qa as never,
    });

    const result = await run('run-1');

    expect(result.status).toBe('COMPLETED');
    expect(result.allVariantsPassed).toBe(true);
    expect(result.variants.map((v) => v.targetDurationSeconds)).toEqual([15, 10, 6]);
    expect(result.variants.every((v) => v.qaPassed)).toBe(true);
    // Final QA re-ran for EVERY completed variant.
    expect(qa).toHaveBeenCalledTimes(3);
    expect(qa.mock.calls.map((c) => c[0].variantSpecificationId)).toEqual([
      SPEC_15,
      SPEC_10,
      SPEC_6,
    ]);
  });

  it('exposes typed progress while running', async () => {
    const generator = vi.fn<GeneratorFn>().mockResolvedValue(generatedThree());
    const dispatch = vi.fn<DispatchFn>(async (i) =>
      okDispatch(`attempt-${i.variantSpecificationId}`),
    );
    const poll = vi.fn<PollFn>(async (i) => succeededPoll(i.attemptId.replace('attempt-', '')));
    const qa = vi.fn<QaFn>().mockResolvedValue(passingQa());

    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
      pollVariantRenderActivity: poll as never,
      runVariantFinalQaActivity: qa as never,
    });

    await run('run-progress');

    const progress = runQuery<{ phase: string; entries: unknown[] }>('getVariantProgress');
    expect(progress.entries).toHaveLength(3);
  });
});

describe('variantWorkflow — failure, retry and cancellation', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('blocks without rendering anything when a cut is illegal', async () => {
    const generator = vi.fn<GeneratorFn>().mockResolvedValue({
      ok: false,
      reason: 'INVALID_CUT',
      targetDurationSeconds: 10,
      violations: [{ code: 'CUT_SPLITS_CLIP', detail: 'frame 180 splits a shot' }],
      detail: '10s cut is illegal: CUT_SPLITS_CLIP',
    });
    const dispatch = vi.fn<DispatchFn>();

    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
    });

    const result = await run('run-invalid');

    expect(result.status).toBe('BLOCKED');
    expect(result.failureMessage).toContain('CUT_SPLITS_CLIP');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('blocks without rendering when the master did not pass Final QA', async () => {
    const generator = vi.fn<GeneratorFn>().mockResolvedValue({
      ok: false,
      reason: 'MASTER_NOT_QA_PASSED',
      detail: 'master failed Final QA',
    });
    const dispatch = vi.fn<DispatchFn>();

    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
    });

    const result = await run('run-stale');

    expect(result.status).toBe('BLOCKED');
    expect(result.failureMessage).toContain('MASTER_NOT_QA_PASSED');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('retries a retryable render failure up to maxAttempts, then gives up on that variant', async () => {
    const generator = vi.fn<GeneratorFn>().mockResolvedValue(generatedOne());
    const dispatch = vi.fn<DispatchFn>(async () => okDispatch('attempt-1'));
    const poll = vi.fn<PollFn>().mockResolvedValue({
      terminal: true,
      status: 'FAILED',
      failureReason: 'PROVIDER_ERROR',
      failureMessage: 'worker died',
    });
    const qa = vi.fn<QaFn>();

    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
      pollVariantRenderActivity: poll as never,
      runVariantFinalQaActivity: qa as never,
    });

    const result = await run('run-retry', { maxAttempts: 3 });

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('BLOCKED');
    expect(result.allVariantsPassed).toBe(false);
    // No QA runs for a variant that never rendered.
    expect(qa).not.toHaveBeenCalled();
  });

  it('never retries a non-retryable capability rejection', async () => {
    const generator = vi.fn<GeneratorFn>().mockResolvedValue(generatedOne());
    const dispatch = vi.fn<DispatchFn>().mockResolvedValue({
      ok: false,
      reason: 'UNSUPPORTED_CAPABILITY',
      detail: 'renderer cannot do 9:16',
    });

    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
    });

    const result = await run('run-capability');

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('BLOCKED');
  });

  it('stops on a budget refusal without retrying', async () => {
    const generator = vi.fn<GeneratorFn>().mockResolvedValue(generatedOne());
    const dispatch = vi.fn<DispatchFn>().mockResolvedValue({
      ok: false,
      reason: 'BUDGET_EXCEEDED',
      level: 'CAMPAIGN',
      detail: 'campaign budget exhausted',
    });

    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
    });

    const result = await run('run-budget');

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('BLOCKED');
    expect(result.variants[0]!.failureReason).toBe('BUDGET_EXCEEDED');
  });

  it('reports BLOCKED when a rendered variant fails its Final QA re-run', async () => {
    const generator = vi.fn<GeneratorFn>().mockResolvedValue(generatedOne());
    const dispatch = vi.fn<DispatchFn>(async () => okDispatch('attempt-1'));
    const poll = vi.fn<PollFn>().mockResolvedValue(succeededPoll('1'));
    const qa = vi.fn<QaFn>().mockResolvedValue({
      ok: true,
      pass: false,
      assessmentId: 'qa-1',
      creativeVariantId: 'cv-1',
      overallScore: 0,
      blockingFindingCount: 2,
    });

    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
      pollVariantRenderActivity: poll as never,
      runVariantFinalQaActivity: qa as never,
    });

    const result = await run('run-qa-fail');

    expect(qa).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('BLOCKED');
    expect(result.allVariantsPassed).toBe(false);
    expect(result.variants[0]!.qaPassed).toBe(false);
  });

  it('cancels an in-flight render on signal and stops the pipeline', async () => {
    const generator = vi.fn<GeneratorFn>().mockResolvedValue(generatedThree());
    const dispatch = vi.fn<DispatchFn>(async () => okDispatch('attempt-1'));
    let polls = 0;
    const poll = vi.fn<PollFn>(async () => {
      polls += 1;
      if (polls === 1) {
        fireSignal('cancelVariantsSignal', undefined);
        return { terminal: false, status: 'POLLING' } as const;
      }
      return succeededPoll('1');
    });
    const cancel = vi.fn().mockResolvedValue({ cancelled: true });
    const qa = vi.fn<QaFn>();

    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
      pollVariantRenderActivity: poll as never,
      cancelVariantRenderActivity: cancel as never,
      runVariantFinalQaActivity: qa as never,
    });

    const result = await run('run-cancel');

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('CANCELLED');
    expect(qa).not.toHaveBeenCalled();
  });

  it('is replay-safe: identical inputs produce identical activity calls', async () => {
    const calls: string[] = [];
    const generator = vi.fn<GeneratorFn>(async (i) => {
      calls.push(`gen:${i.revisionAttempt}`);
      return generatedOne();
    });
    const dispatch = vi.fn<DispatchFn>(async (i) => {
      calls.push(`dispatch:${i.variantSpecificationId}:${i.attemptNumber}`);
      return okDispatch('attempt-1');
    });
    const poll = vi.fn<PollFn>(async () => succeededPoll('1'));
    const qa = vi.fn<QaFn>(async (i) => {
      calls.push(`qa:${i.variantSpecificationId}:${i.revisionAttempt}`);
      return passingQa();
    });

    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
      pollVariantRenderActivity: poll as never,
      runVariantFinalQaActivity: qa as never,
    });

    await run('run-replay');
    const first = [...calls];
    calls.length = 0;
    resetFakeWorkflowRuntime();
    setFakeActivityImpls({
      runVariantGeneratorActivity: generator as never,
      dispatchVariantRenderActivity: dispatch as never,
      pollVariantRenderActivity: poll as never,
      runVariantFinalQaActivity: qa as never,
    });
    await run('run-replay');

    expect(calls).toEqual(first);
    expect(first).toEqual(['gen:1', `dispatch:${SPEC_15}:1`, `qa:${SPEC_15}:1`]);
  });
});
