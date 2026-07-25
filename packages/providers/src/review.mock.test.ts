import { describe, expect, it } from 'vitest';
import { MockReviewProvider } from './review.mock';
import { ReviewProviderError } from './review';

describe('MockReviewProvider', () => {
  it('creates a review session with a share link and is idempotent by key', async () => {
    const provider = new MockReviewProvider();
    const first = await provider.createReviewSession({ idempotencyKey: 'k1', campaignId: 'c1' });
    const retry = await provider.createReviewSession({ idempotencyKey: 'k1', campaignId: 'c1' });

    expect(first.id).toBe(retry.id);
    expect(first.shareLink).toContain(first.id);
    expect(await provider.getShareLink(first.id)).toBe(first.shareLink);
  });

  it('registers candidate versions and preserves version history per shot', async () => {
    const provider = new MockReviewProvider();
    const session = await provider.createReviewSession({ idempotencyKey: 'k', campaignId: 'c1' });

    const v1 = await provider.registerCandidateVersion({
      idempotencyKey: 'reg-1',
      sessionId: session.id,
      shotId: 'shot-1',
      candidateId: 'cand-1',
    });
    const v2 = await provider.registerCandidateVersion({
      idempotencyKey: 'reg-2',
      sessionId: session.id,
      shotId: 'shot-1',
      candidateId: 'cand-2',
    });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    const history = await provider.listVersions(session.id, 'shot-1');
    expect(history.map((v) => v.candidateId)).toEqual(['cand-1', 'cand-2']);
  });

  it('is idempotent registering the same candidate version and rejects a conflicting reuse of a key', async () => {
    const provider = new MockReviewProvider();
    const session = await provider.createReviewSession({ idempotencyKey: 'k', campaignId: 'c1' });
    const v1 = await provider.registerCandidateVersion({
      idempotencyKey: 'reg-1',
      sessionId: session.id,
      shotId: 'shot-1',
      candidateId: 'cand-1',
    });
    const retry = await provider.registerCandidateVersion({
      idempotencyKey: 'reg-1',
      sessionId: session.id,
      shotId: 'shot-1',
      candidateId: 'cand-1',
    });
    expect(retry.id).toBe(v1.id);

    await expect(
      provider.registerCandidateVersion({
        idempotencyKey: 'reg-1',
        sessionId: session.id,
        shotId: 'shot-1',
        candidateId: 'cand-different',
      }),
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });

  it('posts plain, timecoded, and annotated comments preserving reviewer identity and order', async () => {
    const provider = new MockReviewProvider();
    const session = await provider.createReviewSession({ idempotencyKey: 'k', campaignId: 'c1' });
    const version = await provider.registerCandidateVersion({
      idempotencyKey: 'reg-1',
      sessionId: session.id,
      shotId: 'shot-1',
      candidateId: 'cand-1',
    });

    await provider.postComment({
      idempotencyKey: 'cm-1',
      sessionId: session.id,
      versionId: version.id,
      authorId: 'reviewer-1',
      body: 'Tighten the framing',
    });
    const timecoded = await provider.postComment({
      idempotencyKey: 'cm-2',
      sessionId: session.id,
      versionId: version.id,
      authorId: 'reviewer-2',
      body: 'Artifact here',
      timecodeSeconds: 1.5,
      annotation: {
        kind: 'RECT',
        timecodeSeconds: 1.5,
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.5 },
        ],
      },
    });

    expect(timecoded.timecodeSeconds).toBe(1.5);
    expect(timecoded.annotation?.kind).toBe('RECT');
    const comments = await provider.listComments(session.id, version.id);
    expect(comments.map((c) => c.authorId)).toEqual(['reviewer-1', 'reviewer-2']);
    expect(comments.map((c) => c.sequence)).toEqual([1, 2]);
  });

  it('records a reviewer decision on a version', async () => {
    const provider = new MockReviewProvider();
    const session = await provider.createReviewSession({ idempotencyKey: 'k', campaignId: 'c1' });
    const version = await provider.registerCandidateVersion({
      idempotencyKey: 'reg-1',
      sessionId: session.id,
      shotId: 'shot-1',
      candidateId: 'cand-1',
    });
    expect(version.status).toBe('PENDING');

    const decided = await provider.setVersionDecision({
      sessionId: session.id,
      versionId: version.id,
      reviewerId: 'reviewer-1',
      status: 'APPROVED',
    });
    expect(decided.status).toBe('APPROVED');
    expect(decided.reviewerId).toBe('reviewer-1');
  });

  it('raises typed failures for unknown sessions, unknown versions, and invalid annotations', async () => {
    const provider = new MockReviewProvider();
    await expect(provider.listVersions('nope')).rejects.toMatchObject({
      reason: 'SESSION_NOT_FOUND',
    });

    const session = await provider.createReviewSession({ idempotencyKey: 'k', campaignId: 'c1' });
    await expect(
      provider.setVersionDecision({
        sessionId: session.id,
        versionId: 'nope',
        reviewerId: 'r',
        status: 'APPROVED',
      }),
    ).rejects.toMatchObject({ reason: 'VERSION_NOT_FOUND' });

    await expect(
      provider.postComment({
        idempotencyKey: 'cm',
        sessionId: session.id,
        authorId: 'r',
        body: 'bad',
        annotation: { kind: 'RECT', timecodeSeconds: 0, points: [{ x: 2, y: 0 }] },
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_ANNOTATION' });

    const err = new ReviewProviderError('SESSION_NOT_FOUND', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReviewProviderError');
  });
});
