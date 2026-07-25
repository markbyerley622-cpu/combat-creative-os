import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type * as activities from '../activities';
import {
  applyAutoForwardResult,
  applyAutoRetryResult,
  applyBoundExceeded,
  applyGateAdvanceResult,
  applyRunContinuityAssessmentResult,
  applyRunStrategyConceptScriptResult,
  applyRunVisualQualityAssessmentsResult,
  buildAutoForwardIdempotencyKey,
  buildAutoRetryIdempotencyKey,
  buildGateIdempotencyKey,
  decideGateSignal,
  decideVerifyResult,
  initialCampaignProductionState,
  type CampaignProductionWorkflowState,
} from './campaign-production-workflow-state';

function buildApproval(
  overrides: Partial<activities.VerifiedHumanApproval> = {},
): activities.VerifiedHumanApproval {
  return {
    id: randomUUID(),
    gate: 'CONCEPT',
    decision: 'APPROVED',
    decidedByUserId: randomUUID(),
    decidedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('initialCampaignProductionState', () => {
  it('starts RUNNING with no pending gate, zeroed revision counts, and no processed approvals', () => {
    const state = initialCampaignProductionState('DRAFT');
    expect(state).toEqual({
      currentStage: 'DRAFT',
      status: 'RUNNING',
      pendingGate: null,
      blockedReason: undefined,
      revisionCounts: { CONCEPT: 0, SHOT_SELECTION: 0, FINAL: 0 },
      processedApprovalIds: new Set(),
    });
  });
});

describe('applyAutoForwardResult', () => {
  const base = initialCampaignProductionState('DRAFT');

  it('advances currentStage and stays RUNNING on ok:true', () => {
    const next = applyAutoForwardResult(base, { ok: true, toStage: 'STRATEGY_REVIEW' });
    expect(next.currentStage).toBe('STRATEGY_REVIEW');
    expect(next.status).toBe('RUNNING');
  });

  it('completes the workflow on TERMINAL', () => {
    const next = applyAutoForwardResult(base, { ok: false, reason: 'TERMINAL' });
    expect(next.status).toBe('COMPLETED');
  });

  it('opens the pending gate on GATE_REQUIRED', () => {
    const next = applyAutoForwardResult(base, {
      ok: false,
      reason: 'GATE_REQUIRED',
      gate: 'CONCEPT',
      targetStage: 'SCRIPT_REVIEW',
    });
    expect(next.status).toBe('AWAITING_APPROVAL');
    expect(next.pendingGate).toBe('CONCEPT');
  });

  it('blocks with a descriptive reason on any other failure', () => {
    const next = applyAutoForwardResult(base, {
      ok: false,
      reason: 'MISSING_PREREQUISITE',
      detail: 'briefAccepted is false',
    });
    expect(next.status).toBe('BLOCKED');
    expect(next.blockedReason).toBe('MISSING_PREREQUISITE: briefAccepted is false');
  });
});

describe('applyRunStrategyConceptScriptResult', () => {
  const base = initialCampaignProductionState('STRATEGY_REVIEW');

  it('leaves state unchanged on success, so the caller proceeds to its normal auto-forward attempt', () => {
    const next = applyRunStrategyConceptScriptResult(base, {
      ok: true,
      strategyId: randomUUID(),
      conceptId: randomUUID(),
      scriptId: randomUUID(),
    });
    expect(next).toBe(base);
  });

  it('escalates to BLOCKED with the failing agent name on AGENT_FAILED', () => {
    const next = applyRunStrategyConceptScriptResult(base, {
      ok: false,
      reason: 'AGENT_FAILED',
      agentName: 'creative-director',
      detail: 'schema validation failed twice',
    });
    expect(next.status).toBe('BLOCKED');
    expect(next.blockedReason).toBe(
      'STRATEGY_REVIEW artifact generation failed (AGENT_FAILED): creative-director: schema validation failed twice',
    );
  });

  it('escalates to BLOCKED on BRIEF_NOT_FOUND', () => {
    const next = applyRunStrategyConceptScriptResult(base, {
      ok: false,
      reason: 'BRIEF_NOT_FOUND',
      detail: 'Campaign c1 has no accepted CampaignBrief',
    });
    expect(next.status).toBe('BLOCKED');
    expect(next.blockedReason).toBe(
      'STRATEGY_REVIEW artifact generation failed (BRIEF_NOT_FOUND): Campaign c1 has no accepted CampaignBrief',
    );
  });
});

describe('decideGateSignal', () => {
  function stateWithPendingGate(gate: CampaignProductionWorkflowState['pendingGate']) {
    return { ...initialCampaignProductionState('CONCEPT_REVIEW'), pendingGate: gate };
  }

  it('proposes verification for a payload matching the pending gate', () => {
    const approvalId = randomUUID();
    const decision = decideGateSignal(stateWithPendingGate('CONCEPT'), {
      approvalId,
      workspaceId: randomUUID(),
      campaignId: randomUUID(),
      gate: 'CONCEPT',
      decision: 'APPROVED',
      decidedByUserId: randomUUID(),
    });
    expect(decision).toEqual({ kind: 'VERIFY', approvalId });
  });

  it('ignores a payload for a gate other than the one currently pending', () => {
    const decision = decideGateSignal(stateWithPendingGate('CONCEPT'), {
      approvalId: randomUUID(),
      workspaceId: randomUUID(),
      campaignId: randomUUID(),
      gate: 'FINAL',
      decision: 'APPROVED',
      decidedByUserId: randomUUID(),
    });
    expect(decision).toEqual({ kind: 'IGNORE' });
  });

  it('ignores any payload when no gate is pending', () => {
    const decision = decideGateSignal(stateWithPendingGate(null), {
      approvalId: randomUUID(),
      workspaceId: randomUUID(),
      campaignId: randomUUID(),
      gate: 'CONCEPT',
      decision: 'APPROVED',
      decidedByUserId: randomUUID(),
    });
    expect(decision).toEqual({ kind: 'IGNORE' });
  });

  it('ignores a duplicate resend of an already-processed approvalId', () => {
    const approvalId = randomUUID();
    const state = {
      ...stateWithPendingGate('CONCEPT'),
      processedApprovalIds: new Set([approvalId]),
    };
    const decision = decideGateSignal(state, {
      approvalId,
      workspaceId: randomUUID(),
      campaignId: randomUUID(),
      gate: 'CONCEPT',
      decision: 'APPROVED',
      decidedByUserId: randomUUID(),
    });
    expect(decision).toEqual({ kind: 'IGNORE' });
  });
});

describe('decideVerifyResult', () => {
  const state = initialCampaignProductionState('CONCEPT_REVIEW');

  it('ignores an approval that was not found', () => {
    const outcome = decideVerifyResult(state, 'CONCEPT', 3, { found: false });
    expect(outcome).toEqual({ kind: 'IGNORE' });
  });

  it('ignores an approval found under a different gate', () => {
    const outcome = decideVerifyResult(state, 'CONCEPT', 3, { found: true, matchesGate: false });
    expect(outcome).toEqual({ kind: 'IGNORE' });
  });

  it('advances on a verified APPROVED decision', () => {
    const approval = buildApproval({ decision: 'APPROVED' });
    const outcome = decideVerifyResult(state, 'CONCEPT', 3, {
      found: true,
      matchesGate: true,
      approval,
    });
    expect(outcome).toEqual({ kind: 'ADVANCE', approval });
  });

  it('advances a revision decision while under the bound', () => {
    const approval = buildApproval({ decision: 'CHANGES_REQUESTED' });
    const outcome = decideVerifyResult(state, 'CONCEPT', 3, {
      found: true,
      matchesGate: true,
      approval,
    });
    expect(outcome).toEqual({ kind: 'ADVANCE', approval });
  });

  it('escalates to BOUND_EXCEEDED once the gate has exhausted its revision budget', () => {
    const exhausted = {
      ...state,
      revisionCounts: { ...state.revisionCounts, CONCEPT: 3 },
    };
    const approval = buildApproval({ decision: 'CHANGES_REQUESTED' });
    const outcome = decideVerifyResult(exhausted, 'CONCEPT', 3, {
      found: true,
      matchesGate: true,
      approval,
    });
    expect(outcome).toEqual({ kind: 'BOUND_EXCEEDED' });
  });
});

describe('applyBoundExceeded', () => {
  it('blocks the workflow with a gate- and bound-specific reason', () => {
    const state = initialCampaignProductionState('CONCEPT_REVIEW');
    const next = applyBoundExceeded(state, 'CONCEPT', 3);
    expect(next.status).toBe('BLOCKED');
    expect(next.blockedReason).toBe('Gate CONCEPT exceeded max revisions (3)');
  });
});

describe('applyGateAdvanceResult', () => {
  function stateAwaiting(gate: 'CONCEPT' | 'SHOT_SELECTION' | 'FINAL') {
    return {
      ...initialCampaignProductionState('CONCEPT_REVIEW'),
      status: 'AWAITING_APPROVAL' as const,
      pendingGate: gate,
    };
  }

  it('advances the stage, clears the pending gate, and does not touch revision counts on APPROVED', () => {
    const approval = buildApproval({ decision: 'APPROVED' });
    const next = applyGateAdvanceResult(stateAwaiting('CONCEPT'), 'CONCEPT', approval, {
      ok: true,
      toStage: 'SCRIPT_REVIEW',
    });
    expect(next.currentStage).toBe('SCRIPT_REVIEW');
    expect(next.status).toBe('RUNNING');
    expect(next.pendingGate).toBeNull();
    expect(next.revisionCounts.CONCEPT).toBe(0);
    expect(next.processedApprovalIds.has(approval.id)).toBe(true);
  });

  it('increments the gate revision count on a non-approved decision', () => {
    const approval = buildApproval({ decision: 'CHANGES_REQUESTED' });
    const next = applyGateAdvanceResult(stateAwaiting('CONCEPT'), 'CONCEPT', approval, {
      ok: true,
      toStage: 'STRATEGY_REVIEW',
    });
    expect(next.currentStage).toBe('STRATEGY_REVIEW');
    expect(next.status).toBe('RUNNING');
    expect(next.revisionCounts.CONCEPT).toBe(1);
  });

  it('blocks (rather than silently stalling) when the verified advance itself fails', () => {
    const approval = buildApproval({ decision: 'APPROVED' });
    const next = applyGateAdvanceResult(stateAwaiting('CONCEPT'), 'CONCEPT', approval, {
      ok: false,
      reason: 'CONCURRENT_MODIFICATION',
      detail: 'campaign was modified concurrently',
    });
    expect(next.status).toBe('BLOCKED');
    expect(next.blockedReason).toBe('CONCURRENT_MODIFICATION: campaign was modified concurrently');
    expect(next.processedApprovalIds.has(approval.id)).toBe(true);
  });
});

describe('idempotency key builders', () => {
  it('builds a distinct auto-forward key per (workflowRunId, stage, attempt)', () => {
    expect(buildAutoForwardIdempotencyKey('run-1', 'DRAFT', 1)).toBe('run-1:AUTO:DRAFT:1');
    expect(buildAutoForwardIdempotencyKey('run-1', 'DRAFT', 2)).not.toBe(
      buildAutoForwardIdempotencyKey('run-1', 'DRAFT', 1),
    );
  });

  it('builds a distinct gate key per (workflowRunId, gate, approvalId)', () => {
    const approvalId = randomUUID();
    expect(buildGateIdempotencyKey('run-1', 'CONCEPT', approvalId)).toBe(
      `run-1:GATE:CONCEPT:${approvalId}`,
    );
  });
});

describe('applyRunVisualQualityAssessmentsResult', () => {
  const base: CampaignProductionWorkflowState = {
    ...initialCampaignProductionState('VISUAL_QA'),
  };

  it('leaves state unchanged on success (routing decided by allPassed in the workflow)', () => {
    const next = applyRunVisualQualityAssessmentsResult(base, {
      ok: true,
      allPassed: true,
      anyBlocking: false,
      shotResults: [],
    });
    expect(next).toEqual(base);
  });

  it('escalates to BLOCKED on an Activity-level failure', () => {
    const next = applyRunVisualQualityAssessmentsResult(base, {
      ok: false,
      reason: 'AGENT_FAILED',
      agentName: 'visual-quality-controller',
      shotId: 'shot-1',
      detail: 'schema invalid',
    });
    expect(next.status).toBe('BLOCKED');
    expect(next.blockedReason).toContain('VISUAL_QA');
    expect(next.blockedReason).toContain('visual-quality-controller');
  });
});

describe('applyRunContinuityAssessmentResult', () => {
  const base = initialCampaignProductionState('CONTINUITY_QA');

  it('leaves state unchanged on success', () => {
    const next = applyRunContinuityAssessmentResult(base, {
      ok: true,
      allPassed: true,
      anyBlocking: false,
      shotResults: [],
    });
    expect(next).toEqual(base);
  });

  it('escalates to BLOCKED when continuity cannot run (visual QA incomplete)', () => {
    const next = applyRunContinuityAssessmentResult(base, {
      ok: false,
      reason: 'VISUAL_QA_INCOMPLETE',
      shotId: 'shot-1',
      detail: 'no passing visual assessment',
    });
    expect(next.status).toBe('BLOCKED');
    expect(next.blockedReason).toContain('CONTINUITY_QA');
  });
});

describe('applyAutoRetryResult', () => {
  const base = initialCampaignProductionState('VISUAL_QA');

  it('moves back to SHOT_GENERATION and stays RUNNING on a successful retry', () => {
    const next = applyAutoRetryResult(base, { ok: true, toStage: 'SHOT_GENERATION' });
    expect(next.currentStage).toBe('SHOT_GENERATION');
    expect(next.status).toBe('RUNNING');
  });

  it('escalates to BLOCKED when retries are exhausted (MISSING_PREREQUISITE)', () => {
    const next = applyAutoRetryResult(base, {
      ok: false,
      reason: 'MISSING_PREREQUISITE',
      detail: 'visualQARetryAllowed is false',
    });
    expect(next.status).toBe('BLOCKED');
    expect(next.blockedReason).toContain('Automated QA retry blocked');
  });

  it('escalates to BLOCKED on a budget rejection', () => {
    const next = applyAutoRetryResult(base, {
      ok: false,
      reason: 'BUDGET_EXCEEDED',
      detail: 'workspace budget exhausted',
    });
    expect(next.status).toBe('BLOCKED');
  });
});

describe('buildAutoRetryIdempotencyKey', () => {
  it('is stable and distinct per stage/attempt (replay-safe)', () => {
    expect(buildAutoRetryIdempotencyKey('run-1', 'VISUAL_QA', 2)).toBe('run-1:RETRY:VISUAL_QA:2');
    expect(buildAutoRetryIdempotencyKey('run-1', 'CONTINUITY_QA', 5)).toBe(
      'run-1:RETRY:CONTINUITY_QA:5',
    );
  });
});
