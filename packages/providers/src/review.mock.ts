import {
  ReviewProviderError,
  type ReviewAnnotation,
  type ReviewComment,
  type ReviewProvider,
  type ReviewSession,
  type ReviewStatus,
  type ReviewVersion,
} from './review';

interface InternalSession {
  session: ReviewSession;
  versions: ReviewVersion[];
  comments: ReviewComment[];
}

/**
 * Deterministic, in-memory `ReviewProvider`. No network I/O, no wall-clock:
 * ids are derived from a per-instance monotonic counter and comment ordering
 * from a per-session sequence, so a given call sequence always produces the
 * same result (CLAUDE.md provider-mock rule). Idempotency is keyed on the
 * caller-supplied `idempotencyKey`; a replay with the same key returns the
 * original record, and a key reused for a materially different payload raises
 * a typed `IDEMPOTENCY_CONFLICT` rather than silently diverging.
 */
export class MockReviewProvider implements ReviewProvider {
  readonly name = 'mock-review';
  private readonly sessions = new Map<string, InternalSession>();
  private readonly sessionByKey = new Map<string, string>();
  private readonly versionByKey = new Map<string, string>();
  private readonly commentByKey = new Map<string, string>();
  private counter = 0;

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  async createReviewSession(input: {
    idempotencyKey: string;
    campaignId: string;
    context?: Record<string, unknown>;
  }): Promise<ReviewSession> {
    const existingId = this.sessionByKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.sessions.get(existingId)!;
      if (existing.session.campaignId !== input.campaignId) {
        throw new ReviewProviderError(
          'IDEMPOTENCY_CONFLICT',
          `idempotencyKey ${input.idempotencyKey} was already used for a different campaign`,
        );
      }
      return existing.session;
    }
    const id = this.nextId('session');
    const session: ReviewSession = {
      id,
      campaignId: input.campaignId,
      shareLink: `https://mock-review.local/session/${id}`,
    };
    this.sessions.set(id, { session, versions: [], comments: [] });
    this.sessionByKey.set(input.idempotencyKey, id);
    return session;
  }

  async registerCandidateVersion(input: {
    idempotencyKey: string;
    sessionId: string;
    shotId: string;
    candidateId: string;
    s3Key?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ReviewVersion> {
    const internal = this.getSessionOrThrow(input.sessionId);
    const existingId = this.versionByKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = internal.versions.find((v) => v.id === existingId);
      if (existing && existing.candidateId !== input.candidateId) {
        throw new ReviewProviderError(
          'IDEMPOTENCY_CONFLICT',
          `idempotencyKey ${input.idempotencyKey} was already used for a different candidate`,
        );
      }
      if (existing) return existing;
    }
    const priorForShot = internal.versions.filter((v) => v.shotId === input.shotId);
    const version: ReviewVersion = {
      id: this.nextId('version'),
      shotId: input.shotId,
      candidateId: input.candidateId,
      version: priorForShot.length + 1,
      status: 'PENDING',
      s3Key: input.s3Key,
      metadata: input.metadata,
    };
    internal.versions.push(version);
    this.versionByKey.set(input.idempotencyKey, version.id);
    return version;
  }

  async postComment(input: {
    idempotencyKey: string;
    sessionId: string;
    versionId?: string;
    authorId: string;
    body: string;
    timecodeSeconds?: number;
    annotation?: ReviewAnnotation;
  }): Promise<ReviewComment> {
    const internal = this.getSessionOrThrow(input.sessionId);
    const existingId = this.commentByKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = internal.comments.find((c) => c.id === existingId);
      if (existing) return existing;
    }
    if (input.versionId && !internal.versions.some((v) => v.id === input.versionId)) {
      throw new ReviewProviderError(
        'VERSION_NOT_FOUND',
        `version ${input.versionId} does not belong to session ${input.sessionId}`,
      );
    }
    if (input.annotation) {
      this.assertValidAnnotation(input.annotation);
    }
    const comment: ReviewComment = {
      id: this.nextId('comment'),
      authorId: input.authorId,
      body: input.body,
      timecodeSeconds: input.timecodeSeconds,
      annotation: input.annotation,
      versionId: input.versionId,
      sequence: internal.comments.length + 1,
    };
    internal.comments.push(comment);
    this.commentByKey.set(input.idempotencyKey, comment.id);
    return comment;
  }

  async listComments(sessionId: string, versionId?: string): Promise<ReviewComment[]> {
    const internal = this.getSessionOrThrow(sessionId);
    const comments = versionId
      ? internal.comments.filter((c) => c.versionId === versionId)
      : internal.comments;
    return [...comments].sort((a, b) => a.sequence - b.sequence);
  }

  async setVersionDecision(input: {
    sessionId: string;
    versionId: string;
    reviewerId: string;
    status: ReviewStatus;
  }): Promise<ReviewVersion> {
    const internal = this.getSessionOrThrow(input.sessionId);
    const version = internal.versions.find((v) => v.id === input.versionId);
    if (!version) {
      throw new ReviewProviderError(
        'VERSION_NOT_FOUND',
        `version ${input.versionId} does not belong to session ${input.sessionId}`,
      );
    }
    version.status = input.status;
    version.reviewerId = input.reviewerId;
    return version;
  }

  async getVersion(sessionId: string, versionId: string): Promise<ReviewVersion> {
    const internal = this.getSessionOrThrow(sessionId);
    const version = internal.versions.find((v) => v.id === versionId);
    if (!version) {
      throw new ReviewProviderError(
        'VERSION_NOT_FOUND',
        `version ${versionId} does not belong to session ${sessionId}`,
      );
    }
    return version;
  }

  async listVersions(sessionId: string, shotId?: string): Promise<ReviewVersion[]> {
    const internal = this.getSessionOrThrow(sessionId);
    const versions = shotId
      ? internal.versions.filter((v) => v.shotId === shotId)
      : internal.versions;
    return [...versions].sort((a, b) => a.version - b.version);
  }

  async getShareLink(sessionId: string): Promise<string> {
    return this.getSessionOrThrow(sessionId).session.shareLink;
  }

  private assertValidAnnotation(annotation: ReviewAnnotation): void {
    const inRange = annotation.points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
    const shapeOk =
      annotation.points.length > 0 &&
      (annotation.kind !== 'POINT' || annotation.points.length === 1) &&
      annotation.timecodeSeconds >= 0;
    if (!inRange || !shapeOk) {
      throw new ReviewProviderError(
        'INVALID_ANNOTATION',
        'annotation points must be normalized to [0,1] and match the annotation kind',
      );
    }
  }

  private getSessionOrThrow(sessionId: string): InternalSession {
    const internal = this.sessions.get(sessionId);
    if (!internal) {
      throw new ReviewProviderError('SESSION_NOT_FOUND', `unknown review session: ${sessionId}`);
    }
    return internal;
  }
}
