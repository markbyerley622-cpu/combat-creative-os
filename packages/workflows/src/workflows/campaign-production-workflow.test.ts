import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
import type { GateApprovalSignalPayload } from '@combat/domain';
import {
  fireSignal,
  resetFakeWorkflowRuntime,
  runQuery,
  setFakeActivityImpls,
} from '../test-helpers/fake-temporal-workflow';

// vitest hoists vi.mock calls above every import in this file, so the static
// `campaignProductionWorkflow` import below still resolves against the fake.
vi.mock('@temporalio/workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@temporalio/workflow')>();
  const fake = await import('../test-helpers/fake-temporal-workflow');
  return {
    ...actual,
    proxyActivities: fake.fakeProxyActivities,
    setHandler: fake.fakeSetHandler,
    condition: fake.fakeCondition,
  };
});

import { campaignProductionWorkflow } from './campaign-production-workflow';

function buildSignalPayload(
  overrides: Partial<GateApprovalSignalPayload> = {},
): GateApprovalSignalPayload {
  return {
    approvalId: randomUUID(),
    workspaceId: randomUUID(),
    campaignId: randomUUID(),
    gate: 'CONCEPT',
    decision: 'APPROVED',
    decidedByUserId: randomUUID(),
    ...overrides,
  };
}

function buildRunStrategyConceptScriptActivityMock() {
  return vi
    .fn<
      (
        input: activities.RunStrategyConceptScriptInput,
      ) => Promise<activities.RunStrategyConceptScriptOutput>
    >()
    .mockResolvedValue({
      ok: true,
      strategyId: randomUUID(),
      conceptId: randomUUID(),
      scriptId: randomUUID(),
    });
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

describe('campaignProductionWorkflow (wired via fake @temporalio/workflow runtime)', () => {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();

  beforeEach(() => {
    resetFakeWorkflowRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drives AUTO_FORWARD stages, opens the CONCEPT gate, and completes once approved', async () => {
    const advanceCampaignStageActivity = vi
      .fn<
        (
          input: activities.AdvanceCampaignStageInput,
        ) => Promise<activities.AdvanceCampaignStageOutput>
      >()
      .mockResolvedValueOnce({ ok: true, toStage: 'STRATEGY_REVIEW' })
      .mockResolvedValueOnce({ ok: true, toStage: 'CONCEPT_REVIEW' })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'CONCEPT',
        targetStage: 'SCRIPT_REVIEW',
      })
      .mockResolvedValueOnce({ ok: true, toStage: 'SCRIPT_REVIEW' })
      .mockResolvedValueOnce({ ok: false, reason: 'TERMINAL' });
    const verifyHumanApprovalActivity =
      vi.fn<
        (
          input: activities.VerifyHumanApprovalInput,
        ) => Promise<activities.VerifyHumanApprovalOutput>
      >();
    const runStrategyConceptScriptActivity = buildRunStrategyConceptScriptActivityMock();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advanceCampaignStageActivity as never,
      verifyHumanApprovalActivity: verifyHumanApprovalActivity as never,
      runStrategyConceptScriptActivity: runStrategyConceptScriptActivity as never,
    });

    const resultPromise = campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      initialStage: 'DRAFT',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('CONCEPT'));
    expect(runQuery('getCurrentStage')).toBe('CONCEPT_REVIEW');
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');

    const payload = buildSignalPayload({
      workspaceId,
      campaignId,
      gate: 'CONCEPT',
      decision: 'APPROVED',
    });
    verifyHumanApprovalActivity.mockResolvedValueOnce(verifiedApprovalFor(payload));
    fireSignal('approveConceptSignal', payload);

    const result = await resultPromise;

    expect(result).toEqual({
      finalStage: 'SCRIPT_REVIEW',
      status: 'COMPLETED',
      blockedReason: undefined,
    });
    expect(verifyHumanApprovalActivity).toHaveBeenCalledTimes(1);
    expect(verifyHumanApprovalActivity).toHaveBeenCalledWith({
      workspaceId,
      campaignId,
      approvalId: payload.approvalId,
      expectedGate: 'CONCEPT',
    });
    expect(advanceCampaignStageActivity).toHaveBeenCalledTimes(5);
    expect(advanceCampaignStageActivity).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ mode: 'GATE_DECISION', gate: 'CONCEPT', decision: 'APPROVED' }),
    );
    expect(runStrategyConceptScriptActivity).toHaveBeenCalledTimes(1);
    expect(runStrategyConceptScriptActivity).toHaveBeenCalledWith({
      workspaceId,
      campaignId,
      workflowRunId: 'run-1',
      revisionAttempt: 1,
    });
  });

  it('routes a CHANGES_REQUESTED CONCEPT decision back before a later approval succeeds', async () => {
    const advanceCampaignStageActivity = vi
      .fn<
        (
          input: activities.AdvanceCampaignStageInput,
        ) => Promise<activities.AdvanceCampaignStageOutput>
      >()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'CONCEPT',
        targetStage: 'SCRIPT_REVIEW',
      })
      .mockResolvedValueOnce({ ok: true, toStage: 'STRATEGY_REVIEW' }) // CHANGES_REQUESTED revision edge
      .mockResolvedValueOnce({ ok: true, toStage: 'CONCEPT_REVIEW' }) // auto-forward back to the gate
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'CONCEPT',
        targetStage: 'SCRIPT_REVIEW',
      })
      .mockResolvedValueOnce({ ok: true, toStage: 'SCRIPT_REVIEW' }) // APPROVED forward edge
      .mockResolvedValueOnce({ ok: false, reason: 'TERMINAL' });
    const verifyHumanApprovalActivity =
      vi.fn<
        (
          input: activities.VerifyHumanApprovalInput,
        ) => Promise<activities.VerifyHumanApprovalOutput>
      >();
    const runStrategyConceptScriptActivity = buildRunStrategyConceptScriptActivityMock();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advanceCampaignStageActivity as never,
      verifyHumanApprovalActivity: verifyHumanApprovalActivity as never,
      runStrategyConceptScriptActivity: runStrategyConceptScriptActivity as never,
    });

    const resultPromise = campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-2',
      initialStage: 'CONCEPT_REVIEW',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('CONCEPT'));
    const changesRequested = buildSignalPayload({
      workspaceId,
      campaignId,
      gate: 'CONCEPT',
      decision: 'CHANGES_REQUESTED',
    });
    verifyHumanApprovalActivity.mockResolvedValueOnce(verifiedApprovalFor(changesRequested));
    fireSignal('approveConceptSignal', changesRequested);

    await vi.waitFor(() => expect(runQuery<number>('getRevisionCount', 'CONCEPT')).toBe(1));
    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('CONCEPT'));

    const approved = buildSignalPayload({
      workspaceId,
      campaignId,
      gate: 'CONCEPT',
      decision: 'APPROVED',
    });
    verifyHumanApprovalActivity.mockResolvedValueOnce(verifiedApprovalFor(approved));
    fireSignal('approveConceptSignal', approved);

    const result = await resultPromise;

    expect(result.status).toBe('COMPLETED');
    expect(runQuery<number>('getRevisionCount', 'CONCEPT')).toBe(1);
    // Runs exactly once — on the revision pass through STRATEGY_REVIEW — with
    // revisionAttempt derived from the post-CHANGES_REQUESTED revision count.
    expect(runStrategyConceptScriptActivity).toHaveBeenCalledTimes(1);
    expect(runStrategyConceptScriptActivity).toHaveBeenCalledWith({
      workspaceId,
      campaignId,
      workflowRunId: 'run-2',
      revisionAttempt: 2,
    });
  });

  it('escalates to BLOCKED once a gate exceeds maxRevisionsPerGate, without attempting a further transition', async () => {
    const advanceCampaignStageActivity = vi
      .fn<
        (
          input: activities.AdvanceCampaignStageInput,
        ) => Promise<activities.AdvanceCampaignStageOutput>
      >()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'CONCEPT',
        targetStage: 'SCRIPT_REVIEW',
      })
      .mockResolvedValueOnce({ ok: true, toStage: 'STRATEGY_REVIEW' })
      .mockResolvedValueOnce({ ok: true, toStage: 'CONCEPT_REVIEW' })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'CONCEPT',
        targetStage: 'SCRIPT_REVIEW',
      });
    const verifyHumanApprovalActivity =
      vi.fn<
        (
          input: activities.VerifyHumanApprovalInput,
        ) => Promise<activities.VerifyHumanApprovalOutput>
      >();
    const runStrategyConceptScriptActivity = buildRunStrategyConceptScriptActivityMock();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advanceCampaignStageActivity as never,
      verifyHumanApprovalActivity: verifyHumanApprovalActivity as never,
      runStrategyConceptScriptActivity: runStrategyConceptScriptActivity as never,
    });

    const resultPromise = campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-3',
      initialStage: 'CONCEPT_REVIEW',
      maxRevisionsPerGate: 1,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('CONCEPT'));
    const firstRevision = buildSignalPayload({
      workspaceId,
      campaignId,
      gate: 'CONCEPT',
      decision: 'CHANGES_REQUESTED',
    });
    verifyHumanApprovalActivity.mockResolvedValueOnce(verifiedApprovalFor(firstRevision));
    fireSignal('approveConceptSignal', firstRevision);

    await vi.waitFor(() => expect(runQuery<number>('getRevisionCount', 'CONCEPT')).toBe(1));
    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('CONCEPT'));

    const secondRevision = buildSignalPayload({
      workspaceId,
      campaignId,
      gate: 'CONCEPT',
      decision: 'CHANGES_REQUESTED',
    });
    verifyHumanApprovalActivity.mockResolvedValueOnce(verifiedApprovalFor(secondRevision));
    fireSignal('approveConceptSignal', secondRevision);

    const result = await resultPromise;

    expect(result.status).toBe('BLOCKED');
    expect(result.blockedReason).toBe('Gate CONCEPT exceeded max revisions (1)');
    // The second, bound-exceeding decision must never reach a further advance call.
    expect(advanceCampaignStageActivity).toHaveBeenCalledTimes(4);
    // Runs exactly once — the single revision pass through STRATEGY_REVIEW before
    // the second CHANGES_REQUESTED decision escalates to BLOCKED without a further visit.
    expect(runStrategyConceptScriptActivity).toHaveBeenCalledTimes(1);
  });

  it('drops a signal delivered on the wrong channel rather than bypassing the pending gate', async () => {
    const advanceCampaignStageActivity = vi
      .fn<
        (
          input: activities.AdvanceCampaignStageInput,
        ) => Promise<activities.AdvanceCampaignStageOutput>
      >()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'CONCEPT',
        targetStage: 'SCRIPT_REVIEW',
      });
    const verifyHumanApprovalActivity =
      vi.fn<
        (
          input: activities.VerifyHumanApprovalInput,
        ) => Promise<activities.VerifyHumanApprovalOutput>
      >();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advanceCampaignStageActivity as never,
      verifyHumanApprovalActivity: verifyHumanApprovalActivity as never,
    });

    const resultPromise = campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-4',
      initialStage: 'CONCEPT_REVIEW',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('CONCEPT'));

    // A well-formed FINAL decision fired on the FINAL channel while CONCEPT is
    // still pending must never be allowed to skip the CONCEPT gate.
    fireSignal(
      'approveFinalSignal',
      buildSignalPayload({ workspaceId, campaignId, gate: 'FINAL', decision: 'APPROVED' }),
    );

    // Give the fake condition() loop a few microtask turns to (not) act on it.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runQuery('getPendingGate')).toBe('CONCEPT');
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');
    expect(verifyHumanApprovalActivity).not.toHaveBeenCalled();

    const approved = buildSignalPayload({
      workspaceId,
      campaignId,
      gate: 'CONCEPT',
      decision: 'APPROVED',
    });
    verifyHumanApprovalActivity.mockResolvedValueOnce(verifiedApprovalFor(approved));
    advanceCampaignStageActivity
      .mockResolvedValueOnce({ ok: true, toStage: 'SCRIPT_REVIEW' })
      .mockResolvedValueOnce({ ok: false, reason: 'TERMINAL' });
    fireSignal('approveConceptSignal', approved);

    const result = await resultPromise;
    expect(result.status).toBe('COMPLETED');
  });

  it('ignores an exact duplicate resend of an already-processed approvalId', async () => {
    const advanceCampaignStageActivity = vi
      .fn<
        (
          input: activities.AdvanceCampaignStageInput,
        ) => Promise<activities.AdvanceCampaignStageOutput>
      >()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'CONCEPT',
        targetStage: 'SCRIPT_REVIEW',
      })
      .mockResolvedValueOnce({ ok: true, toStage: 'SCRIPT_REVIEW' })
      .mockResolvedValueOnce({ ok: false, reason: 'TERMINAL' });
    const verifyHumanApprovalActivity =
      vi.fn<
        (
          input: activities.VerifyHumanApprovalInput,
        ) => Promise<activities.VerifyHumanApprovalOutput>
      >();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advanceCampaignStageActivity as never,
      verifyHumanApprovalActivity: verifyHumanApprovalActivity as never,
    });

    const resultPromise = campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-5',
      initialStage: 'CONCEPT_REVIEW',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('CONCEPT'));

    const approved = buildSignalPayload({
      workspaceId,
      campaignId,
      gate: 'CONCEPT',
      decision: 'APPROVED',
    });
    verifyHumanApprovalActivity.mockResolvedValueOnce(verifiedApprovalFor(approved));
    fireSignal('approveConceptSignal', approved);
    // An exact duplicate resend (same approvalId) queued right behind the original.
    fireSignal('approveConceptSignal', { ...approved });

    const result = await resultPromise;

    expect(result.status).toBe('COMPLETED');
    expect(verifyHumanApprovalActivity).toHaveBeenCalledTimes(1);
  });
});
