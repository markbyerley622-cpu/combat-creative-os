import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
import type { CompositingWorkflowOutput } from '@combat/domain';
import {
  resetFakeWorkflowRuntime,
  setFakeActivityImpls,
  setFakeChildWorkflowImpls,
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

import { campaignProductionWorkflow } from './campaign-production-workflow';

type AdvanceFn = (
  i: activities.AdvanceCampaignStageInput,
) => Promise<activities.AdvanceCampaignStageOutput>;
type VerifySelectionFn = (
  i: activities.VerifyShotSelectionInput,
) => Promise<activities.VerifyShotSelectionOutput>;

const workspaceId = randomUUID();
const campaignId = randomUUID();

function run(runId: string) {
  return campaignProductionWorkflow({
    workspaceId,
    campaignId,
    workflowRunId: runId,
    initialStage: 'COMPOSITING',
    maxRevisionsPerGate: 3,
    videoProviderId: 'mock-video-generation',
  });
}

describe('campaignProductionWorkflow — COMPOSITING wiring (M9)', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('runs the CompositingWorkflow child, advances COMPOSITING -> ROUGH_CUT -> SOUND_DESIGN, and BLOCKS there (M9 stopping point)', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: 'ROUGH_CUT' }) // COMPOSITING -> ROUGH_CUT (compositingComplete)
      .mockResolvedValueOnce({ ok: true, toStage: 'SOUND_DESIGN' }) // ROUGH_CUT -> SOUND_DESIGN (roughCutAssembled)
      .mockResolvedValueOnce({
        ok: false,
        reason: 'MISSING_PREREQUISITE',
        detail: 'soundDesignComplete is false',
      });
    const verify = vi
      .fn<VerifySelectionFn>()
      .mockResolvedValue({ valid: true, setId: 'set-1', version: 1 });
    const child = vi.fn(async (): Promise<CompositingWorkflowOutput> => ({
      status: 'COMPLETED',
      roughEditSpecificationId: 're-1',
      roughEditAssetId: 'asset-1',
    }));

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      verifyShotSelectionActivity: verify as never,
    });
    setFakeChildWorkflowImpls({ compositingWorkflow: child as never });

    const result = await run('run-comp-1');
    expect(child).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('SOUND_DESIGN');
    expect(result.blockedReason).toContain('soundDesignComplete');
  });

  it('escalates to BLOCKED (no advance) when the CompositingWorkflow child ends BLOCKED', async () => {
    const advance = vi.fn<AdvanceFn>();
    const verify = vi
      .fn<VerifySelectionFn>()
      .mockResolvedValue({ valid: true, setId: 'set-1', version: 1 });
    const child = vi.fn(async (): Promise<CompositingWorkflowOutput> => ({
      status: 'BLOCKED',
      roughEditSpecificationId: 're-1',
      failureReason: 'PROVIDER_ERROR',
      failureMessage: 'render failed',
    }));
    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      verifyShotSelectionActivity: verify as never,
    });
    setFakeChildWorkflowImpls({ compositingWorkflow: child as never });

    const result = await run('run-comp-2');
    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('COMPOSITING');
    expect(advance).not.toHaveBeenCalled();
  });

  it('refuses to start compositing when the persisted selection is no longer valid (gate non-bypass)', async () => {
    const advance = vi.fn<AdvanceFn>();
    const verify = vi
      .fn<VerifySelectionFn>()
      .mockResolvedValue({ valid: false, reason: 'NOT_APPROVED', detail: 'not approved' });
    const child = vi.fn();
    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      verifyShotSelectionActivity: verify as never,
    });
    setFakeChildWorkflowImpls({ compositingWorkflow: child as never });

    const result = await run('run-comp-3');
    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('COMPOSITING');
    expect(child).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });
});
