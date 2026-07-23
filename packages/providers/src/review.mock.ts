import { randomUUID } from 'node:crypto';
import type { ReviewComment, ReviewProvider, ReviewStatus } from './review';

interface InternalReviewAsset {
  reviewAssetId: string;
  comments: ReviewComment[];
  status: ReviewStatus;
}

export class MockReviewProvider implements ReviewProvider {
  readonly name = 'mock-review';
  private readonly assets = new Map<string, InternalReviewAsset>();

  async createReviewAsset(): Promise<{ reviewAssetId: string }> {
    const reviewAssetId = randomUUID();
    this.assets.set(reviewAssetId, { reviewAssetId, comments: [], status: 'PENDING' });
    return { reviewAssetId };
  }

  async postComment(reviewAssetId: string, comment: ReviewComment): Promise<void> {
    const asset = this.getOrThrow(reviewAssetId);
    asset.comments.push(comment);
  }

  async getApprovalStatus(reviewAssetId: string): Promise<ReviewStatus> {
    return this.getOrThrow(reviewAssetId).status;
  }

  async generateShareLink(reviewAssetId: string): Promise<string> {
    this.getOrThrow(reviewAssetId);
    return `https://mock-review.local/share/${reviewAssetId}`;
  }

  /** Test-only helper: mocks are the only place review decisions are simulated. */
  setApprovalStatus(reviewAssetId: string, status: ReviewStatus): void {
    this.getOrThrow(reviewAssetId).status = status;
  }

  private getOrThrow(reviewAssetId: string): InternalReviewAsset {
    const asset = this.assets.get(reviewAssetId);
    if (!asset) {
      throw new Error(`Unknown review asset: ${reviewAssetId}`);
    }
    return asset;
  }
}
