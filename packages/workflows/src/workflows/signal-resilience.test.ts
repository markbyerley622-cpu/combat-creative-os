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

/**
 * M14 — approval-signal resilience.
 *
 * Signals are the one input a workflow cannot validate at compile time: they
 * arrive from `apps/api` over the network, can be delivered more than once,
 * out of order, late, or for a gate that is no longer open. These tests drive
 * each of those shapes at the real `campaignProductionWorkflow` and assert the
 * gate stays exactly as unbypassable as it is on the happy path — a duplicate
 * or stale signal must never produce a second transition.
 */

type AdvanceFn = (
  i: activities.AdvanceCampaignStageInput,
) => Promise<activities.AdvanceCampaignStageOutput>;

const workspaceId = randomUUID();
const campaignId = randomUUID();

function run(runId: string, initialStage: 'CONCEPT_REVIEW' = 'CONCEPT_REVIEW') {
  return campaignProductionWorkflow({
    workspaceId,
    campaignId,
    workflowRunId: runId,
    initialStage,
    maxRevisionsPerGate: 3,
    videoProviderId: 'mock-video-generation',
    deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
    maxVariantRepairAttempts: 2,
  });
}

function payload(overrides: Partial<GateApprovalSignalPayload> = {}): GateApprovalSignalPayload {
  return {
    approvalId: randomUUID(),
    workspaceId,
    campaignId,
    gate: 'CONCEPT',
    decision: 'APPROVED',
    decidedByUserId: randomUUID(),
    ...overrides,
  };
}

function verified(p: GateApprovalSignalPayload) {
  return {
    found: true as const,
    matchesGate: true as const,
    approval: {
      id: p.approvalId,
      gate: p.gate,
      decision: p.decision,
      decidedByUserId: p.decidedByUserId,
      repairTarget: p.repairTarget,
      decidedAt: new Date().toISOString(),
    },
  };
}

/** A workflow parked at the CONCEPT gate, ready to receive signals. */
function gateHarness() {
  const advance = vi
    .fn<AdvanceFn>()
    .mockResolvedValueOnce({
      ok: false,
      reason: 'GATE_REQUIRED',
      gate: 'CONCEPT',
      targetStage: 'SCRIPT_REVIEW',
    })
    .mockResolvedValue({ ok: false, reason: 'TERMINAL' });
  const verify = vi.fn();
  const strategy = vi
    .fn()
    .mockResolvedValue({ ok: true, strategyId: 's', conceptId: 'c', scriptId: 'sc' });

  setFakeActivityImpls({
    advanceCampaignStageActivity: advance as never,
    verifyHumanApprovalActivity: verify as never,
    runStrategyConceptScriptActivity: strategy as never,
  });
  return { advance, verify };
}

describe('M14 — duplicate approval signals', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('the same approval delivered twice crosses the gate exactly once', async () => {
    const { advance, verify } = gateHarness();
    const resultPromise = run('dup-1');
    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('CONCEPT'));

    const p = payload();
    verify.mockResolvedValue(verified(p));
    // Two at-least-once deliveries of the identical signal.
    fireSignal('approveConceptSignal', p);
    fireSignal('approveConceptSignal', p);

    await resultPromise;

    const gateAdvances = advance.mock.calls.filter((c) => c[0].mode === 'GATE_DECISION');
    expect(gateAdvances).toHaveLength(1);
    // The duplicate was dropped before spending a verify call on it.
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('a re-delivered approval after the gate closed does not reopen it', async () => {
    const { advance, verify } = gateHarness();
    const resultPromise = run('dup-2');
    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('CONCEPT'));

    const p = payload();
    verify.mockResolvedValue(verified(p));
    fireSignal('approveConceptSignal', p);
    await resultPromise;

    const before = advance.mock.calls.length;
    // Late duplicate, long after the workflow completed its gate.
    fireSignal('approveConceptSignal', p);
    await new Promise((resolve) => setImmediate(resolve));

    expect(advance.mock.calls).toHaveLength(before);
  });
});

