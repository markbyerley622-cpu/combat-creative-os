/**
 * Frame.io-compatible review provider (§7.1 resolved default #3): a
 * provider-neutral interface whose complete deterministic mock
 * (`review.mock.ts`) is sufficient for all local development. Real Frame.io
 * integration is deferred until the Shot Selection / review workflow passes
 * end-to-end against the mock — the method set below is intentionally the
 * subset a Frame.io adapter maps onto cleanly (sessions, versioned assets,
 * timecoded comments + annotations, reviewer decisions, share links).
 *
 * M8 extends the original four-method contract (createReviewAsset/postComment/
 * getApprovalStatus/generateShareLink) into the session+version model the Shot
 * Selection review workspace needs. Nothing outside `packages/providers`
 * depended on the old shape, so this is an in-place widening, not a break.
 */
export type ReviewStatus = 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED';

export const REVIEW_PROVIDER_FAILURE_REASONS = [
  'SESSION_NOT_FOUND',
  'VERSION_NOT_FOUND',
  'INVALID_ANNOTATION',
  'IDEMPOTENCY_CONFLICT',
] as const;
export type ReviewProviderFailureReason = (typeof REVIEW_PROVIDER_FAILURE_REASONS)[number];

/** Typed provider failure — a real adapter maps its own error surface onto these reasons so callers never branch on provider-specific strings. */
export class ReviewProviderError extends Error {
  constructor(
    readonly reason: ReviewProviderFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewProviderError';
  }
}

/**
 * A spatial/temporal annotation on a review version, represented purely as
 * typed metadata (a shape descriptor + normalized coordinates) — never
 * rasterized pixels. A real adapter renders these into Frame.io's annotation
 * layer; the mock stores them verbatim.
 */
export interface ReviewAnnotation {
  kind: 'RECT' | 'POINT' | 'FREEHAND';
  /** Where in the clip the annotation applies. */
  timecodeSeconds: number;
  /** Normalized [0,1] geometry — points, rect corners, or a freehand path — kept provider-neutral. */
  points: readonly { x: number; y: number }[];
  note?: string;
}

export interface ReviewComment {
  id: string;
  authorId: string;
  body: string;
  /** Present for a timecoded comment pinned to a moment in the clip. */
  timecodeSeconds?: number;
  annotation?: ReviewAnnotation;
  /** The specific version the comment is attached to (a session-level comment omits this). */
  versionId?: string;
  /** Monotonic per-session sequence — deterministic ordering with no wall-clock dependency. */
  sequence: number;
}

export interface ReviewVersion {
  id: string;
  shotId: string;
  candidateId: string;
  /** 1-based; incremented each time a new candidate is registered for the same shot (version history). */
  version: number;
  status: ReviewStatus;
  /** The reviewer who last set `status` — undefined while PENDING. */
  reviewerId?: string;
  /**
   * The internal storage key the reviewed media lives under. Kept inside the
   * provider only — API responses never surface it (CLAUDE.md: "never expose
   * internal object keys"); callers reach bytes only through a signed URL.
   */
  s3Key?: string;
  metadata?: Record<string, unknown>;
}

export interface ReviewSession {
  id: string;
  campaignId: string;
  shareLink: string;
}

export interface ReviewProvider {
  readonly name: string;

  /** Idempotent by `idempotencyKey`: a replayed call returns the same session rather than a second one. */
  createReviewSession(input: {
    idempotencyKey: string;
    campaignId: string;
    context?: Record<string, unknown>;
  }): Promise<ReviewSession>;

  /**
   * Registers a candidate as a reviewable version. Idempotent by
   * `idempotencyKey`; registering a *different* candidate for a shot already
   * under review appends a new version (incrementing `version`), preserving the
   * full version history.
   */
  registerCandidateVersion(input: {
    idempotencyKey: string;
    sessionId: string;
    shotId: string;
    candidateId: string;
    s3Key?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ReviewVersion>;

  /** Idempotent by `idempotencyKey`. Supports plain, timecoded, and annotated comments; the reviewer identity is `authorId`. */
  postComment(input: {
    idempotencyKey: string;
    sessionId: string;
    versionId?: string;
    authorId: string;
    body: string;
    timecodeSeconds?: number;
    annotation?: ReviewAnnotation;
  }): Promise<ReviewComment>;

  listComments(sessionId: string, versionId?: string): Promise<ReviewComment[]>;

  setVersionDecision(input: {
    sessionId: string;
    versionId: string;
    reviewerId: string;
    status: ReviewStatus;
  }): Promise<ReviewVersion>;

  getVersion(sessionId: string, versionId: string): Promise<ReviewVersion>;

  /** Full version history for a session, or just one shot's when `shotId` is given, oldest-first. */
  listVersions(sessionId: string, shotId?: string): Promise<ReviewVersion[]>;

  getShareLink(sessionId: string): Promise<string>;
}
