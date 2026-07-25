import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
import {
  resetFakeWorkflowRuntime,
  runQuery,
  setFakeActivityImpls,
} from '../test-helpers/fake-temporal-workflow';
import {
  applyPerformanceAnalystResult,
  initialPerformanceAnalysisState,
  toOutput,
  toProgress,
} from './performance-analysis-workflow-state';

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

import { performanceAnalysisWorkflow } from './performance-analysis-workflow';
import * as workflowSignals from './campaign-production-workflow-signals';
import * as performanceSignals from './performance-analysis-workflow-signals';

type AnalystFn = (
  i: activities.RunPerformanceAnalystInput,
) => Promise<activities.RunPerformanceAnalystOutput>;

const workspaceId = randomUUID();
const campaignId = randomUUID();

function run(runId: string) {
  return performanceAnalysisWorkflow({
    workspaceId,
    campaignId,
    workflowRunId: runId,
    windowKey: '2026-W30',
    minObservations: 1,
    analysisAttempt: 1,
  });
}

function succeeded(): activities.RunPerformanceAnalystOutput {
  return {
    ok: true,
    observationsAnalyzed: 2,
    learnings: [
      {
        learningRecordId: randomUUID(),
        learningKey: 'short-hook-holds-attention',
        version: 1,
        scope: 'STRATEGY',
        confidence: 'MEDIUM',
        evidenceCount: 2,
      },
    ],
  };
}

describe('performanceAnalysisWorkflow', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('runs the analyst once and reports the persisted learnings', async () => {
    const analyst = vi.fn<AnalystFn>().mockResolvedValue(succeeded());
    setFakeActivityImpls({ runPerformanceAnalystActivity: analyst as never });

    const result = await run('perf-1');

    expect(analyst).toHaveBeenCalledTimes(1);
    expect(analyst.mock.calls[0]![0]).toMatchObject({
      workspaceId,
      campaignId,
      windowKey: '2026-W30',
      analysisAttempt: 1,
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.observationsAnalyzed).toBe(2);
    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0]).toMatchObject({ confidence: 'MEDIUM', evidenceCount: 2 });
  });

  it('SKIPS rather than failing when there is not enough completed data yet', async () => {
    const analyst = vi.fn<AnalystFn>().mockResolvedValue({
      ok: false,
      reason: 'INSUFFICIENT_OBSERVATIONS',
      observationsAvailable: 0,
      detail: 'no closed observations yet',
    });
    setFakeActivityImpls({ runPerformanceAnalystActivity: analyst as never });

    const result = await run('perf-2');

    expect(result.status).toBe('SKIPPED');
    expect(result.learnings).toHaveLength(0);
    expect(result.skippedReason).toContain('no closed observations');
  });

  it.each([
    ['CAMPAIGN_NOT_FOUND', { reason: 'CAMPAIGN_NOT_FOUND', detail: 'gone' }],
    ['AGENT_FAILED', { reason: 'AGENT_FAILED', detail: 'provider error' }],
    ['UNSUPPORTED_EVIDENCE', { reason: 'UNSUPPORTED_EVIDENCE', detail: 'cited unknown id' }],
  ])('BLOCKS on %s', async (_label, failure) => {
    const analyst = vi
      .fn<AnalystFn>()
      .mockResolvedValue({ ok: false, ...failure } as activities.RunPerformanceAnalystOutput);
    setFakeActivityImpls({ runPerformanceAnalystActivity: analyst as never });

    const result = await run('perf-3');

    expect(result.status).toBe('BLOCKED');
    expect(result.failureMessage).toContain(failure.reason);
    expect(result.learnings).toHaveLength(0);
  });

  it('exposes typed progress', async () => {
    setFakeActivityImpls({
      runPerformanceAnalystActivity: vi.fn<AnalystFn>().mockResolvedValue(succeeded()) as never,
    });

    await run('perf-4');

    expect(runQuery('getPerformanceAnalysisProgress')).toEqual({
      phase: 'DONE',
      observationsLoaded: 2,
      learningsPersisted: 1,
    });
  });

  it('is replay-safe: identical input produces identical activity calls', async () => {
    const analyst = vi.fn<AnalystFn>().mockResolvedValue(succeeded());
    setFakeActivityImpls({ runPerformanceAnalystActivity: analyst as never });

    await run('perf-5');
    const first = analyst.mock.calls.map((c) => JSON.stringify(c[0]));
    analyst.mockClear();
    resetFakeWorkflowRuntime();
    setFakeActivityImpls({ runPerformanceAnalystActivity: analyst as never });
    await run('perf-5');

    expect(analyst.mock.calls.map((c) => JSON.stringify(c[0]))).toEqual(first);
  });
});

