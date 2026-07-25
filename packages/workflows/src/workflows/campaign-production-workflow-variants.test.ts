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

const workspaceId = randomUUID();
const campaignId = randomUUID();

function run(runId: string, maxVariantRepairAttempts = 2) {
  return campaignProductionWorkflow({
    workspaceId,
    campaignId,
    workflowRunId: runId,
    initialStage: 'VARIANT_GENERATION',
    maxRevisionsPerGate: 3,
    videoProviderId: 'mock-video-generation',
    deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
    maxVariantRepairAttempts,
  });
}

function allPassed() {
  return {
    status: 'COMPLETED' as const,
    allVariantsPassed: true,
    variants: [
      { targetDurationSeconds: 15, qaPassed: true },
      { targetDurationSeconds: 10, qaPassed: true },
      { targetDurationSeconds: 6, qaPassed: true },
    ],
  };
}

function oneFailed() {
  return {
    status: 'BLOCKED' as const,
    allVariantsPassed: false,
    variants: [
      { targetDurationSeconds: 15, qaPassed: true },
      { targetDurationSeconds: 10, qaPassed: false },
      { targetDurationSeconds: 6, qaPassed: true },
    ],
    failureMessage: 'not every variant passed QA: 10s',
  };
}

describe('campaignProductionWorkflow — VARIANT_GENERATION / VARIANT_QA wiring (M12)', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('runs the variant child, advances VARIANT_GENERATION -> VARIANT_QA -> EXPORTING, and BLOCKS there (M12 stopping point)', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: 'VARIANT_QA' }) // variantsGenerated
      .mockResolvedValueOnce({ ok: true, toStage: 'EXPORTING' }) // variantQAPassed
      .mockResolvedValueOnce({
        ok: false,
        reason: 'MISSING_PREREQUISITE',
        detail: 'exportRenderComplete is false',
      });
    const child = vi.fn().mockResolvedValue(allPassed());

    setFakeActivityImpls({ advanceCampaignStageActivity: advance as never });
    setFakeChildWorkflowImpls({ variantWorkflow: child as never });

    const result = await run('run-variants-1');

    expect(child).toHaveBeenCalledTimes(1);
    expect(child.mock.calls[0]![0]).toMatchObject({
      workspaceId,
      campaignId,
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      revisionAttempt: 1,
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('EXPORTING');
    expect(result.blockedReason).toContain('exportRenderComplete');
  });

  it('routes a failing variant back to VARIANT_GENERATION via a bounded AUTO_RETRY', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: 'VARIANT_QA' })
      // VARIANT_QA forward attempt: not every variant passed.
      .mockResolvedValueOnce({
        ok: false,
        reason: 'MISSING_PREREQUISITE',
        detail: 'variantQAPassed is false',
      })
      // The repair edge back to VARIANT_GENERATION.
      .mockResolvedValueOnce({ ok: true, toStage: 'VARIANT_GENERATION' })
      // Second pass: everything passes this time.
      .mockResolvedValueOnce({ ok: true, toStage: 'VARIANT_QA' })
      .mockResolvedValueOnce({ ok: true, toStage: 'EXPORTING' })
      .mockResolvedValueOnce({ ok: false, reason: 'TERMINAL' });
    const child = vi.fn().mockResolvedValueOnce(oneFailed()).mockResolvedValueOnce(allPassed());

    setFakeActivityImpls({ advanceCampaignStageActivity: advance as never });
    setFakeChildWorkflowImpls({ variantWorkflow: child as never });

    const result = await run('run-variants-2');

    // The child re-cut on the second visit, with an incremented revisionAttempt.
    expect(child).toHaveBeenCalledTimes(2);
    expect(child.mock.calls[1]![0]).toMatchObject({ revisionAttempt: 2 });

    const retryCall = advance.mock.calls.find((c) => c[0].mode === 'AUTO_RETRY');
    expect(retryCall?.[0]).toMatchObject({ mode: 'AUTO_RETRY', fromStage: 'VARIANT_QA' });
    // A single-edge stage needs no repairTarget.
    expect((retryCall?.[0] as { repairTarget?: string }).repairTarget).toBeUndefined();
    expect(result.finalStage).toBe('EXPORTING');
  });

  it('BLOCKS once the variant repair bound is exhausted rather than looping forever', async () => {
    const advance = vi.fn<AdvanceFn>(async (i) => {
      if (i.mode === 'AUTO_RETRY') return { ok: true, toStage: 'VARIANT_GENERATION' };
      if (i.fromStage === 'VARIANT_GENERATION') return { ok: true, toStage: 'VARIANT_QA' };
      return { ok: false, reason: 'MISSING_PREREQUISITE', detail: 'variantQAPassed is false' };
    });
    const child = vi.fn().mockResolvedValue(oneFailed());

    setFakeActivityImpls({ advanceCampaignStageActivity: advance as never });
    setFakeChildWorkflowImpls({ variantWorkflow: child as never });

    const result = await run('run-variants-3', 2);

    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('VARIANT_QA');
    expect(result.blockedReason).toContain('repair bound exceeded');
    // Exactly maxVariantRepairAttempts retries were taken, then it stopped.
    expect(advance.mock.calls.filter((c) => c[0].mode === 'AUTO_RETRY')).toHaveLength(2);
    expect(child).toHaveBeenCalledTimes(3); // initial + 2 repairs
  });

  it('escalates to BLOCKED when the child produced no variants at all', async () => {
    const advance = vi.fn<AdvanceFn>();
    const child = vi.fn().mockResolvedValue({
      status: 'BLOCKED',
      allVariantsPassed: false,
      variants: [],
      failureMessage: 'Variant generation failed (MASTER_NOT_QA_PASSED): master failed Final QA',
    });

    setFakeActivityImpls({ advanceCampaignStageActivity: advance as never });
    setFakeChildWorkflowImpls({ variantWorkflow: child as never });

    const result = await run('run-variants-4');

    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('VARIANT_GENERATION');
    expect(result.blockedReason).toContain('MASTER_NOT_QA_PASSED');
    expect(advance).not.toHaveBeenCalled();
  });

  it('escalates to BLOCKED when the variant child is cancelled', async () => {
    const advance = vi.fn<AdvanceFn>();
    const child = vi.fn().mockResolvedValue({
      status: 'CANCELLED',
      allVariantsPassed: false,
      variants: [],
    });

    setFakeActivityImpls({ advanceCampaignStageActivity: advance as never });
    setFakeChildWorkflowImpls({ variantWorkflow: child as never });

    const result = await run('run-variants-5');

    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('VARIANT_GENERATION');
    expect(advance).not.toHaveBeenCalled();
  });
});

