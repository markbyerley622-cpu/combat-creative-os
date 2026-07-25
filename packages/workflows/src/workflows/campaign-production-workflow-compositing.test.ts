import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
import type { CompositingWorkflowOutput } from '@combat/domain';
import {
  resetFakeWorkflowRuntime,
  runQuery,
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

  it('runs the CompositingWorkflow child, advances COMPOSITING -> ROUGH_CUT -> SOUND_DESIGN -> FINAL_QA -> the FINAL gate (M11 stopping point)', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: 'ROUGH_CUT' }) // COMPOSITING -> ROUGH_CUT (compositingComplete)
      .mockResolvedValueOnce({ ok: true, toStage: 'SOUND_DESIGN' }) // ROUGH_CUT -> SOUND_DESIGN (roughCutAssembled)
      .mockResolvedValueOnce({ ok: true, toStage: 'FINAL_QA' }) // SOUND_DESIGN -> FINAL_QA (soundDesignComplete, M10)
      .mockResolvedValueOnce({ ok: true, toStage: 'FINAL_APPROVAL' }) // FINAL_QA -> FINAL_APPROVAL (finalQAPassed, M11)
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'FINAL',
        targetStage: 'VARIANT_GENERATION',
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
      // M10: SOUND_DESIGN runs the Sound Director before its AUTO_FORWARD.
      runSoundDirectorActivity: (async () => ({
        ok: true,
        soundDesignPlanId: 'sdp-1',
        timelineId: 't-1',
        version: 1,
        cueCount: 2,
      })) as never,
      // M11: FINAL_QA runs the Final QA Controller before its AUTO_FORWARD.
      runFinalQaControllerActivity: (async () => ({
        ok: true,
        pass: true,
        assessmentId: 'qa-1',
        finalMasterAssetId: 'master-1',
        overallScore: 1,
        blockingFindingCount: 0,
      })) as never,
    });
    setFakeChildWorkflowImpls({ compositingWorkflow: child as never });

    const resultPromise = run('run-comp-1');
    // The campaign now runs the whole automated tail and parks on the FINAL
    // human gate — the M11 stopping point (no Variant Generator until M12).
    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('FINAL'));
    expect(child).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(runQuery('getCurrentStage')).toBe('FINAL_APPROVAL');
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');
    void resultPromise;
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
