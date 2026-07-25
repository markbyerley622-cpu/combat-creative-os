import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
import {
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

type AdvanceFn = (
  i: activities.AdvanceCampaignStageInput,
) => Promise<activities.AdvanceCampaignStageOutput>;
type SoundFn = (i: activities.RunSoundDirectorInput) => Promise<activities.RunSoundDirectorOutput>;

const workspaceId = randomUUID();
const campaignId = randomUUID();

function run(runId: string) {
  return campaignProductionWorkflow({
    workspaceId,
    campaignId,
    workflowRunId: runId,
    initialStage: 'SOUND_DESIGN',
    maxRevisionsPerGate: 3,
    videoProviderId: 'mock-video-generation',
  });
}

describe('campaignProductionWorkflow — SOUND_DESIGN wiring (M10)', () => {
  beforeEach(() => resetFakeWorkflowRuntime());
  afterEach(() => vi.restoreAllMocks());

  it('runs the Sound Director and hands SOUND_DESIGN -> FINAL_QA to the Final QA Controller (M11)', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: 'FINAL_QA' }) // SOUND_DESIGN -> FINAL_QA (soundDesignComplete)
      .mockResolvedValueOnce({ ok: true, toStage: 'FINAL_APPROVAL' }) // FINAL_QA -> FINAL_APPROVAL (finalQAPassed, M11)
      .mockResolvedValueOnce({
        ok: false,
        reason: 'GATE_REQUIRED',
        gate: 'FINAL',
        targetStage: 'VARIANT_GENERATION',
      });
    const sound = vi.fn<SoundFn>().mockResolvedValue({
      ok: true,
      soundDesignPlanId: 'sdp-1',
      timelineId: 't-1',
      version: 1,
      cueCount: 2,
    });
    const finalQa = vi.fn().mockResolvedValue({
      ok: true,
      pass: true,
      assessmentId: 'qa-1',
      finalMasterAssetId: 'master-1',
      overallScore: 1,
      blockingFindingCount: 0,
    });

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runSoundDirectorActivity: sound as never,
      runFinalQaControllerActivity: finalQa as never,
    });

    const resultPromise = run('run-sound-1');
    await vi.waitFor(() => expect(runQuery<string | null>('getPendingGate')).toBe('FINAL'));
    expect(sound).toHaveBeenCalledTimes(1);
    expect(finalQa).toHaveBeenCalledTimes(1);
    expect(runQuery('getCurrentStage')).toBe('FINAL_APPROVAL');
    void resultPromise;
  });

  it('escalates to BLOCKED at SOUND_DESIGN (no advance) when the Sound Director fails', async () => {
    const advance = vi.fn<AdvanceFn>();
    const sound = vi
      .fn<SoundFn>()
      .mockResolvedValue({ ok: false, reason: 'ROUGH_EDIT_NOT_FOUND', detail: 'no rough edit' });

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runSoundDirectorActivity: sound as never,
    });

    const result = await run('run-sound-2');
    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('SOUND_DESIGN');
    expect(result.blockedReason).toContain('SOUND_DESIGN plan generation failed');
    expect(advance).not.toHaveBeenCalled();
  });
});
