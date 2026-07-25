import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
import type { ShotGenerationWorkflowOutput } from '@combat/domain';
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
type VisualFn = (
  input: activities.RunVisualQualityAssessmentsInput,
) => Promise<activities.RunVisualQualityAssessmentsOutput>;
type ContinuityFn = (
  input: activities.RunContinuityAssessmentInput,
) => Promise<activities.RunContinuityAssessmentOutput>;

const VISUAL_PASS = { ok: true, allPassed: true, anyBlocking: false, shotResults: [] } as const;
const VISUAL_FAIL = { ok: true, allPassed: false, anyBlocking: true, shotResults: [] } as const;
const CONTINUITY_PASS = { ok: true, allPassed: true, anyBlocking: false, shotResults: [] } as const;
const CONTINUITY_FAIL = { ok: true, allPassed: false, anyBlocking: true, shotResults: [] } as const;

function shotGenChild() {
  return vi.fn(async (): Promise<ShotGenerationWorkflowOutput> => ({
    status: 'COMPLETED',
    shotResults: [
      { shotSpecificationId: 'spec-1', status: 'SUCCEEDED', candidateAssetIds: ['a1'] },
    ],
  }));
}

function loadSpecsFn() {
  return vi
    .fn<
      (
        input: activities.LoadLatestShotSpecificationsInput,
      ) => Promise<activities.LoadLatestShotSpecificationsOutput>
    >()
    .mockResolvedValue({ ok: true, shotSpecificationIds: ['spec-1'] });
}

