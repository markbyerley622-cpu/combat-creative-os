import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  allShotsSucceeded,
  anyShotFailed,
  applyAttemptFailed,
  applyCancelSignal,
  applyCancelled,
  applyDispatchResult,
  applyPolling,
  applySucceeded,
  initialShotGenerationState,
  toProgress,
} from './shot-generation-workflow-state';

describe('shot-generation-workflow-state', () => {
  it('initializes every shot as PENDING with attemptNumber 0', () => {
    const ids = [randomUUID(), randomUUID()];
    const state = initialShotGenerationState(ids);

    expect(Object.keys(state.perShot)).toEqual(ids);
    for (const id of ids) {
      expect(state.perShot[id]).toEqual({
        shotSpecificationId: id,
        status: 'PENDING',
        attemptNumber: 0,
      });
    }
    expect(state.cancelled).toBe(false);
  });

  it('applyDispatchResult(ok:true) moves the shot to POLLING and records attemptId', () => {
    const id = randomUUID();
    let state = initialShotGenerationState([id]);

    state = applyDispatchResult(state, id, 1, {
      ok: true,
      attemptId: 'attempt-1',
      providerJobId: 'job-1',
      shotId: 'shot-1',
      providerId: 'mock',
    });

    expect(state.perShot[id]).toMatchObject({
      status: 'POLLING',
      attemptNumber: 1,
      attemptId: 'attempt-1',
    });
  });

  it('applyDispatchResult(ok:false) is terminal FAILED with the failure detail recorded', () => {
    const id = randomUUID();
    let state = initialShotGenerationState([id]);

    state = applyDispatchResult(state, id, 1, {
      ok: false,
      reason: 'UNSUPPORTED_CAPABILITY',
      detail: 'aspectRatio not supported',
      attemptId: 'attempt-1',
    });

    expect(state.perShot[id]).toMatchObject({
      status: 'FAILED',
      lastFailureReason: 'UNSUPPORTED_CAPABILITY',
      lastFailureMessage: 'aspectRatio not supported',
    });
  });

  it('applyPolling keeps the shot in POLLING', () => {
    const id = randomUUID();
    let state = initialShotGenerationState([id]);
    state = applyPolling(state, id);
    expect(state.perShot[id]!.status).toBe('POLLING');
  });

  it('applySucceeded records candidateAssetIds and status SUCCEEDED', () => {
    const id = randomUUID();
    let state = initialShotGenerationState([id]);
    state = applySucceeded(state, id, ['asset-1', 'asset-2']);
    expect(state.perShot[id]).toMatchObject({
      status: 'SUCCEEDED',
      candidateAssetIds: ['asset-1', 'asset-2'],
    });
  });

  it('applyCancelled marks the shot CANCELLED', () => {
    const id = randomUUID();
    let state = initialShotGenerationState([id]);
    state = applyCancelled(state, id);
    expect(state.perShot[id]!.status).toBe('CANCELLED');
  });

  it('applyCancelSignal sets state.cancelled without touching per-shot status', () => {
    const id = randomUUID();
    let state = initialShotGenerationState([id]);
    state = applyCancelSignal(state);
    expect(state.cancelled).toBe(true);
    expect(state.perShot[id]!.status).toBe('PENDING');
  });

  describe('applyAttemptFailed — bounded retry', () => {
    it('allows a retry while attemptNumber < maxAttempts', () => {
      const id = randomUUID();
      let state = initialShotGenerationState([id]);

      const { state: nextState, retry } = applyAttemptFailed(
        state,
        id,
        1,
        3,
        'PROVIDER_TIMEOUT',
        'timed out',
      );
      state = nextState;

      expect(retry).toBe(true);
      expect(state.perShot[id]).toMatchObject({
        status: 'FAILED',
        lastFailureReason: 'PROVIDER_TIMEOUT',
        lastFailureMessage: 'timed out',
      });
    });

    it('exhausts retries once attemptNumber reaches maxAttempts', () => {
      const id = randomUUID();
      let state = initialShotGenerationState([id]);

      const { state: nextState, retry } = applyAttemptFailed(
        state,
        id,
        3,
        3,
        'PROVIDER_REJECTED',
        'rejected',
      );
      state = nextState;

      expect(retry).toBe(false);
      expect(state.perShot[id]!.status).toBe('RETRY_EXHAUSTED');
    });
  });

  it('toProgress flattens perShot into a shots array plus the cancelled flag', () => {
    const ids = [randomUUID(), randomUUID()];
    const state = initialShotGenerationState(ids);
    const progress = toProgress(state);
    expect(progress.shots).toHaveLength(2);
    expect(progress.cancelled).toBe(false);
  });

  describe('allShotsSucceeded / anyShotFailed', () => {
    it('allShotsSucceeded is true only when every shot is SUCCEEDED', () => {
      const [a, b] = [randomUUID(), randomUUID()];
      let state = initialShotGenerationState([a, b]);
      expect(allShotsSucceeded(state)).toBe(false);

      state = applySucceeded(state, a, []);
      expect(allShotsSucceeded(state)).toBe(false);

      state = applySucceeded(state, b, []);
      expect(allShotsSucceeded(state)).toBe(true);
    });

    it('anyShotFailed is true if any shot is FAILED or RETRY_EXHAUSTED', () => {
      const [a, b] = [randomUUID(), randomUUID()];
      let state = initialShotGenerationState([a, b]);
      expect(anyShotFailed(state)).toBe(false);

      state = applySucceeded(state, a, []);
      const { state: nextState } = applyAttemptFailed(state, b, 3, 3, 'PROVIDER_ERROR', 'boom');
      state = nextState;

      expect(anyShotFailed(state)).toBe(true);
    });
  });
});