describe('M14 — wrong-gate and malformed signals', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('a FINAL payload delivered on the CONCEPT channel is dropped', async () => {
    const { advance, verify } = gateHarness();
    const resultPromise = run('wrong-gate-1');
    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('CONCEPT'));

    // The handler filters on payload.gate, not the channel it arrived on.
    fireSignal('approveConceptSignal', payload({ gate: 'FINAL' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(verify).not.toHaveBeenCalled();
    expect(advance.mock.calls.filter((c) => c[0].mode === 'GATE_DECISION')).toHaveLength(0);
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');

    // The correct signal still works afterwards — the bad one poisoned nothing.
    const good = payload();
    verify.mockResolvedValue(verified(good));
    fireSignal('approveConceptSignal', good);
    await resultPromise;
    expect(advance.mock.calls.filter((c) => c[0].mode === 'GATE_DECISION')).toHaveLength(1);
  });

  it('a signal for a gate that is not currently pending is dropped', async () => {
    const { advance, verify } = gateHarness();
    const resultPromise = run('wrong-gate-2');
    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('CONCEPT'));

    // SHOT_SELECTION is not the open gate.
    fireSignal('selectShotsSignal', payload({ gate: 'SHOT_SELECTION' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(verify).not.toHaveBeenCalled();
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');

    const good = payload();
    verify.mockResolvedValue(verified(good));
    fireSignal('approveConceptSignal', good);
    await resultPromise;
    expect(advance.mock.calls.filter((c) => c[0].mode === 'GATE_DECISION')).toHaveLength(1);
  });

  it('an approval the backend cannot verify never advances the stage', async () => {
    const { advance, verify } = gateHarness();
    const resultPromise = run('unverifiable');
    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('CONCEPT'));

    // The signal points at an approval row that does not exist — the classic
    // forged-signal shape. The workflow trusts the Activity, not the signal.
    const forged = payload();
    verify.mockResolvedValueOnce({ found: false, matchesGate: false, approval: null } as never);
    fireSignal('approveConceptSignal', forged);
    await new Promise((resolve) => setImmediate(resolve));

    expect(advance.mock.calls.filter((c) => c[0].mode === 'GATE_DECISION')).toHaveLength(0);
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');

    const good = payload();
    verify.mockResolvedValue(verified(good));
    fireSignal('approveConceptSignal', good);
    await resultPromise;
    expect(advance.mock.calls.filter((c) => c[0].mode === 'GATE_DECISION')).toHaveLength(1);
  });

  it('an approval whose gate does not match the pending gate is refused by the Activity', async () => {
    const { advance, verify } = gateHarness();
    const resultPromise = run('mismatched');
    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('CONCEPT'));

    const p = payload();
    // The row exists but is recorded against a different gate.
    verify.mockResolvedValueOnce({
      found: true,
      matchesGate: false,
      approval: null,
    } as never);
    fireSignal('approveConceptSignal', p);
    await new Promise((resolve) => setImmediate(resolve));

    expect(advance.mock.calls.filter((c) => c[0].mode === 'GATE_DECISION')).toHaveLength(0);

    const good = payload();
    verify.mockResolvedValue(verified(good));
    fireSignal('approveConceptSignal', good);
    await resultPromise;
    expect(advance.mock.calls.filter((c) => c[0].mode === 'GATE_DECISION')).toHaveLength(1);
  });
});

describe('M14 — out-of-order and burst delivery', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('a burst of distinct approvals crosses the gate once and ignores the rest', async () => {
    const { advance, verify } = gateHarness();
    const resultPromise = run('burst');
    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('CONCEPT'));

    const first = payload();
    verify.mockResolvedValue(verified(first));
    // Three different approval rows racing for the same open gate.
    fireSignal('approveConceptSignal', first);
    fireSignal('approveConceptSignal', payload());
    fireSignal('approveConceptSignal', payload());

    await resultPromise;

    // Exactly one transition — the gate is not a counter.
    expect(advance.mock.calls.filter((c) => c[0].mode === 'GATE_DECISION')).toHaveLength(1);
  });

  it('a signal delivered before the gate opens is queued, not lost', async () => {
    const { advance, verify } = gateHarness();
    const p = payload();
    verify.mockResolvedValue(verified(p));

    const resultPromise = run('early');
    // Fire immediately — the workflow may not have reached the gate yet.
    fireSignal('approveConceptSignal', p);

    await resultPromise;

    // The early signal was buffered and consumed once the gate opened.
    expect(advance.mock.calls.filter((c) => c[0].mode === 'GATE_DECISION')).toHaveLength(1);
  });
});