describe('campaignProductionWorkflow — VISUAL_QA/CONTINUITY_QA wiring (M7)', () => {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();

  beforeEach(() => {
    resetFakeWorkflowRuntime();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs both QA assessments and stops awaiting the SHOT_SELECTION human gate (exact M7 stopping point)', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: 'CONTINUITY_QA' }) // VISUAL_QA -> CONTINUITY_QA
      .mockResolvedValueOnce({ ok: true, toStage: 'HUMAN_SHOT_SELECTION' }) // CONTINUITY_QA -> HUMAN_SHOT_SELECTION
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'SHOT_SELECTION',
        targetStage: 'COMPOSITING',
      }) // HUMAN_SHOT_SELECTION gate opens
      .mockResolvedValueOnce({ ok: true, toStage: 'COMPOSITING' }) // gate approval advance
      .mockResolvedValueOnce({ ok: false, reason: 'TERMINAL' });
    const runVisualQualityAssessmentsActivity = vi.fn<VisualFn>().mockResolvedValue(VISUAL_PASS);
    const runContinuityAssessmentActivity = vi
      .fn<ContinuityFn>()
      .mockResolvedValue(CONTINUITY_PASS);
    const verifyHumanApprovalActivity =
      vi.fn<
        (
          input: activities.VerifyHumanApprovalInput,
        ) => Promise<activities.VerifyHumanApprovalOutput>
      >();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      verifyHumanApprovalActivity: verifyHumanApprovalActivity as never,
      runVisualQualityAssessmentsActivity: runVisualQualityAssessmentsActivity as never,
      runContinuityAssessmentActivity: runContinuityAssessmentActivity as never,
    });

    const resultPromise = campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-qa-1',
      initialStage: 'VISUAL_QA',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
    });

    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('SHOT_SELECTION'));
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');
    expect(runQuery('getCurrentStage')).toBe('HUMAN_SHOT_SELECTION');
    expect(runVisualQualityAssessmentsActivity).toHaveBeenCalledTimes(1);
    expect(runContinuityAssessmentActivity).toHaveBeenCalledTimes(1);
    // No automated retry occurred, and nothing crossed the human gate on its own.
    expect(advance.mock.calls.every((c) => c[0].mode !== 'AUTO_RETRY')).toBe(true);

    // Human approves -> the run completes (proves the gate, not an automated
    // process, is what advances past HUMAN_SHOT_SELECTION).
    const approvalId = randomUUID();
    verifyHumanApprovalActivity.mockResolvedValueOnce({
      found: true,
      matchesGate: true,
      approval: {
        id: approvalId,
        gate: 'SHOT_SELECTION',
        decision: 'APPROVED',
        decidedByUserId: randomUUID(),
        decidedAt: new Date().toISOString(),
      },
    });
    fireSignal('selectShotsSignal', {
      approvalId,
      workspaceId,
      campaignId,
      gate: 'SHOT_SELECTION',
      decision: 'APPROVED',
      decidedByUserId: randomUUID(),
    });
    const result = await resultPromise;
    expect(result.status).toBe('COMPLETED');
  });

  it('repairs a failed VISUAL_QA by AUTO_RETRY back through SHOT_GENERATION, then advances once it passes', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: 'SHOT_GENERATION' }) // AUTO_RETRY VISUAL_QA -> SHOT_GENERATION
      .mockResolvedValueOnce({ ok: true, toStage: 'VISUAL_QA' }) // SHOT_GENERATION -> VISUAL_QA
      .mockResolvedValueOnce({ ok: true, toStage: 'CONTINUITY_QA' }) // VISUAL_QA -> CONTINUITY_QA
      .mockResolvedValueOnce({ ok: true, toStage: 'HUMAN_SHOT_SELECTION' }) // CONTINUITY_QA -> HUMAN_SHOT_SELECTION
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'SHOT_SELECTION',
        targetStage: 'COMPOSITING',
      });
    const runVisualQualityAssessmentsActivity = vi
      .fn<VisualFn>()
      .mockResolvedValueOnce(VISUAL_FAIL)
      .mockResolvedValueOnce(VISUAL_PASS);
    const runContinuityAssessmentActivity = vi
      .fn<ContinuityFn>()
      .mockResolvedValue(CONTINUITY_PASS);
    const shotGenChildImpl = shotGenChild();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      loadLatestShotSpecificationsActivity: loadSpecsFn() as never,
      runVisualQualityAssessmentsActivity: runVisualQualityAssessmentsActivity as never,
      runContinuityAssessmentActivity: runContinuityAssessmentActivity as never,
    });
    setFakeChildWorkflowImpls({ shotGenerationWorkflow: shotGenChildImpl as never });

    campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-qa-2',
      initialStage: 'VISUAL_QA',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
    });

    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('SHOT_SELECTION'));
    expect(runVisualQualityAssessmentsActivity).toHaveBeenCalledTimes(2);
    expect(shotGenChildImpl).toHaveBeenCalledTimes(1);
    const autoRetry = advance.mock.calls.find((c) => c[0].mode === 'AUTO_RETRY')?.[0];
    expect(autoRetry?.fromStage).toBe('VISUAL_QA');
  });

  it('repairs a failed CONTINUITY_QA by AUTO_RETRY back through SHOT_GENERATION', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: 'CONTINUITY_QA' }) // VISUAL_QA -> CONTINUITY_QA
      .mockResolvedValueOnce({ ok: true, toStage: 'SHOT_GENERATION' }) // AUTO_RETRY CONTINUITY_QA -> SHOT_GENERATION
      .mockResolvedValueOnce({ ok: true, toStage: 'VISUAL_QA' }) // SHOT_GENERATION -> VISUAL_QA
      .mockResolvedValueOnce({ ok: true, toStage: 'CONTINUITY_QA' }) // VISUAL_QA -> CONTINUITY_QA
      .mockResolvedValueOnce({ ok: true, toStage: 'HUMAN_SHOT_SELECTION' }) // CONTINUITY_QA -> HUMAN_SHOT_SELECTION
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'SHOT_SELECTION',
        targetStage: 'COMPOSITING',
      });
    const runVisualQualityAssessmentsActivity = vi.fn<VisualFn>().mockResolvedValue(VISUAL_PASS);
    const runContinuityAssessmentActivity = vi
      .fn<ContinuityFn>()
      .mockResolvedValueOnce(CONTINUITY_FAIL)
      .mockResolvedValueOnce(CONTINUITY_PASS);
    const shotGenChildImpl = shotGenChild();

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      loadLatestShotSpecificationsActivity: loadSpecsFn() as never,
      runVisualQualityAssessmentsActivity: runVisualQualityAssessmentsActivity as never,
      runContinuityAssessmentActivity: runContinuityAssessmentActivity as never,
    });
    setFakeChildWorkflowImpls({ shotGenerationWorkflow: shotGenChildImpl as never });

    campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-qa-3',
      initialStage: 'VISUAL_QA',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
    });

    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('SHOT_SELECTION'));
    expect(runContinuityAssessmentActivity).toHaveBeenCalledTimes(2);
    const autoRetry = advance.mock.calls.find((c) => c[0].mode === 'AUTO_RETRY')?.[0];
    expect(autoRetry?.fromStage).toBe('CONTINUITY_QA');
  });

  it('escalates to BLOCKED when a failed VISUAL_QA has exhausted its bounded retries', async () => {
    const advance = vi.fn<AdvanceFn>().mockResolvedValueOnce({
      ok: false,
      reason: 'MISSING_PREREQUISITE',
      detail: 'visualQARetryAllowed is false',
    });
    const runVisualQualityAssessmentsActivity = vi.fn<VisualFn>().mockResolvedValue(VISUAL_FAIL);

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runVisualQualityAssessmentsActivity: runVisualQualityAssessmentsActivity as never,
    });

    const result = await campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-qa-4',
      initialStage: 'VISUAL_QA',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('VISUAL_QA');
    expect(result.blockedReason).toContain('Automated QA retry blocked');
    // The single advance call was the AUTO_RETRY — no forward transition happened.
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance.mock.calls[0]![0].mode).toBe('AUTO_RETRY');
  });

  it('escalates to BLOCKED (no gate reached) when the VISUAL_QA assessment Activity itself fails', async () => {
    const advance = vi.fn<AdvanceFn>();
    const runVisualQualityAssessmentsActivity = vi.fn<VisualFn>().mockResolvedValue({
      ok: false,
      reason: 'AGENT_FAILED',
      agentName: 'visual-quality-controller',
      shotId: 'shot-1',
      detail: 'schema invalid',
    });

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runVisualQualityAssessmentsActivity: runVisualQualityAssessmentsActivity as never,
    });

    const result = await campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-qa-5',
      initialStage: 'VISUAL_QA',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('VISUAL_QA');
    expect(advance).not.toHaveBeenCalled();
  });
});