describe('performanceAnalysisWorkflow — decoupled from campaign production', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('proxies only the analyst Activity — no stage-advance, approval or asset Activity', async () => {
    const analyst = vi.fn<AnalystFn>().mockResolvedValue(succeeded());
    const forbidden = {
      advanceCampaignStageActivity: vi.fn(),
      verifyHumanApprovalActivity: vi.fn(),
      runVariantGeneratorActivity: vi.fn(),
      dispatchVariantRenderActivity: vi.fn(),
      runFinalQaControllerActivity: vi.fn(),
      ingestAssetActivity: vi.fn(),
    };
    setFakeActivityImpls({
      runPerformanceAnalystActivity: analyst as never,
      ...(forbidden as unknown as Record<string, never>),
    });

    await run('perf-decoupled');

    expect(analyst).toHaveBeenCalledTimes(1);
    for (const [name, fn] of Object.entries(forbidden)) {
      expect(fn, `${name} must never be called by performance analysis`).not.toHaveBeenCalled();
    }
  });

  it('defines no signals at all — it cannot be told to approve or advance anything', () => {
    // The production workflow's three approval signals exist...
    expect(workflowSignals.approveConceptSignal).toBeDefined();
    expect(workflowSignals.selectShotsSignal).toBeDefined();
    expect(workflowSignals.approveFinalSignal).toBeDefined();

    // ...and this workflow's module exports exactly one thing: a query.
    expect(Object.keys(performanceSignals)).toEqual(['getPerformanceAnalysisProgressQuery']);
  });

  it('has no campaign stage, approval, asset or export field in its state or output', async () => {
    const analyst = vi.fn<AnalystFn>().mockResolvedValue(succeeded());
    setFakeActivityImpls({ runPerformanceAnalystActivity: analyst as never });

    const result = await run('perf-shape');

    const forbiddenKeys = ['stage', 'currentStage', 'approval', 'assetId', 'export', 'pendingGate'];
    const serialized = JSON.stringify(result).toLowerCase();
    for (const key of forbiddenKeys) {
      expect(serialized, `output must not carry ${key}`).not.toContain(key.toLowerCase());
    }
  });
});

describe('performance-analysis-workflow-state — pure reducer', () => {
  it('starts LOADING with nothing analyzed', () => {
    const state = initialPerformanceAnalysisState();

    expect(state).toEqual({
      phase: 'LOADING',
      status: 'RUNNING',
      observationsLoaded: 0,
      learnings: [],
    });
  });

  it('maps a successful analyst run onto COMPLETED with its learnings', () => {
    const state = applyPerformanceAnalystResult(initialPerformanceAnalysisState(), succeeded());

    expect(state.status).toBe('COMPLETED');
    expect(state.phase).toBe('DONE');
    expect(state.observationsLoaded).toBe(2);
    expect(state.learnings).toHaveLength(1);
    expect(toProgress(state)).toEqual({
      phase: 'DONE',
      observationsLoaded: 2,
      learningsPersisted: 1,
    });
  });

  it('maps insufficient data onto SKIPPED, not a failure', () => {
    const state = applyPerformanceAnalystResult(initialPerformanceAnalysisState(), {
      ok: false,
      reason: 'INSUFFICIENT_OBSERVATIONS',
      observationsAvailable: 1,
      detail: 'only 1 closed observation',
    });

    expect(state.status).toBe('SKIPPED');
    expect(state.observationsLoaded).toBe(1);
    expect(toOutput(state).failureMessage).toBeUndefined();
  });

  it('maps every other failure onto BLOCKED with an attributed reason', () => {
    const state = applyPerformanceAnalystResult(initialPerformanceAnalysisState(), {
      ok: false,
      reason: 'AGENT_FAILED',
      detail: 'provider timeout',
    });

    expect(state.status).toBe('BLOCKED');
    expect(toOutput(state)).toMatchObject({
      status: 'BLOCKED',
      failureReason: 'PERFORMANCE_ANALYSIS_FAILED',
    });
    expect(toOutput(state).failureMessage).toContain('provider timeout');
  });

  it('never leaves a RUNNING state in the output', () => {
    expect(toOutput(initialPerformanceAnalysisState()).status).toBe('BLOCKED');
  });
});
