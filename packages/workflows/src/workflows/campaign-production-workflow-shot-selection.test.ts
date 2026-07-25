import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
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
  input: activities.AdvanceCampaignStageInput,
) => Promise<activities.AdvanceCampaignStageOutput>;
type VerifyApprovalFn = (
  input: activities.VerifyHumanApprovalInput,
) => Promise<activities.VerifyHumanApprovalOutput>;
type VerifySelectionFn = (
  input: activities.VerifyShotSelectionInput,
) => Promise<activities.VerifyShotSelectionOutput>;

function approvedApproval(id: string) {
  return {
    found: true as const,
    matchesGate: true as const,
    approval: {
      id,
      gate: 'SHOT_SELECTION' as const,
      decision: 'APPROVED' as const,
      decidedByUserId: randomUUID(),
      decidedAt: new Date().toISOString(),
    },
  };
}

describe('campaignProductionWorkflow — SHOT_SELECTION gate (M8)', () => {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();

  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('does NOT advance past HUMAN_SHOT_SELECTION when the persisted selection set is not valid', async () => {
    const advance = vi.fn<AdvanceFn>().mockResolvedValueOnce({
      ok: false,
      reason: 'GATE_REQUIRED',
      gate: 'SHOT_SELECTION',
      targetStage: 'COMPOSITING',
    });
    const verifyHumanApprovalActivity = vi
      .fn<VerifyApprovalFn>()
      .mockResolvedValue(approvedApproval(randomUUID()));
    const verifyShotSelectionActivity = vi
      .fn<VerifySelectionFn>()
      .mockResolvedValue({ valid: false, reason: 'NO_SET', detail: 'no set' });

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      verifyHumanApprovalActivity: verifyHumanApprovalActivity as never,
      verifyShotSelectionActivity: verifyShotSelectionActivity as never,
    });

    campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-sel-1',
      initialStage: 'HUMAN_SHOT_SELECTION',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('SHOT_SELECTION'));
    fireSignal('selectShotsSignal', {
      approvalId: randomUUID(),
      workspaceId,
      campaignId,
      gate: 'SHOT_SELECTION',
      decision: 'APPROVED',
      decidedByUserId: randomUUID(),
    });

    await vi.waitFor(() => expect(verifyShotSelectionActivity).toHaveBeenCalledTimes(1));
    // The gate is NOT satisfied: no GATE_DECISION advance happened (only the
    // initial AUTO_FORWARD that opened the gate), and the run stays awaiting.
    expect(advance).toHaveBeenCalledTimes(1);
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');
    expect(runQuery('getCurrentStage')).toBe('HUMAN_SHOT_SELECTION');
  });

  it('advances to COMPOSITING when the persisted selection set is valid', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'SHOT_SELECTION',
        targetStage: 'COMPOSITING',
      })
      .mockResolvedValueOnce({ ok: true, toStage: 'COMPOSITING' })
      .mockResolvedValueOnce({ ok: false, reason: 'TERMINAL' });
    const verifyHumanApprovalActivity = vi
      .fn<VerifyApprovalFn>()
      .mockResolvedValue(approvedApproval(randomUUID()));
    const verifyShotSelectionActivity = vi
      .fn<VerifySelectionFn>()
      .mockResolvedValue({ valid: true, setId: 'set-1', version: 1 });

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      verifyHumanApprovalActivity: verifyHumanApprovalActivity as never,
      verifyShotSelectionActivity: verifyShotSelectionActivity as never,
    });
    // M9: entering COMPOSITING starts the CompositingWorkflow child, which
    // completes here so the run reaches its TERMINAL end at COMPOSITING.
    setFakeChildWorkflowImpls({
      compositingWorkflow: (async () => ({
        status: 'COMPLETED',
        roughEditSpecificationId: 're-1',
        roughEditAssetId: 'a-1',
      })) as never,
    });

    const resultPromise = campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-sel-2',
      initialStage: 'HUMAN_SHOT_SELECTION',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('SHOT_SELECTION'));
    fireSignal('selectShotsSignal', {
      approvalId: randomUUID(),
      workspaceId,
      campaignId,
      gate: 'SHOT_SELECTION',
      decision: 'APPROVED',
      decidedByUserId: randomUUID(),
    });

    const result = await resultPromise;
    // Verified twice: once at the gate, once again at COMPOSITING entry (M9 defense-in-depth).
    expect(verifyShotSelectionActivity).toHaveBeenCalledTimes(2);
    expect(result.finalStage).toBe('COMPOSITING');
  });
});
