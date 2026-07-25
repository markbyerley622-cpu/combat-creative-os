import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
import type { GateApprovalSignalPayload } from '@combat/domain';
import {
  fireSignal,
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
type FinalQaFn = (
  i: activities.RunFinalQaControllerInput,
) => Promise<activities.RunFinalQaControllerOutput>;

const workspaceId = randomUUID();
const campaignId = randomUUID();

function run(runId: string) {
  return campaignProductionWorkflow({
    workspaceId,
    campaignId,
    workflowRunId: runId,
    initialStage: 'FINAL_QA',
    maxRevisionsPerGate: 3,
    videoProviderId: 'mock-video-generation',
  });
}

function finalApprovalPayload(): GateApprovalSignalPayload {
  return {
    approvalId: randomUUID(),
    workspaceId,
    campaignId,
    gate: 'FINAL',
    decision: 'APPROVED',
    decidedByUserId: randomUUID(),
  };
}

function verifiedApprovalFor(payload: GateApprovalSignalPayload): {
  found: true;
  matchesGate: true;
  approval: activities.VerifiedHumanApproval;
} {
  return {
    found: true,
    matchesGate: true,
    approval: {
      id: payload.approvalId,
      gate: payload.gate,
      decision: payload.decision,
      decidedByUserId: payload.decidedByUserId,
      repairTarget: payload.repairTarget,
      decidedAt: new Date().toISOString(),
    },
  };
}

function passingQa(): activities.RunFinalQaControllerOutput {
  return {
    ok: true,
    pass: true,
    assessmentId: 'qa-1',
    finalMasterAssetId: 'master-1',
    overallScore: 1,
    blockingFindingCount: 0,
  };
}

describe('campaignProductionWorkflow — FINAL_QA wiring (M11)', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('runs Final QA, opens the FINAL gate, and crosses it only on a verified approval (M11 stopping point)', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      // FINAL_QA -> FINAL_APPROVAL is not gated; the FINAL gate sits on
      // FINAL_APPROVAL -> VARIANT_GENERATION.
      .mockResolvedValueOnce({ ok: true, toStage: 'FINAL_APPROVAL' })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'FINAL',
        targetStage: 'VARIANT_GENERATION',
      })
      .mockResolvedValueOnce({ ok: true, toStage: 'VARIANT_GENERATION' })
      // VARIANT_GENERATION legitimately blocks — no Variant Generator until M12.
      .mockResolvedValueOnce({
        ok: false,
        reason: 'MISSING_PREREQUISITE',
        detail: 'variantsGenerated is false',
      });
    const finalQa = vi.fn<FinalQaFn>().mockResolvedValue(passingQa());
    const verify = vi.fn();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runFinalQaControllerActivity: finalQa as never,
      verifyHumanApprovalActivity: verify as never,
    });

    const resultPromise = run('run-final-qa-1');

    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('FINAL'));
    expect(runQuery('getCurrentStage')).toBe('FINAL_APPROVAL');
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');
    // Final QA ran exactly once, at FINAL_QA — not again at FINAL_APPROVAL.
    expect(finalQa).toHaveBeenCalledTimes(1);
    expect(finalQa.mock.calls[0]![0]).toMatchObject({ workspaceId, campaignId });

    const payload = finalApprovalPayload();
    verify.mockResolvedValueOnce(verifiedApprovalFor(payload));
    fireSignal('approveFinalSignal', payload);

    const result = await resultPromise;

    expect(verify).toHaveBeenCalledWith({
      workspaceId,
      campaignId,
      approvalId: payload.approvalId,
      expectedGate: 'FINAL',
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('VARIANT_GENERATION');
    expect(result.blockedReason).toContain('variantsGenerated');
  });

  it.each([
    ['COMPOSITING'],
    ['ROUGH_CUT'],
    ['SOUND_DESIGN'],
  ] as const)('routes a failing master back to %s via a repair-targeted AUTO_RETRY', async (repairTarget) => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: repairTarget })
      // The repair stage's own forward attempt — stop the loop there.
      .mockResolvedValueOnce({
        ok: false,
        reason: 'MISSING_PREREQUISITE',
        detail: 'repair not yet complete',
      });
    const finalQa = vi.fn<FinalQaFn>().mockResolvedValue({
      ok: true,
      pass: false,
      assessmentId: 'qa-1',
      finalMasterAssetId: 'master-1',
      overallScore: 0.25,
      blockingFindingCount: 1,
      repairTarget,
    });

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runFinalQaControllerActivity: finalQa as never,
      // COMPOSITING and SOUND_DESIGN have their own stage hooks; stub them so a
      // repair landing there exercises the real re-entry rather than throwing.
      runSoundDirectorActivity: vi.fn().mockResolvedValue({
        ok: true,
        soundDesignPlanId: 'sdp-1',
        timelineId: 't-1',
        version: 1,
        cueCount: 1,
      }) as never,
      verifyShotSelectionActivity: vi
        .fn()
        .mockResolvedValue({ valid: true, setId: 'sel-1', detail: '' }) as never,
    });
    setFakeChildWorkflowImpls({
      compositingWorkflow: vi.fn().mockResolvedValue({ status: 'COMPLETED' }) as never,
    });

    const result = await run(`run-final-qa-repair-${repairTarget}`);

    const retryCall = advance.mock.calls[0]![0];
    expect(retryCall).toMatchObject({
      mode: 'AUTO_RETRY',
      fromStage: 'FINAL_QA',
      repairTarget,
    });
    expect(result.finalStage).toBe(repairTarget);
  });

  it('escalates to BLOCKED at FINAL_QA (no advance) when Final QA cannot be assessed', async () => {
    const advance = vi.fn<AdvanceFn>();
    const finalQa = vi.fn<FinalQaFn>().mockResolvedValue({
      ok: false,
      reason: 'ROUGH_CUT_ASSET_NOT_FOUND',
      detail: 'no registered ROUGH_CUT asset',
    });

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runFinalQaControllerActivity: finalQa as never,
    });

    const result = await run('run-final-qa-2');

    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('FINAL_QA');
    expect(result.blockedReason).toContain('FINAL_QA assessment failed');
    expect(advance).not.toHaveBeenCalled();
  });

  it('escalates to BLOCKED when a failing master has no routable repair target', async () => {
    const advance = vi.fn<AdvanceFn>();
    const finalQa = vi.fn<FinalQaFn>().mockResolvedValue({
      ok: false,
      reason: 'UNROUTABLE_FAILURE',
      detail: 'Final QA failed with no routable repair category (TECHNICAL)',
    });

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runFinalQaControllerActivity: finalQa as never,
    });

    const result = await run('run-final-qa-3');

    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('FINAL_QA');
    expect(result.blockedReason).toContain('UNROUTABLE_FAILURE');
    expect(advance).not.toHaveBeenCalled();
  });

  it('BLOCKS rather than advancing when the bounded repair facts refuse the retry', async () => {
    const advance = vi.fn<AdvanceFn>().mockResolvedValueOnce({
      ok: false,
      reason: 'MISSING_PREREQUISITE',
      detail: 'finalQARepairTargetIsCompositing is false',
    });
    const finalQa = vi.fn<FinalQaFn>().mockResolvedValue({
      ok: true,
      pass: false,
      assessmentId: 'qa-1',
      finalMasterAssetId: 'master-1',
      overallScore: 0,
      blockingFindingCount: 2,
      repairTarget: 'COMPOSITING',
    });

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runFinalQaControllerActivity: finalQa as never,
    });

    const result = await run('run-final-qa-4');

    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('FINAL_QA');
    expect(result.blockedReason).toContain('Automated QA retry blocked');
  });

  it('never satisfies the FINAL gate itself — a passing master parks at FINAL_APPROVAL until a human signals', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: 'FINAL_APPROVAL' })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'FINAL',
        targetStage: 'VARIANT_GENERATION',
      })
      .mockResolvedValueOnce({ ok: true, toStage: 'VARIANT_GENERATION' })
      .mockResolvedValueOnce({ ok: false, reason: 'TERMINAL' });
    const verify = vi.fn();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runFinalQaControllerActivity: vi.fn<FinalQaFn>().mockResolvedValue(passingQa()) as never,
      verifyHumanApprovalActivity: verify as never,
    });

    const resultPromise = run('run-final-qa-5');
    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('FINAL'));

    // Let the workflow spin for several turns with no signal delivered: a
    // passing Final QA must not be able to satisfy the FINAL gate on its own.
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential: each turn must complete before the next assertion
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(verify).not.toHaveBeenCalled();
    expect(advance.mock.calls.every((c) => c[0].mode !== 'GATE_DECISION')).toBe(true);
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');
    expect(runQuery('getCurrentStage')).toBe('FINAL_APPROVAL');

    // Release the parked workflow so the test does not leave a pending promise.
    const payload = finalApprovalPayload();
    verify.mockResolvedValueOnce(verifiedApprovalFor(payload));
    fireSignal('approveFinalSignal', payload);
    await resultPromise;
  });
});