describe('campaignProductionWorkflow — the FINAL gate still guards VARIANT_GENERATION (M12)', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('never reaches VARIANT_GENERATION without a verified FINAL approval', async () => {
    const advance = vi.fn<AdvanceFn>().mockResolvedValueOnce({
      ok: false,
      reason: 'GATE_REQUIRED',
      gate: 'FINAL',
      targetStage: 'VARIANT_GENERATION',
    });
    const verify = vi.fn();
    const child = vi.fn();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      verifyHumanApprovalActivity: verify as never,
    });
    setFakeChildWorkflowImpls({ variantWorkflow: child as never });

    const resultPromise = campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-variants-gate',
      initialStage: 'FINAL_APPROVAL',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('FINAL'));

    // Spin without a signal: no variant work may begin.
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(child).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(runQuery('getCurrentStage')).toBe('FINAL_APPROVAL');

    // Release the parked workflow.
    const payload: GateApprovalSignalPayload = {
      approvalId: randomUUID(),
      workspaceId,
      campaignId,
      gate: 'FINAL',
      decision: 'APPROVED',
      decidedByUserId: randomUUID(),
    };
    verify.mockResolvedValueOnce({
      found: true,
      matchesGate: true,
      approval: {
        id: payload.approvalId,
        gate: 'FINAL',
        decision: 'APPROVED',
        decidedByUserId: payload.decidedByUserId,
        decidedAt: new Date().toISOString(),
      },
    });
    advance.mockResolvedValueOnce({ ok: false, reason: 'TERMINAL' });
    fireSignal('approveFinalSignal', payload);
    await resultPromise;
  });
});
