/**
 * Frame.io-compatible review provider — resolved per review (§7.1 resolved
 * default #3): provider-neutral interface, complete deterministic mock is
 * sufficient for all local development, real Frame.io integration deferred
 * until the review workflow passes end-to-end against the mock.
 */
export type ReviewStatus = 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED';

export interface ReviewComment {
  authorId: string;
  body: string;
  timestampSeconds?: number;
}

export interface ReviewProvider {
  readonly name: string;
  createReviewAsset(input: {
    s3Key: string;
    context: Record<string, unknown>;
  }): Promise<{ reviewAssetId: string }>;
  postComment(reviewAssetId: string, comment: ReviewComment): Promise<void>;
  getApprovalStatus(reviewAssetId: string): Promise<ReviewStatus>;
  generateShareLink(reviewAssetId: string): Promise<string>;
}
