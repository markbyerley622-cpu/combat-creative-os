import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as activities from '../activities';
import {
  resetFakeWorkflowRuntime,
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

  it('runs the Sound Director, advances SOUND_DESIGN -> FINAL_QA, and BLOCKS there (M10 stopping point)', async () => {
    const advance = vi
      .fn<AdvanceFn>()
      .mockResolvedValueOnce({ ok: true, toStage: 'FINAL_QA' }) // SOUND_DESIGN -> FINAL_QA (soundDesignComplete)
      .mockResolvedValueOnce({
        ok: false,
        reason: 'MISSING_PREREQUISITE',
        detail: 'finalQAPassed is false',
      });
    const sound = vi.fn<SoundFn>().mockResolvedValue({
      ok: true,
      soundDesignPlanId: 'sdp-1',
      timelineId: 't-1',
      version: 1,
      cueCount: 2,
    });

    setFakeActivityImpls({
      advanceCampaignStageActivity: advance as never,
      runSoundDirectorActivity: sound as never,
    });

    const result = await run('run-sound-1');
    expect(sound).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('BLOCKED');
    expect(result.finalStage).toBe('FINAL_QA');
    expect(result.blockedReason).toContain('finalQAPassed');
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
