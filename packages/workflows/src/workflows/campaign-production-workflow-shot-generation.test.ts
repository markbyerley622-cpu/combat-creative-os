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

/**
 * Wiring coverage for M6's PROMPTING/SHOT_GENERATION stage hooks — proves
 * `campaignProductionWorkflow` runs the Shot Prompt Engineer at PROMPTING,
 * starts `ShotGenerationWorkflow` as a child at SHOT_GENERATION, and only
 * proceeds past either on success, exactly mirroring the STRATEGY_REVIEW
 * wiring test's structure (`campaign-production-workflow.test.ts`). Reaching
 * `HUMAN_SHOT_SELECTION` requires `advanceCampaignStageActivity` to report
 * `allShotsPassedVisualQA`/`allShotsPassedContinuityQA` true, which in the
 * real system depends on QC-agent output that doesn't exist until M7 — this
 * test mocks `advanceCampaignStageActivity`'s *results* (not the fact
 * derivation itself, which `campaign-transition-service.test.ts` already
 * covers exhaustively) purely to prove the WIRING walks through to the gate,
 * the same technique M4's tests already established for this file.
 */
describe('campaignProductionWorkflow — PROMPTING/SHOT_GENERATION wiring', () => {
  const workspaceId = randomUUID();
  const campaignId = randomUUID();

  beforeEach(() => {
    resetFakeWorkflowRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the Shot Prompt Engineer at PROMPTING, then the ShotGenerationWorkflow child at SHOT_GENERATION, before advancing to HUMAN_SHOT_SELECTION', async () => {
    const advanceCampaignStageActivity = vi
      .fn<
        (
          input: activities.AdvanceCampaignStageInput,
        ) => Promise<activities.AdvanceCampaignStageOutput>
      >()
      .mockResolvedValueOnce({ ok: true, toStage: 'SHOT_GENERATION' }) // PROMPTING -> SHOT_GENERATION
      .mockResolvedValueOnce({ ok: true, toStage: 'VISUAL_QA' }) // SHOT_GENERATION -> VISUAL_QA
      .mockResolvedValueOnce({ ok: true, toStage: 'CONTINUITY_QA' }) // VISUAL_QA -> CONTINUITY_QA
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'SHOT_SELECTION',
        targetStage: 'COMPOSITING',
      }) // CONTINUITY_QA -> HUMAN_SHOT_SELECTION gate opens
      .mockResolvedValueOnce({ ok: true, toStage: 'COMPOSITING' }) // SHOT_SELECTION GATE_DECISION advance
      .mockResolvedValueOnce({ ok: false, reason: 'TERMINAL' }); // let the run end rather than dangle
    const verifyHumanApprovalActivity =
      vi.fn<
        (
          input: activities.VerifyHumanApprovalInput,
        ) => Promise<activities.VerifyHumanApprovalOutput>
      >();
    const runShotPromptEngineerActivity = vi
      .fn<
        (
          input: activities.RunShotPromptEngineerInput,
        ) => Promise<activities.RunShotPromptEngineerOutput>
      >()
      .mockResolvedValue({ ok: true, shotSpecificationIds: ['spec-1', 'spec-2'] });
    const loadLatestShotSpecificationsActivity = vi
      .fn<
        (
          input: activities.LoadLatestShotSpecificationsInput,
        ) => Promise<activities.LoadLatestShotSpecificationsOutput>
      >()
      .mockResolvedValue({ ok: true, shotSpecificationIds: ['spec-1', 'spec-2'] });
    const shotGenerationWorkflowImpl = vi.fn(async (): Promise<ShotGenerationWorkflowOutput> => ({
      status: 'COMPLETED',
      shotResults: [
        { shotSpecificationId: 'spec-1', status: 'SUCCEEDED', candidateAssetIds: ['a1'] },
        { shotSpecificationId: 'spec-2', status: 'SUCCEEDED', candidateAssetIds: ['a2'] },
      ],
    }));

    // M7: both QC stages now run an assessment Activity before AUTO_FORWARD;
    // here every shot passes, so neither issues an AUTO_RETRY and the advance
    // sequence above is unchanged.
    const runVisualQualityAssessmentsActivity = vi
      .fn<
        (
          input: activities.RunVisualQualityAssessmentsInput,
        ) => Promise<activities.RunVisualQualityAssessmentsOutput>
      >()
      .mockResolvedValue({ ok: true, allPassed: true, anyBlocking: false, shotResults: [] });
    const runContinuityAssessmentActivity = vi
      .fn<
        (
          input: activities.RunContinuityAssessmentInput,
        ) => Promise<activities.RunContinuityAssessmentOutput>
      >()
      .mockResolvedValue({ ok: true, allPassed: true, anyBlocking: false, shotResults: [] });

    setFakeActivityImpls({
      loadShotSelectionRegenerationFeedbackActivity: (async () => ({ feedback: [] })) as never,
      verifyShotSelectionActivity: (async () => ({
        valid: true,
        setId: 'set-1',
        version: 1,
      })) as never,
      advanceCampaignStageActivity: advanceCampaignStageActivity as never,
      verifyHumanApprovalActivity: verifyHumanApprovalActivity as never,
      runShotPromptEngineerActivity: runShotPromptEngineerActivity as never,
      loadLatestShotSpecificationsActivity: loadLatestShotSpecificationsActivity as never,
      runVisualQualityAssessmentsActivity: runVisualQualityAssessmentsActivity as never,
      runContinuityAssessmentActivity: runContinuityAssessmentActivity as never,
    });
    setFakeChildWorkflowImpls({
      shotGenerationWorkflow: shotGenerationWorkflowImpl as never,
      compositingWorkflow: (async () => ({
        status: 'COMPLETED',
        roughEditSpecificationId: 're-1',
        roughEditAssetId: 'a-1',
      })) as never,
    });

    const resultPromise = campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-shotgen-1',
      initialStage: 'PROMPTING',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    await vi.waitFor(() => expect(shotGenerationWorkflowImpl).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(runQuery('getPendingGate')).toBe('SHOT_SELECTION'));

    // currentStage stays at the FROM-stage of the blocked GATE_REQUIRED
    // attempt (CONTINUITY_QA) — matches AdvanceCampaignStageOutput's
    // GATE_REQUIRED handling elsewhere in this file, which never sets
    // toStage; pendingGate is the authoritative signal that the gate opened.
    expect(runQuery('getCurrentStage')).toBe('CONTINUITY_QA');
    expect(runQuery('getStatus')).toBe('AWAITING_APPROVAL');
    expect(runShotPromptEngineerActivity).toHaveBeenCalledTimes(1);
    expect(runShotPromptEngineerActivity).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, campaignId, providerId: 'mock-video-generation' }),
    );
    expect(loadLatestShotSpecificationsActivity).toHaveBeenCalledTimes(1);
    expect(shotGenerationWorkflowImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        campaignId,
        shotSpecificationIds: ['spec-1', 'spec-2'],
      }),
    );
    // Never reaches COMPOSITING in this test, but the key invariant is that
    // advanceCampaignStageActivity was never called for SHOT_GENERATION until
    // AFTER the child workflow resolved — proven by call ordering below.
    const shotGenCallOrder = shotGenerationWorkflowImpl.mock.invocationCallOrder[0]!;
    const secondAdvanceCallOrder = advanceCampaignStageActivity.mock.invocationCallOrder[1]!;
    expect(shotGenCallOrder).toBeLessThan(secondAdvanceCallOrder);

    // Let the run resolve (rather than dangle in AWAITING_APPROVAL forever)
    // by approving the now-open SHOT_SELECTION gate.
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

  it('escalates to BLOCKED without advancing past PROMPTING when the Shot Prompt Engineer fails', async () => {
    const advanceCampaignStageActivity =
      vi.fn<
        (
          input: activities.AdvanceCampaignStageInput,
        ) => Promise<activities.AdvanceCampaignStageOutput>
      >();
    const runShotPromptEngineerActivity = vi
      .fn<
        (
          input: activities.RunShotPromptEngineerInput,
        ) => Promise<activities.RunShotPromptEngineerOutput>
      >()
      .mockResolvedValue({
        ok: false,
        reason: 'AGENT_FAILED',
        agentName: 'shot-prompt-engineer',
        shotId: 'shot-1',
        detail: 'schema invalid',
      });

    setFakeActivityImpls({
      loadShotSelectionRegenerationFeedbackActivity: (async () => ({ feedback: [] })) as never,
      verifyShotSelectionActivity: (async () => ({
        valid: true,
        setId: 'set-1',
        version: 1,
      })) as never,
      advanceCampaignStageActivity: advanceCampaignStageActivity as never,
      runShotPromptEngineerActivity: runShotPromptEngineerActivity as never,
    });

    const result = await campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-shotgen-2',
      initialStage: 'PROMPTING',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('PROMPTING');
    expect(result.blockedReason).toContain('shot-prompt-engineer');
    expect(advanceCampaignStageActivity).not.toHaveBeenCalled();
  });

  it('escalates to BLOCKED (no compositing begins) when the ShotGenerationWorkflow child ends BLOCKED', async () => {
    const advanceCampaignStageActivity = vi
      .fn<
        (
          input: activities.AdvanceCampaignStageInput,
        ) => Promise<activities.AdvanceCampaignStageOutput>
      >()
      .mockResolvedValueOnce({ ok: true, toStage: 'SHOT_GENERATION' });
    const runShotPromptEngineerActivity = vi
      .fn<
        (
          input: activities.RunShotPromptEngineerInput,
        ) => Promise<activities.RunShotPromptEngineerOutput>
      >()
      .mockResolvedValue({ ok: true, shotSpecificationIds: ['spec-1'] });
    const loadLatestShotSpecificationsActivity = vi
      .fn<
        (
          input: activities.LoadLatestShotSpecificationsInput,
        ) => Promise<activities.LoadLatestShotSpecificationsOutput>
      >()
      .mockResolvedValue({ ok: true, shotSpecificationIds: ['spec-1'] });
    const shotGenerationWorkflowImpl = vi.fn(async (): Promise<ShotGenerationWorkflowOutput> => ({
      status: 'BLOCKED',
      shotResults: [
        {
          shotSpecificationId: 'spec-1',
          status: 'RETRY_EXHAUSTED',
          candidateAssetIds: [],
          failureReason: 'PROVIDER_REJECTED',
        },
      ],
    }));

    setFakeActivityImpls({
      loadShotSelectionRegenerationFeedbackActivity: (async () => ({ feedback: [] })) as never,
      verifyShotSelectionActivity: (async () => ({
        valid: true,
        setId: 'set-1',
        version: 1,
      })) as never,
      advanceCampaignStageActivity: advanceCampaignStageActivity as never,
      runShotPromptEngineerActivity: runShotPromptEngineerActivity as never,
      loadLatestShotSpecificationsActivity: loadLatestShotSpecificationsActivity as never,
    });
    setFakeChildWorkflowImpls({ shotGenerationWorkflow: shotGenerationWorkflowImpl as never });

    const result = await campaignProductionWorkflow({
      workspaceId,
      campaignId,
      workflowRunId: 'run-shotgen-3',
      initialStage: 'PROMPTING',
      maxRevisionsPerGate: 3,
      videoProviderId: 'mock-video-generation',
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      maxVariantRepairAttempts: 2,
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('SHOT_GENERATION');
    expect(result.blockedReason).toContain('RETRY_EXHAUSTED');
    // advanceCampaignStageActivity was called once for PROMPTING->SHOT_GENERATION,
    // but never again for SHOT_GENERATION->VISUAL_QA — compositing is nowhere close.
    expect(advanceCampaignStageActivity).toHaveBeenCalledTimes(1);
  });
});
